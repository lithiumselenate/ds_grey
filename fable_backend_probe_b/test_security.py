"""Tests for security.py: HMAC authentication, nonces, URLs, redaction."""
import threading
import unittest

import security
from security import (
    AuthError,
    Authenticator,
    NonceCache,
    ResolutionError,
    StructuredLogger,
    UnsafeAddressError,
    compute_signature,
    is_safe_address,
    redact,
    resolve_and_validate,
    validate_callback_url,
)

SECRET = b"unit-test-secret-not-production"
NOW = 1_700_000_000


class FakeClock:
    def __init__(self, value=NOW):
        self.value = value

    def __call__(self):
        return self.value


def lookup(tenant, key_id):
    if (tenant, key_id) == ("t1", "k1"):
        return SECRET
    return None


def signed_headers(method, target, body, *, tenant="t1", key="k1", ts=str(NOW),
                   nonce="nonce-0001", secret=SECRET, signature=None):
    sig = signature if signature is not None else compute_signature(
        secret, tenant, key, ts, nonce, method, target, body
    )
    return [
        ("X-Tenant-ID", tenant),
        ("X-Key-ID", key),
        ("X-Timestamp", ts),
        ("X-Nonce", nonce),
        ("X-Signature", sig),
    ]


def make_auth(clock=None):
    return Authenticator(lookup, clock or FakeClock())


class AuthenticationTests(unittest.TestCase):
    def test_valid_request_authenticates(self):
        auth = make_auth()
        body = b'{"x":1}'
        headers = signed_headers("POST", "/v1/events?a=b", body)
        self.assertEqual(
            auth.authenticate("POST", "/v1/events?a=b", headers, body), "t1"
        )

    def test_mutated_body_invalidates_signature(self):
        auth = make_auth()
        headers = signed_headers("POST", "/v1/events", b'{"x":1}')
        with self.assertRaises(AuthError):
            auth.authenticate("POST", "/v1/events", headers, b'{"x":2}')

    def test_mutated_raw_target_invalidates_signature(self):
        auth = make_auth()
        headers = signed_headers("GET", "/v1/jobs/abc", b"")
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/v1/jobs/abc?admin=1", headers, b"")

    def test_query_string_is_part_of_signed_value(self):
        auth = make_auth()
        headers = signed_headers("GET", "/v1/jobs/abc?x=1", b"")
        self.assertEqual(
            auth.authenticate("GET", "/v1/jobs/abc?x=1", headers, b""), "t1"
        )

    def test_malformed_signatures_rejected(self):
        auth = make_auth()
        good = compute_signature(
            SECRET, "t1", "k1", str(NOW), "nonce-0001", "GET", "/", b""
        )
        for bad in [good.upper(), good[:-1], good + "0", "zz" * 32, "", "0x" + good]:
            headers = signed_headers("GET", "/", b"", signature=bad)
            with self.assertRaises(AuthError):
                auth.authenticate("GET", "/", headers, b"")

    def test_wrong_secret_rejected_generically(self):
        auth = make_auth()
        headers = signed_headers("GET", "/", b"", secret=b"other")
        with self.assertRaises(AuthError) as ctx:
            auth.authenticate("GET", "/", headers, b"")
        self.assertEqual(str(ctx.exception), "authentication_failed")

    def test_unknown_tenant_same_generic_error(self):
        auth = make_auth()
        headers = signed_headers("GET", "/", b"", tenant="ghost")
        with self.assertRaises(AuthError) as ctx:
            auth.authenticate("GET", "/", headers, b"")
        self.assertEqual(str(ctx.exception), "authentication_failed")

    def test_timestamp_boundaries(self):
        for offset, ok in [(-300, True), (300, True), (-301, False), (301, False)]:
            auth = make_auth()
            ts = str(NOW + offset)
            headers = signed_headers("GET", "/", b"", ts=ts,
                                     nonce=f"n-{offset}-x1")
            if ok:
                self.assertEqual(auth.authenticate("GET", "/", headers, b""), "t1")
            else:
                with self.assertRaises(AuthError):
                    auth.authenticate("GET", "/", headers, b"")

    def test_non_integer_timestamp_rejected(self):
        auth = make_auth()
        for ts in ["", "12.5", "-5", "abc", " 170"]:
            headers = signed_headers("GET", "/", b"", ts=ts, nonce="n-" + repr(ts))
            with self.assertRaises(AuthError):
                auth.authenticate("GET", "/", headers, b"")

    def test_missing_and_repeated_headers_rejected(self):
        auth = make_auth()
        base = signed_headers("GET", "/", b"")
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/", base[:-1], b"")  # missing signature
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/", base + [("X-Nonce", "evil")], b"")
        # Case-varied duplicate is still ambiguous.
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/", base + [("x-tenant-id", "t2")], b"")

    def test_nonce_replay_rejected(self):
        auth = make_auth()
        headers = signed_headers("GET", "/", b"", nonce="replay-me")
        self.assertEqual(auth.authenticate("GET", "/", headers, b""), "t1")
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/", headers, b"")

    def test_invalid_signature_does_not_burn_nonce(self):
        auth = make_auth()
        bad = signed_headers("GET", "/", b"", nonce="precious", secret=b"wrong")
        with self.assertRaises(AuthError):
            auth.authenticate("GET", "/", bad, b"")
        good = signed_headers("GET", "/", b"", nonce="precious")
        self.assertEqual(auth.authenticate("GET", "/", good, b""), "t1")

    def test_concurrent_nonce_reuse_admits_exactly_one(self):
        auth = make_auth()
        headers = signed_headers("GET", "/", b"", nonce="contended")
        results = []
        barrier = threading.Barrier(8)

        def attempt():
            barrier.wait()
            try:
                auth.authenticate("GET", "/", headers, b"")
                results.append("ok")
            except AuthError:
                results.append("denied")

        threads = [threading.Thread(target=attempt) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results.count("ok"), 1)
        self.assertEqual(results.count("denied"), 7)

    def test_nonce_scoped_by_tenant_and_key(self):
        cache = NonceCache()
        self.assertTrue(cache.try_consume("t1", "k1", "n", NOW))
        self.assertTrue(cache.try_consume("t2", "k1", "n", NOW))
        self.assertTrue(cache.try_consume("t1", "k2", "n", NOW))
        self.assertFalse(cache.try_consume("t1", "k1", "n", NOW + 599))
        self.assertTrue(cache.try_consume("t1", "k1", "n", NOW + 600))


class CallbackURLTests(unittest.TestCase):
    def test_valid_https_urls(self):
        parsed = validate_callback_url("https://hooks.example.test/delivery?a=1")
        self.assertEqual(parsed.hostname, "hooks.example.test")
        self.assertEqual(parsed.port, 443)
        self.assertEqual(parsed.target, "/delivery?a=1")
        self.assertEqual(
            validate_callback_url("https://hooks.example.test:8443/x").port, 8443
        )

    def test_rejected_urls(self):
        bad = [
            "http://hooks.example.test/x",  # scheme
            "ftp://hooks.example.test/x",
            "https://user@hooks.example.test/x",  # userinfo
            "https://user:pw@hooks.example.test/x",
            "https://hooks.example.test/x#frag",  # fragment
            "https://hooks.example.test/x#",
            "https:///x",  # empty host
            "https://",
            "https://hooks.example.test:80/x",  # port
            "https://hooks.example.test:65536/x",  # malformed port
            "https://exa mple.test/x",
            "",
        ]
        for url in bad:
            with self.assertRaises(security.CallbackURLError, msg=url):
                validate_callback_url(url)

    def test_address_safety(self):
        unsafe = [
            "127.0.0.1", "10.0.0.1", "192.168.1.9", "172.16.0.1",  # loopback/private
            "169.254.1.1", "fe80::1",  # link-local
            "224.0.0.1", "ff02::1",  # multicast
            "0.0.0.0", "::",  # unspecified
            "::1", "fc00::1", "100.64.0.1", "203.0.113.5",  # non-global
            "::ffff:10.0.0.1", "::ffff:127.0.0.1",  # IPv4-mapped IPv6
            "not-an-ip",
        ]
        for addr in unsafe:
            self.assertFalse(is_safe_address(addr), addr)
        for addr in ["93.184.216.34", "2606:4700:4700::1111",
                     "::ffff:93.184.216.34"]:
            self.assertTrue(is_safe_address(addr), addr)

    def test_resolver_all_addresses_must_be_safe(self):
        resolver = lambda host: ["93.184.216.34", "10.0.0.1"]  # noqa: E731
        with self.assertRaises(UnsafeAddressError):
            resolve_and_validate("hooks.example.test", resolver)

    def test_resolver_multiple_safe_addresses(self):
        resolver = lambda host: ["93.184.216.34", "2606:4700:4700::1111"]  # noqa: E731
        self.assertEqual(
            resolve_and_validate("hooks.example.test", resolver), "93.184.216.34"
        )

    def test_ip_literals_bypass_resolver(self):
        def resolver(host):
            raise AssertionError("resolver must not be called for literals")

        self.assertEqual(
            resolve_and_validate("93.184.216.34", resolver), "93.184.216.34"
        )
        with self.assertRaises(UnsafeAddressError):
            resolve_and_validate("127.0.0.1", resolver)
        with self.assertRaises(UnsafeAddressError):
            resolve_and_validate("::ffff:10.0.0.1", resolver)

    def test_ipv6_literal_url(self):
        parsed = validate_callback_url("https://[2606:4700:4700::1111]/hook")
        self.assertEqual(parsed.hostname, "2606:4700:4700::1111")

    def test_resolution_failures_raise_resolution_error(self):
        def broken(host):
            raise OSError("nxdomain")

        with self.assertRaises(ResolutionError):
            resolve_and_validate("hooks.example.test", broken)
        with self.assertRaises(ResolutionError):
            resolve_and_validate("hooks.example.test", lambda host: [])


class RedactionTests(unittest.TestCase):
    def test_redact_masks_sensitive_keys_recursively(self):
        record = redact(
            {
                "event": "x",
                "signature": "deadbeef",
                "nested": {"secret": "s3cr3t", "payload": {"card": "4111"}},
                "items": [{"token": "abc"}],
                "safe": 5,
            }
        )
        self.assertEqual(record["signature"], security.REDACTED)
        self.assertEqual(record["nested"]["secret"], security.REDACTED)
        self.assertEqual(record["nested"]["payload"], security.REDACTED)
        self.assertEqual(record["items"][0]["token"], security.REDACTED)
        self.assertEqual(record["safe"], 5)

    def test_structured_logger_redacts(self):
        events = []
        logger = StructuredLogger(events.append)
        logger.log("evt", tenant_id="t1", signature="deadbeef", body=b"raw")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "evt")
        self.assertEqual(events[0]["tenant_id"], "t1")
        self.assertNotIn("deadbeef", repr(events[0]))
        self.assertNotIn("raw", repr(events[0]))


if __name__ == "__main__":
    unittest.main()
