"""Authentication, request signing, callback-URL validation, and redaction.

Every authentication failure raises :class:`AuthenticationError` carrying the
same generic message, so callers can never learn whether the tenant, key,
timestamp, nonce, or signature was wrong.  Every rejected callback URL raises
:class:`CallbackURLError` without embedding resolved addresses.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import socket
import threading
import urllib.parse
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence, Tuple

GENERIC_AUTH_ERROR = "unauthorized"
MAX_TIMESTAMP_SKEW_SECONDS = 300
NONCE_TTL_SECONDS = 600
ALLOWED_CALLBACK_PORTS = frozenset({443, 8443})
REDACTED = "[REDACTED]"

REQUIRED_AUTH_HEADERS = (
    "x-tenant-id",
    "x-key-id",
    "x-timestamp",
    "x-nonce",
    "x-signature",
)

_SIGNATURE_RE = re.compile(r"\A[0-9a-f]{64}\Z")
_TIMESTAMP_RE = re.compile(r"\A[0-9]{1,20}\Z")
_NONCE_RE = re.compile(r"\A[\x21-\x7e]{1,128}\Z")
_IDENTIFIER_RE = re.compile(r"\A[\x21-\x7e]{1,128}\Z")
_HOSTNAME_LABEL_RE = re.compile(r"\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\Z")

# Constant-size stand-in secret so unknown credentials still perform one HMAC
# computation and one constant-time comparison before failing generically.
_DUMMY_SECRET = b"\x00" * 32

_SENSITIVE_KEY_SUBSTRINGS = ("secret", "signature", "password", "token", "authorization")
_SENSITIVE_KEYS_EXACT = frozenset(
    {"payload", "body", "raw_body", "response_body", "response_snippet", "callback_response"}
)


class AuthenticationError(Exception):
    """Generic authentication failure; intentionally reason-free."""

    def __init__(self) -> None:
        super().__init__(GENERIC_AUTH_ERROR)


class CallbackURLError(Exception):
    """Generic callback URL rejection; intentionally address-free."""

    def __init__(self) -> None:
        super().__init__("callback_url_rejected")


def canonical_message(
    tenant_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> bytes:
    """Exact byte sequence covered by the request signature."""
    body_hash = hashlib.sha256(body).hexdigest()
    text = "\n".join(
        (tenant_id, key_id, timestamp, nonce, method.upper(), raw_target, body_hash)
    )
    return text.encode("utf-8")


def sign_request(
    secret: bytes,
    tenant_id: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    raw_target: str,
    body: bytes,
) -> str:
    """Lowercase hexadecimal HMAC-SHA256 over the canonical message."""
    message = canonical_message(tenant_id, key_id, timestamp, nonce, method, raw_target, body)
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


class InMemoryNonceStore:
    """Atomic single-use nonce tracking scoped by (tenant_id, key_id)."""

    def __init__(self, ttl_seconds: int = NONCE_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._seen: dict = {}

    def consume(self, tenant_id: str, key_id: str, nonce: str, now: int) -> bool:
        """Atomically record the nonce; False when already used within TTL."""
        key = (tenant_id, key_id, nonce)
        with self._lock:
            for stale in [k for k, expiry in self._seen.items() if expiry <= now]:
                del self._seen[stale]
            if key in self._seen:
                return False
            self._seen[key] = now + self._ttl
            return True


class Authenticator:
    """Verifies signed requests.

    ``credentials`` is an injected callable ``(tenant_id, key_id) -> secret
    bytes or None`` — secrets are configuration, never hard-coded here.
    ``clock`` is the injected wall clock returning Unix seconds.
    """

    def __init__(
        self,
        credentials: Callable[[str, str], Optional[bytes]],
        clock: Callable[[], float],
        nonce_store: InMemoryNonceStore,
        max_skew_seconds: int = MAX_TIMESTAMP_SKEW_SECONDS,
    ) -> None:
        self._credentials = credentials
        self._clock = clock
        self._nonce_store = nonce_store
        self._max_skew = max_skew_seconds

    def authenticate(
        self,
        method: str,
        raw_target: str,
        headers: Mapping[str, Sequence[str]],
        body: bytes,
    ) -> Tuple[str, str]:
        """Return (tenant_id, key_id) or raise generic AuthenticationError.

        ``headers`` maps lowercase header names to the list of received
        values; each security header must appear exactly once and be
        unambiguous.  ``raw_target`` must be the raw request target including
        any original query string.  The nonce is consumed only after the
        signature verifies, so an invalid signature never burns a nonce.
        """
        values = {}
        for name in REQUIRED_AUTH_HEADERS:
            received = headers.get(name, [])
            if len(received) != 1:
                raise AuthenticationError()
            value = received[0].strip()
            if not value:
                raise AuthenticationError()
            values[name] = value

        tenant_id = values["x-tenant-id"]
        key_id = values["x-key-id"]
        timestamp = values["x-timestamp"]
        nonce = values["x-nonce"]
        signature = values["x-signature"]

        if not _IDENTIFIER_RE.match(tenant_id) or not _IDENTIFIER_RE.match(key_id):
            raise AuthenticationError()
        # Reject malformed signature encodings before any comparison.
        if not _SIGNATURE_RE.match(signature):
            raise AuthenticationError()
        if not _NONCE_RE.match(nonce):
            raise AuthenticationError()
        if not _TIMESTAMP_RE.match(timestamp):
            raise AuthenticationError()

        now = int(self._clock())
        if abs(int(timestamp) - now) > self._max_skew:
            raise AuthenticationError()

        secret = self._credentials(tenant_id, key_id)
        known = secret is not None
        expected = sign_request(
            secret if known else _DUMMY_SECRET,
            tenant_id,
            key_id,
            timestamp,
            nonce,
            method,
            raw_target,
            body,
        )
        matches = hmac.compare_digest(expected, signature)
        if not (matches and known):
            raise AuthenticationError()

        # Only a fully valid signature may consume its nonce; consumption is
        # atomic under concurrent requests.
        if not self._nonce_store.consume(tenant_id, key_id, nonce, now):
            raise AuthenticationError()
        return tenant_id, key_id


@dataclass(frozen=True)
class ValidatedCallback:
    """A callback URL whose destination addresses were all verified global.

    ``ip`` is the single validated address the transport must connect to;
    ``host`` is the original hostname preserved for TLS/SNI and Host headers.
    """

    url: str
    host: str
    port: int
    request_target: str
    ip: str
    addresses: Tuple[str, ...]


def _effective_address(ip):
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            return mapped
    return ip


def address_is_global(ip) -> bool:
    """True only for globally routable unicast addresses.

    IPv4-mapped IPv6 addresses are unwrapped and judged as their IPv4 value.
    """
    ip = _effective_address(ip)
    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    return ip.is_global


def _valid_hostname(hostname: str) -> bool:
    if not hostname or len(hostname) > 253:
        return False
    labels = hostname.lower().split(".")
    return all(_HOSTNAME_LABEL_RE.match(label) for label in labels)


def validate_callback_url(
    url: str, resolver: Callable[[str], Sequence[str]]
) -> ValidatedCallback:
    """Validate a callback URL and resolve it through the injected resolver.

    Rejects non-HTTPS schemes, userinfo, fragments, empty or malformed
    hostnames, and ports other than 443/8443.  Every resolved address (or the
    textual IP literal itself) must be globally routable; a single unsafe
    answer rejects the whole URL.  Callers must re-run this immediately
    before each delivery attempt to defend against DNS rebinding.
    """
    if not isinstance(url, str) or "#" in url:
        raise CallbackURLError()
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        raise CallbackURLError() from None
    if parts.scheme != "https":
        raise CallbackURLError()
    try:
        if parts.username is not None or parts.password is not None:
            raise CallbackURLError()
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        raise CallbackURLError() from None
    if not hostname:
        raise CallbackURLError()
    if port is None:
        port = 443
    if port not in ALLOWED_CALLBACK_PORTS:
        raise CallbackURLError()

    addresses = []
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        addresses.append(literal)
    else:
        if not _valid_hostname(hostname):
            raise CallbackURLError()
        try:
            resolved = list(resolver(hostname))
        except Exception:
            raise CallbackURLError() from None
        if not resolved:
            raise CallbackURLError()
        for item in resolved:
            try:
                addresses.append(ipaddress.ip_address(item))
            except ValueError:
                raise CallbackURLError() from None

    for address in addresses:
        if not address_is_global(address):
            raise CallbackURLError()

    request_target = parts.path or "/"
    if parts.query:
        request_target = request_target + "?" + parts.query
    return ValidatedCallback(
        url=url,
        host=hostname,
        port=port,
        request_target=request_target,
        ip=str(addresses[0]),
        addresses=tuple(str(a) for a in addresses),
    )


def default_resolver(hostname: str) -> Sequence[str]:
    """Production resolver (system DNS). Tests must inject fakes instead."""
    infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    return sorted({info[4][0] for info in infos})


def redact(value):
    """Recursively mask sensitive fields for structured logging.

    Masks any mapping key that names secrets, signatures, passwords, tokens,
    or authorization material, plus payload/body/response contents.
    """
    if isinstance(value, Mapping):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in _SENSITIVE_KEYS_EXACT or any(
                marker in lowered for marker in _SENSITIVE_KEY_SUBSTRINGS
            ):
                out[key] = REDACTED
            else:
                out[key] = redact(item)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value
