"""RelayVault application layer and minimal HTTP adapter.

The transport-independent core is :class:`Application` with::

    Application.handle(method, raw_target, headers, body) -> Response

``headers`` is a list of (name, value) pairs exactly as received; the *raw*
request target (including its original query string) is what gets signed.
Routing decodes the path separately but never alters the signed value.

The :class:`ThreadingHTTPServer` adapter enforces the body-size limit from
``Content-Length`` *before* reading the complete body.

API summary
-----------
* ``POST /v1/events``   – enqueue a webhook delivery job (requires
  ``Idempotency-Key``); 202 created, 200 + ``duplicate: true`` for a repeat
  with a byte-identical body, 409 for a conflicting body, and 409
  ``event_id_conflict`` when a different idempotency key reuses an existing
  event_id for the same tenant (documented deterministic behaviour).
* ``GET /v1/jobs/{job_id}`` – fetch one of the tenant's jobs; a missing job
  and another tenant's job return an identical 404.

Responses are compact JSON with a stable shape.  Errors never contain stack
traces, SQL text, secrets, resolved addresses, or tenant-existence hints.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from security import (
    AuthError,
    Authenticator,
    CallbackURLError,
    StructuredLogger,
    resolve_and_validate,
    validate_callback_url,
)

__all__ = [
    "Application",
    "MAX_BODY_BYTES",
    "Response",
    "body_length_from_headers",
    "make_server",
]

MAX_BODY_BYTES = 65536

_EVENT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_EVENT_TYPE_RE = re.compile(r"[a-z0-9._-]{1,80}")
_IDEMPOTENCY_KEY_RE = re.compile(r"[A-Za-z0-9_-]{8,80}")
_JOB_PATH_RE = re.compile(r"/v1/jobs/([^/]+)")

_EVENTS_ENDPOINT = "POST /v1/events"
_REQUIRED_FIELDS = ("event_id", "type", "callback_url", "payload")


@dataclass
class Response:
    status: int
    body: bytes
    headers: list = field(default_factory=list)


def _json_response(status: int, payload: dict) -> Response:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return Response(
        status=status,
        body=body,
        headers=[
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
        ],
    )


def _error(status: int, code: str) -> Response:
    return _json_response(status, {"error": code})


class _BadRequest(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


# ---------------------------------------------------------------------------
# Strict JSON parsing helpers
# ---------------------------------------------------------------------------

def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise _BadRequest(400, "invalid_body")
        obj[key] = value
    return obj


def _reject_constant(_value):
    # NaN, Infinity, -Infinity
    raise _BadRequest(400, "invalid_body")


def _parse_strict_json(body: bytes):
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise _BadRequest(400, "invalid_body") from None
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except _BadRequest:
        raise
    except (ValueError, RecursionError):
        raise _BadRequest(400, "invalid_body") from None
    # Defence in depth: no non-finite numbers anywhere.
    _assert_finite(value)
    return value


def _assert_finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise _BadRequest(400, "invalid_body")
    if isinstance(value, dict):
        for v in value.values():
            _assert_finite(v)
    elif isinstance(value, list):
        for v in value:
            _assert_finite(v)


def _single_header(headers, name: str):
    """Return the lone value of a header or None; ambiguity is an error."""
    lowered = name.lower()
    found = [str(v) for (k, v) in headers if str(k).strip().lower() == lowered]
    if not found:
        return None
    if len(found) != 1:
        raise _BadRequest(400, "invalid_headers")
    return found[0].strip()


def body_length_from_headers(headers) -> int:
    """Content-Length for the HTTP adapter; raises on ambiguity/garbage."""
    value = _single_header(headers, "Content-Length")
    if value is None:
        return 0
    if not re.fullmatch(r"[0-9]{1,12}", value):
        raise _BadRequest(400, "invalid_headers")
    return int(value)


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

class Application:
    """Transport-independent RelayVault API core.

    Collaborators are injected for determinism: ``store`` (SQLite store),
    ``authenticator``, ``resolver`` (hostname -> addresses, used to vet
    callback URLs at enqueue time), ``clock`` (wall-clock Unix seconds),
    ``id_factory`` (job-id generation), and ``logger``.
    """

    def __init__(
        self,
        store,
        authenticator: Authenticator,
        resolver,
        clock,
        id_factory=None,
        logger: StructuredLogger | None = None,
    ) -> None:
        if id_factory is None:
            import uuid

            id_factory = lambda: "job_" + uuid.uuid4().hex  # noqa: E731
        self._store = store
        self._auth = authenticator
        self._resolver = resolver
        self._clock = clock
        self._id_factory = id_factory
        self._logger = logger if logger is not None else StructuredLogger()

    def handle(self, method: str, raw_target: str, headers, body: bytes) -> Response:
        method = str(method).upper()
        body = bytes(body or b"")
        headers = list(headers or [])

        # Enforced again here so non-HTTP transports get the same limit; the
        # HTTP adapter already refuses before reading an oversized body.
        if len(body) > MAX_BODY_BYTES:
            return _error(413, "body_too_large")

        try:
            tenant_id = self._auth.authenticate(method, raw_target, headers, body)
        except AuthError:
            self._logger.log("auth.failed", method=method)
            return _error(401, "authentication_failed")

        try:
            path = urlsplit(raw_target).path
        except ValueError:
            return _error(404, "not_found")

        try:
            if path == "/v1/events":
                if method != "POST":
                    return _error(405, "method_not_allowed")
                return self._create_event(tenant_id, headers, body)
            match = _JOB_PATH_RE.fullmatch(path)
            if match is not None:
                if method != "GET":
                    return _error(405, "method_not_allowed")
                return self._get_job(tenant_id, unquote(match.group(1)))
            return _error(404, "not_found")
        except _BadRequest as exc:
            return _error(exc.status, exc.code)
        except Exception:
            # Never leak stack traces or SQL text.
            self._logger.log("request.internal_error", path="/v1")
            return _error(500, "internal_error")

    # ------------------------------------------------------------------

    def _create_event(self, tenant_id: str, headers, body: bytes) -> Response:
        self._check_content_headers(headers)
        idem_key = _single_header(headers, "Idempotency-Key")
        if idem_key is None or _IDEMPOTENCY_KEY_RE.fullmatch(idem_key) is None:
            raise _BadRequest(400, "invalid_idempotency_key")

        document = _parse_strict_json(body)
        if not isinstance(document, dict):
            raise _BadRequest(400, "invalid_body")
        unknown = set(document) - set(_REQUIRED_FIELDS)
        if unknown or set(_REQUIRED_FIELDS) - set(document):
            raise _BadRequest(400, "invalid_body")

        event_id = document["event_id"]
        event_type = document["type"]
        callback_url = document["callback_url"]
        payload = document["payload"]
        if not isinstance(event_id, str) or _EVENT_ID_RE.fullmatch(event_id) is None:
            raise _BadRequest(400, "invalid_event_id")
        if (
            not isinstance(event_type, str)
            or _EVENT_TYPE_RE.fullmatch(event_type) is None
        ):
            raise _BadRequest(400, "invalid_type")
        if not isinstance(payload, dict):
            raise _BadRequest(400, "invalid_payload")

        try:
            parsed = validate_callback_url(callback_url)
            resolve_and_validate(parsed.hostname, self._resolver)
        except CallbackURLError:
            # Generic: never reveal resolved addresses or the failing check.
            raise _BadRequest(422, "invalid_callback_url") from None

        now = int(self._clock())
        outcome, job = self._store.create_event_job(
            tenant_id=tenant_id,
            endpoint=_EVENTS_ENDPOINT,
            idempotency_key=idem_key,
            body_hash=hashlib.sha256(body).hexdigest(),
            job_id=self._id_factory(),
            event_id=event_id,
            event_type=event_type,
            callback_url=callback_url,
            payload_json=json.dumps(payload, separators=(",", ":"), sort_keys=True),
            now=now,
        )
        if outcome == "created":
            self._logger.log(
                "event.accepted",
                tenant_id=tenant_id,
                job_id=job["job_id"],
                event_type=event_type,
            )
            return _json_response(202, self._job_view(job))
        if outcome == "duplicate":
            view = self._job_view(job)
            view["duplicate"] = True
            return _json_response(200, view)
        if outcome == "idempotency_conflict":
            return _error(409, "idempotency_conflict")
        return _error(409, "event_id_conflict")

    def _get_job(self, tenant_id: str, job_id: str) -> Response:
        job = self._store.get_job(tenant_id, job_id)
        if job is None:
            # Identical response for "missing" and "someone else's job".
            return _error(404, "not_found")
        return _json_response(200, self._job_view(job))

    @staticmethod
    def _check_content_headers(headers) -> None:
        encoding = _single_header(headers, "Content-Encoding")
        if encoding is not None and encoding.lower() != "identity":
            raise _BadRequest(415, "unsupported_content_encoding")
        content_type = _single_header(headers, "Content-Type")
        if content_type is None:
            raise _BadRequest(415, "unsupported_content_type")
        media_type, _, params = content_type.partition(";")
        if media_type.strip().lower() != "application/json":
            raise _BadRequest(415, "unsupported_content_type")
        for param in params.split(";"):
            param = param.strip().lower()
            if param and param not in ("charset=utf-8", 'charset="utf-8"'):
                raise _BadRequest(415, "unsupported_content_type")

    @staticmethod
    def _job_view(job: dict) -> dict:
        return {
            "job_id": job["job_id"],
            "event_id": job["event_id"],
            "type": job["event_type"],
            "callback_url": job["callback_url"],
            "status": job["status"],
            "attempts": job["attempts"],
            "next_attempt_at": job["next_attempt_at"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
        }


# ---------------------------------------------------------------------------
# Minimal ThreadingHTTPServer adapter
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "RelayVault"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def _dispatch(self) -> None:
        application = self.server.application  # type: ignore[attr-defined]
        headers = list(self.headers.items())
        if self.headers.get("Transfer-Encoding") is not None:
            self._respond(_error(411, "length_required"))
            return
        try:
            length = body_length_from_headers(headers)
        except _BadRequest as exc:
            self._respond(_error(exc.status, exc.code))
            return
        # Enforce the limit BEFORE reading the complete body.
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._respond(_error(413, "body_too_large"))
            return
        body = self.rfile.read(length) if length else b""
        response = application.handle(self.command, self.path, headers, body)
        self._respond(response)

    def _respond(self, response: Response) -> None:
        self.send_response(response.status)
        names = {name.lower() for name, _ in response.headers}
        for name, value in response.headers:
            self.send_header(name, value)
        if "content-length" not in names:
            self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        self.wfile.write(response.body)

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_PATCH = _dispatch

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        # Silence the default request logging (may echo raw targets).
        pass


def make_server(application: Application, host: str = "127.0.0.1", port: int = 0):
    """Build (but do not start) a ThreadingHTTPServer bound to ``application``."""
    server = ThreadingHTTPServer((host, port), _Handler)
    server.application = application  # type: ignore[attr-defined]
    return server


if __name__ == "__main__":  # pragma: no cover - manual smoke entry point
    # Secrets are injected via the environment; nothing is hard-coded.
    # RELAYVAULT_KEYS_JSON = {"tenant:key": "hex-or-plain-secret", ...}
    import os
    import socket
    import sys
    import time as _time

    from store import Store

    raw_keys = os.environ.get("RELAYVAULT_KEYS_JSON")
    if not raw_keys:
        sys.exit("Set RELAYVAULT_KEYS_JSON to run the demo server.")
    keys = {
        tuple(name.split(":", 1)): value.encode("utf-8")
        for name, value in json.loads(raw_keys).items()
    }

    def _lookup(tenant, key_id):
        return keys.get((tenant, key_id))

    def _resolver(hostname):
        return [info[4][0] for info in socket.getaddrinfo(hostname, 443)]

    app = Application(
        store=Store(os.environ.get("RELAYVAULT_DB", "relayvault.sqlite3")),
        authenticator=Authenticator(_lookup, _time.time),
        resolver=_resolver,
        clock=_time.time,
    )
    make_server(app, port=int(os.environ.get("RELAYVAULT_PORT", "8443"))).serve_forever()
