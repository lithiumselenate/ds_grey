"""RelayVault application layer and HTTP adapter.

``Application.handle(method, raw_target, headers, body) -> Response`` is
transport independent and is what the tests drive directly.  The
``ThreadingHTTPServer`` adapter at the bottom of this module only moves bytes
and enforces the body-size limit *before* the full body is read.

Endpoints
---------
``POST /v1/events``        enqueue a webhook delivery job (idempotent)
``GET  /v1/jobs/{job_id}`` tenant-scoped job status

Both use the signed-request scheme implemented in :mod:`security`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets as _secrets
import sys
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import unquote

from security import (
    AuthError,
    Headers,
    HeaderError,
    RequestVerifier,
    StaticSecretProvider,
    SystemResolver,
    UrlValidationError,
    redact,
    validate_callback_url,
)
from store import IdempotentResult, Store

MAX_BODY_BYTES = 65536
EVENTS_ENDPOINT = "POST /v1/events"

_EVENT_ID_RE = re.compile(r"\A[A-Za-z0-9_\-]{1,64}\Z")
_EVENT_TYPE_RE = re.compile(r"\A[a-z0-9._\-]{1,80}\Z")
_IDEMPOTENCY_KEY_RE = re.compile(r"\A[A-Za-z0-9_\-]{8,80}\Z")
_JOB_ID_RE = re.compile(r"\A[A-Za-z0-9_\-]{1,80}\Z")
_CONTENT_LENGTH_RE = re.compile(r"\A(?:0|[1-9][0-9]{0,12})\Z")
_METHOD_RE = re.compile(r"\A[A-Z]{3,10}\Z")
_RAW_TARGET_RE = re.compile(r"\A/[!-~]*\Z")

_EVENT_FIELDS = ("event_id", "type", "callback_url", "payload")


# --------------------------------------------------------------------------
# Response plumbing
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


def _render(status: int, document: Mapping[str, Any]) -> Response:
    body = json.dumps(
        document, separators=(",", ":"), allow_nan=False, ensure_ascii=False
    ).encode("utf-8")
    headers = (
        ("Content-Type", "application/json"),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
    )
    return Response(status=status, headers=headers, body=body)


def ok_response(status: int, data: Mapping[str, Any]) -> Response:
    return _render(status, {"ok": True, "data": dict(data)})


def error_response(status: int, code: str, message: str) -> Response:
    """Errors carry only a stable code plus a short static message.

    Never a stack trace, SQL text, secret, resolved address or any hint about
    tenant/route existence.
    """
    return _render(status, {"ok": False, "error": {"code": code, "message": message}})


class RequestError(Exception):
    def __init__(self, status: int, code: str, message: str, *, detail: str = "") -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail or code


# --------------------------------------------------------------------------
# Strict JSON parsing
# --------------------------------------------------------------------------


def _reject_duplicate_keys(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise RequestError(
                400, "invalid_json", "duplicate object key", detail="duplicate_json_key"
            )
        seen.add(key)
    return dict(pairs)


def _reject_constant(name: str) -> Any:
    raise RequestError(
        400, "invalid_json", "non-finite number", detail="non_finite_number"
    )


def _parse_float(text: str) -> float:
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise RequestError(
            400, "invalid_json", "non-finite number", detail="non_finite_number"
        )
    return value


def parse_json_object(raw: bytes) -> dict[str, Any]:
    """Parse a JSON object with hostile input rejected up front."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RequestError(
            400, "invalid_body", "body is not valid UTF-8", detail="invalid_utf8"
        ) from None
    if not text.strip():
        raise RequestError(400, "invalid_body", "empty body", detail="empty_body")
    try:
        document = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
            parse_float=_parse_float,
        )
    except RequestError:
        raise
    except (json.JSONDecodeError, ValueError, RecursionError):
        raise RequestError(
            400, "invalid_json", "malformed JSON", detail="malformed_json"
        ) from None
    if not isinstance(document, dict):
        raise RequestError(
            400, "invalid_json", "body must be a JSON object", detail="not_an_object"
        )
    return document


# --------------------------------------------------------------------------
# Adapter-side envelope planning (tested without sockets)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class BodyPlan:
    length: int = 0
    error: Response | None = None


def plan_body_read(
    method: str, headers: Headers, *, max_body_bytes: int = MAX_BODY_BYTES
) -> BodyPlan:
    """Decide how many body bytes may be read, before reading any of them."""
    if not isinstance(headers, Headers):
        headers = Headers(headers)
    if headers.count("Transfer-Encoding"):
        return BodyPlan(
            error=error_response(
                501, "unsupported_transfer_encoding", "transfer-encoding unsupported"
            )
        )
    raw_values = headers.get_all("Content-Length")
    if len(raw_values) > 1:
        return BodyPlan(
            error=error_response(400, "bad_request", "ambiguous content-length")
        )
    if not raw_values:
        if method.upper() in ("POST", "PUT", "PATCH"):
            return BodyPlan(
                error=error_response(411, "length_required", "content-length required")
            )
        return BodyPlan(length=0)
    value = raw_values[0].strip()
    if not _CONTENT_LENGTH_RE.match(value):
        return BodyPlan(
            error=error_response(400, "bad_request", "invalid content-length")
        )
    length = int(value)
    if length > max_body_bytes:
        return BodyPlan(
            error=error_response(413, "payload_too_large", "body too large")
        )
    return BodyPlan(length=length)


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RouteMatch:
    name: str
    params: dict[str, str] = field(default_factory=dict)


class Application:
    def __init__(
        self,
        *,
        store: Store,
        verifier: RequestVerifier,
        clock: Callable[[], float],
        resolver: Callable[[str], Sequence[str]],
        id_factory: Callable[[], str] | None = None,
        log: Callable[[str, Mapping[str, Any]], None] | None = None,
        max_body_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self._store = store
        self._verifier = verifier
        self._clock = clock
        self._resolver = resolver
        self._id_factory = id_factory or (lambda: "job_" + _secrets.token_hex(16))
        self._log = log or (lambda event, fields: None)
        self.max_body_bytes = int(max_body_bytes)

    # -- logging ---------------------------------------------------------
    def _emit(self, event: str, **fields: Any) -> None:
        try:
            self._log(event, redact(fields))
        except Exception:
            pass

    # -- entry point -----------------------------------------------------
    def handle(
        self,
        method: str,
        raw_target: str,
        headers: "Mapping[str, str] | Sequence[tuple[str, str]] | Headers",
        body: bytes,
    ) -> Response:
        header_view = headers if isinstance(headers, Headers) else Headers(headers)
        body = bytes(body or b"")
        method_upper = str(method).upper()

        try:
            if not _METHOD_RE.match(method_upper):
                raise RequestError(400, "bad_request", "invalid method")
            if not _RAW_TARGET_RE.match(raw_target):
                raise RequestError(400, "bad_request", "invalid request target")
            if len(body) > self.max_body_bytes:
                raise RequestError(413, "payload_too_large", "body too large")

            route = self._route(raw_target)

            # Authentication happens before routing decisions are revealed,
            # so unknown routes cannot be probed anonymously.
            principal = self._verifier.verify(
                method_upper, raw_target, header_view, body
            )

            if route is None:
                raise RequestError(404, "not_found", "resource not found")
            if route.name == "events":
                if method_upper != "POST":
                    raise RequestError(405, "method_not_allowed", "method not allowed")
                return self._create_event(principal, header_view, body)
            if route.name == "job":
                if method_upper != "GET":
                    raise RequestError(405, "method_not_allowed", "method not allowed")
                return self._get_job(principal, header_view, body, route.params["job_id"])
            raise RequestError(404, "not_found", "resource not found")
        except AuthError as exc:
            self._emit("auth.rejected", reason=exc.reason, method=method_upper)
            return error_response(401, exc.public_code, exc.public_message)
        except RequestError as exc:
            self._emit(
                "request.rejected", code=exc.code, detail=exc.detail,
                status=exc.status, method=method_upper,
            )
            return error_response(exc.status, exc.code, exc.message)
        except Exception:
            # No traceback, no SQL text, no internals.
            self._emit("request.internal_error", method=method_upper)
            return error_response(500, "internal_error", "internal error")

    # -- routing ---------------------------------------------------------
    def _route(self, raw_target: str) -> RouteMatch | None:
        """Route on a *separately* decoded path.

        The signed value (``raw_target``) is never rewritten.  Percent
        decoding that would introduce a path separator or a control character
        is rejected instead of silently changing the routed value.
        """
        path, _, _query = raw_target.partition("?")
        try:
            decoded = unquote(path, errors="strict")
        except UnicodeDecodeError:
            raise RequestError(400, "bad_request", "invalid request target") from None
        if decoded.count("/") != path.count("/"):
            raise RequestError(400, "bad_request", "invalid request target")
        if any(not ch.isprintable() for ch in decoded):
            raise RequestError(400, "bad_request", "invalid request target")

        if decoded == "/v1/events":
            return RouteMatch("events")
        prefix = "/v1/jobs/"
        if decoded.startswith(prefix):
            job_id = decoded[len(prefix):]
            if job_id and "/" not in job_id:
                return RouteMatch("job", {"job_id": job_id})
        return None

    # -- POST /v1/events -------------------------------------------------
    def _create_event(
        self, principal: Any, headers: Headers, body: bytes
    ) -> Response:
        self._require_json_content(headers)
        try:
            idem_key = headers.unique("Idempotency-Key", required=True)
        except HeaderError as exc:
            raise RequestError(
                400, "invalid_idempotency_key", "invalid Idempotency-Key",
                detail=exc.reason,
            ) from None
        if not _IDEMPOTENCY_KEY_RE.match(idem_key or ""):
            raise RequestError(
                400, "invalid_idempotency_key", "invalid Idempotency-Key"
            )

        document = parse_json_object(body)
        unknown = sorted(set(document) - set(_EVENT_FIELDS))
        if unknown:
            raise RequestError(
                400, "unknown_field", "unknown top-level field",
                detail="unknown_field",
            )
        missing = [name for name in _EVENT_FIELDS if name not in document]
        if missing:
            raise RequestError(400, "missing_field", "missing required field")

        event_id = document["event_id"]
        event_type = document["type"]
        callback_url = document["callback_url"]
        payload = document["payload"]

        if not isinstance(event_id, str) or not _EVENT_ID_RE.match(event_id):
            raise RequestError(400, "invalid_field", "invalid event_id")
        if not isinstance(event_type, str) or not _EVENT_TYPE_RE.match(event_type):
            raise RequestError(400, "invalid_field", "invalid type")
        if not isinstance(callback_url, str):
            raise RequestError(400, "invalid_field", "invalid callback_url")
        if not isinstance(payload, dict):
            raise RequestError(400, "invalid_field", "payload must be an object")

        try:
            validate_callback_url(callback_url, self._resolver)
        except UrlValidationError as exc:
            # Generic message: the reason (e.g. which address class) stays in
            # the internal log only.
            self._emit(
                "callback.rejected", reason=exc.reason, tenant_id=principal.tenant_id
            )
            raise RequestError(
                400, "invalid_callback_url", "callback_url rejected",
                detail=exc.reason,
            ) from None
        except Exception:
            raise RequestError(
                400, "invalid_callback_url", "callback_url rejected",
                detail="resolver_error",
            ) from None

        payload_json = json.dumps(
            payload, separators=(",", ":"), sort_keys=True, allow_nan=False,
            ensure_ascii=False,
        )
        body_sha256 = hashlib.sha256(body).hexdigest()
        now = int(self._clock())

        result: IdempotentResult = self._store.create_or_get_job(
            tenant_id=principal.tenant_id,
            endpoint=EVENTS_ENDPOINT,
            idem_key=idem_key,
            body_sha256=body_sha256,
            job_id=self._id_factory(),
            event_id=event_id,
            event_type=event_type,
            callback_url=callback_url,
            payload_json=payload_json,
            now=now,
        )

        if result.conflict == "idempotency_key_reuse":
            self._emit(
                "event.idempotency_conflict", tenant_id=principal.tenant_id,
                event_id=event_id,
            )
            raise RequestError(
                409, "idempotency_key_reuse",
                "Idempotency-Key already used with a different body",
            )
        if result.conflict == "event_id_conflict":
            self._emit(
                "event.event_id_conflict", tenant_id=principal.tenant_id,
                event_id=event_id,
            )
            raise RequestError(
                409, "event_id_conflict", "event_id already exists for this tenant"
            )
        if result.job is None:
            raise RequestError(500, "internal_error", "internal error")

        document_out = dict(result.job.public_dict())
        document_out["duplicate"] = not result.created
        if result.created:
            self._emit(
                "event.accepted", tenant_id=principal.tenant_id,
                job_id=result.job.id, event_id=event_id, event_type=event_type,
                callback_host=_host_of(callback_url),
            )
            return ok_response(202, document_out)
        self._emit(
            "event.duplicate", tenant_id=principal.tenant_id, job_id=result.job.id,
            event_id=event_id,
        )
        return ok_response(200, document_out)

    # -- GET /v1/jobs/{job_id} -------------------------------------------
    def _get_job(
        self, principal: Any, headers: Headers, body: bytes, job_id: str
    ) -> Response:
        if body:
            raise RequestError(400, "bad_request", "body not allowed")
        try:
            if headers.unique("Content-Type") is not None:
                raise RequestError(400, "bad_request", "body not allowed")
        except HeaderError:
            raise RequestError(400, "bad_request", "ambiguous headers") from None
        # Hostile job ids are simply values: the query is parameterized and a
        # syntactically impossible id can only ever be "not found".
        if not _JOB_ID_RE.match(job_id):
            self._emit("job.lookup_rejected", tenant_id=principal.tenant_id)
            return error_response(404, "not_found", "resource not found")
        job = self._store.get_job(job_id, principal.tenant_id)
        if job is None:
            # Identical response for "missing" and "belongs to another tenant".
            self._emit("job.not_found", tenant_id=principal.tenant_id)
            return error_response(404, "not_found", "resource not found")
        self._emit("job.read", tenant_id=principal.tenant_id, job_id=job.id)
        return ok_response(200, job.public_dict())

    # -- helpers ---------------------------------------------------------
    def _require_json_content(self, headers: Headers) -> None:
        try:
            content_type = headers.unique("Content-Type", required=True)
            encoding = headers.unique("Content-Encoding")
        except HeaderError as exc:
            raise RequestError(
                415, "unsupported_media_type", "unsupported media type",
                detail=exc.reason,
            ) from None
        if encoding is not None and encoding.lower() != "identity":
            raise RequestError(
                415, "unsupported_media_type", "content-encoding unsupported"
            )
        parts = [piece.strip() for piece in (content_type or "").split(";")]
        if parts[0].lower() != "application/json":
            raise RequestError(
                415, "unsupported_media_type", "unsupported media type"
            )
        for parameter in parts[1:]:
            if not parameter:
                continue
            name, _, value = parameter.partition("=")
            if name.strip().lower() != "charset" or value.strip().strip('"').lower() \
                    not in ("utf-8", "utf8"):
                raise RequestError(
                    415, "unsupported_media_type", "unsupported charset"
                )


def _host_of(url: str) -> str:
    from urllib.parse import urlsplit

    try:
        return urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


# --------------------------------------------------------------------------
# HTTP adapter
# --------------------------------------------------------------------------


class RelayVaultHandler(BaseHTTPRequestHandler):
    """Minimal adapter: size guard, byte shuffling, no business logic."""

    protocol_version = "HTTP/1.1"
    server_version = "RelayVault"
    sys_version = ""

    @property
    def application(self) -> Application:
        return self.server.application  # type: ignore[attr-defined]

    def _write(self, response: Response) -> None:
        self.send_response(response.status)
        for name, value in response.headers:
            self.send_header(name, value)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response.body)

    def _dispatch(self) -> None:
        app = self.application
        headers = Headers(self.headers.items())
        plan = plan_body_read(
            self.command, headers, max_body_bytes=app.max_body_bytes
        )
        if plan.error is not None:
            # Refuse before reading the body at all.
            self.close_connection = True
            self._write(plan.error)
            return
        body = b""
        if plan.length:
            body = self.rfile.read(plan.length)
            if len(body) != plan.length:
                self.close_connection = True
                self._write(error_response(400, "bad_request", "truncated body"))
                return
        self._write(app.handle(self.command, self.path, headers, body))

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        self.application._emit("http.request", line=format % args)


class RelayVaultServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], application: Application) -> None:
        self.application = application
        super().__init__(address, RelayVaultHandler)


def build_application(
    *,
    db_path: str,
    secrets: Mapping[tuple[str, str], bytes | str],
    clock: Callable[[], float],
    resolver: Callable[[str], Sequence[str]],
    id_factory: Callable[[], str] | None = None,
    log: Callable[[str, Mapping[str, Any]], None] | None = None,
    max_body_bytes: int = MAX_BODY_BYTES,
    store: Store | None = None,
) -> Application:
    """Wire the object graph.  All secrets arrive through ``secrets``."""
    store = store or Store(db_path, clock=clock)
    verifier = RequestVerifier(
        StaticSecretProvider(secrets), store, clock
    )
    return Application(
        store=store, verifier=verifier, clock=clock, resolver=resolver,
        id_factory=id_factory, log=log, max_body_bytes=max_body_bytes,
    )


def _stderr_log(event: str, fields: Mapping[str, Any]) -> None:
    sys.stderr.write(
        json.dumps({"event": event, **dict(fields)}, separators=(",", ":"),
                   default=str) + "\n"
    )


def _secrets_from_env(raw: str | None) -> dict[tuple[str, str], bytes]:
    """Load injected configuration: ``[{tenant_id, key_id, secret}, ...]``.

    No secret is ever hard-coded; an empty configuration yields a service
    that authenticates nobody.
    """
    if not raw:
        return {}
    table: dict[tuple[str, str], bytes] = {}
    for entry in json.loads(raw):
        table[(str(entry["tenant_id"]), str(entry["key_id"]))] = str(
            entry["secret"]
        ).encode("utf-8")
    return table


def main(argv: Sequence[str] | None = None) -> int:
    import time

    argv = list(argv if argv is not None else sys.argv[1:])
    host = os.environ.get("RELAYVAULT_HOST", "127.0.0.1")
    port = int(os.environ.get("RELAYVAULT_PORT", "8080"))
    db_path = os.environ.get("RELAYVAULT_DB", "relayvault.sqlite3")
    application = build_application(
        db_path=db_path,
        secrets=_secrets_from_env(os.environ.get("RELAYVAULT_SECRETS")),
        clock=time.time,
        resolver=SystemResolver(),
        log=_stderr_log,
    )
    server = RelayVaultServer((host, port), application)
    _stderr_log("service.start", {"host": host, "port": port})
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
