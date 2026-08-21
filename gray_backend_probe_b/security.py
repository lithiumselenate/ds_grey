"""RelayVault security layer.

Contains transport-independent primitives:

* :class:`Headers` -- case-insensitive, duplicate-aware header view.
* :class:`RequestVerifier` -- HMAC-SHA256 request authentication with
  timestamp skew checks and single-use nonces.
* :func:`validate_callback_url` -- SSRF-hardened callback URL validation
  against an *injected* resolver.
* :func:`redact` -- structured-logging redaction helper.

Nothing in this module performs I/O of its own: clocks, secrets, nonce
storage and hostname resolution are all injected by the caller.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import socket
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

MAX_TIMESTAMP_SKEW_SECONDS = 300
NONCE_TTL_SECONDS = 600
MAX_RAW_TARGET_BYTES = 2048
MAX_URL_LENGTH = 2048
ALLOWED_CALLBACK_PORTS = (443, 8443)

SECURITY_HEADERS = (
    "X-Tenant-ID",
    "X-Key-ID",
    "X-Timestamp",
    "X-Nonce",
    "X-Signature",
)

_SIGNATURE_RE = re.compile(r"\A[0-9a-f]{64}\Z")
_PRINCIPAL_ID_RE = re.compile(r"\A[A-Za-z0-9_.\-]{1,64}\Z")
_TIMESTAMP_RE = re.compile(r"\A-?(?:0|[1-9][0-9]{0,18})\Z")
_NONCE_RE = re.compile(r"\A[A-Za-z0-9_\-]{8,128}\Z")
_RAW_TARGET_RE = re.compile(r"\A/[!-~]*\Z")  # printable ASCII, no space/control
_HOSTNAME_LABEL_RE = re.compile(r"\A[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\Z")

# A key used only so that unknown tenants/keys cost the same HMAC work as
# known ones; it is not a secret and never authenticates anything.
_DECOY_KEY = b"relayvault-decoy-key-not-a-secret"

_SENSITIVE_KEY_RE = re.compile(
    r"(secret|signature|authorization|cookie|token|password|passwd|api[_-]?key"
    r"|payload|body|x-signature|credential)",
    re.IGNORECASE,
)

REDACTED = "[redacted]"


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class AuthError(Exception):
    """Authentication failure.

    ``reason`` is for internal logging only.  The public response code is
    always the generic ``unauthorized`` so clients cannot distinguish an
    unknown tenant from a bad signature, stale timestamp or replayed nonce.
    """

    public_code = "unauthorized"
    public_message = "authentication failed"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class HeaderError(Exception):
    """Missing, repeated or otherwise ambiguous header."""

    def __init__(self, name: str, reason: str) -> None:
        super().__init__(f"{reason}:{name}")
        self.name = name
        self.reason = reason


class UrlValidationError(Exception):
    """Callback URL rejected by policy."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# --------------------------------------------------------------------------
# Headers
# --------------------------------------------------------------------------


class Headers:
    """Immutable, duplicate-preserving, case-insensitive header collection."""

    __slots__ = ("_items",)

    def __init__(self, items: "Mapping[str, str] | Iterable[tuple[str, str]]") -> None:
        if isinstance(items, Headers):
            pairs = list(items.items())
        elif isinstance(items, Mapping):
            pairs = [(str(k), str(v)) for k, v in items.items()]
        else:
            pairs = [(str(k), str(v)) for k, v in items]
        self._items = tuple(pairs)

    def items(self) -> tuple[tuple[str, str], ...]:
        return self._items

    def get_all(self, name: str) -> list[str]:
        lowered = name.lower()
        return [v for k, v in self._items if k.lower() == lowered]

    def count(self, name: str) -> int:
        return len(self.get_all(name))

    def unique(self, name: str, *, required: bool = False) -> str | None:
        """Return the single value of ``name``.

        Raises :class:`HeaderError` when the header repeats (even with an
        identical value), when it is required but absent, or when its value
        is ambiguous (empty after trimming, or non-ASCII/control bytes).
        """
        values = self.get_all(name)
        if len(values) > 1:
            raise HeaderError(name, "repeated_header")
        if not values:
            if required:
                raise HeaderError(name, "missing_header")
            return None
        raw = values[0]
        if "\r" in raw or "\n" in raw or "\x00" in raw:
            raise HeaderError(name, "ambiguous_header")
        value = raw.strip(" \t")
        if not value:
            raise HeaderError(name, "ambiguous_header")
        if not value.isascii() or not value.isprintable():
            raise HeaderError(name, "ambiguous_header")
        return value


# --------------------------------------------------------------------------
# Secret providers / nonce store protocol
# --------------------------------------------------------------------------


class StaticSecretProvider:
    """Injected tenant/key secret configuration.

    Secrets are supplied by the embedding process (environment, file, KMS,
    ...).  No secret is ever hard-coded in this module.
    """

    def __init__(self, secrets: Mapping[tuple[str, str], bytes | str]) -> None:
        table: dict[tuple[str, str], bytes] = {}
        for (tenant_id, key_id), secret in secrets.items():
            if isinstance(secret, str):
                secret = secret.encode("utf-8")
            table[(str(tenant_id), str(key_id))] = bytes(secret)
        self._table = table

    def __call__(self, tenant_id: str, key_id: str) -> bytes | None:
        return self._table.get((tenant_id, key_id))


class InMemoryNonceStore:
    """Reference nonce store (single process, used by tests and demos).

    The production store lives in :mod:`store` and is atomic across
    connections; this one is atomic across threads.
    """

    def __init__(self) -> None:
        import threading

        self._lock = threading.Lock()
        self._seen: dict[tuple[str, str, str], int] = {}

    def claim_nonce(
        self, tenant_id: str, key_id: str, nonce: str, now: int, ttl_seconds: int
    ) -> bool:
        key = (tenant_id, key_id, nonce)
        with self._lock:
            for existing, expires in list(self._seen.items()):
                if expires <= now:
                    del self._seen[existing]
            if key in self._seen:
                return False
            self._seen[key] = now + ttl_seconds
            return True


# --------------------------------------------------------------------------
# Request authentication
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    key_id: str
    timestamp: int
    nonce: str


def canonical_signing_bytes(
    tenant_id: str, key_id: str, timestamp: str, nonce: str, method: str,
    raw_target: str, body: bytes,
) -> bytes:
    """Build the exact byte sequence that is signed.

    ``tenant_id \\n key_id \\n timestamp \\n nonce \\n METHOD \\n raw_target
    \\n sha256(body).hexdigest()`` with no trailing newline.  ``raw_target``
    is used verbatim, including its original query string.
    """
    body_digest = hashlib.sha256(body).hexdigest()
    parts = (
        tenant_id,
        key_id,
        timestamp,
        nonce,
        method.upper(),
        raw_target,
        body_digest,
    )
    return "\n".join(parts).encode("utf-8")


def compute_signature(
    secret: bytes, tenant_id: str, key_id: str, timestamp: str, nonce: str,
    method: str, raw_target: str, body: bytes,
) -> str:
    """Lowercase hex HMAC-SHA256 of the canonical signing bytes."""
    message = canonical_signing_bytes(
        tenant_id, key_id, timestamp, nonce, method, raw_target, body
    )
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


class RequestVerifier:
    """Verifies signed requests.

    Ordering matters: the signature is checked *before* the nonce is
    consumed, so an invalid signature can never burn a valid nonce.
    """

    def __init__(
        self,
        secret_provider: Callable[[str, str], bytes | None],
        nonce_store: Any,
        clock: Callable[[], float],
        *,
        max_skew_seconds: int = MAX_TIMESTAMP_SKEW_SECONDS,
        nonce_ttl_seconds: int = NONCE_TTL_SECONDS,
    ) -> None:
        self._secret_provider = secret_provider
        self._nonce_store = nonce_store
        self._clock = clock
        self._max_skew = int(max_skew_seconds)
        self._nonce_ttl = int(nonce_ttl_seconds)

    def verify(
        self, method: str, raw_target: str, headers: Headers, body: bytes
    ) -> Principal:
        if not isinstance(headers, Headers):
            headers = Headers(headers)
        try:
            tenant_id = headers.unique("X-Tenant-ID", required=True)
            key_id = headers.unique("X-Key-ID", required=True)
            timestamp_raw = headers.unique("X-Timestamp", required=True)
            nonce = headers.unique("X-Nonce", required=True)
            signature = headers.unique("X-Signature", required=True)
        except HeaderError as exc:
            raise AuthError(exc.reason) from None

        assert tenant_id and key_id and timestamp_raw and nonce and signature

        if not _PRINCIPAL_ID_RE.match(tenant_id):
            raise AuthError("malformed_tenant_id")
        if not _PRINCIPAL_ID_RE.match(key_id):
            raise AuthError("malformed_key_id")
        if not _NONCE_RE.match(nonce):
            raise AuthError("malformed_nonce")
        if not _TIMESTAMP_RE.match(timestamp_raw):
            raise AuthError("malformed_timestamp")
        # Reject malformed signature encodings *before* any comparison.
        if not _SIGNATURE_RE.match(signature):
            raise AuthError("malformed_signature")
        if not _RAW_TARGET_RE.match(raw_target) or len(
            raw_target.encode("utf-8")
        ) > MAX_RAW_TARGET_BYTES:
            raise AuthError("malformed_target")

        timestamp = int(timestamp_raw)
        now = int(self._clock())
        if abs(now - timestamp) > self._max_skew:
            raise AuthError("timestamp_out_of_window")

        secret = self._secret_provider(tenant_id, key_id)
        # Always run the HMAC so unknown principals are not distinguishable
        # by response content or by obvious timing differences.
        expected = compute_signature(
            secret if secret is not None else _DECOY_KEY,
            tenant_id, key_id, timestamp_raw, nonce, method, raw_target, body,
        )
        signature_ok = hmac.compare_digest(expected, signature)
        if secret is None or not signature_ok:
            raise AuthError("bad_signature")

        if not self._nonce_store.claim_nonce(
            tenant_id, key_id, nonce, now, self._nonce_ttl
        ):
            raise AuthError("nonce_replayed")

        return Principal(
            tenant_id=tenant_id, key_id=key_id, timestamp=timestamp, nonce=nonce
        )


# --------------------------------------------------------------------------
# Callback URL validation (SSRF defence)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidatedCallback:
    """Result of callback validation.

    ``ip``/``family`` are handed to the transport *separately* from
    ``hostname`` so the transport never resolves the name itself, while
    ``hostname`` is still available for TLS/SNI and the HTTP Host header.
    """

    url: str
    hostname: str
    port: int
    target: str
    ip: str
    family: int
    addresses: tuple[str, ...] = field(default=())


def _normalise_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """Parse a textual address, unmapping IPv4-mapped IPv6 addresses."""
    candidate = text.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if "%" in candidate:  # scoped/zoned IPv6 is never a global destination
        raise UrlValidationError("scoped_address")
    address = ipaddress.ip_address(candidate)
    if isinstance(address, ipaddress.IPv6Address):
        mapped = address.ipv4_mapped
        if mapped is not None:
            return mapped
        if address.sixtofour is not None:
            return address.sixtofour
        if address.teredo is not None:
            return address.teredo[1]
    return address


def _assert_global(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
    if (
        address.is_loopback
        or address.is_private
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or not address.is_global
    ):
        raise UrlValidationError("non_global_address")


def _validate_hostname(hostname: str) -> None:
    if not hostname or len(hostname) > 253:
        raise UrlValidationError("bad_hostname")
    if hostname.endswith("."):
        raise UrlValidationError("bad_hostname")
    if not hostname.isascii():
        raise UrlValidationError("bad_hostname")
    for label in hostname.split("."):
        if not _HOSTNAME_LABEL_RE.match(label):
            raise UrlValidationError("bad_hostname")


def validate_callback_url(
    url: str, resolver: Callable[[str], Sequence[str]]
) -> ValidatedCallback:
    """Validate ``url`` for outbound delivery.

    Enforces HTTPS-only, no userinfo, no fragment, allow-listed ports and a
    fully global resolved address set.  The URL is rejected when *any*
    resolved address is non-global, so a mixed safe/unsafe DNS answer never
    yields a delivery attempt.
    """
    from urllib.parse import urlsplit

    if not isinstance(url, str) or not url:
        raise UrlValidationError("empty_url")
    if len(url) > MAX_URL_LENGTH:
        raise UrlValidationError("url_too_long")
    if not url.isascii():
        raise UrlValidationError("non_ascii_url")
    if any(ch.isspace() or not ch.isprintable() for ch in url):
        raise UrlValidationError("malformed_url")
    if "#" in url:
        raise UrlValidationError("fragment_not_allowed")

    try:
        parts = urlsplit(url)
    except ValueError:
        raise UrlValidationError("malformed_url") from None

    if parts.scheme != "https":
        raise UrlValidationError("scheme_not_https")
    if parts.fragment:
        raise UrlValidationError("fragment_not_allowed")
    if "@" in parts.netloc or parts.username or parts.password:
        raise UrlValidationError("userinfo_not_allowed")

    try:
        port = parts.port
    except ValueError:
        raise UrlValidationError("bad_port") from None
    if port is None:
        port = 443
    if port not in ALLOWED_CALLBACK_PORTS:
        raise UrlValidationError("port_not_allowed")

    hostname = parts.hostname or ""
    if not hostname:
        raise UrlValidationError("bad_hostname")

    literal: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        literal = _normalise_address(hostname)
    except UrlValidationError:
        raise
    except ValueError:
        literal = None

    if literal is not None:
        addresses = [literal]
    else:
        _validate_hostname(hostname)
        answers = resolver(hostname)
        if isinstance(answers, (str, bytes)):
            raise UrlValidationError("bad_resolver_answer")
        answers = list(answers)
        if not answers:
            raise UrlValidationError("no_addresses")
        addresses = []
        for answer in answers:
            try:
                addresses.append(_normalise_address(str(answer)))
            except UrlValidationError:
                raise
            except ValueError:
                raise UrlValidationError("bad_resolver_answer") from None

    for address in addresses:
        _assert_global(address)

    chosen = addresses[0]
    family = (
        socket.AF_INET if isinstance(chosen, ipaddress.IPv4Address) else socket.AF_INET6
    )
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"

    return ValidatedCallback(
        url=url,
        hostname=hostname,
        port=port,
        target=target,
        ip=str(chosen),
        family=family,
        addresses=tuple(str(a) for a in addresses),
    )


class SystemResolver:
    """Default resolver used by the runnable service (never used in tests)."""

    def __init__(self, getaddrinfo: Callable[..., Any] | None = None) -> None:
        self._getaddrinfo = getaddrinfo or socket.getaddrinfo

    def __call__(self, hostname: str) -> list[str]:
        infos = self._getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        seen: list[str] = []
        for info in infos:
            address = info[4][0]
            if address not in seen:
                seen.append(address)
        return seen


# --------------------------------------------------------------------------
# Redaction helper
# --------------------------------------------------------------------------


def redact(value: Any, *, secrets: Iterable[str] = (), max_string: int = 96) -> Any:
    """Return a log-safe copy of ``value``.

    * mapping keys that look sensitive (secret, signature, payload, token,
      cookie, authorization, ...) are replaced by ``[redacted]``;
    * any literal secret from ``secrets`` found inside a string is replaced;
    * long strings are truncated so payload-sized data cannot leak by
      accident.
    """
    secret_list = [s for s in secrets if isinstance(s, str) and s]

    def scrub_text(text: str) -> str:
        for secret in secret_list:
            if secret in text:
                text = text.replace(secret, REDACTED)
        if len(text) > max_string:
            text = text[:max_string] + f"...[{len(text)}B truncated]"
        return text

    def walk(node: Any, depth: int) -> Any:
        if depth > 8:
            return REDACTED
        if isinstance(node, Mapping):
            result: dict[str, Any] = {}
            for key, item in node.items():
                key_text = str(key)
                if _SENSITIVE_KEY_RE.search(key_text):
                    result[key_text] = REDACTED
                else:
                    result[key_text] = walk(item, depth + 1)
            return result
        if isinstance(node, (list, tuple, set, frozenset)):
            return [walk(item, depth + 1) for item in node]
        if isinstance(node, str):
            return scrub_text(node)
        if isinstance(node, bytes):
            return f"<{len(node)} bytes>"
        if isinstance(node, (int, float, bool)) or node is None:
            return node
        return scrub_text(repr(node))

    return walk(value, 0)
