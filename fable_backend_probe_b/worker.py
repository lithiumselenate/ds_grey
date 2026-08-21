"""Delivery worker for RelayVault.

The worker claims due jobs from the store, re-validates the callback URL
*immediately before every delivery attempt* (defending against DNS rebinding
between enqueue and delivery), and hands the transport the already-validated
IP address separately from the original hostname.  The transport therefore
cannot re-resolve the hostname behind the validator; the hostname is preserved
only for TLS/SNI and the HTTP ``Host`` header.

Failure classification (documented, deterministic)
--------------------------------------------------
* HTTP 200–299                        -> success (``delivered``);
* HTTP 408, 429, 500–599              -> retryable (``http_<code>``);
* any other HTTP status (incl. 3xx)   -> terminal; redirects are never
  followed — a 3xx response counts as a terminal delivery failure and no
  follow-up request is issued;
* hostname resolution failure         -> retryable, ``dns_error``;
* unsafe resolved address (rebinding) -> terminal,  ``unsafe_address``;
* syntactically invalid stored URL    -> terminal,  ``invalid_url``;
* transport timeout                   -> retryable, ``timeout``;
* oversized response                  -> terminal,  ``oversized_response``;
* other transport failure             -> retryable, ``transport_error``.

At most ``RESPONSE_RETENTION_BYTES`` (8192) of a callback response body are
retained in the in-memory delivery result.  Response bodies are never
persisted and never logged.  Wall-clock time is used for persisted
timestamps; the injected monotonic clock is used only for in-process duration
measurement and is never persisted.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from security import (
    CallbackURLError,
    ResolutionError,
    StructuredLogger,
    UnsafeAddressError,
    resolve_and_validate,
    validate_callback_url,
)
from store import LeaseError

__all__ = [
    "DeliveryRequest",
    "DeliveryResult",
    "OversizedResponseError",
    "TransportError",
    "TransportTimeoutError",
    "Worker",
    "classify_status",
    "RESPONSE_RETENTION_BYTES",
]

RESPONSE_RETENTION_BYTES = 8192

SUCCESS = "success"
RETRYABLE = "retryable"
TERMINAL = "terminal"


class TransportError(Exception):
    """Generic outbound transport failure (retryable)."""


class TransportTimeoutError(TransportError):
    """The delivery attempt timed out (retryable)."""


class OversizedResponseError(TransportError):
    """The callback response exceeded the allowed size (terminal)."""


def classify_status(status_code: int) -> str:
    code = int(status_code)
    if 200 <= code <= 299:
        return SUCCESS
    if code in (408, 429) or 500 <= code <= 599:
        return RETRYABLE
    return TERMINAL


@dataclass(frozen=True)
class DeliveryRequest:
    """What the transport receives.  ``ip`` is the pre-validated address the
    transport must connect to; ``hostname`` exists only for SNI/Host."""

    method: str
    ip: str
    hostname: str
    port: int
    target: str
    headers: dict
    body: bytes


@dataclass
class DeliveryResult:
    job_id: str
    outcome: str  # delivered | requeued | failed
    error_code: str | None = None
    status_code: int | None = None
    response_snippet: bytes = field(default=b"", repr=False)


class Worker:
    """Claims and delivers jobs.

    All effectful collaborators are injected: ``resolver(hostname) -> [ip]``,
    ``transport(DeliveryRequest) -> (status_code, body_bytes)``,
    ``wall_clock() -> unix seconds`` (persisted timestamps), and
    ``monotonic_clock()`` (duration measurement only).
    """

    def __init__(
        self,
        store,
        resolver,
        transport,
        wall_clock,
        worker_id: str,
        logger: StructuredLogger | None = None,
        monotonic_clock=time.monotonic,
        lease_seconds: int = 30,
    ) -> None:
        self._store = store
        self._resolver = resolver
        self._transport = transport
        self._wall_clock = wall_clock
        self._monotonic = monotonic_clock
        self._worker_id = worker_id
        self._logger = logger if logger is not None else StructuredLogger()
        self._lease_seconds = int(lease_seconds)

    def run_once(self, limit: int = 10):
        """Claim up to ``limit`` due jobs and attempt delivery for each."""
        now = int(self._wall_clock())
        jobs = self._store.claim_due(
            self._worker_id, limit, self._lease_seconds, now
        )
        return [self._deliver(job) for job in jobs]

    # ------------------------------------------------------------------

    def _deliver(self, job) -> DeliveryResult:
        job_id = job["job_id"]
        started = self._monotonic()

        try:
            parsed = validate_callback_url(job["callback_url"])
        except CallbackURLError:
            return self._settle(job_id, started, retryable=False, code="invalid_url")

        # Re-resolve and re-validate immediately before delivery (rebinding
        # defence).  The chosen IP is passed to the transport explicitly.
        try:
            ip = resolve_and_validate(parsed.hostname, self._resolver)
        except UnsafeAddressError:
            return self._settle(job_id, started, retryable=False, code="unsafe_address")
        except ResolutionError:
            return self._settle(job_id, started, retryable=True, code="dns_error")

        body = json.dumps(
            {
                "event_id": job["event_id"],
                "type": job["event_type"],
                "payload": json.loads(job["payload"]),
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        host_header = (
            parsed.hostname if parsed.port == 443 else f"{parsed.hostname}:{parsed.port}"
        )
        request = DeliveryRequest(
            method="POST",
            ip=ip,
            hostname=parsed.hostname,
            port=parsed.port,
            target=parsed.target,
            headers={"Host": host_header, "Content-Type": "application/json"},
            body=body,
        )

        try:
            status_code, response_body = self._transport(request)
        except TransportTimeoutError:
            return self._settle(job_id, started, retryable=True, code="timeout")
        except OversizedResponseError:
            return self._settle(
                job_id, started, retryable=False, code="oversized_response"
            )
        except Exception:
            return self._settle(
                job_id, started, retryable=True, code="transport_error"
            )

        snippet = bytes(response_body or b"")[:RESPONSE_RETENTION_BYTES]
        classification = classify_status(status_code)
        if classification == SUCCESS:
            now = int(self._wall_clock())
            try:
                self._store.complete(job_id, self._worker_id, now)
            except LeaseError:
                return DeliveryResult(job_id, "failed", error_code="lease_lost")
            self._log(job_id, "delivered", None, status_code, started)
            return DeliveryResult(
                job_id, "delivered", status_code=int(status_code),
                response_snippet=snippet,
            )
        result = self._settle(
            job_id,
            started,
            retryable=(classification == RETRYABLE),
            code=f"http_{int(status_code)}",
        )
        result.status_code = int(status_code)
        result.response_snippet = snippet
        return result

    def _settle(
        self, job_id: str, started, *, retryable: bool, code: str
    ) -> DeliveryResult:
        now = int(self._wall_clock())
        try:
            updated = self._store.fail(job_id, self._worker_id, retryable, now, code)
        except LeaseError:
            return DeliveryResult(job_id, "failed", error_code="lease_lost")
        outcome = "requeued" if updated["status"] == "queued" else "failed"
        self._log(job_id, outcome, code, None, started)
        return DeliveryResult(job_id, outcome, error_code=code)

    def _log(self, job_id, outcome, code, status_code, started) -> None:
        duration_ms = int((self._monotonic() - started) * 1000)
        self._logger.log(
            "delivery.attempted",
            worker_id=self._worker_id,
            job_id=job_id,
            outcome=outcome,
            error_code=code,
            status_code=status_code,
            duration_ms=duration_ms,
        )
