"""RelayVault security primitives.

This module is transport independent and contains no I/O of its own.  Every
dependency that could make behaviour non-deterministic (wall clock, nonce
persistence, hostname resolution, log sink) is injected by the caller.

Contents
--------
* generic request/auth error types with client-safe payloads
* header normalisation that rejects missing / repeated / ambiguous headers
* the canonical signing string and HMAC-SHA256 verification
* replay defence built on an injected atomic nonce store
* callback URL validation (HTTPS only, no SSRF-capable addresses)
* a redaction helper plus a structured JSON logger

Security notes
--------------
* Signatures are compared with :func:`hmac.compare_digest` and only after the
  supplied encoding has been validated as 64 lowercase hex characters.
* Unknown tenant/key pairs still perform one HMAC computation against a
  process-local dummy secret so that "unknown principal" and "bad signature"
  cost roughly the same and return the identical generic error.
* Nonces are consumed *after* the signature has been verified, therefore a
  forged request can never burn a legitimate nonce.
* No secret, signature, nonce or payload value is ever placed in an error
  message, a log record, or a response body.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import secrets as _secrets
import socket
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, Sequence

__all__ = [
    "MAX_CLOCK_SKEW_SECONDS",
    "NONCE_TTL_SECONDS",
    "SECURITY_HEADERS",
    "RequestError",
    "AuthError",
    "CallbackUrlError",
    "Config",
    "Principal",
    "CallbackTarget",
    "normalize_headers",
    "canonical_string",
    "sign",
    "verify_request",
    "validate_callback_url",
    "SystemResolver",
    "redact_value",
    "redact_fields",
    "JsonLogger",
    "null_log",
]

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #

MAX_CLOCK_SKEW_SECONDS = 300
NONCE_TTL_SECONDS = 600

SECURITY_HEADERS: tuple[str, ...] = (
    "x-tenant-id",
    "x-key-id",
    "x-timestamp",
    "x-nonce",
    "x-signature",
)

#: Headers that must appear at most once.  A repeat (or a folded value) is
#: ambiguous and therefore rejected instead of guessed.
SINGLE_VALUED_HEADERS: frozenset[str] = frozenset(
    SECURITY_HEADERS
    + (
        "content-type",
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "idempotency-key",
        "host",
    )
)

_ID_RE = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")
_NONCE_RE = re.compile(r"\A[A-Za-z0-9._:-]{8,128}\Z")
_TIMESTAMP_RE = re.compile(r"\A-?(?:0|[1-9][0-9]{0,18})\Z")
_SIGNATURE_RE = re.compile(r"\A[0-9a-f]{64}\Z")

_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOSTNAME_RE = re.compile(r"\A" + _LABEL + r"(?:\." + _LABEL + r")*\Z")

ALLOWED_CALLBACK_PORTS: frozenset[int] = frozenset({443, 8443})

#: Only used to equalise the cost of the "unknown principal" branch.  It is
#: random per process and is never a valid credential.
_DUMMY_SECRET = _secrets.token_bytes(32)


# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #


class RequestError(Exception):
    """An error with a deliberately small, client-safe representation."""

    def __init__(self, status: int, code: str, message: str, *, reason: str = "") -> None:
        super().__init__(code)
        self.status = int(status)
        self.code = str(code)
        self.message = str(message)
        # ``reason`` is for structured logs only; it never reaches a client and
        # must never contain secrets, addresses, SQL or payload fragments.
        self.reason = str(reason or code)


class AuthError(RequestError):
    """Single generic authentication failure.

    The status/code/message are constant so that a caller cannot distinguish an
    unknown tenant from a bad key id, a stale timestamp, a replayed nonce or an
    invalid signature.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(401, "unauthenticated", "authentication failed", reason=reason)


class CallbackUrlError(RequestError):
    """Callback URL rejected.  ``reason`` never contains a resolved address."""

    def __init__(self, reason: str) -> None:
        super().__init__(400, "invalid_callback_url", "callback_url is not acceptable", reason=reason)


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    key_id: str


class Config:
    """Injected tenant/key secrets.

    Secrets arrive from the embedding process (env var, file, secret manager).
    Nothing is hard-coded here and the mapping is copied defensively.
    """

    def __init__(self, tenants: Mapping[str, Mapping[str, bytes | str]]) -> None:
        copied: dict[str, dict[str, bytes]] = {}
        for tenant_id, keys in tenants.items():
            if not _ID_RE.match(tenant_id):
                raise ValueError("invalid tenant id in configuration")
            if not keys:
                raise ValueError("tenant has no keys in configuration")
            per_tenant: dict[str, bytes] = {}
            for key_id, secret in keys.items():
                if not _ID_RE.match(key_id):
                    raise ValueError("invalid key id in configuration")
                raw = secret.encode("utf-8") if isinstance(secret, str) else bytes(secret)
                if len(raw) < 16:
                    raise ValueError("configured secret is too short (>=16 bytes)")
                per_tenant[key_id] = raw
            copied[tenant_id] = per_tenant
        self._tenants = copied

    def tenant_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._tenants))

    def secret_for(self, tenant_id: str, key_id: str) -> bytes | None:
        keys = self._tenants.get(tenant_id)
        if keys is None:
            return None
        return keys.get(key_id)

    def __repr__(self) -> str:  # pragma: no cover - defensive, avoids leaks
        return f"<Config tenants={len(self._tenants)}>"


# --------------------------------------------------------------------------- #
# headers
# --------------------------------------------------------------------------- #


def _header_pairs(headers: Any) -> list[tuple[str, str]]:
    if headers is None:
        return []
    items = getattr(headers, "items", None)
    if callable(items):
        return [(str(k), str(v)) for k, v in items()]
    return [(str(k), str(v)) for k, v in headers]


def normalize_headers(headers: Any) -> dict[str, str]:
    """Return a lowercase single-valued header mapping.

    Raises :class:`AuthError` when a *security* header is repeated or ambiguous
    (so the failure stays generic) and :class:`RequestError` 400 when any other
    single-valued header is repeated or ambiguous.
    """

    seen: dict[str, str] = {}
    for raw_name, raw_value in _header_pairs(headers):
        name = raw_name.strip().lower()
        value = raw_value.strip()
        if name in SINGLE_VALUED_HEADERS:
            ambiguous = name in seen or "," in value or not value
            if not ambiguous:
                ambiguous = any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)
            if ambiguous:
                if name in SECURITY_HEADERS:
                    raise AuthError("ambiguous_security_header")
                raise RequestError(
                    400, "malformed_header", "a required header is repeated or ambiguous",
                    reason="ambiguous_header",
                )
        seen[name] = value
    return seen


# --------------------------------------------------------------------------- #
# signing
# --------------------------------------------------------------------------- #


def canonical_string(
    tenant_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> bytes:
    """Build the exact byte sequence that is signed.

    ``raw_target`` is used verbatim -- including its original query string --
    so a decoded or re-encoded target can never satisfy a signature made over
    the wire form.
    """

    body_hash = hashlib.sha256(body if body is not None else b"").hexdigest()
    parts = (
        str(tenant_id),
        str(key_id),
        str(timestamp),
        str(nonce),
        str(method).upper(),
        str(raw_target),
        body_hash,
    )
    return "\n".join(parts).encode("utf-8")


def sign(
    secret: bytes,
    tenant_id: str,
    key_id: str,
    timestamp: str | int,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> str:
    """Lowercase hex HMAC-SHA256 of :func:`canonical_string`."""

    message = canonical_string(
        tenant_id, key_id, str(timestamp), nonce, method, raw_target, body
    )
    return hmac.new(bytes(secret), message, hashlib.sha256).hexdigest()


class NonceStore:
    """Structural interface for the injected replay store."""

    def consume(
        self, tenant_id: str, key_id: str, nonce: str, now: int, ttl: int = NONCE_TTL_SECONDS
    ) -> bool:  # pragma: no cover - interface only
        raise NotImplementedError


def verify_request(
    *,
    method: str,
    raw_target: str,
    headers: Any,
    body: bytes,
    config: Config,
    clock: Callable[[], int],
    nonce_store: NonceStore,
    log: Callable[..., None] = lambda *a, **k: None,
    max_skew: int = MAX_CLOCK_SKEW_SECONDS,
    nonce_ttl: int = NONCE_TTL_SECONDS,
) -> Principal:
    """Authenticate one request or raise :class:`AuthError`.

    Order of operations matters: format checks, then the clock window, then the
    signature, and only then the single-use nonce.  An invalid signature
    therefore never consumes a nonce.
    """

    normalized = normalize_headers(headers)

    values = []
    for name in SECURITY_HEADERS:
        value = normalized.get(name)
        if not value:
            raise AuthError("missing_security_header")
        values.append(value)
    tenant_id, key_id, timestamp_raw, nonce, signature = values

    if not _ID_RE.match(tenant_id) or not _ID_RE.match(key_id):
        raise AuthError("malformed_principal")
    if not _NONCE_RE.match(nonce):
        raise AuthError("malformed_nonce")
    if not _TIMESTAMP_RE.match(timestamp_raw):
        raise AuthError("malformed_timestamp")
    # Reject malformed signature encodings *before* any comparison.
    if not _SIGNATURE_RE.match(signature):
        raise AuthError("malformed_signature")

    timestamp = int(timestamp_raw)
    now = int(clock())
    if abs(now - timestamp) > int(max_skew):
        raise AuthError("timestamp_out_of_window")

    secret = config.secret_for(tenant_id, key_id)
    unknown_principal = secret is None
    effective_secret = _DUMMY_SECRET if unknown_principal else secret

    expected = sign(
        effective_secret, tenant_id, key_id, timestamp_raw, nonce, method, raw_target, body or b""
    )
    signature_ok = hmac.compare_digest(expected, signature)
    if unknown_principal or not signature_ok:
        raise AuthError("unknown_principal" if unknown_principal else "signature_mismatch")

    if not nonce_store.consume(tenant_id, key_id, nonce, now, nonce_ttl):
        raise AuthError("nonce_replay")

    log("auth.accepted", tenant_id=tenant_id, key_id=key_id, method=str(method).upper())
    return Principal(tenant_id=tenant_id, key_id=key_id)


# --------------------------------------------------------------------------- #
# callback URL validation
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CallbackTarget:
    """A callback URL that passed validation, pinned to one checked address."""

    url: str
    hostname: str          # original hostname, used for TLS/SNI and Host header
    host_header: str       # hostname plus non-default port, bracketed for IPv6
    port: int
    ip: str                # validated literal address the transport must dial
    ip_version: int
    request_target: str    # path + query for the outbound request line
    is_literal: bool       # True when the URL already carried an IP literal


def _effective_addresses(text: str) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    """Parse one textual address into every address it can act as.

    IPv4-mapped, 6to4 and Teredo IPv6 addresses are unwrapped so that e.g.
    ``::ffff:127.0.0.1`` is judged as loopback, not as an opaque v6 address.
    """

    try:
        address = ipaddress.ip_address(text)
    except ValueError as exc:
        raise CallbackUrlError("unparsable_address") from exc

    found: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = [address]
    if isinstance(address, ipaddress.IPv6Address):
        for candidate in (address.ipv4_mapped, address.sixtofour, address.teredo[0] if address.teredo else None):
            if candidate is not None:
                found.append(candidate)
    return tuple(found)


def _address_is_safe(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if (
        address.is_loopback
        or address.is_private
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None or address.sixtofour is not None or address.teredo is not None:
            return False
        if address.is_site_local:
            return False
    else:
        if address == ipaddress.IPv4Address("255.255.255.255"):
            return False
    return bool(address.is_global)


def _check_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    candidates = _effective_addresses(text)
    for candidate in candidates:
        if not _address_is_safe(candidate):
            # The offending address itself is never included in the reason.
            raise CallbackUrlError("non_global_address")
    return candidates[0]


class SystemResolver:
    """Real DNS resolver.  Never used by the test suite."""

    def __call__(self, hostname: str) -> list[str]:  # pragma: no cover - network
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
        addresses: list[str] = []
        for info in infos:
            address = info[4][0]
            if address not in addresses:
                addresses.append(address)
        return addresses


def validate_callback_url(
    url: str,
    resolver: Callable[[str], Sequence[str]],
    *,
    allowed_ports: Iterable[int] = ALLOWED_CALLBACK_PORTS,
) -> CallbackTarget:
    """Validate a callback URL and pin it to one verified IP address.

    Raises :class:`CallbackUrlError` for any non-HTTPS scheme, user info,
    fragment, malformed host, disallowed port, unresolvable name, or when *any*
    resolved address is non-global.  Rejecting the whole answer set (rather
    than filtering it) keeps a partially poisoned DNS reply from being used.
    """

    if not isinstance(url, str) or not url or len(url) > 2048:
        raise CallbackUrlError("bad_url_length")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in url):
        raise CallbackUrlError("non_ascii_or_control_in_url")
    if "#" in url:
        raise CallbackUrlError("fragment_present")

    # Imported lazily-by-module (stdlib only) and used for structure, never for
    # deciding trust on its own.
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise CallbackUrlError("unparsable_url") from exc

    if parts.scheme != "https":
        raise CallbackUrlError("scheme_not_https")
    if parts.fragment:
        raise CallbackUrlError("fragment_present")
    if "@" in parts.netloc or parts.username or parts.password:
        raise CallbackUrlError("userinfo_present")

    try:
        port = parts.port
    except ValueError as exc:
        raise CallbackUrlError("bad_port") from exc
    port = 443 if port is None else int(port)
    if port not in frozenset(int(p) for p in allowed_ports):
        raise CallbackUrlError("port_not_allowed")

    hostname = parts.hostname or ""
    if not hostname or len(hostname) > 253:
        raise CallbackUrlError("empty_or_long_host")

    is_literal = False
    try:
        ipaddress.ip_address(hostname)
        is_literal = True
    except ValueError:
        is_literal = False

    if is_literal:
        addresses: list[str] = [hostname]
    else:
        if not _HOSTNAME_RE.match(hostname):
            raise CallbackUrlError("malformed_host")
        try:
            answer = resolver(hostname)
        except CallbackUrlError:
            raise
        except Exception as exc:  # resolver failures are never detailed
            raise CallbackUrlError("resolution_failed") from exc
        addresses = [str(a) for a in (answer or [])]
        if not addresses:
            raise CallbackUrlError("no_addresses")

    chosen = _check_address(addresses[0])
    for extra in addresses[1:]:
        _check_address(extra)

    request_target = parts.path or "/"
    if not request_target.startswith("/"):
        raise CallbackUrlError("bad_path")
    if parts.query:
        request_target = f"{request_target}?{parts.query}"

    if is_literal and chosen.version == 6:
        host_header_host = f"[{hostname}]"
    else:
        host_header_host = hostname
    host_header = host_header_host if port == 443 else f"{host_header_host}:{port}"

    return CallbackTarget(
        url=url,
        hostname=hostname,
        host_header=host_header,
        port=port,
        ip=str(chosen),
        ip_version=int(chosen.version),
        request_target=request_target,
        is_literal=is_literal,
    )


# --------------------------------------------------------------------------- #
# redaction and logging
# --------------------------------------------------------------------------- #

REDACTED = "[redacted]"
MAX_LOGGED_STRING = 200

SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "secret",
    "signature",
    "authorization",
    "auth_header",
    "cookie",
    "password",
    "token",
    "apikey",
    "api_key",
    "nonce",
    "payload",
    "body",
    "response_body",
    "credential",
)

_LONG_HEX_RE = re.compile(r"\b[0-9a-fA-F]{32,}\b")
_HEX_TOKEN = "[redacted:hex]"

#: Metric-style suffixes are safe metadata even when the stem looks sensitive,
#: e.g. ``payload_bytes`` is a length while ``payload`` is content.
_SAFE_METRIC_RE = re.compile(r"_(bytes|count|present|length|size|sha256|fingerprint|id)$")


def _is_sensitive_key(key: str) -> bool:
    flat = str(key).lower().replace("-", "_")
    if _SAFE_METRIC_RE.search(flat):
        return False
    return any(part in flat for part in SENSITIVE_KEY_PARTS)


def redact_value(value: Any, *, _depth: int = 0) -> Any:
    """Return a log-safe copy of ``value``.

    Sensitive keys are replaced wholesale, long hex runs (HMACs, digests, hex
    secrets) are masked, long strings are truncated, and recursion is bounded.
    """

    if _depth > 4:
        return "[truncated:depth]"
    if isinstance(value, str):
        masked = _LONG_HEX_RE.sub(_HEX_TOKEN, value)
        if len(masked) > MAX_LOGGED_STRING:
            masked = masked[:MAX_LOGGED_STRING] + "...[truncated]"
        return masked
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"[bytes:{len(bytes(value))}]"
    if isinstance(value, bool) or value is None or isinstance(value, int) or isinstance(value, float):
        return value
    if isinstance(value, Mapping):
        return {
            str(k): (REDACTED if _is_sensitive_key(k) else redact_value(v, _depth=_depth + 1))
            for k, v in list(value.items())[:32]
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [redact_value(v, _depth=_depth + 1) for v in list(value)[:32]]
    return f"[{type(value).__name__}]"


def redact_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    """Redact a flat log record's fields, dropping sensitive keys entirely."""

    out: dict[str, Any] = {}
    for key, value in fields.items():
        name = str(key)
        out[name] = REDACTED if _is_sensitive_key(name) else redact_value(value)
    return out


class JsonLogger:
    """Structured logger: one compact JSON object per event, always redacted."""

    def __init__(self, sink: Callable[[str], None], *, service: str = "relayvault") -> None:
        self._sink = sink
        self._service = service

    def __call__(self, event: str, **fields: Any) -> None:
        record = {"service": self._service, "event": str(event)}
        record.update(redact_fields(fields))
        self._sink(json.dumps(record, separators=(",", ":"), sort_keys=True, default=str))


def null_log(event: str, **fields: Any) -> None:
    """Discard every log record (default injection)."""

    return None
