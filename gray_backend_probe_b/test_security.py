"""Tests for RelayVault authentication, URL validation and redaction."""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import unittest

import security
from security import (
    AuthError,
    Headers,
    RequestVerifier,
    StaticSecretProvider,
    UrlValidationError,
    compute_signature,
    redact,
    validate_callback_url,
)
from store import Store

TENANT = "tenant_alpha"
KEY_ID = "key_1"
# Test-only material; production secrets are injected, never hard-coded.
SECRET = b"unit-test-secret-alpha-0001"


class FakeClock:
    def __init__(self, now: int = 1_700_000_000) -> None:
        self.now = float(now)

    def __call__(self) -> float:
        return self.now


class RecordingResolver:
    def __init__(self, table: dict[str, list[str]]) -> None:
        self.table = table
        self.calls: list[str] = []

    def __call__(self, hostname: str) -> list[str]:
        self.calls.append(hostname)
        return list(self.table.get(hostname, []))


def signed_headers(
    method: str,
    raw_target: str,
    body: bytes,
    *,
    tenant: str = TENANT,
    key_id: str = KEY_ID,
    secret: bytes = SECRET,
    timestamp: int = 1_700_000_000,
    nonce: str = "nonce-00000001",
    signature: str | None = None,
    extra: list[tuple[str, str]] | None = None,
) -> list[tuple[str, str]]:
    if signature is None:
        signature = compute_signature(
            secret, tenant, key_id, str(timestamp), nonce, method, raw_target, body
        )
    headers = [
        ("X-Tenant-ID", tenant),
        ("X-Key-ID", key_id),
        ("X-Timestamp", str(timestamp)),
        ("X-Nonce", nonce),
        ("X-Signature", signature),
    ]
    headers.extend(extra or [])
    return headers


class VerifierTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = os.path.join(self._tmp.name, "auth.sqlite3")
        self.clock = FakeClock()
        self.store = Store(self.db_path, clock=self.clock)
        self.addCleanup(self.store.close)
        self.verifier = RequestVerifier(
            StaticSecretProvider({(TENANT, KEY_ID): SECRET}), self.store, self.clock
        )

    def verify(self, method: str, target: str, body: bytes, headers) -> object:
        return self.verifier.verify(method, target, Headers(headers), body)


class TestValidAuthentication(VerifierTestCase):
    def test_valid_signature_accepted(self) -> None:
        body = b'{"a":1}'
        headers = signed_headers("POST", "/v1/events", body)
        principal = self.verify("POST", "/v1/events", body, headers)
        self.assertEqual(principal.tenant_id, TENANT)
        self.assertEqual(principal.key_id, KEY_ID)
        self.assertEqual(principal.nonce, "nonce-00000001")

    def test_raw_target_query_string_is_part_of_signature(self) -> None:
        target = "/v1/events?trace=1&x=%2Fetc"
        headers = signed_headers("POST", target, b"")
        principal = self.verify("POST", target, b"", headers)
        self.assertEqual(principal.tenant_id, TENANT)

    def test_get_with_empty_body(self) -> None:
        headers = signed_headers("GET", "/v1/jobs/job_1", b"")
        self.assertTrue(self.verify("GET", "/v1/jobs/job_1", b"", headers))

    def test_method_case_is_normalised_in_signature(self) -> None:
        body = b""
        headers = signed_headers("POST", "/v1/events", body)
        # Lowercase transport method must still verify (METHOD_UPPERCASE).
        self.assertTrue(self.verify("post", "/v1/events", body, headers))


class TestSignatureMutations(VerifierTestCase):
    def test_body_mutation_invalidates_signature(self) -> None:
        headers = signed_headers("POST", "/v1/events", b'{"a":1}')
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b'{"a":2}', headers)
        self.assertEqual(ctx.exception.reason, "bad_signature")
        self.assertEqual(ctx.exception.public_code, "unauthorized")

    def test_raw_target_mutation_invalidates_signature(self) -> None:
        headers = signed_headers("POST", "/v1/events?x=1", b"")
        with self.assertRaises(AuthError):
            self.verify("POST", "/v1/events?x=2", b"", headers)

    def test_dropping_query_string_invalidates_signature(self) -> None:
        headers = signed_headers("POST", "/v1/events?x=1", b"")
        with self.assertRaises(AuthError):
            self.verify("POST", "/v1/events", b"", headers)

    def test_method_mutation_invalidates_signature(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"")
        with self.assertRaises(AuthError):
            self.verify("PUT", "/v1/events", b"", headers)

    def test_tenant_swap_invalidates_signature(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"")
        swapped = [
            ("X-Tenant-ID", "tenant_beta") if name == "X-Tenant-ID" else (name, value)
            for name, value in headers
        ]
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", swapped)
        self.assertEqual(ctx.exception.public_code, "unauthorized")

    def test_unknown_tenant_returns_same_generic_error(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"", tenant="tenant_ghost")
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", headers)
        self.assertEqual(ctx.exception.public_code, "unauthorized")
        self.assertEqual(ctx.exception.public_message, "authentication failed")


class TestMalformedSignatures(VerifierTestCase):
    def _expect_malformed(self, signature: str) -> None:
        headers = signed_headers(
            "POST", "/v1/events", b"", signature=signature, nonce="nonce-aaaaaaa1"
        )
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", headers)
        self.assertEqual(ctx.exception.reason, "malformed_signature")

    def test_uppercase_hex_rejected(self) -> None:
        good = compute_signature(
            SECRET, TENANT, KEY_ID, "1700000000", "nonce-aaaaaaa1", "POST",
            "/v1/events", b"",
        )
        self._expect_malformed(good.upper())

    def test_short_long_and_non_hex_rejected(self) -> None:
        for signature in ("a" * 63, "a" * 65, "z" * 64, "0x" + "a" * 62, "!" * 64):
            with self.subTest(signature=signature[:8]):
                self._expect_malformed(signature)

    def test_malformed_signature_does_not_touch_nonce(self) -> None:
        nonce = "nonce-reuse-01"
        bad = signed_headers(
            "POST", "/v1/events", b"", signature="Q" * 64, nonce=nonce
        )
        with self.assertRaises(AuthError):
            self.verify("POST", "/v1/events", b"", bad)
        good = signed_headers("POST", "/v1/events", b"", nonce=nonce)
        self.assertTrue(self.verify("POST", "/v1/events", b"", good))

    def test_empty_signature_header_is_ambiguous(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"", signature="   ")
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", headers)
        self.assertEqual(ctx.exception.reason, "ambiguous_header")


class TestSecurityHeaderHygiene(VerifierTestCase):
    def test_missing_header_rejected(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"")
        for index in range(5):
            trimmed = [h for i, h in enumerate(headers) if i != index]
            with self.subTest(missing=headers[index][0]):
                with self.assertRaises(AuthError) as ctx:
                    self.verify("POST", "/v1/events", b"", trimmed)
                self.assertEqual(ctx.exception.reason, "missing_header")

    def test_repeated_header_rejected_even_when_identical(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"")
        duplicated = headers + [("x-signature", headers[-1][1])]
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", duplicated)
        self.assertEqual(ctx.exception.reason, "repeated_header")

    def test_case_insensitive_header_names_accepted(self) -> None:
        headers = [
            (name.lower(), value)
            for name, value in signed_headers("POST", "/v1/events", b"")
        ]
        self.assertTrue(self.verify("POST", "/v1/events", b"", headers))

    def test_non_ascii_header_value_rejected(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"", tenant="tenant_alpha")
        mutated = [
            ("X-Tenant-ID", "tenant_\u00e4lpha") if n == "X-Tenant-ID" else (n, v)
            for n, v in headers
        ]
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", mutated)
        self.assertEqual(ctx.exception.reason, "ambiguous_header")

    def test_malformed_nonce_and_timestamp_rejected(self) -> None:
        cases = {
            "malformed_nonce": ("X-Nonce", "short"),
            "malformed_timestamp": ("X-Timestamp", "17e8"),
        }
        for reason, (header, value) in cases.items():
            headers = [
                (name, value if name == header else current)
                for name, current in signed_headers("POST", "/v1/events", b"")
            ]
            with self.subTest(reason=reason):
                with self.assertRaises(AuthError) as ctx:
                    self.verify("POST", "/v1/events", b"", headers)
                self.assertEqual(ctx.exception.reason, reason)

    def test_non_canonical_timestamp_rejected(self) -> None:
        for raw in ("+1700000000", "01700000000", "1700000000.0", "1_700_000_000"):
            headers = signed_headers("POST", "/v1/events", b"")
            mutated = [
                ("X-Timestamp", raw) if n == "X-Timestamp" else (n, v)
                for n, v in headers
            ]
            with self.subTest(raw=raw):
                with self.assertRaises(AuthError):
                    self.verify("POST", "/v1/events", b"", mutated)

    def test_optional_whitespace_around_header_value_is_trimmed(self) -> None:
        # RFC 9110 optional whitespace is not part of the field value, so a
        # padded header still matches the signature over the trimmed value.
        headers = [
            ("X-Timestamp", f" {value} ") if name == "X-Timestamp" else (name, value)
            for name, value in signed_headers("POST", "/v1/events", b"")
        ]
        self.assertTrue(self.verify("POST", "/v1/events", b"", headers))

    def test_malformed_raw_target_rejected(self) -> None:
        for target in ("v1/events", "/v1/ev ents", "/v1/events\n"):
            headers = signed_headers("POST", target, b"")
            with self.subTest(target=target):
                with self.assertRaises(AuthError) as ctx:
                    self.verify("POST", target, b"", headers)
                self.assertEqual(ctx.exception.reason, "malformed_target")


class TestTimestampBoundaries(VerifierTestCase):
    def _attempt(self, offset: int, nonce: str) -> None:
        timestamp = int(self.clock.now) + offset
        headers = signed_headers(
            "POST", "/v1/events", b"", timestamp=timestamp, nonce=nonce
        )
        self.verify("POST", "/v1/events", b"", headers)

    def test_exact_boundaries_accepted(self) -> None:
        self._attempt(300, "nonce-bound-01")
        self._attempt(-300, "nonce-bound-02")

    def test_just_outside_boundaries_rejected(self) -> None:
        for offset, nonce in ((301, "nonce-bound-03"), (-301, "nonce-bound-04")):
            with self.subTest(offset=offset):
                with self.assertRaises(AuthError) as ctx:
                    self._attempt(offset, nonce)
                self.assertEqual(ctx.exception.reason, "timestamp_out_of_window")

    def test_stale_timestamp_does_not_consume_nonce(self) -> None:
        nonce = "nonce-bound-05"
        with self.assertRaises(AuthError):
            self._attempt(4000, nonce)
        self._attempt(0, nonce)  # nonce still fresh


class TestNonceLifecycle(VerifierTestCase):
    def test_nonce_single_use(self) -> None:
        headers = signed_headers("POST", "/v1/events", b"", nonce="nonce-single-1")
        self.verify("POST", "/v1/events", b"", headers)
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", headers)
        self.assertEqual(ctx.exception.reason, "nonce_replayed")

    def test_invalid_signature_does_not_burn_nonce(self) -> None:
        nonce = "nonce-notburned"
        forged = signed_headers(
            "POST", "/v1/events", b"", nonce=nonce, secret=b"wrong-secret"
        )
        with self.assertRaises(AuthError) as ctx:
            self.verify("POST", "/v1/events", b"", forged)
        self.assertEqual(ctx.exception.reason, "bad_signature")
        honest = signed_headers("POST", "/v1/events", b"", nonce=nonce)
        self.assertTrue(self.verify("POST", "/v1/events", b"", honest))

    def test_nonce_scoped_by_tenant_and_key(self) -> None:
        secrets = {
            (TENANT, KEY_ID): SECRET,
            (TENANT, "key_2"): b"second-key-secret",
            ("tenant_beta", KEY_ID): b"beta-secret",
        }
        verifier = RequestVerifier(
            StaticSecretProvider(secrets), self.store, self.clock
        )
        nonce = "nonce-scoped-1"
        for tenant, key_id, secret in (
            (TENANT, KEY_ID, SECRET),
            (TENANT, "key_2", b"second-key-secret"),
            ("tenant_beta", KEY_ID, b"beta-secret"),
        ):
            headers = signed_headers(
                "POST", "/v1/events", b"", tenant=tenant, key_id=key_id,
                secret=secret, nonce=nonce,
            )
            self.assertTrue(
                verifier.verify("POST", "/v1/events", Headers(headers), b"")
            )

    def test_nonce_reusable_after_ttl(self) -> None:
        nonce = "nonce-ttl-0001"
        headers = signed_headers("POST", "/v1/events", b"", nonce=nonce)
        self.verify("POST", "/v1/events", b"", headers)
        self.clock.now += 601
        fresh = signed_headers(
            "POST", "/v1/events", b"", nonce=nonce, timestamp=int(self.clock.now)
        )
        self.assertTrue(self.verify("POST", "/v1/events", b"", fresh))

    def test_concurrent_reuse_of_one_nonce_admits_exactly_one(self) -> None:
        nonce = "nonce-concurrent"
        headers = Headers(signed_headers("POST", "/v1/events", b"", nonce=nonce))
        worker_count = 12
        barrier = threading.Barrier(worker_count)
        successes: list[int] = []
        failures: list[str] = []
        lock = threading.Lock()

        def attempt() -> None:
            # Separate Store instance == separate SQLite connection.
            store = Store(self.db_path, clock=self.clock)
            verifier = RequestVerifier(
                StaticSecretProvider({(TENANT, KEY_ID): SECRET}), store, self.clock
            )
            barrier.wait()
            try:
                verifier.verify("POST", "/v1/events", headers, b"")
                with lock:
                    successes.append(1)
            except AuthError as exc:
                with lock:
                    failures.append(exc.reason)
            finally:
                store.close()

        threads = [threading.Thread(target=attempt) for _ in range(worker_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), worker_count - 1)
        self.assertEqual(set(failures), {"nonce_replayed"})


class TestCallbackUrlValidation(unittest.TestCase):
    def setUp(self) -> None:
        self.resolver = RecordingResolver(
            {
                "hooks.example.test": ["93.184.216.34"],
                "multi.example.test": ["93.184.216.34", "104.18.32.7"],
                "mixed.example.test": ["93.184.216.34", "127.0.0.1"],
                "v6.example.test": ["2606:2800:220:1:248:1893:25c8:1946"],
                "mapped.example.test": ["::ffff:93.184.216.34"],
                "mappedbad.example.test": ["::ffff:10.1.2.3"],
                "internal.example.test": ["10.0.0.5"],
                "meta.example.test": ["169.254.169.254"],
                "empty.example.test": [],
            }
        )

    def test_valid_https_url(self) -> None:
        result = validate_callback_url(
            "https://hooks.example.test/delivery?x=1", self.resolver
        )
        self.assertEqual(result.hostname, "hooks.example.test")
        self.assertEqual(result.port, 443)
        self.assertEqual(result.ip, "93.184.216.34")
        self.assertEqual(result.family, socket.AF_INET)
        self.assertEqual(result.target, "/delivery?x=1")

    def test_alternate_allowed_port(self) -> None:
        result = validate_callback_url(
            "https://hooks.example.test:8443/x", self.resolver
        )
        self.assertEqual(result.port, 8443)

    def test_rejected_shapes(self) -> None:
        cases = {
            "http://hooks.example.test/x": "scheme_not_https",
            "ftp://hooks.example.test/x": "scheme_not_https",
            "https://user:pw@hooks.example.test/x": "userinfo_not_allowed",
            "https://hooks.example.test/x#frag": "fragment_not_allowed",
            "https://hooks.example.test/x#": "fragment_not_allowed",
            "https:///x": "bad_hostname",
            "https://hooks.example.test:8080/x": "port_not_allowed",
            "https://hooks.example.test:80/x": "port_not_allowed",
            "https://ho oks.example.test/x": "malformed_url",
            "https://xn--exmple-cua.test/x": "no_addresses",
            "https://h\u00f6st.example.test/x": "non_ascii_url",
            "https://hooks.example.test./x": "bad_hostname",
            "https://-bad.example.test/x": "bad_hostname",
            "https://empty.example.test/x": "no_addresses",
        }
        for url, reason in cases.items():
            with self.subTest(url=url):
                with self.assertRaises(UrlValidationError) as ctx:
                    validate_callback_url(url, self.resolver)
                self.assertEqual(ctx.exception.reason, reason)

    def test_non_global_literals_rejected(self) -> None:
        literals = [
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://192.168.1.10/x",
            "https://172.16.9.9/x",
            "https://169.254.169.254/x",
            "https://0.0.0.0/x",
            "https://224.0.0.1/x",
            "https://240.0.0.1/x",
            "https://[::1]/x",
            "https://[fe80::1]/x",
            "https://[fc00::1]/x",
            "https://[::]/x",
            "https://[ff02::1]/x",
            "https://[::ffff:127.0.0.1]/x",
            "https://[::ffff:10.0.0.1]/x",
            "https://[::ffff:192.168.0.1]/x",
        ]
        for url in literals:
            with self.subTest(url=url):
                with self.assertRaises(UrlValidationError) as ctx:
                    validate_callback_url(url, self.resolver)
                self.assertIn(
                    ctx.exception.reason, ("non_global_address", "scoped_address")
                )
        self.assertEqual(self.resolver.calls, [])  # literals never resolved

    def test_global_literals_accepted(self) -> None:
        result = validate_callback_url("https://93.184.216.34/x", self.resolver)
        self.assertEqual(result.ip, "93.184.216.34")
        v6 = validate_callback_url("https://[2606:2800:220:1::1]/x", self.resolver)
        self.assertEqual(v6.family, socket.AF_INET6)

    def test_resolved_private_and_link_local_rejected(self) -> None:
        for host in ("internal.example.test", "meta.example.test",
                     "mappedbad.example.test"):
            with self.subTest(host=host):
                with self.assertRaises(UrlValidationError) as ctx:
                    validate_callback_url(f"https://{host}/x", self.resolver)
                self.assertEqual(ctx.exception.reason, "non_global_address")

    def test_mixed_answer_rejected_entirely(self) -> None:
        with self.assertRaises(UrlValidationError) as ctx:
            validate_callback_url("https://mixed.example.test/x", self.resolver)
        self.assertEqual(ctx.exception.reason, "non_global_address")

    def test_multiple_safe_answers_pick_first_deterministically(self) -> None:
        result = validate_callback_url("https://multi.example.test/x", self.resolver)
        self.assertEqual(result.ip, "93.184.216.34")
        self.assertEqual(result.addresses, ("93.184.216.34", "104.18.32.7"))

    def test_ipv6_and_ipv4_mapped_resolution(self) -> None:
        v6 = validate_callback_url("https://v6.example.test/x", self.resolver)
        self.assertEqual(v6.family, socket.AF_INET6)
        self.assertEqual(v6.ip, "2606:2800:220:1:248:1893:25c8:1946")
        mapped = validate_callback_url("https://mapped.example.test/x", self.resolver)
        self.assertEqual(mapped.ip, "93.184.216.34")
        self.assertEqual(mapped.family, socket.AF_INET)

    def test_default_target_when_path_missing(self) -> None:
        result = validate_callback_url("https://hooks.example.test", self.resolver)
        self.assertEqual(result.target, "/")

    def test_hostname_preserved_for_sni(self) -> None:
        result = validate_callback_url("https://mapped.example.test/x", self.resolver)
        self.assertEqual(result.hostname, "mapped.example.test")
        self.assertNotEqual(result.hostname, result.ip)


class TestRedaction(unittest.TestCase):
    def test_sensitive_keys_removed(self) -> None:
        record = {
            "event": "event.accepted",
            "x-signature": "deadbeef",
            "secret": SECRET.decode(),
            "authorization": "Bearer abc",
            "payload": {"card": "4111111111111111"},
            "nested": {"api_key": "k-123", "safe": "ok"},
            "job_id": "job_1",
        }
        cleaned = redact(record)
        self.assertEqual(cleaned["x-signature"], security.REDACTED)
        self.assertEqual(cleaned["secret"], security.REDACTED)
        self.assertEqual(cleaned["authorization"], security.REDACTED)
        self.assertEqual(cleaned["payload"], security.REDACTED)
        self.assertEqual(cleaned["nested"]["api_key"], security.REDACTED)
        self.assertEqual(cleaned["nested"]["safe"], "ok")
        self.assertEqual(cleaned["job_id"], "job_1")
        self.assertNotIn("4111111111111111", repr(cleaned))
        self.assertNotIn(SECRET.decode(), repr(cleaned))

    def test_literal_secret_scrubbed_from_free_text(self) -> None:
        cleaned = redact(
            {"note": f"used {SECRET.decode()} here"}, secrets=[SECRET.decode()]
        )
        self.assertNotIn(SECRET.decode(), cleaned["note"])
        self.assertIn(security.REDACTED, cleaned["note"])

    def test_long_strings_truncated_and_bytes_summarised(self) -> None:
        cleaned = redact({"blob": "x" * 500, "raw": b"0123456789"})
        self.assertLess(len(cleaned["blob"]), 200)
        self.assertIn("truncated", cleaned["blob"])
        self.assertEqual(cleaned["raw"], "<10 bytes>")

    def test_lists_and_depth_are_handled(self) -> None:
        cleaned = redact({"items": [{"secret": "s"}, {"ok": 1}]})
        self.assertEqual(cleaned["items"][0]["secret"], security.REDACTED)
        self.assertEqual(cleaned["items"][1]["ok"], 1)


if __name__ == "__main__":
    unittest.main()
