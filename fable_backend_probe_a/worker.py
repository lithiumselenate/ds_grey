"""Delivery worker: claims leased jobs, re-validates callback URLs, and
classifies delivery outcomes deterministically.

Failure classification (documented contract):

==============================  ===========  =====================
Condition                       Class        last_error_code
==============================  ===========  =====================
HTTP 200-299                    success      (cleared)
HTTP 408, 429, 500-599          retryable    ``http_<status>``
Any other HTTP status (incl.    terminal     ``http_<status>``
3xx: redirects are never
followed)
Resolver rejection at delivery  retryable    ``resolver_rejected``
(DNS rebinding defense)
Timeout                         retryable    ``timeout``
Oversized response              terminal     ``oversized_response``
Transport failure               retryable    ``transport_error``
==============================  ===========  =====================

Retryable failures reschedule after ``min(2 ** attempt, 300)`` seconds and
become terminal after five attempts.  The wall clock is used for every
persisted timestamp; the injected monotonic clock is used only for measuring
in-process durations and is never persisted.
"""
from __future__ import annotations

import ipaddress
import json
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Sequence

import security
import store as store_module

DEFAULT_LEASE_SECONDS = 60
DELIVERY_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 1 << 20  # transports must refuse larger responses
RETRYABLE_STATUS_CODES = frozenset({408, 429}) | frozenset(range(500, 600))


class TransportTimeout(Exception):
    """The delivery attempt timed out (retryable)."""


class TransportFailure(Exception):
    """Connection/TLS/protocol failure (retryable)."""


class OversizedResponse(Exception):
    """The callback response exceeded MAX_RESPONSE_BYTES (terminal)."""


@dataclass
class DeliveryRequest:
    """Outbound request handed to the transport.

    ``ip`` is the pre-validated address the transport MUST connect to; it is
    passed separately from ``host`` so the transport cannot re-resolve the
    hostname behind the validator.  ``host`` is preserved for TLS/SNI and the
    HTTP ``Host`` header.  Transports must never follow redirects.
    """

    ip: str
    host: str
    port: int
    method: str
    target: str
    headers: Dict[str, str]
    body: bytes
    timeout: float


@dataclass
class TransportResponse:
    status: int
    body: bytes = b""


def host_header(host: str, port: int) -> str:
    try:
        if isinstance(ipaddress.ip_address(host), ipaddress.IPv6Address):
            host = "[%s]" % host
    except ValueError:
        pass
    return host if port == 443 else "%s:%d" % (host, port)


class Worker:
    """Claims due jobs and attempts delivery through an injected transport."""

    def __init__(
        self,
        job_store: store_module.Store,
        resolver: Callable[[str], Sequence[str]],
        transport: Callable[[DeliveryRequest], TransportResponse],
        worker_id: str,
        wall_clock: Callable[[], float] = time.time,
        monotonic_clock: Callable[[], float] = time.monotonic,
        logger: Optional[Callable[[str, dict], None]] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        timeout_seconds: float = DELIVERY_TIMEOUT_SECONDS,
    ) -> None:
        self._store = job_store
        self._resolver = resolver
        self._transport = transport
        self._worker_id = worker_id
        self._wall_clock = wall_clock
        self._monotonic = monotonic_clock
        self._logger = logger or (lambda event, fields: None)
        self._lease_seconds = lease_seconds
        self._timeout = timeout_seconds

    def _log(self, event: str, **fields) -> None:
        self._logger(event, security.redact(fields))

    def _now(self) -> int:
        return int(self._wall_clock())

    def run_once(self, limit: int = 10) -> int:
        """Claim up to ``limit`` due jobs and attempt each once."""
        jobs = self._store.claim_due(
            self._worker_id, limit, self._lease_seconds, self._now()
        )
        for job in jobs:
            self._deliver(job)
        return len(jobs)

    def _deliver(self, job: dict) -> None:
        started = self._monotonic()
        job_id = job["job_id"]
        attempt = job["attempts"]
        # Re-validate and re-resolve immediately before delivery so a DNS
        # rebinding after enqueue cannot reach a non-global address.
        try:
            target = security.validate_callback_url(job["callback_url"], self._resolver)
        except security.CallbackURLError:
            self._store.fail(
                job_id, self._worker_id, True, self._now(), "resolver_rejected"
            )
            self._finish_log(job, "resolver_rejected", None, started)
            return

        body = json.dumps(
            {
                "event_id": job["event_id"],
                "payload": json.loads(job["payload"]),
                "type": job["event_type"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        request = DeliveryRequest(
            ip=target.ip,
            host=target.host,
            port=target.port,
            method="POST",
            target=target.request_target,
            headers={
                "Host": host_header(target.host, target.port),
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
            body=body,
            timeout=self._timeout,
        )
        try:
            response = self._transport(request)
        except TransportTimeout:
            self._store.fail(job_id, self._worker_id, True, self._now(), "timeout")
            self._finish_log(job, "timeout", None, started)
            return
        except OversizedResponse:
            self._store.fail(
                job_id, self._worker_id, False, self._now(), "oversized_response"
            )
            self._finish_log(job, "oversized_response", None, started)
            return
        except Exception:
            self._store.fail(
                job_id, self._worker_id, True, self._now(), "transport_error"
            )
            self._finish_log(job, "transport_error", None, started)
            return

        status = response.status
        if 200 <= status <= 299:
            self._store.complete(job_id, self._worker_id, self._now())
            self._finish_log(job, "delivered", status, started)
            return
        snippet = response.body[: store_module.MAX_RESPONSE_SNIPPET_BYTES]
        retryable = status in RETRYABLE_STATUS_CODES
        self._store.fail(
            job_id,
            self._worker_id,
            retryable,
            self._now(),
            "http_%d" % status,
            response_snippet=snippet,
        )
        self._finish_log(job, "retry" if retryable else "terminal", status, started)

    def _finish_log(self, job: dict, outcome: str, status, started: float) -> None:
        # Safe metadata only: no URLs, addresses, payloads, or response bodies.
        self._log(
            "delivery_attempt",
            job_id=job["job_id"],
            tenant_id=job["tenant_id"],
            attempt=job["attempts"],
            outcome=outcome,
            http_status=status,
            duration_ms=round((self._monotonic() - started) * 1000.0, 3),
        )


def default_transport(request: DeliveryRequest) -> TransportResponse:
    """Production HTTPS transport.  Tests must inject fakes instead.

    Connects to the pre-validated ``request.ip`` (never re-resolving the
    hostname), presents ``request.host`` for SNI and certificate checking,
    never follows redirects, and refuses responses over MAX_RESPONSE_BYTES.
    """
    import http.client
    import socket
    import ssl

    context = ssl.create_default_context()
    try:
        raw = socket.create_connection((request.ip, request.port), timeout=request.timeout)
    except socket.timeout as exc:
        raise TransportTimeout() from exc
    except OSError as exc:
        raise TransportFailure() from exc
    try:
        tls = context.wrap_socket(raw, server_hostname=request.host)
        connection = http.client.HTTPSConnection(request.host, request.port)
        connection.sock = tls
        connection.request(request.method, request.target, request.body, request.headers)
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise OversizedResponse()
        return TransportResponse(status=response.status, body=body)
    except (TransportTimeout, TransportFailure, OversizedResponse):
        raise
    except socket.timeout as exc:
        raise TransportTimeout() from exc
    except Exception as exc:
        raise TransportFailure() from exc
    finally:
        try:
            raw.close()
        except OSError:
            pass
