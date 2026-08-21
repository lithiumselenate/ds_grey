"""RelayVault delivery worker.

Claims leased jobs, re-validates the callback URL immediately before every
attempt (DNS-rebinding defence), performs one HTTP request through an
injected transport and records the outcome.

Failure classification (documented contract)
--------------------------------------------
================================  ==============  ==========================
condition                          retryable?      error code
================================  ==============  ==========================
HTTP 200-299                       n/a (success)   -
HTTP 408, 429, 500-599             retryable       ``http_retryable``
any other HTTP status (incl. 3xx)  terminal        ``http_terminal``
callback URL rejected by policy    terminal        ``callback_rejected``
resolver raised an exception       retryable       ``resolver_error``
transport timeout                  retryable       ``timeout``
transport failure (I/O, TLS)       retryable       ``transport_error``
response larger than 8192 bytes    terminal        ``response_too_large``
unexpected internal error          retryable       ``internal_error``
================================  ==============  ==========================

Redirects are never followed: a 3xx is an "other HTTP status" and therefore
terminal.

At most :data:`store.MAX_RESPONSE_RETAINED_BYTES` (8192) bytes of a callback
response are ever held, and only in memory for classification; the response
body is never persisted or logged.  Attempt durations use an injected
monotonic clock; persisted timestamps use the injected wall clock.
"""

from __future__ import annotations

import http.client
import json
import socket
import ssl
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from security import UrlValidationError, redact, validate_callback_url
from store import MAX_RESPONSE_RETAINED_BYTES, STATUS_FAILED, Job, Store

RETRYABLE_HTTP_STATUSES = frozenset({408, 429})
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_LEASE_SECONDS = 60


class TransportTimeout(Exception):
    """The outbound attempt exceeded its timeout."""


class TransportFailure(Exception):
    """Connection, TLS or protocol failure."""


class ResponseTooLarge(Exception):
    """The callback response exceeded the retained-byte budget."""


@dataclass(frozen=True)
class DeliveryRequest:
    """Everything the transport needs -- with the IP kept separate.

    ``ip``/``family`` are the validated destination; ``hostname`` is only for
    TLS/SNI and the HTTP ``Host`` header.  A transport must never resolve
    ``hostname`` itself.
    """

    ip: str
    family: int
    port: int
    hostname: str
    method: str
    target: str
    headers: Mapping[str, str]
    body: bytes
    timeout: float
    max_response_bytes: int = MAX_RESPONSE_RETAINED_BYTES


@dataclass(frozen=True)
class DeliveryResponse:
    status: int
    body_bytes: int = 0
    truncated: bool = False


@dataclass(frozen=True)
class AttemptOutcome:
    job_id: str
    success: bool
    status_code: int | None
    error_code: str | None
    retryable: bool
    terminal: bool
    duration_ms: int


def classify_status(status: int) -> tuple[bool, bool, str | None]:
    """Return ``(success, retryable, error_code)`` for an HTTP status."""
    if 200 <= status <= 299:
        return True, False, None
    if status in RETRYABLE_HTTP_STATUSES or 500 <= status <= 599:
        return False, True, "http_retryable"
    return False, False, "http_terminal"


class DeliveryWorker:
    def __init__(
        self,
        store: Store,
        *,
        resolver: Callable[[str], Sequence[str]],
        transport: Any,
        clock: Callable[[], float],
        monotonic: Callable[[], float],
        worker_id: str,
        log: Callable[[str, Mapping[str, Any]], None] | None = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_response_bytes: int = MAX_RESPONSE_RETAINED_BYTES,
    ) -> None:
        self._store = store
        self._resolver = resolver
        self._transport = transport
        self._clock = clock
        self._monotonic = monotonic
        self.worker_id = str(worker_id)
        self._log = log or (lambda event, fields: None)
        self._lease_seconds = int(lease_seconds)
        self._timeout = float(timeout_seconds)
        self._max_response_bytes = int(max_response_bytes)

    # -- logging ---------------------------------------------------------
    def _emit(self, event: str, **fields: Any) -> None:
        try:
            self._log(event, redact(fields))
        except Exception:  # logging must never break delivery
            pass

    # -- public API ------------------------------------------------------
    def run_once(self, limit: int = 10) -> list[AttemptOutcome]:
        now = int(self._clock())
        jobs = self._store.claim_due(
            self.worker_id, limit, self._lease_seconds, now
        )
        outcomes: list[AttemptOutcome] = []
        for job in jobs:
            outcomes.append(self.deliver(job))
        return outcomes

    def deliver(self, job: Job) -> AttemptOutcome:
        started = self._monotonic()
        status_code: int | None = None

        try:
            validated = validate_callback_url(job.callback_url, self._resolver)
        except UrlValidationError as exc:
            # Policy rejection at delivery time (this is the DNS-rebinding
            # gate): terminal, and we never log the offending address.
            return self._record(
                job, started, success=False, retryable=False,
                error_code="callback_rejected", status_code=None,
                detail=exc.reason,
            )
        except Exception:
            return self._record(
                job, started, success=False, retryable=True,
                error_code="resolver_error", status_code=None,
                detail="resolver_exception",
            )

        request = DeliveryRequest(
            ip=validated.ip,
            family=validated.family,
            port=validated.port,
            hostname=validated.hostname,
            method="POST",
            target=validated.target,
            headers={
                "Host": _host_header(validated.hostname, validated.port),
                "Content-Type": "application/json",
                "User-Agent": "RelayVault/1.0",
                "X-RelayVault-Event-Id": job.event_id,
                "X-RelayVault-Attempt": str(job.attempts + 1),
            },
            body=self._delivery_body(job),
            timeout=self._timeout,
            max_response_bytes=self._max_response_bytes,
        )

        try:
            response = self._transport.send(request)
        except TransportTimeout:
            return self._record(
                job, started, success=False, retryable=True,
                error_code="timeout", status_code=None, detail="timeout",
            )
        except ResponseTooLarge:
            return self._record(
                job, started, success=False, retryable=False,
                error_code="response_too_large", status_code=None,
                detail="oversized_response",
            )
        except TransportFailure:
            return self._record(
                job, started, success=False, retryable=True,
                error_code="transport_error", status_code=None,
                detail="transport_failure",
            )
        except Exception:
            return self._record(
                job, started, success=False, retryable=True,
                error_code="internal_error", status_code=None,
                detail="unexpected_transport_error",
            )

        status_code = int(getattr(response, "status", 0))
        success, retryable, error_code = classify_status(status_code)
        return self._record(
            job, started, success=success, retryable=retryable,
            error_code=error_code, status_code=status_code,
            detail=None,
        )

    # -- internals -------------------------------------------------------
    def _delivery_body(self, job: Job) -> bytes:
        envelope = (
            '{"event_id":' + json.dumps(job.event_id)
            + ',"type":' + json.dumps(job.event_type)
            + ',"payload":' + job.payload_json
            + "}"
        )
        return envelope.encode("utf-8")

    def _record(
        self,
        job: Job,
        started: float,
        *,
        success: bool,
        retryable: bool,
        error_code: str | None,
        status_code: int | None,
        detail: str | None,
    ) -> AttemptOutcome:
        duration_ms = int(max(0.0, self._monotonic() - started) * 1000)
        now = int(self._clock())  # wall clock for persistence
        terminal = success
        if success:
            accepted = self._store.complete(job.id, self.worker_id, now)
            if not accepted:
                self._emit(
                    "delivery.lease_lost", job_id=job.id, worker_id=self.worker_id
                )
            self._emit(
                "delivery.succeeded",
                job_id=job.id,
                tenant_id=job.tenant_id,
                attempt=job.attempts + 1,
                status_code=status_code,
                duration_ms=duration_ms,
                callback_host=_hostname_only(job.callback_url),
            )
        else:
            updated = self._store.fail(
                job.id, self.worker_id, retryable, now,
                error_code or "unknown", status_code=status_code,
            )
            if updated is None:
                self._emit(
                    "delivery.lease_lost", job_id=job.id, worker_id=self.worker_id
                )
            else:
                terminal = updated.status == STATUS_FAILED
            self._emit(
                "delivery.failed",
                job_id=job.id,
                tenant_id=job.tenant_id,
                attempt=job.attempts + 1,
                status_code=status_code,
                error_code=error_code,
                detail=detail,
                terminal=terminal,
                duration_ms=duration_ms,
                callback_host=_hostname_only(job.callback_url),
            )
        return AttemptOutcome(
            job_id=job.id,
            success=success,
            status_code=status_code,
            error_code=error_code,
            retryable=retryable and not terminal,
            terminal=terminal,
            duration_ms=duration_ms,
        )


def _host_header(hostname: str, port: int) -> str:
    host = f"[{hostname}]" if ":" in hostname else hostname
    return host if port == 443 else f"{host}:{port}"


def _hostname_only(url: str) -> str:
    """Log-safe host extraction (never the resolved IP, never the path)."""
    from urllib.parse import urlsplit

    try:
        return urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


class HttpsTransport:
    """Real outbound transport.

    Connects to the pre-validated IP and only uses the hostname for TLS/SNI
    and the ``Host`` header, so no second resolution can occur.  Redirects
    are never followed and at most ``max_response_bytes`` are read.

    Not exercised by the test suite: the tests use fake transports and make
    no network connections.
    """

    def __init__(self, ssl_context: ssl.SSLContext | None = None) -> None:
        self._ssl_context = ssl_context or ssl.create_default_context()

    def send(self, request: DeliveryRequest) -> DeliveryResponse:
        raw = None
        tls = None
        try:
            raw = socket.socket(request.family, socket.SOCK_STREAM)
            raw.settimeout(request.timeout)
            raw.connect((request.ip, request.port))
            tls = self._ssl_context.wrap_socket(
                raw, server_hostname=request.hostname
            )
            conn = http.client.HTTPConnection(request.ip, request.port)
            conn.sock = tls
            conn.putrequest(request.method, request.target, skip_host=True,
                            skip_accept_encoding=True)
            for name, value in request.headers.items():
                conn.putheader(name, value)
            conn.putheader("Content-Length", str(len(request.body)))
            conn.endheaders()
            conn.send(request.body)
            response = conn.getresponse()
            budget = request.max_response_bytes
            chunk = response.read(budget + 1)
            if len(chunk) > budget:
                raise ResponseTooLarge("callback response too large")
            return DeliveryResponse(
                status=response.status, body_bytes=len(chunk), truncated=False
            )
        except (TimeoutError, socket.timeout) as exc:  # noqa: UP041
            raise TransportTimeout(str(type(exc).__name__)) from None
        except ResponseTooLarge:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            raise TransportFailure(str(type(exc).__name__)) from None
        finally:
            for sock in (tls, raw):
                try:
                    if sock is not None:
                        sock.close()
                except OSError:
                    pass
