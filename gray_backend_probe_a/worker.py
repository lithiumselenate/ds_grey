"""Callback delivery and retry logic for RelayVault.

Every attempt re-validates the callback URL immediately before dialling, which
is the defence against DNS rebinding: a hostname that resolved to a global
address at enqueue time is resolved and judged again here, and the *validated
IP* is handed to the transport separately from the hostname.  The transport
therefore never resolves anything itself, while TLS/SNI and the HTTP ``Host``
header still carry the original hostname.

Redirects are never followed: a 3xx is a terminal outcome.

Failure classification (see :data:`CLASSIFICATIONS`)
---------------------------------------------------
============================  ==========  ===========================================
error code                    retryable   meaning
============================  ==========  ===========================================
``ok``                        n/a         HTTP 200-299
``http_retryable``            yes         HTTP 408, 429 or 500-599
``http_terminal``             no          any other status except 3xx
``redirect_not_followed``     no          HTTP 3xx; redirects are never followed
``callback_url_rejected``     no          resolver/URL validation refused the target
``timeout``                   yes         connect/read timeout from the transport
``transport_error``           yes         connection reset, TLS failure, etc.
``response_too_large``        no          more than 8192 bytes of response body
``internal_error``            yes         unexpected worker-side exception
============================  ==========  ===========================================

Only a status code, a byte count and an error code are persisted.  Response
bodies are read up to the 8 KiB cap and then discarded -- never stored, never
logged.
"""

from __future__ import annotations

import socket
import ssl
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from security import (
    CallbackTarget,
    CallbackUrlError,
    null_log,
    validate_callback_url,
)
from store import (
    MAX_RETAINED_RESPONSE_BYTES,
    Job,
    Store,
)

__all__ = [
    "DeliveryRequest",
    "DeliveryResponse",
    "TransportError",
    "TransportTimeout",
    "ResponseTooLarge",
    "SocketTransport",
    "DeliveryWorker",
    "CLASSIFICATIONS",
    "classify_status",
]

DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_LEASE_SECONDS = 60
USER_AGENT = "RelayVault/1.0"

CLASSIFICATIONS: dict[str, dict[str, Any]] = {
    "ok": {"retryable": False, "terminal": True, "detail": "HTTP 200-299, delivered"},
    "http_retryable": {"retryable": True, "terminal": False, "detail": "HTTP 408/429/5xx"},
    "http_terminal": {"retryable": False, "terminal": True, "detail": "other HTTP status"},
    "redirect_not_followed": {
        "retryable": False,
        "terminal": True,
        "detail": "HTTP 3xx; redirects are never followed",
    },
    "callback_url_rejected": {
        "retryable": False,
        "terminal": True,
        "detail": "URL or resolved address failed validation at delivery time",
    },
    "timeout": {"retryable": True, "terminal": False, "detail": "transport timeout"},
    "transport_error": {"retryable": True, "terminal": False, "detail": "transport failure"},
    "response_too_large": {
        "retryable": False,
        "terminal": True,
        "detail": "response exceeded the 8192 byte retention cap",
    },
    "internal_error": {"retryable": True, "terminal": False, "detail": "unexpected worker error"},
}


class TransportError(Exception):
    """Generic outbound transport failure (retryable)."""


class TransportTimeout(TransportError):
    """Connect or read timeout (retryable)."""


class ResponseTooLarge(TransportError):
    """Peer sent more than the retention cap allows (terminal)."""


@dataclass(frozen=True)
class DeliveryRequest:
    """What the transport is allowed to know.

    ``ip`` is the already-validated address to connect to.  ``hostname`` is kept
    only for TLS/SNI and the ``Host`` header -- a conforming transport must not
    resolve it.
    """

    method: str
    ip: str
    ip_version: int
    port: int
    hostname: str
    host_header: str
    request_target: str
    headers: Mapping[str, str]
    body: bytes
    timeout: float
    max_response_bytes: int = MAX_RETAINED_RESPONSE_BYTES
    follow_redirects: bool = False


@dataclass(frozen=True)
class DeliveryResponse:
    """Transport result.  The body itself is deliberately absent."""

    status_code: int
    response_bytes: int = 0
    headers: Mapping[str, str] = field(default_factory=dict)


class SocketTransport:
    """Real HTTPS transport.  Connects to the pinned IP, never resolves.

    Not exercised by the test suite (the tests inject fakes), so it makes no
    network calls during testing.
    """

    def __init__(self, *, ssl_context: ssl.SSLContext | None = None) -> None:
        self._ctx = ssl_context or ssl.create_default_context()
        self._ctx.check_hostname = True
        self._ctx.verify_mode = ssl.CERT_REQUIRED

    def __call__(self, request: DeliveryRequest) -> DeliveryResponse:  # pragma: no cover - network
        family = socket.AF_INET6 if request.ip_version == 6 else socket.AF_INET
        raw = socket.socket(family, socket.SOCK_STREAM)
        raw.settimeout(request.timeout)
        try:
            raw.connect((request.ip, request.port))
            with self._ctx.wrap_socket(raw, server_hostname=request.hostname) as tls:
                head = [f"{request.method} {request.request_target} HTTP/1.1"]
                head.append(f"Host: {request.host_header}")
                for name, value in request.headers.items():
                    head.append(f"{name}: {value}")
                head.append(f"Content-Length: {len(request.body)}")
                head.append("Connection: close")
                blob = ("\r\n".join(head) + "\r\n\r\n").encode("ascii") + request.body
                tls.sendall(blob)
                buffer = b""
                cap = request.max_response_bytes
                while b"\r\n\r\n" not in buffer:
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    if len(buffer) > cap:
                        raise ResponseTooLarge("response head exceeded cap")
                head_blob, _, rest = buffer.partition(b"\r\n\r\n")
                first_line = head_blob.split(b"\r\n", 1)[0].decode("latin-1")
                pieces = first_line.split(" ")
                status_code = int(pieces[1]) if len(pieces) > 1 else 0
                seen = len(rest)
                while True:
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    seen += len(chunk)
                    if seen > cap:
                        raise ResponseTooLarge("response body exceeded cap")
                return DeliveryResponse(status_code=status_code, response_bytes=seen)
        except ResponseTooLarge:
            raise
        except socket.timeout as exc:
            raise TransportTimeout("timeout") from exc
        except (OSError, ssl.SSLError, ValueError) as exc:
            raise TransportError("transport failure") from exc
        finally:
            try:
                raw.close()
            except OSError:
                pass


def classify_status(status_code: int) -> tuple[bool, str]:
    """Map an HTTP status to ``(retryable, error_code)``.

    ``('ok')`` is returned for 2xx.  408, 429 and 5xx retry; 3xx is terminal
    because redirects are never followed; everything else is terminal.
    """

    code = int(status_code)
    if 200 <= code <= 299:
        return False, "ok"
    if 300 <= code <= 399:
        return False, "redirect_not_followed"
    if code in (408, 429) or 500 <= code <= 599:
        return True, "http_retryable"
    return False, "http_terminal"


class DeliveryWorker:
    """Leases due jobs and attempts one delivery each."""

    def __init__(
        self,
        *,
        store: Store,
        resolver: Callable[[str], Sequence[str]],
        transport: Callable[[DeliveryRequest], DeliveryResponse],
        clock: Callable[[], int],
        monotonic: Callable[[], float],
        worker_id: str,
        log: Callable[..., None] = null_log,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        batch_limit: int = 10,
    ) -> None:
        self.store = store
        self.resolver = resolver
        self.transport = transport
        # ``clock`` is wall-clock seconds for persistence; ``monotonic`` measures
        # in-process durations only and is never persisted as a timestamp.
        self.clock = clock
        self.monotonic = monotonic
        self.worker_id = str(worker_id)
        self.log = log
        self.lease_seconds = int(lease_seconds)
        self.timeout = float(timeout)
        self.batch_limit = int(batch_limit)

    # -- one pass -------------------------------------------------------- #

    def run_once(self, limit: int | None = None) -> dict[str, int]:
        limit = self.batch_limit if limit is None else int(limit)
        now = int(self.clock())
        jobs = self.store.claim_due(self.worker_id, limit, self.lease_seconds, now)
        summary = {"claimed": len(jobs), "delivered": 0, "retried": 0, "terminal": 0}
        for job in jobs:
            outcome = self.deliver(job)
            if outcome == "delivered":
                summary["delivered"] += 1
            elif outcome == "retry":
                summary["retried"] += 1
            else:
                summary["terminal"] += 1
        return summary

    def deliver(self, job: Job) -> str:
        """Attempt one delivery for an already-leased job."""

        started = self.monotonic()

        # Re-resolve and re-validate now, not at enqueue time (DNS rebinding).
        try:
            target = validate_callback_url(job.callback_url, self.resolver)
        except CallbackUrlError as exc:
            self.log(
                "delivery.url_rejected",
                job_id=job.job_id,
                tenant_id=job.tenant_id,
                attempt=job.attempts,
                reason=exc.reason,
            )
            return self._settle(
                job, retryable=False, error_code="callback_url_rejected",
                status_code=None, response_bytes=None, started=started,
            )

        request = self._build_request(job, target)
        try:
            response = self.transport(request)
        except ResponseTooLarge:
            return self._settle(
                job, retryable=False, error_code="response_too_large",
                status_code=None, response_bytes=None, started=started,
            )
        except TransportTimeout:
            return self._settle(
                job, retryable=True, error_code="timeout",
                status_code=None, response_bytes=None, started=started,
            )
        except TransportError:
            return self._settle(
                job, retryable=True, error_code="transport_error",
                status_code=None, response_bytes=None, started=started,
            )
        except Exception as exc:  # unexpected: retry, but never leak details
            self.log(
                "delivery.internal_error",
                job_id=job.job_id,
                tenant_id=job.tenant_id,
                exc_type=type(exc).__name__,
            )
            return self._settle(
                job, retryable=True, error_code="internal_error",
                status_code=None, response_bytes=None, started=started,
            )

        status_code = int(getattr(response, "status_code", 0))
        response_bytes = int(getattr(response, "response_bytes", 0) or 0)
        if response_bytes > MAX_RETAINED_RESPONSE_BYTES:
            return self._settle(
                job, retryable=False, error_code="response_too_large",
                status_code=status_code, response_bytes=MAX_RETAINED_RESPONSE_BYTES,
                started=started,
            )

        retryable, code = classify_status(status_code)
        duration_ms = self._duration_ms(started)
        if code == "ok":
            ok = self.store.complete(
                job.job_id,
                self.worker_id,
                int(self.clock()),
                status_code=status_code,
                response_bytes=response_bytes,
                duration_ms=duration_ms,
            )
            self.log(
                "delivery.delivered" if ok else "delivery.lease_lost",
                job_id=job.job_id,
                tenant_id=job.tenant_id,
                attempt=job.attempts,
                status_code=status_code,
                duration_ms=duration_ms,
            )
            return "delivered" if ok else "lease_lost"
        return self._settle(
            job, retryable=retryable, error_code=code, status_code=status_code,
            response_bytes=response_bytes, started=started,
        )

    # -- helpers --------------------------------------------------------- #

    def _build_request(self, job: Job, target: CallbackTarget) -> DeliveryRequest:
        body = job.payload_json.encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "X-RelayVault-Event-Id": job.event_id,
            "X-RelayVault-Event-Type": job.event_type,
            "X-RelayVault-Attempt": str(job.attempts),
        }
        return DeliveryRequest(
            method="POST",
            ip=target.ip,
            ip_version=target.ip_version,
            port=target.port,
            hostname=target.hostname,
            host_header=target.host_header,
            request_target=target.request_target,
            headers=headers,
            body=body,
            timeout=self.timeout,
            max_response_bytes=MAX_RETAINED_RESPONSE_BYTES,
            follow_redirects=False,
        )

    def _duration_ms(self, started: float) -> int:
        return max(0, int(round((self.monotonic() - started) * 1000)))

    def _settle(
        self,
        job: Job,
        *,
        retryable: bool,
        error_code: str,
        status_code: int | None,
        response_bytes: int | None,
        started: float,
    ) -> str:
        duration_ms = self._duration_ms(started)
        outcome = self.store.fail(
            job.job_id,
            self.worker_id,
            retryable,
            int(self.clock()),
            error_code,
            status_code=status_code,
            response_bytes=response_bytes,
            duration_ms=duration_ms,
        )
        if outcome is None:
            self.log("delivery.lease_lost", job_id=job.job_id, tenant_id=job.tenant_id)
            return "lease_lost"
        self.log(
            "delivery.failed",
            job_id=job.job_id,
            tenant_id=job.tenant_id,
            attempt=outcome.attempts,
            error_code=outcome.error_code,
            status_code=status_code,
            terminal=outcome.terminal,
            retry_delay=outcome.retry_delay,
            duration_ms=duration_ms,
        )
        return "terminal" if outcome.terminal else "retry"
