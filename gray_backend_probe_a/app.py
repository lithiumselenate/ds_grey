"""RelayVault application layer and its ThreadingHTTPServer adapter.

The application is transport independent::

    Application.handle(method, raw_target, headers, body) -> Response

The HTTP adapter's only jobs are to enforce the body-size limit *before* the
body is read, hand the raw request target through untouched, and serialise the
returned :class:`Response`.  Every test drives :meth:`Application.handle` (or
the handler with in-memory buffers), so no socket is ever created.

Endpoints
---------
``POST /v1/events``       create a delivery job (idempotent, 202 / 200 / 409)
``GET  /v1/jobs/{job_id}`` tenant-scoped job status (404 when not yours)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets as _secrets
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import unquote

from security import (
    AuthError,
    CallbackUrlError,
    Config,
    Principal,
    RequestError,
    JsonLogger,
    SystemResolver,
    normalize_headers,
    null_log,
    validate_callback_url,
    verify_request,
)
from store import (
    EventIdConflict,
    IdempotencyConflict,
    SqliteNonceStore,
    Store,
)

__all__ = [
    "MAX_BODY_BYTES",
    "Response",
    "Application",
    "RelayVaultHTTPRequestHandler",
    "RelayVaultHTTPServer",
    "build_application",
    "load_config_from_env",
    "make_server",
    "main",
]

MAX_BODY_BYTES = 65_536
EVENTS_ENDPOINT = "POST /v1/events"

JSON_CONTENT_TYPE = "application/json"
_ALLOWED_CHARSETS = frozenset({"", "utf-8", "utf8"})

_EVENT_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
_EVENT_TYPE_RE = re.compile(r"\A[a-z0-9._-]{1,80}\Z")
_IDEM_KEY_RE = re.compile(r"\A[A-Za-z0-9_-]{8,80}\Z")

_EVENT_FIELDS = frozenset({"event_id", "type", "callback_url", "payload"})
_MAX_JOB_ID_LENGTH = 512


# --------------------------------------------------------------------------- #
# responses
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    @property
    def content_type(self) -> str:
        for name, value in self.headers:
            if name.lower() == "content-type":
                return value
        return ""


def _render(status: int, document: Mapping[str, Any], extra: Sequence[tuple[str, str]] = ()) -> Response:
    body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
    headers = [
        ("Content-Type", JSON_CONTENT_TYPE),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ]
    headers.extend(extra)
    return Response(status=int(status), headers=tuple(headers), body=body)


def ok_response(status: int, data: Mapping[str, Any]) -> Response:
    return _render(status, {"ok": True, "data": dict(data)})


def error_response(
    status: int, code: str, message: str, extra: Sequence[tuple[str, str]] = ()
) -> Response:
    """Errors carry only a stable code and a short generic message."""

    return _render(status, {"ok": False, "error": {"code": str(code), "message": str(message)}}, extra)


# --------------------------------------------------------------------------- #
# JSON parsing policy
# --------------------------------------------------------------------------- #


class _JsonPolicyError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _object_pairs_hook(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    seen: set[str] = set()
    for key, _value in pairs:
        if key in seen:
            # Called for every object, so nested duplicates are caught too.
            raise _JsonPolicyError("duplicate_json_key")
        seen.add(key)
    return dict(pairs)


def _parse_float(text: str) -> float:
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise _JsonPolicyError("non_finite_number")
    return value


def _parse_int(text: str) -> int:
    if len(text.lstrip("-")) > 40:
        raise _JsonPolicyError("number_out_of_range")
    return int(text)


def _parse_constant(name: str) -> Any:
    # json only calls this for NaN / Infinity / -Infinity.
    raise _JsonPolicyError("non_finite_number")


def parse_json_object(raw: bytes) -> dict[str, Any]:
    if not raw:
        raise RequestError(400, "empty_body", "a JSON object body is required")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RequestError(400, "invalid_encoding", "body must be valid UTF-8") from None
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs_hook,
            parse_float=_parse_float,
            parse_int=_parse_int,
            parse_constant=_parse_constant,
        )
    except _JsonPolicyError as exc:
        raise RequestError(400, exc.code, "body rejected by JSON policy") from None
    except RecursionError:
        raise RequestError(400, "json_too_deep", "body nesting is too deep") from None
    except ValueError:
        raise RequestError(400, "invalid_json", "body is not valid JSON") from None
    if not isinstance(value, dict):
        raise RequestError(400, "body_not_object", "body must be a JSON object")
    return value


# --------------------------------------------------------------------------- #
# target parsing
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ParsedTarget:
    raw_target: str      # exactly what arrived on the wire; the signed value
    raw_path: str
    query: str
    decoded_path: str    # used for routing only
    segments: tuple[str, ...]


def parse_target(raw_target: str) -> ParsedTarget:
    """Split a request target for routing without altering the signed value.

    The signature always covers ``raw_target`` verbatim.  Percent-decoding is
    performed for routing only, and any encoding that could change the routed
    shape (encoded separators, NUL, traversal, control characters) is rejected
    rather than silently normalised.
    """

    if not isinstance(raw_target, str) or not raw_target.startswith("/"):
        raise RequestError(400, "invalid_target", "request target is not acceptable")
    if len(raw_target) > 2048:
        raise RequestError(414, "target_too_long", "request target is too long")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in raw_target):
        raise RequestError(400, "invalid_target", "request target is not acceptable")

    raw_path, _, query = raw_target.partition("?")
    lowered = raw_path.lower()
    if "%2f" in lowered or "%00" in lowered or "%25" in lowered:
        raise RequestError(400, "encoded_separator", "request target is not acceptable")
    try:
        decoded_path = unquote(raw_path, encoding="utf-8", errors="strict")
    except UnicodeDecodeError:
        raise RequestError(400, "invalid_percent_encoding", "request target is not acceptable") from None
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded_path):
        raise RequestError(400, "invalid_target", "request target is not acceptable")
    if "//" in decoded_path or "/./" in decoded_path or "/../" in decoded_path:
        raise RequestError(400, "invalid_target", "request target is not acceptable")
    if decoded_path.endswith(("/.", "/..")):
        raise RequestError(400, "invalid_target", "request target is not acceptable")

    segments = tuple(s for s in decoded_path.split("/") if s != "")
    return ParsedTarget(
        raw_target=raw_target,
        raw_path=raw_path,
        query=query,
        decoded_path=decoded_path,
        segments=segments,
    )


# --------------------------------------------------------------------------- #
# application
# --------------------------------------------------------------------------- #


def default_id_factory() -> str:
    return "job_" + _secrets.token_hex(16)


class Application:
    """Transport-independent RelayVault API."""

    def __init__(
        self,
        *,
        config: Config,
        store: Store,
        nonce_store: Any,
        clock: Callable[[], int],
        resolver: Callable[[str], Sequence[str]],
        id_factory: Callable[[], str] = default_id_factory,
        monotonic: Callable[[], float] = time.monotonic,
        log: Callable[..., None] = null_log,
        max_body_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self.config = config
        self.store = store
        self.nonce_store = nonce_store
        self.clock = clock
        self.monotonic = monotonic
        self.resolver = resolver
        self.id_factory = id_factory
        self.log = log
        self.max_body_bytes = int(max_body_bytes)
        self.store.ensure_tenants(config.tenant_ids(), now=int(clock()))

    # -- entry point ----------------------------------------------------- #

    def handle(self, method: str, raw_target: str, headers: Any, body: bytes) -> Response:
        method = str(method or "").upper()
        body = b"" if body is None else bytes(body)
        try:
            if len(body) > self.max_body_bytes:
                raise RequestError(413, "payload_too_large", "request body is too large")
            target = parse_target(raw_target)
            return self._route(method, target, headers, body)
        except AuthError as exc:
            self.log("auth.rejected", method=method, reason=exc.reason)
            return error_response(exc.status, exc.code, exc.message)
        except RequestError as exc:
            self.log("request.rejected", method=method, code=exc.code, reason=exc.reason)
            return error_response(exc.status, exc.code, exc.message)
        except Exception as exc:  # never leak a traceback, SQL text or message
            self.log("request.error", method=method, exc_type=type(exc).__name__)
            return error_response(500, "internal_error", "internal error")

    def _route(self, method: str, target: ParsedTarget, headers: Any, body: bytes) -> Response:
        segments = target.segments
        if segments == ("v1", "events"):
            if method != "POST":
                return error_response(
                    405, "method_not_allowed", "method not allowed", (("Allow", "POST"),)
                )
            return self._create_event(method, target, headers, body)
        if len(segments) == 3 and segments[0] == "v1" and segments[1] == "jobs":
            if method != "GET":
                return error_response(
                    405, "method_not_allowed", "method not allowed", (("Allow", "GET"),)
                )
            return self._get_job(method, target, headers, body, segments[2])
        return error_response(404, "not_found", "resource not found")

    # -- authentication -------------------------------------------------- #

    def _authenticate(self, method: str, target: ParsedTarget, headers: Any, body: bytes) -> Principal:
        return verify_request(
            method=method,
            raw_target=target.raw_target,  # verbatim wire value
            headers=headers,
            body=body,
            config=self.config,
            clock=self.clock,
            nonce_store=self.nonce_store,
            log=self.log,
        )

    # -- POST /v1/events ------------------------------------------------- #

    def _create_event(self, method: str, target: ParsedTarget, headers: Any, body: bytes) -> Response:
        normalized = normalize_headers(headers)
        principal = self._authenticate(method, target, headers, body)

        self._check_content_headers(normalized)
        idem_key = normalized.get("idempotency-key", "")
        if not _IDEM_KEY_RE.match(idem_key):
            raise RequestError(
                400, "invalid_idempotency_key", "Idempotency-Key is missing or malformed"
            )

        document = parse_json_object(body)
        event_id, event_type, callback_url, payload = self._validate_event(document)

        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
        request_sha256 = hashlib.sha256(body).hexdigest()
        now = int(self.clock())

        try:
            job, created = self.store.create_job_idempotent(
                tenant_id=principal.tenant_id,
                endpoint=EVENTS_ENDPOINT,
                idem_key=idem_key,
                request_sha256=request_sha256,
                job_id=str(self.id_factory()),
                event_id=event_id,
                event_type=event_type,
                callback_url=callback_url,
                payload_json=payload_json,
                now=now,
            )
        except IdempotencyConflict:
            self.log(
                "events.idempotency_conflict",
                tenant_id=principal.tenant_id,
                idempotency_key_present=True,
            )
            return error_response(
                409,
                "idempotency_conflict",
                "Idempotency-Key was already used with a different body",
            )
        except EventIdConflict:
            self.log("events.event_id_conflict", tenant_id=principal.tenant_id, event_id=event_id)
            return error_response(
                409, "event_id_conflict", "event_id already exists for this tenant"
            )

        self.log(
            "events.created" if created else "events.duplicate",
            tenant_id=principal.tenant_id,
            job_id=job.job_id,
            event_id=job.event_id,
            event_type=job.event_type,
            payload_bytes=job.payload_bytes,
        )
        data = job.public_dict()
        data["duplicate"] = not created
        return ok_response(202 if created else 200, data)

    def _check_content_headers(self, normalized: Mapping[str, str]) -> None:
        encoding = normalized.get("content-encoding", "").lower()
        if encoding and encoding != "identity":
            raise RequestError(
                415, "unsupported_content_encoding", "content encoding is not supported"
            )
        content_type = normalized.get("content-type", "")
        if not content_type:
            raise RequestError(415, "unsupported_media_type", "content type must be application/json")
        pieces = [p.strip() for p in content_type.split(";")]
        if pieces[0].lower() != JSON_CONTENT_TYPE:
            raise RequestError(415, "unsupported_media_type", "content type must be application/json")
        for parameter in pieces[1:]:
            if not parameter:
                continue
            name, _, value = parameter.partition("=")
            if name.strip().lower() != "charset":
                raise RequestError(
                    415, "unsupported_media_type", "content type must be application/json"
                )
            if value.strip().strip('"').lower() not in _ALLOWED_CHARSETS:
                raise RequestError(
                    415, "unsupported_media_type", "content type must be application/json"
                )

    def _validate_event(self, document: Mapping[str, Any]) -> tuple[str, str, str, dict[str, Any]]:
        unknown = sorted(set(document) - _EVENT_FIELDS)
        if unknown:
            raise RequestError(400, "unknown_field", "body contains unknown fields")
        missing = sorted(_EVENT_FIELDS - set(document))
        if missing:
            raise RequestError(400, "missing_field", "body is missing required fields")

        event_id = document["event_id"]
        event_type = document["type"]
        callback_url = document["callback_url"]
        payload = document["payload"]

        if not isinstance(event_id, str) or not _EVENT_ID_RE.match(event_id):
            raise RequestError(400, "invalid_event_id", "event_id is not acceptable")
        if not isinstance(event_type, str) or not _EVENT_TYPE_RE.match(event_type):
            raise RequestError(400, "invalid_type", "type is not acceptable")
        if not isinstance(callback_url, str):
            raise RequestError(400, "invalid_callback_url", "callback_url is not acceptable")
        if not isinstance(payload, dict):
            raise RequestError(400, "invalid_payload", "payload must be a JSON object")

        try:
            target = validate_callback_url(callback_url, self.resolver)
        except CallbackUrlError as exc:
            # ``reason`` is logged (never an address); the client sees a generic code.
            self.log("callback_url.rejected", reason=exc.reason)
            raise
        return event_id, event_type, target.url, payload

    # -- GET /v1/jobs/{job_id} ------------------------------------------- #

    def _get_job(
        self, method: str, target: ParsedTarget, headers: Any, body: bytes, job_id: str
    ) -> Response:
        if body:
            raise RequestError(400, "unexpected_body", "this endpoint takes no body")
        principal = self._authenticate(method, target, headers, body)

        if len(job_id) > _MAX_JOB_ID_LENGTH:
            return error_response(404, "not_found", "resource not found")
        # ``job_id`` is hostile input: it is only ever a bound SQL parameter and
        # is scoped to the authenticated tenant.  A missing job and another
        # tenant's job are indistinguishable.
        job = self.store.get_job(principal.tenant_id, job_id)
        if job is None:
            self.log("jobs.not_found", tenant_id=principal.tenant_id)
            return error_response(404, "not_found", "resource not found")
        self.log("jobs.read", tenant_id=principal.tenant_id, job_id=job.job_id)
        return ok_response(200, job.public_dict())


# --------------------------------------------------------------------------- #
# HTTP adapter
# --------------------------------------------------------------------------- #


class RelayVaultHTTPRequestHandler(BaseHTTPRequestHandler):
    """Minimal HTTP/1.1 adapter around :meth:`Application.handle`."""

    protocol_version = "HTTP/1.1"
    server_version = "RelayVault"
    sys_version = ""
    max_body_bytes = MAX_BODY_BYTES

    # -- plumbing -------------------------------------------------------- #

    @property
    def application(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    @property
    def logger(self) -> Callable[..., None]:
        return getattr(self.server, "log", null_log)

    def log_message(self, fmt: str, *args: Any) -> None:  # never write to stderr
        return None

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        return None

    def log_error(self, fmt: str, *args: Any) -> None:
        return None

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """Emit JSON (never HTML with echoed request text) for adapter errors."""

        self.close_connection = True
        self._emit(error_response(int(code), "bad_request", "request could not be processed"))

    # -- verbs ----------------------------------------------------------- #

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def handle_expect_100(self) -> bool:
        declared = self._declared_length()
        if declared is None or declared > self.max_body_bytes:
            self.close_connection = True
            self._emit(error_response(413, "payload_too_large", "request body is too large"))
            return False
        return super().handle_expect_100()

    # -- core ------------------------------------------------------------ #

    def _declared_length(self) -> int | None:
        values = self.headers.get_all("content-length") or []
        if len(values) != 1:
            return None
        try:
            declared = int(str(values[0]).strip())
        except (TypeError, ValueError):
            return None
        return declared if declared >= 0 else None

    def _dispatch(self, method: str) -> None:
        if self.headers.get_all("transfer-encoding"):
            self.close_connection = True
            self._emit(
                error_response(
                    400, "unsupported_transfer_encoding", "transfer encodings are not supported"
                )
            )
            return

        body = b""
        if method in ("POST", "PUT", "PATCH"):
            values = self.headers.get_all("content-length") or []
            if len(values) != 1:
                self.close_connection = True
                self._emit(error_response(411, "length_required", "Content-Length is required"))
                return
            declared = self._declared_length()
            if declared is None:
                self.close_connection = True
                self._emit(error_response(400, "invalid_content_length", "Content-Length is invalid"))
                return
            # Enforced *before* the body is read, so an oversized upload is
            # never buffered or parsed.
            if declared > self.max_body_bytes:
                self.close_connection = True
                self._emit(error_response(413, "payload_too_large", "request body is too large"))
                return
            body = self._read_exactly(declared)
            if body is None:
                self.close_connection = True
                self._emit(error_response(400, "incomplete_body", "request body was truncated"))
                return

        try:
            response = self.application.handle(method, self.path, list(self.headers.items()), body)
        except Exception:  # pragma: no cover - Application.handle already guards
            response = error_response(500, "internal_error", "internal error")
        self._emit(response)

    def _read_exactly(self, count: int) -> bytes | None:
        remaining = int(count)
        chunks: list[bytes] = []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _emit(self, response: Response) -> None:
        self.send_response(response.status)
        for name, value in response.headers:
            self.send_header(name, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if getattr(self, "command", None) != "HEAD":
            self.wfile.write(response.body)
        try:
            self.wfile.flush()
        except (BrokenPipeError, ValueError):  # pragma: no cover - client vanished
            pass


class RelayVaultHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        application: Application,
        *,
        log: Callable[..., None] = null_log,
    ) -> None:
        self.application = application
        self.log = log
        super().__init__(server_address, RelayVaultHTTPRequestHandler)


# --------------------------------------------------------------------------- #
# composition helpers
# --------------------------------------------------------------------------- #


def _wall_clock() -> int:
    return int(time.time())


def build_application(
    *,
    db_path: str,
    config: Config,
    clock: Callable[[], int] = _wall_clock,
    monotonic: Callable[[], float] = time.monotonic,
    resolver: Callable[[str], Sequence[str]] | None = None,
    id_factory: Callable[[], str] = default_id_factory,
    log: Callable[..., None] = null_log,
) -> tuple[Application, Store]:
    """Wire a store, nonce store and application together."""

    store = Store(db_path)
    application = Application(
        config=config,
        store=store,
        nonce_store=SqliteNonceStore(store),
        clock=clock,
        monotonic=monotonic,
        resolver=resolver if resolver is not None else SystemResolver(),
        id_factory=id_factory,
        log=log,
    )
    return application, store


def load_config_from_env(environ: Mapping[str, str] | None = None) -> Config:
    """Load tenant secrets from the environment.

    ``RELAYVAULT_SECRETS_FILE`` points at a JSON document, or
    ``RELAYVAULT_SECRETS`` carries it inline::

        {"tenant_a": {"key_1": "<secret>"}}

    No secret is ever hard-coded; a missing configuration is a startup error.
    """

    environ = os.environ if environ is None else environ
    path = environ.get("RELAYVAULT_SECRETS_FILE")
    inline = environ.get("RELAYVAULT_SECRETS")
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    elif inline:
        document = json.loads(inline)
    else:
        raise RuntimeError(
            "set RELAYVAULT_SECRETS_FILE or RELAYVAULT_SECRETS; secrets are never built in"
        )
    if not isinstance(document, dict):
        raise RuntimeError("secret configuration must be a JSON object")
    return Config(document)


def make_server(
    host: str, port: int, *, db_path: str, config: Config, log: Callable[..., None] | None = None
) -> RelayVaultHTTPServer:
    logger = log if log is not None else JsonLogger(lambda line: print(line, file=sys.stderr))
    application, _store = build_application(db_path=db_path, config=config, log=logger)
    return RelayVaultHTTPServer((host, int(port)), application, log=logger)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - entry point
    argv = list(sys.argv[1:] if argv is None else argv)
    host = argv[0] if argv else "127.0.0.1"
    port = int(argv[1]) if len(argv) > 1 else 8080
    db_path = argv[2] if len(argv) > 2 else os.environ.get("RELAYVAULT_DB", "relayvault.sqlite3")
    config = load_config_from_env()
    server = make_server(host, port, db_path=db_path, config=config)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
