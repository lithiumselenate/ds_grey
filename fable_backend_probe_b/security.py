"""Authentication, callback-URL validation, and log redaction for RelayVault.

Design notes
------------
* Every authentication failure raises :class:`AuthError` with the same generic
  message.  Callers must never surface which check failed (tenant, key,
  timestamp, nonce, or signature).
* The signature is lowercase-hex HMAC-SHA256 over::

      tenant_id \n key_id \n timestamp \n nonce \n METHOD \n raw_target \n
      sha256(raw_body).hexdigest()

* Nonce acceptance is atomic (a single lock-protected check-and-insert) and is
  performed only *after* the signature verified, so an invalid signature can
  never consume a nonce.
* Callback URLs must be HTTPS on port 443/8443, without userinfo or fragment.
  Hostnames are resolved through an injected resolver and every returned
  address must be globally routable (IPv4-mapped IPv6 addresses are unwrapped
  and judged as IPv4).
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import secrets as _secrets
import threading
from dataclasses import dataclass
from urllib.parse import urlsplit

__all__ = [
    "AuthError",
    "Authenticator",
    "CallbackURLError",
    "ResolutionError",
    "UnsafeAddressError",
    "NonceCache",
    "ParsedCallback",
    "StructuredLogger",
    "canonical_string",
    "compute_signature",
    "is_safe_address",
    "redact",
    "resolve_and_validate",
    "validate_callback_url",
]

MAX_SKEW_SECONDS = 300
NONCE_TTL_SECONDS = 600
ALLOWED_CALLBACK_PORTS = frozenset({443, 8443})

_SIGNATURE_RE = re.compile(r"[0-9a-f]{64}")
_TIMESTAMP_RE = re.compile(r"[0-9]{1,12}")
_NONCE_RE = re.compile(r"[\x21-\x7e]{1,128}")
_HOSTNAME_RE = re.compile(r"[A-Za-z0-9]([A-Za-z0-9.-]{0,252})?")

_AUTH_HEADER_NAMES = (
    "x-tenant-id",
    "x-key-id",
    "x-timestamp",
    "x-nonce",
    "x-signature",
)

_GENERIC_AUTH_MESSAGE = "authentication_failed"


class AuthError(Exception):
    """Generic authentication failure.  Carries no diagnostic detail."""

    def __init__(self) -> None:
        super().__init__(_GENERIC_AUTH_MESSAGE)


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

def canonical_string(
    tenant_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> bytes:
    """The exact byte sequence covered by the request signature."""
    parts = "\n".join(
        [
            tenant_id,
            key_id,
            timestamp,
            nonce,
            method.upper(),
            raw_target,
            hashlib.sha256(body).hexdigest(),
        ]
    )
    return parts.encode("utf-8")


def compute_signature(
    secret: bytes,
    tenant_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> str:
    """Lowercase hexadecimal HMAC-SHA256 signature for a request."""
    message = canonical_string(
        tenant_id, key_id, timestamp, nonce, method, raw_target, body
    )
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Nonce replay protection
# ---------------------------------------------------------------------------

class NonceCache:
    """In-memory single-use nonce registry scoped by (tenant_id, key_id).

    ``try_consume`` is atomic: under concurrency exactly one caller wins for a
    given (tenant, key, nonce) inside the TTL window.
    """

    def __init__(self, ttl_seconds: int = NONCE_TTL_SECONDS) -> None:
        self._ttl = int(ttl_seconds)
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str, str], int] = {}

    def try_consume(self, tenant_id: str, key_id: str, nonce: str, now: int) -> bool:
        scope = (tenant_id, key_id, nonce)
        with self._lock:
            self._prune(now)
            expiry = self._entries.get(scope)
            if expiry is not None and expiry > now:
                return False
            self._entries[scope] = now + self._ttl
            return True

    def _prune(self, now: int) -> None:
        if len(self._entries) < 4096:
            return
        dead = [k for k, exp in self._entries.items() if exp <= now]
        for key in dead:
            del self._entries[key]


# ---------------------------------------------------------------------------
# Request authentication
# ---------------------------------------------------------------------------

class Authenticator:
    """Verifies signed requests.

    ``secret_lookup(tenant_id, key_id)`` must return the shared secret bytes
    or ``None``.  ``clock`` returns wall-clock Unix seconds.  Secrets are
    injected configuration; nothing here is hard-coded.
    """

    def __init__(
        self,
        secret_lookup,
        clock,
        nonce_cache: NonceCache | None = None,
        max_skew_seconds: int = MAX_SKEW_SECONDS,
    ) -> None:
        self._lookup = secret_lookup
        self._clock = clock
        self._nonces = nonce_cache if nonce_cache is not None else NonceCache()
        self._max_skew = int(max_skew_seconds)
        # Random per-process decoy secret so unknown tenants/keys still pay
        # for a full HMAC computation (uniform failure timing/behaviour).
        self._decoy_secret = _secrets.token_bytes(32)

    def authenticate(self, method: str, raw_target: str, headers, body: bytes) -> str:
        """Return the authenticated tenant_id or raise :class:`AuthError`."""
        values = _extract_auth_headers(headers)
        tenant_id, key_id, timestamp, nonce, signature = values

        # Reject malformed encodings *before* any comparison.
        if _SIGNATURE_RE.fullmatch(signature) is None:
            raise AuthError()
        if _TIMESTAMP_RE.fullmatch(timestamp) is None:
            raise AuthError()
        if _NONCE_RE.fullmatch(nonce) is None:
            raise AuthError()

        now = int(self._clock())
        if abs(int(timestamp) - now) > self._max_skew:
            raise AuthError()

        secret = self._lookup(tenant_id, key_id)
        known = secret is not None
        effective_secret = secret if known else self._decoy_secret
        expected = compute_signature(
            effective_secret,
            tenant_id,
            key_id,
            timestamp,
            nonce,
            method,
            raw_target,
            body,
        )
        matches = hmac.compare_digest(expected, signature)
        if not (known and matches):
            raise AuthError()

        # Only a fully valid signature may consume its nonce.
        if not self._nonces.try_consume(tenant_id, key_id, nonce, now):
            raise AuthError()
        return tenant_id


def _extract_auth_headers(headers) -> tuple[str, str, str, str, str]:
    """Collect the five auth headers; reject missing, repeated, or ambiguous.

    ``headers`` is an iterable of (name, value) pairs exactly as received.
    """
    seen: dict[str, list[str]] = {name: [] for name in _AUTH_HEADER_NAMES}
    for name, value in headers:
        lowered = str(name).strip().lower()
        if lowered in seen:
            seen[lowered].append(str(value))
    out = []
    for name in _AUTH_HEADER_NAMES:
        candidates = seen[name]
        if len(candidates) != 1:
            raise AuthError()
        value = candidates[0].strip()
        if not value or any(c in value for c in "\r\n\x00"):
            raise AuthError()
        out.append(value)
    return tuple(out)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Callback URL validation
# ---------------------------------------------------------------------------

class CallbackURLError(Exception):
    """The callback URL is unacceptable (generic; no address details)."""


class ResolutionError(CallbackURLError):
    """The hostname could not be resolved (classified retryable by workers)."""


class UnsafeAddressError(CallbackURLError):
    """Resolution produced a non-global address (classified terminal)."""


@dataclass(frozen=True)
class ParsedCallback:
    url: str
    hostname: str
    port: int
    target: str  # path plus original query string


def validate_callback_url(url: str) -> ParsedCallback:
    """Syntactic validation of a callback URL.  Raises CallbackURLError."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise CallbackURLError("invalid_callback_url")
    if "#" in url:
        raise CallbackURLError("invalid_callback_url")
    try:
        parts = urlsplit(url)
    except ValueError:
        raise CallbackURLError("invalid_callback_url") from None
    if parts.scheme.lower() != "https":
        raise CallbackURLError("invalid_callback_url")
    if "@" in parts.netloc:
        raise CallbackURLError("invalid_callback_url")
    if parts.fragment:
        raise CallbackURLError("invalid_callback_url")
    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        raise CallbackURLError("invalid_callback_url") from None
    if not hostname:
        raise CallbackURLError("invalid_callback_url")
    if _maybe_ip_literal(hostname) is None and (
        _HOSTNAME_RE.fullmatch(hostname) is None
    ):
        raise CallbackURLError("invalid_callback_url")
    if port is None:
        port = 443
    if port not in ALLOWED_CALLBACK_PORTS:
        raise CallbackURLError("invalid_callback_url")
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    return ParsedCallback(url=url, hostname=hostname, port=port, target=target)


def _effective_address(addr):
    """Unwrap IPv4-mapped IPv6 addresses so they are judged as IPv4."""
    if isinstance(addr, ipaddress.IPv6Address):
        mapped = addr.ipv4_mapped
        if mapped is not None:
            return mapped
    return addr


def is_safe_address(text: str) -> bool:
    """True only for globally routable unicast IPv4/IPv6 addresses."""
    try:
        addr = ipaddress.ip_address(str(text).strip())
    except ValueError:
        return False
    effective = _effective_address(addr)
    if (
        effective.is_loopback
        or effective.is_private
        or effective.is_link_local
        or effective.is_multicast
        or effective.is_reserved
        or effective.is_unspecified
    ):
        return False
    return bool(effective.is_global)


def resolve_and_validate(hostname: str, resolver) -> str:
    """Resolve ``hostname`` via the injected resolver and vet every address.

    Returns one validated global IP (as text) that the transport must use
    directly.  Raises :class:`UnsafeAddressError` if *any* returned address is
    loopback, private, link-local, multicast, reserved, unspecified, or
    otherwise non-global, and :class:`ResolutionError` when resolution fails.
    IP-literal hostnames are validated directly without invoking the resolver.
    """
    literal = _maybe_ip_literal(hostname)
    if literal is not None:
        addresses = [literal]
    else:
        try:
            addresses = [str(a) for a in resolver(hostname)]
        except Exception:
            raise ResolutionError("resolution_failed") from None
        if not addresses:
            raise ResolutionError("resolution_failed")
    for address in addresses:
        if not is_safe_address(address):
            raise UnsafeAddressError("unsafe_address")
    return addresses[0]


def _maybe_ip_literal(hostname: str) -> str | None:
    try:
        return str(ipaddress.ip_address(hostname))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Redaction and structured logging
# ---------------------------------------------------------------------------

REDACTED = "[REDACTED]"

_SENSITIVE_KEYS = frozenset(
    {
        "secret",
        "secrets",
        "signature",
        "x-signature",
        "authorization",
        "payload",
        "body",
        "raw_body",
        "response_body",
        "nonce",
        "x-nonce",
        "idempotency-key",
        "idempotency_key",
        "token",
        "password",
        "key",
    }
)


def redact(value):
    """Recursively mask values whose keys look security-sensitive."""
    if isinstance(value, dict):
        return {
            k: (REDACTED if str(k).lower() in _SENSITIVE_KEYS else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, bytes):
        return REDACTED
    return value


class StructuredLogger:
    """Structured logging through an injectable callable.

    Emits dicts of ``{"event": name, **redact(fields)}``.  Only event names
    and safe metadata should be passed; redaction is a second line of defence.
    """

    def __init__(self, emit=None) -> None:
        self._emit = emit if emit is not None else (lambda record: None)

    def log(self, event: str, **fields) -> None:
        record = {"event": str(event)}
        record.update(redact(fields))
        self._emit(record)
