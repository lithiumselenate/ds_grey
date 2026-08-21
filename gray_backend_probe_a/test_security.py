"""Deterministic tests for RelayVault authentication, replay defence,
callback-URL validation and log redaction.

No network access: every resolver is a fake and no socket is created.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest

import security
from security import (
    AuthError,
    CallbackUrlError,
    Config,
    JsonLogger,
    RequestError,
    canonical_string,
    normalize_headers,
    redact_fields,
    redact_value,
    sign,
    validate_callback_url,
    verify_request,
)
from store import Store, SqliteNonceStore

TENANT = "tenant_a"
KEY = "key_1"
SECRET = b"unit-test-secret-value-0123456789"
OTHER_SECRET = b"another-unit-test-secret-9876543"
NOW = 1_700_000_000

SAFE_V4 = "93.184.216.34"
SAFE_V4_ALT = "8.8.8.8"
SAFE_V6 = "2606:2800:220:1:248:1893:25c8:1946"


class MemoryNonceStore:
    """In-memory replay store with the same contract as the SQLite one."""

    def __init__(self) -> None:
        self.entries: dict[tuple[str, str, str], int] = {}
        self.calls = 0

    def consume(self, tenant_id, key_id, nonce, now, ttl=600):
        self.calls += 1
        key = (tenant_id, key_id, nonce)
        expiry = self.entries.get(key)
        if expiry is not None and expiry > now:
            return False
        self.entries[key] = now + ttl
        return True


class RecordingResolver:
    def __init__(self, answers):
        self._answers = answers
        self.calls: list[str] = []

    def __call__(self, hostname):
        self.calls.append(hostname)
        if isinstance(self._answers, Exception):
            raise self._answers
        if isinstance(self._answers, dict):
            return list(self._answers.get(hostname, []))
        return list(self._answers)


def auth_headers(
    *,
    method="POST",
    target="/v1/events",
    body=b"",
    tenant=TENANT,
    key=KEY,
    secret=SECRET,
    timestamp=NOW,
    nonce="nonce-00000001",
    signature=None,
    extra=(),
):
    computed = sign(secret, tenant, key, str(timestamp), nonce, method, target, body)
    return [
        ("X-Tenant-ID", tenant),
        ("X-Key-ID", key),
        ("X-Timestamp", str(timestamp)),
        ("X-Nonce", nonce),
        ("X-Signature", computed if signature is None else signature),
        *extra,
    ]


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.config = Config({TENANT: {KEY: SECRET}, "tenant_b": {KEY: OTHER_SECRET}})
        self.nonces = MemoryNonceStore()
        self.clock_value = NOW

    def clock(self):
        return self.clock_value

    def verify(self, *, method="POST", target="/v1/events", body=b"", headers=None):
        return verify_request(
            method=method,
            raw_target=target,
            headers=headers if headers is not None else auth_headers(method=method, target=target, body=body),
            body=body,
            config=self.config,
            clock=self.clock,
            nonce_store=self.nonces,
        )

    # 1. valid authentication
    def test_valid_signature_authenticates(self):
        body = b'{"a":1}'
        principal = self.verify(body=body, headers=auth_headers(body=body))
        self.assertEqual((principal.tenant_id, principal.key_id), (TENANT, KEY))
        self.assertEqual(self.nonces.calls, 1)

    def test_canonical_string_layout_is_exact(self):
        blob = canonical_string(TENANT, KEY, "17", "n-1", "post", "/v1/events?x=1", b"body")
        expected = (
            TENANT
            + "\n"
            + KEY
            + "\n17\nn-1\nPOST\n/v1/events?x=1\n"
            + "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5"
        ).encode()
        self.assertEqual(blob, expected)

    def test_empty_body_hash_is_used_for_get(self):
        principal = self.verify(method="GET", target="/v1/jobs/job_1", body=b"",
                                headers=auth_headers(method="GET", target="/v1/jobs/job_1"))
        self.assertEqual(principal.tenant_id, TENANT)

    # 2. mutation of body or raw target invalidates the signature
    def test_body_mutation_invalidates_signature(self):
        headers = auth_headers(body=b'{"a":1}')
        with self.assertRaises(AuthError):
            self.verify(body=b'{"a":2}', headers=headers)
        self.assertEqual(self.nonces.entries, {})

    def test_raw_target_query_mutation_invalidates_signature(self):
        headers = auth_headers(target="/v1/events?replay=0")
        with self.assertRaises(AuthError):
            self.verify(target="/v1/events?replay=1", headers=headers)

    def test_query_string_must_be_included_in_signature(self):
        headers = auth_headers(target="/v1/events")
        with self.assertRaises(AuthError):
            self.verify(target="/v1/events?x=1", headers=headers)

    def test_method_mutation_invalidates_signature(self):
        headers = auth_headers(method="POST", target="/v1/jobs/job_1")
        with self.assertRaises(AuthError):
            self.verify(method="GET", target="/v1/jobs/job_1", headers=headers)

    def test_other_tenant_secret_is_rejected(self):
        headers = auth_headers(secret=OTHER_SECRET)
        with self.assertRaises(AuthError):
            self.verify(headers=headers)

    def test_unknown_tenant_and_key_are_generic_failures(self):
        for headers in (
            auth_headers(tenant="tenant_zzz"),
            auth_headers(key="key_zzz"),
        ):
            with self.assertRaises(AuthError) as ctx:
                self.verify(headers=headers)
            self.assertEqual(ctx.exception.status, 401)
            self.assertEqual(ctx.exception.code, "unauthenticated")
            self.assertEqual(ctx.exception.message, "authentication failed")

    # 3. malformed signatures
    def test_malformed_signatures_are_rejected_before_comparison(self):
        good = auth_headers()
        valid_signature = dict((k.lower(), v) for k, v in good)["x-signature"]
        malformed = [
            "",
            "not-hex",
            valid_signature.upper(),
            valid_signature[:-1],
            valid_signature + "0",
            "0x" + valid_signature[2:],
            valid_signature[:-2] + "zz",
            valid_signature[:32] + " " + valid_signature[33:],
            valid_signature[:32] + "\t" + valid_signature[33:],
            valid_signature.replace(valid_signature[0], "g", 1),
        ]
        for candidate in malformed:
            with self.subTest(signature=candidate):
                headers = auth_headers(signature=candidate)
                with self.assertRaises(AuthError):
                    self.verify(headers=headers)
        self.assertEqual(self.nonces.entries, {}, "malformed signature must not burn a nonce")

    # 4. timestamp boundaries
    def test_timestamp_window_boundaries(self):
        cases = [
            (NOW - 300, True),
            (NOW + 300, True),
            (NOW - 301, False),
            (NOW + 301, False),
            (NOW, True),
        ]
        for offset, expected_ok in cases:
            with self.subTest(timestamp=offset):
                headers = auth_headers(timestamp=offset, nonce="nonce-%d" % offset)
                if expected_ok:
                    self.assertEqual(self.verify(headers=headers).tenant_id, TENANT)
                else:
                    with self.assertRaises(AuthError):
                        self.verify(headers=headers)

    def test_malformed_timestamps_rejected(self):
        for value in ("", "abc", "17.5", "+1700000000", " 1700000000", "0x10", "1e9"):
            with self.subTest(timestamp=value):
                headers = auth_headers(timestamp=value)
                with self.assertRaises(AuthError):
                    self.verify(headers=headers)

    # 5. an invalid signature does not consume its nonce
    def test_invalid_signature_does_not_burn_nonce(self):
        nonce = "nonce-reusable-1"
        bad = auth_headers(nonce=nonce, secret=OTHER_SECRET)
        with self.assertRaises(AuthError):
            self.verify(headers=bad)
        self.assertEqual(self.nonces.calls, 0)
        good = auth_headers(nonce=nonce)
        self.assertEqual(self.verify(headers=good).tenant_id, TENANT)

    def test_nonce_replay_is_rejected(self):
        headers = auth_headers(nonce="nonce-single-use")
        self.assertEqual(self.verify(headers=headers).tenant_id, TENANT)
        with self.assertRaises(AuthError):
            self.verify(headers=headers)

    def test_nonce_is_scoped_by_tenant_and_key(self):
        config = Config({TENANT: {KEY: SECRET, "key_2": OTHER_SECRET}, "tenant_b": {KEY: OTHER_SECRET}})
        self.config = config
        nonce = "nonce-shared-value"
        self.assertEqual(self.verify(headers=auth_headers(nonce=nonce)).tenant_id, TENANT)
        self.assertEqual(
            self.verify(headers=auth_headers(nonce=nonce, key="key_2", secret=OTHER_SECRET)).key_id,
            "key_2",
        )
        self.assertEqual(
            self.verify(headers=auth_headers(nonce=nonce, tenant="tenant_b", secret=OTHER_SECRET)).tenant_id,
            "tenant_b",
        )
        with self.assertRaises(AuthError):
            self.verify(headers=auth_headers(nonce=nonce))

    # header hygiene
    def test_missing_security_header_is_generic_failure(self):
        for drop in ("X-Tenant-ID", "X-Key-ID", "X-Timestamp", "X-Nonce", "X-Signature"):
            with self.subTest(drop=drop):
                headers = [(k, v) for k, v in auth_headers() if k != drop]
                with self.assertRaises(AuthError):
                    self.verify(headers=headers)

    def test_repeated_security_header_is_rejected(self):
        headers = auth_headers()
        duplicated = list(headers) + [("X-Nonce", "nonce-00000002")]
        with self.assertRaises(AuthError):
            self.verify(headers=duplicated)

    def test_folded_security_header_is_rejected(self):
        headers = [
            (k, ("nonce-00000001,nonce-00000002" if k == "X-Nonce" else v))
            for k, v in auth_headers()
        ]
        with self.assertRaises(AuthError):
            self.verify(headers=headers)

    def test_repeated_content_type_is_client_error_not_auth_error(self):
        with self.assertRaises(RequestError) as ctx:
            normalize_headers(
                [("Content-Type", "application/json"), ("Content-Type", "text/plain")]
            )
        self.assertEqual(ctx.exception.status, 400)
        self.assertNotIsInstance(ctx.exception, AuthError)

    def test_malformed_principal_and_nonce_rejected(self):
        for headers in (
            auth_headers(tenant="tenant a"),
            auth_headers(tenant="../etc/passwd"),
            auth_headers(key="key/1"),
            auth_headers(nonce="short"),
            auth_headers(nonce="x" * 200),
        ):
            with self.subTest(headers=headers[0]):
                with self.assertRaises(AuthError):
                    self.verify(headers=headers)


class SqliteNonceConcurrencyTests(unittest.TestCase):
    """6. concurrent reuse of one nonce across separate SQLite connections."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.stores: list[Store] = []

    def tearDown(self):
        for store in self.stores:
            store.close()
        self._tmp.cleanup()

    def new_nonce_store(self):
        store = Store(self.db_path)
        self.stores.append(store)
        return SqliteNonceStore(store)

    def test_only_one_thread_consumes_a_nonce(self):
        worker_count = 12
        nonce_stores = [self.new_nonce_store() for _ in range(worker_count)]
        barrier = threading.Barrier(worker_count)
        results: list[bool] = []
        lock = threading.Lock()

        def attempt(nonce_store):
            barrier.wait()
            accepted = nonce_store.consume(TENANT, KEY, "nonce-contended-1", NOW, 600)
            with lock:
                results.append(accepted)

        threads = [threading.Thread(target=attempt, args=(ns,)) for ns in nonce_stores]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(results), worker_count)
        self.assertEqual(results.count(True), 1, "exactly one consumer may win")
        self.assertEqual(self.stores[0].count_nonces(), 1)

    def test_nonce_is_reusable_only_after_its_ttl(self):
        # The protection window is half-open: a nonce is unusable for the whole
        # 600 second TTL and becomes reusable once the TTL has elapsed.
        nonce_store = self.new_nonce_store()
        self.assertTrue(nonce_store.consume(TENANT, KEY, "nonce-ttl-check", NOW, 600))
        self.assertFalse(nonce_store.consume(TENANT, KEY, "nonce-ttl-check", NOW + 1, 600))
        self.assertFalse(nonce_store.consume(TENANT, KEY, "nonce-ttl-check", NOW + 599, 600))
        self.assertTrue(nonce_store.consume(TENANT, KEY, "nonce-ttl-check", NOW + 600, 600))

    def test_expired_nonces_can_be_purged(self):
        nonce_store = self.new_nonce_store()
        nonce_store.consume(TENANT, KEY, "nonce-purgeable-1", NOW, 600)
        self.assertEqual(self.stores[0].purge_expired_nonces(NOW + 10), 0)
        self.assertEqual(self.stores[0].purge_expired_nonces(NOW + 601), 1)


class CallbackUrlTests(unittest.TestCase):
    """13/14. address classification and hostile DNS answers."""

    def resolve(self, url, answers):
        resolver = RecordingResolver(answers)
        return validate_callback_url(url, resolver), resolver

    def test_accepts_https_with_global_answer(self):
        target, resolver = self.resolve("https://hooks.example.test/deliver?x=1", [SAFE_V4])
        self.assertEqual(target.hostname, "hooks.example.test")
        self.assertEqual(target.ip, SAFE_V4)
        self.assertEqual(target.port, 443)
        self.assertEqual(target.host_header, "hooks.example.test")
        self.assertEqual(target.request_target, "/deliver?x=1")
        self.assertEqual(resolver.calls, ["hooks.example.test"])

    def test_accepts_alternate_port_and_preserves_host_header(self):
        target, _ = self.resolve("https://hooks.example.test:8443/deliver", [SAFE_V4])
        self.assertEqual(target.port, 8443)
        self.assertEqual(target.host_header, "hooks.example.test:8443")

    def test_accepts_global_ipv6_answer(self):
        target, _ = self.resolve("https://hooks.example.test/x", [SAFE_V6])
        self.assertEqual(target.ip_version, 6)
        self.assertEqual(target.ip, SAFE_V6)

    def test_default_path_is_root(self):
        target, _ = self.resolve("https://hooks.example.test", [SAFE_V4])
        self.assertEqual(target.request_target, "/")

    def test_rejects_non_https_scheme(self):
        for url in ("http://hooks.example.test/x", "ftp://hooks.example.test/x", "file:///etc/passwd"):
            with self.subTest(url=url):
                with self.assertRaises(CallbackUrlError):
                    self.resolve(url, [SAFE_V4])

    def test_rejects_userinfo_fragment_and_bad_ports(self):
        cases = {
            "https://user:pass@hooks.example.test/x": "userinfo_present",
            "https://user@hooks.example.test/x": "userinfo_present",
            "https://@hooks.example.test/x": "userinfo_present",
            "https://hooks.example.test/x#frag": "fragment_present",
            "https://hooks.example.test/x#": "fragment_present",
            "https://hooks.example.test:8080/x": "port_not_allowed",
            "https://hooks.example.test:80/x": "port_not_allowed",
            "https://hooks.example.test:0/x": "port_not_allowed",
        }
        for url, reason in cases.items():
            with self.subTest(url=url):
                with self.assertRaises(CallbackUrlError) as ctx:
                    self.resolve(url, [SAFE_V4])
                self.assertEqual(ctx.exception.reason, reason)
                self.assertEqual(ctx.exception.status, 400)

    def test_rejects_malformed_hosts(self):
        for url in (
            "https:///nohost",
            "https://-leading.example.test/x",
            "https://trailing-.example.test/x",
            "https://double..dot.example.test/x",
            "https://trailingdot.example.test./x",
            "https://exa mple.test/x",
            "https://xn--\u00fcber.test/x",
            "https://" + ("a" * 64) + ".example.test/x",
        ):
            with self.subTest(url=url):
                with self.assertRaises(CallbackUrlError):
                    self.resolve(url, [SAFE_V4])

    def test_rejects_non_global_resolved_addresses(self):
        blocked = [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.5",
            "172.16.9.9",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "255.255.255.255",
            "100.64.0.1",
            "224.0.0.1",
            "::1",
            "fe80::1",
            "fd00::abcd",
            "ff02::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:93.184.216.34",
            "2002:5db8:d822::1",
        ]
        for address in blocked:
            with self.subTest(address=address):
                with self.assertRaises(CallbackUrlError) as ctx:
                    self.resolve("https://hooks.example.test/x", [address])
                self.assertEqual(ctx.exception.reason, "non_global_address")
                self.assertNotIn(address, str(ctx.exception))
                self.assertNotIn(address, ctx.exception.message)

    def test_rejects_ip_literals_without_calling_the_resolver(self):
        for url in (
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/x",
            "https://[fe80::1]/x",
            "https://[::ffff:127.0.0.1]/x",
        ):
            with self.subTest(url=url):
                resolver = RecordingResolver([SAFE_V4])
                with self.assertRaises(CallbackUrlError):
                    validate_callback_url(url, resolver)
                self.assertEqual(resolver.calls, [], "literals must not be resolved")

    def test_accepts_global_ip_literal(self):
        resolver = RecordingResolver([])
        target = validate_callback_url("https://%s/x" % SAFE_V4, resolver)
        self.assertEqual(target.ip, SAFE_V4)
        self.assertEqual(resolver.calls, [])
        self.assertTrue(target.is_literal)

    def test_accepts_global_ipv6_literal_with_bracketed_host_header(self):
        target = validate_callback_url("https://[%s]:8443/x" % SAFE_V6, RecordingResolver([]))
        self.assertEqual(target.host_header, "[%s]:8443" % SAFE_V6)
        self.assertEqual(target.ip, SAFE_V6)

    # 14. mixed safe/unsafe answers must reject the whole URL
    def test_mixed_answers_are_rejected_in_any_order(self):
        for answers in (
            [SAFE_V4, "10.0.0.5"],
            ["10.0.0.5", SAFE_V4],
            [SAFE_V4, SAFE_V4_ALT, "169.254.169.254"],
            [SAFE_V6, "::1"],
        ):
            with self.subTest(answers=answers):
                with self.assertRaises(CallbackUrlError) as ctx:
                    self.resolve("https://hooks.example.test/x", answers)
                self.assertEqual(ctx.exception.reason, "non_global_address")

    def test_multiple_safe_answers_pin_the_first(self):
        target, _ = self.resolve("https://hooks.example.test/x", [SAFE_V4, SAFE_V4_ALT, SAFE_V6])
        self.assertEqual(target.ip, SAFE_V4)

    def test_resolver_failures_are_generic(self):
        with self.assertRaises(CallbackUrlError) as ctx:
            self.resolve("https://hooks.example.test/x", RuntimeError("dns exploded: 10.0.0.5"))
        self.assertEqual(ctx.exception.reason, "resolution_failed")
        self.assertNotIn("10.0.0.5", ctx.exception.message)

        with self.assertRaises(CallbackUrlError) as ctx:
            self.resolve("https://hooks.example.test/x", [])
        self.assertEqual(ctx.exception.reason, "no_addresses")

        with self.assertRaises(CallbackUrlError) as ctx:
            self.resolve("https://hooks.example.test/x", ["not-an-address"])
        self.assertEqual(ctx.exception.reason, "unparsable_address")

    def test_rejects_oversized_and_control_character_urls(self):
        with self.assertRaises(CallbackUrlError):
            self.resolve("https://hooks.example.test/" + "a" * 4096, [SAFE_V4])
        with self.assertRaises(CallbackUrlError):
            self.resolve("https://hooks.example.test/\r\nX-Injected: 1", [SAFE_V4])
        with self.assertRaises(CallbackUrlError):
            self.resolve("", [SAFE_V4])


class RedactionTests(unittest.TestCase):
    """21 (unit level). the redaction helper must remove secret material."""

    def test_sensitive_keys_are_replaced(self):
        fields = redact_fields(
            {
                "tenant_id": TENANT,
                "secret": SECRET.decode(),
                "x_signature": "a" * 64,
                "payload": {"card": "4111111111111111"},
                "response_body": "hello",
                "nonce": "nonce-00000001",
                "authorization": "Bearer abc",
                "status_code": 200,
            }
        )
        self.assertEqual(fields["tenant_id"], TENANT)
        self.assertEqual(fields["status_code"], 200)
        for key in ("secret", "x_signature", "payload", "response_body", "nonce", "authorization"):
            self.assertEqual(fields[key], security.REDACTED)
        blob = json.dumps(fields)
        self.assertNotIn(SECRET.decode(), blob)
        self.assertNotIn("4111111111111111", blob)

    def test_long_hex_runs_are_masked_and_strings_truncated(self):
        value = redact_value("digest=" + "ab" * 32)
        self.assertIn("[redacted:hex]", value)
        self.assertNotIn("abab", value)
        truncated = redact_value("x" * 500)
        self.assertLess(len(truncated), 500)
        self.assertTrue(truncated.endswith("[truncated]"))

    def test_nested_and_binary_values_are_handled(self):
        result = redact_value({"outer": {"inner": {"secret": "s3cr3t-value", "ok": 1}}})
        self.assertEqual(result["outer"]["inner"]["secret"], security.REDACTED)
        self.assertEqual(result["outer"]["inner"]["ok"], 1)
        self.assertEqual(redact_value(b"12345"), "[bytes:5]")
        deep = {"a": {"b": {"c": {"d": {"e": {"f": 1}}}}}}
        self.assertIn("truncated:depth", json.dumps(redact_value(deep)))

    def test_metric_style_keys_survive_redaction(self):
        fields = redact_fields(
            {
                "payload": {"secret_note": "x"},
                "payload_bytes": 42,
                "payload_sha256": "b" * 64,
                "key_id": KEY,
                "nonce_fingerprint": "abcd1234",
                "idempotency_key_present": True,
            }
        )
        self.assertEqual(fields["payload"], security.REDACTED)
        self.assertEqual(fields["payload_bytes"], 42)
        self.assertEqual(fields["key_id"], KEY)
        self.assertEqual(fields["idempotency_key_present"], True)
        self.assertEqual(fields["nonce_fingerprint"], "abcd1234")
        # A hash is metadata, but its hex is still masked defensively.
        self.assertEqual(fields["payload_sha256"], "[redacted:hex]")

    def test_json_logger_emits_redacted_single_line_records(self):
        lines: list[str] = []
        log = JsonLogger(lines.append, service="relayvault-test")
        log("auth.accepted", tenant_id=TENANT, signature="f" * 64, payload={"secret_field": "x"})
        self.assertEqual(len(lines), 1)
        self.assertNotIn("\n", lines[0])
        record = json.loads(lines[0])
        self.assertEqual(record["event"], "auth.accepted")
        self.assertEqual(record["service"], "relayvault-test")
        self.assertEqual(record["tenant_id"], TENANT)
        self.assertEqual(record["signature"], security.REDACTED)
        self.assertEqual(record["payload"], security.REDACTED)
        self.assertNotIn("f" * 64, lines[0])


class ConfigTests(unittest.TestCase):
    def test_configuration_is_validated_and_never_prints_secrets(self):
        config = Config({TENANT: {KEY: SECRET}})
        self.assertEqual(config.tenant_ids(), (TENANT,))
        self.assertEqual(config.secret_for(TENANT, KEY), SECRET)
        self.assertIsNone(config.secret_for(TENANT, "missing"))
        self.assertIsNone(config.secret_for("missing", KEY))
        self.assertNotIn(SECRET.decode(), repr(config))
        for bad in ({"bad tenant": {KEY: SECRET}}, {TENANT: {"bad key": SECRET}}, {TENANT: {KEY: b"short"}}, {TENANT: {}}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    Config(bad)

    def test_config_copies_its_input(self):
        source = {TENANT: {KEY: SECRET}}
        config = Config(source)
        source[TENANT][KEY] = b"replaced-secret-value-0123456789"
        self.assertEqual(config.secret_for(TENANT, KEY), SECRET)


if __name__ == "__main__":
    unittest.main()
