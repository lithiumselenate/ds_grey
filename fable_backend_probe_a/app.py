"""RelayVault application layer and minimal ThreadingHTTPServer adapter.

The transport-independent entry point is ``Application.handle(method,
raw_target, headers, body) -> Response``.  ``raw_target`` is the raw request
target (path plus original query string) exactly as received; it is the
signed value.  Routing percent-decodes a copy of the path for matching but
never alters the signed value.  ``headers`` is a sequence of (name, value)
pairs so repeated headers remain observable.
"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import security
import store as store_module

MAX_BODY_BYTES = 65536

_EVENT_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
_EVENT_TYPE_RE = re.compile(r"\A[a-z0-9._-]{1,80}\Z")
_IDEMPOTENCY_KEY_RE = re.compile(r"\A[A-Za-z0-9_-]{8,80}\Z")
_TOP_LEVEL_FIELDS = frozenset({"event_id", "type", "callback_url", "payload"})


@dataclass
class Response:
    """Stable-shape compact JSON response."""

    status: int
    body: dict
    headers: Dict[str, str] = field(default_factory=dict)

    def encode(self) -> bytes:
        return json.dumps(self.body, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _error(status: int, code: str) -> Response:
    return Response(status, {"error": code})


def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate object key")
        obj[key] = value
    return obj


def _reject_constant(name):
    raise ValueError("non-finite JSON number: %s" % name)


def parse_strict_json(text: str):
    """JSON parsing that rejects duplicate keys at any depth and NaN/Infinity."""
    return json.loads(
        text, object_pairs_hook=_reject_duplicate_keys, parse_constant=_reject_constant
    )


def collect_headers(pairs: Iterable[Tuple[str, str]]) -> Dict[str, List[str]]:
    """Case-insensitive multimap preserving repeated header values."""
    collected: Dict[str, List[str]] = {}
    for name, value in pairs:
        collected.setdefault(name.lower(), []).append(value)
    return collected


class Application:
    """Transport-independent request handling.

    All collaborators are injected: the store, the authenticator (which owns
    the credential configuration and clock), the hostname resolver, the wall
    clock, the job-ID generator, and the structured-log sink
    ``logger(event_name, fields_dict)``.  Log fields pass through
    ``security.redact`` and never include secrets, signatures, payload
    contents, or callback response bodies.
    """

    def __init__(
        self,
        job_store: store_module.Store,
        authenticator: security.Authenticator,
        resolver: Callable[[str], Sequence[str]],
        clock: Callable[[], float],
        id_generator: Optional[Callable[[], str]] = None,
        logger: Optional[Callable[[str, dict], None]] = None,
    ) -> None:
        self._store = job_store
        self._auth = authenticator
        self._resolver = resolver
        self._clock = clock
        self._id_generator = id_generator or (lambda: "job_" + uuid.uuid4().hex)
        self._logger = logger or (lambda event, fields: None)

    def _log(self, event: str, **fields) -> None:
        self._logger(event, security.redact(fields))

    def handle(
        self,
        method: str,
        raw_target: str,
        headers: Iterable[Tuple[str, str]],
        body: bytes,
    ) -> Response:
        header_map = collect_headers(headers)
        # Enforced again here in case an adapter failed to pre-check length.
        if len(body) > MAX_BODY_BYTES:
            return _error(413, "body_too_large")
        try:
            tenant_id, key_id = self._auth.authenticate(method, raw_target, header_map, body)
        except security.AuthenticationError:
            self._log("auth_failed", method=method)
            return _error(401, "unauthorized")

        raw_path = raw_target.split("?", 1)[0]
        try:
            decoded_path = urllib.parse.unquote(raw_path, errors="strict")
        except UnicodeDecodeError:
            return _error(404, "not_found")
        segments = [segment for segment in decoded_path.split("/") if segment]

        if segments == ["v1", "events"]:
            if method != "POST":
                return _error(405, "method_not_allowed")
            return self._create_event(tenant_id, header_map, body)
        if len(segments) == 3 and segments[0] == "v1" and segments[1] == "jobs":
            if method != "GET":
                return _error(405, "method_not_allowed")
            if body:
                return _error(400, "invalid_request")
            return self._get_job(tenant_id, segments[2])
        return _error(404, "not_found")

    # -- POST /v1/events -----------------------------------------------------

    def _create_event(
        self, tenant_id: str, header_map: Dict[str, List[str]], body: bytes
    ) -> Response:
        media_error = self._check_content_headers(header_map)
        if media_error is not None:
            return media_error
        idempotency_values = header_map.get("idempotency-key", [])
        if len(idempotency_values) != 1 or not _IDEMPOTENCY_KEY_RE.match(
            idempotency_values[0]
        ):
            return _error(400, "invalid_idempotency_key")
        idempotency_key = idempotency_values[0]

        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return _error(400, "invalid_body")
        try:
            document = parse_strict_json(text)
        except ValueError:
            return _error(400, "invalid_body")
        if not isinstance(document, dict) or set(document) != _TOP_LEVEL_FIELDS:
            return _error(400, "invalid_body")

        event_id = document["event_id"]
        event_type = document["type"]
        callback_url = document["callback_url"]
        payload = document["payload"]
        if not isinstance(event_id, str) or not _EVENT_ID_RE.match(event_id):
            return _error(400, "invalid_body")
        if not isinstance(event_type, str) or not _EVENT_TYPE_RE.match(event_type):
            return _error(400, "invalid_body")
        if not isinstance(callback_url, str) or not isinstance(payload, dict):
            return _error(400, "invalid_body")

        try:
            security.validate_callback_url(callback_url, self._resolver)
        except security.CallbackURLError:
            # Deliberately generic: no resolved addresses, no reason detail.
            return _error(422, "invalid_callback_url")

        now = int(self._clock())
        try:
            job, created = self._store.create_job(
                tenant_id=tenant_id,
                idempotency_key=idempotency_key,
                body_sha256=hashlib.sha256(body).hexdigest(),
                event_id=event_id,
                event_type=event_type,
                callback_url=callback_url,
                payload_json=json.dumps(payload, sort_keys=True, separators=(",", ":")),
                job_id=self._id_generator(),
                now=now,
            )
        except store_module.IdempotencyConflict:
            return _error(409, "idempotency_conflict")
        except store_module.EventIdConflict:
            return _error(409, "event_id_conflict")

        self._log(
            "event_accepted",
            tenant_id=tenant_id,
            job_id=job["job_id"],
            event_id=job["event_id"],
            duplicate=not created,
        )
        return Response(
            202 if created else 200,
            {
                "duplicate": not created,
                "event_id": job["event_id"],
                "job_id": job["job_id"],
                "status": job["status"],
            },
        )

    @staticmethod
    def _check_content_headers(header_map: Dict[str, List[str]]) -> Optional[Response]:
        content_types = header_map.get("content-type", [])
        if len(content_types) != 1:
            return _error(415, "unsupported_media_type")
        parts = [
            part.strip() for part in content_types[0].lower().split(";") if part.strip()
        ]
        if not parts or parts[0] != "application/json":
            return _error(415, "unsupported_media_type")
        for parameter in parts[1:]:
            if parameter != "charset=utf-8":
                return _error(415, "unsupported_media_type")
        if header_map.get("content-encoding") or header_map.get("transfer-encoding"):
            return _error(415, "unsupported_media_type")
        return None

    # -- GET /v1/jobs/{job_id} -------------------------------------------------

    def _get_job(self, tenant_id: str, job_id: str) -> Response:
        job = self._store.get_job(tenant_id, job_id)
        if job is None:
            # Identical response for missing jobs and other tenants' jobs.
            return _error(404, "not_found")
        return Response(
            200,
            {
                "attempts": job["attempts"],
                "callback_url": job["callback_url"],
                "created_at": job["created_at"],
                "event_id": job["event_id"],
                "job_id": job["job_id"],
                "last_error_code": job["last_error_code"],
                "next_attempt_at": job["next_attempt_at"],
                "status": job["status"],
                "type": job["event_type"],
                "updated_at": job["updated_at"],
            },
        )


# -- HTTP adapter ---------------------------------------------------------------


def parse_content_length(
    values: Sequence[str], max_bytes: int = MAX_BODY_BYTES
) -> Tuple[Optional[int], Optional[Tuple[int, str]]]:
    """Validate Content-Length BEFORE any body byte is read or parsed.

    Returns ``(length, None)`` on success or ``(None, (status, code))`` for
    ambiguous/invalid headers and oversized declarations.
    """
    if not values:
        return 0, None
    if len(values) != 1:
        return None, (400, "invalid_content_length")
    value = values[0].strip()
    if not value.isdigit():
        return None, (400, "invalid_content_length")
    length = int(value)
    if length > max_bytes:
        return None, (413, "body_too_large")
    return length, None


class RelayVaultHandler(BaseHTTPRequestHandler):
    server_version = "RelayVault"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        length_values = self.headers.get_all("Content-Length") or []
        length, error = parse_content_length(length_values, MAX_BODY_BYTES)
        if error is not None:
            # Rejected before reading the request body.
            self._respond(_error(error[0], error[1]), close=True)
            return
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            self._respond(_error(400, "invalid_request"), close=True)
            return
        # self.path is the raw request target including its query string.
        response = self.server.application.handle(
            self.command, self.path, list(self.headers.items()), body
        )
        self._respond(response)

    def _respond(self, response: Response, close: bool = False) -> None:
        payload = response.encode()
        self.send_response(response.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in response.headers.items():
            self.send_header(name, value)
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        # Suppress default stderr access logs; the application layer emits
        # structured, redacted events instead.
        return


def make_server(application: Application, host: str = "127.0.0.1", port: int = 0):
    """Build a ThreadingHTTPServer bound to the given address."""
    server = ThreadingHTTPServer((host, port), RelayVaultHandler)
    server.application = application
    return server


def main() -> None:  # pragma: no cover - not exercised by tests
    """Run a real server.  Secrets arrive via configuration, never code:

    RELAYVAULT_DB               path to the SQLite database
    RELAYVAULT_CREDENTIALS_FILE JSON file {"tenant:key": "secret", ...}
    RELAYVAULT_BIND / _PORT     optional bind address and port
    """
    import os
    import sys
    import time

    credentials_path = os.environ["RELAYVAULT_CREDENTIALS_FILE"]
    with open(credentials_path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    secrets = {
        tuple(name.split(":", 1)): value.encode("utf-8") for name, value in raw.items()
    }

    def credentials(tenant_id: str, key_id: str):
        return secrets.get((tenant_id, key_id))

    def log_sink(event: str, fields: dict) -> None:
        sys.stderr.write(
            json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":"))
            + "\n"
        )

    job_store = store_module.Store(os.environ["RELAYVAULT_DB"])
    authenticator = security.Authenticator(
        credentials, time.time, security.InMemoryNonceStore()
    )
    application = Application(
        job_store,
        authenticator,
        security.default_resolver,
        time.time,
        logger=log_sink,
    )
    server = make_server(
        application,
        os.environ.get("RELAYVAULT_BIND", "127.0.0.1"),
        int(os.environ.get("RELAYVAULT_PORT", "0")),
    )
    sys.stderr.write("relayvault listening on %s:%d\n" % server.server_address[:2])
    server.serve_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
