"""Tests for authentication, callback URL validation, and redaction."""
import threading
import unittest

import security

NOW = 1_700_000_000
SECRET = b"unit-test-secret-t1-k1"
OTHER_SECRET = b"unit-test-secret-t2-k2"
_CREDENTIALS = {("t1", "k1"): SECRET, ("t2", "k2"): OTHER_SECRET}


def lookup(tenant_id, key_id):
    return _CREDENTIALS.get((tenant_id, key_id))


def make_authenticator(clock=None, nonce_store=None):
    return security.Authenticator(
        lookup,
        clock or (lambda: NOW),
        nonce_store or security.InMemoryNonceStore(),
    )


def signed_headers(
    method="POST",
    target="/v1/events",
    body=b"{}",
    tenant="t1",
    key="k1",
    timestamp=NOW,
    nonce="nonce-1",
    secret=SECRET,
):
    signature = security.sign_request(
        secret, tenant, key, str(timestamp), nonce, method, target, body
    )
    return {
        "x-tenant-id": [tenant],
        "x-key-id": [key],
        "x-timestamp": [str(timestamp)],
        "x-nonce": [nonce],
        "x-signature": [signature],
    }


class AuthenticationTests(unittest.TestCase):
    def test_valid_authentication(self):
        auth = make_authenticator()
        headers = signed_headers(nonce="n-valid")
        self.assertEqual(
            auth.authenticate("POST", "/v1/events", headers, b"{}"), ("t1", "k1")
        )

    def test_body_mutation_invalidates_signature(self):
        auth = make_authenticator()
        headers = signed_headers(body=b'{"a":1}', nonce="n-body")
        with self.assertRaises(security.AuthenticationError):
            auth.authenticate("POST", "/v1/events", headers, b'{"a":2}')

    def test_raw_target_mutation_invalidates_signature(self):
        auth = make_authenticator()
        headers = signed_headers(
            method="GET", target="/v1/jobs/j1?x=1", body=b"", nonce="n-target"
        )
        with self.assertRaises(security.AuthenticationError):
            auth.authenticate("GET", "/v1/jobs/j1?x=2", headers, b"")
        with self.assertRaises(security.AuthenticationError):
            auth.authenticate("GET", "/v1/jobs/j2?x=1", headers, b"")

    def test_method_case_is_canonicalized(self):
        auth = make_authenticator()
        headers = signed_headers(method="post", nonce="n-method")
        self.assertEqual(
            auth.authenticate("POST", "/v1/events", headers, b"{}"), ("t1", "k1")
        )

    def test_malformed_signatures_rejected(self):
        auth = make_authenticator()
        good = signed_headers(nonce="n-malformed")
        valid = good["x-signature"][0]
        for bad in (
            valid.upper(),          # uppercase hex is malformed
            valid[:-1],             # wrong length
            valid + "ab",           # wrong length
            "z" * 64,               # non-hex characters
            "",                     # empty
            "0x" + valid[2:],       # prefixed
        ):
            headers = dict(good)
            headers["x-signature"] = [bad]
            with self.assertRaises(security.AuthenticationError):
                auth.authenticate("POST", "/v1/events", headers, b"{}")

    def test_timestamp_boundaries(self):
        auth = make_authenticator()
        for offset in (-300, 0, 300):
            headers = signed_headers(timestamp=NOW + offset, nonce="n-ts-%d" % offset)
            auth.authenticate("POST", "/v1/events", headers, b"{}")
        for offset in (-301, 301, -100000):
            headers = signed_headers(timestamp=NOW + offset, nonce="n-bad-%d" % offset)
            with self.assertRaises(security.AuthenticationError):
                auth.authenticate("POST", "/v1/events", headers, b"{}")

    def test_non_integer_timestamps_rejected(self):
        auth = make_authenticator()
        for bad in ("12.5", "abc", "-5", str(NOW) + " ", ""):
            headers = signed_headers(nonce="n-fmt")
            signature = security.sign_request(
                SECRET, "t1", "k1", bad, "n-fmt", "POST", "/v1/events", b"{}"
            )
            headers["x-timestamp"] = [bad]
            headers["x-signature"] = [signature]
            with self.assertRaises(security.AuthenticationError):
                auth.authenticate("POST", "/v1/events", headers, b"{}")

    def test_invalid_signature_does_not_consume_nonce(self):
        auth = make_authenticator()
        headers = signed_headers(nonce="n-preserve")
        wrong = dict(headers)
        wrong["x-signature"] = ["0" * 64]  # well-formed but wrong
        with self.assertRaises(security.AuthenticationError):
            auth.authenticate("POST", "/v1/events", wrong, b"{}")
        # The nonce was not burned: the honest request still succeeds.
        self.assertEqual(
            auth.authenticate("POST", "/v1/events", headers, b"{}"), ("t1", "k1")
        )

    def test_nonce_replay_rejected(self):
        auth = make_authenticator()
        headers = signed_headers(nonce="n-once")
        auth.authenticate("POST", "/v1/events", headers, b"{}")
        with self.assertRaises(security.AuthenticationError):
            auth.authenticate("POST", "/v1/events", headers, b"{}")

    def test_nonce_scoped_by_tenant_and_key(self):
        auth = make_authenticator()
        auth.authenticate(
            "POST", "/v1/events", signed_headers(nonce="n-shared"), b"{}"
        )
        other = signed_headers(
            tenant="t2", key="k2", secret=OTHER_SECRET, nonce="n-shared"
        )
        self.assertEqual(
            auth.authenticate("POST", "/v1/events", other, b"{}"), ("t2", "k2")
        )

    def test_nonce_reusable_after_ttl(self):
        clock = [NOW]
        auth = make_authenticator(clock=lambda: clock[0])
        auth.authenticate("POST", "/v1/events", signed_headers(nonce="n-ttl"), b"{}")
        clock[0] = NOW + security.NONCE_TTL_SECONDS
        headers = signed_headers(timestamp=clock[0], nonce="n-ttl")
        self.assertEqual(
            auth.authenticate("POST", "/v1/events", headers, b"{}"), ("t1", "k1")
        )

    def test_concurrent_reuse_of_one_nonce_single_success(self):
        auth = make_authenticator()
        headers = signed_headers(nonce="n-race")
        thread_count = 8
        barrier = threading.Barrier(thread_count)
        outcomes = []
        lock = threading.Lock()

        def attempt():
            barrier.wait()
            try:
                auth.authenticate("POST", "/v1/events", headers, b"{}")
                result = True
            except security.AuthenticationError:
                result = False
            with lock:
                outcomes.append(result)

        threads = [threading.Thread(target=attempt) for _ in range(thread_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(outcomes), thread_count)
        self.assertEqual(sum(outcomes), 1)

    def test_missing_and_repeated_headers_rejected(self):
        auth = make_authenticator()
        for name in security.REQUIRED_AUTH_HEADERS:
            headers = signed_headers(nonce="n-miss-" + name)
            del headers[name]
            with self.assertRaises(security.AuthenticationError):
                auth.authenticate("POST", "/v1/events", headers, b"{}")
            headers = signed_headers(nonce="n-dup-" + name)
            headers[name] = headers[name] + headers[name]
            with self.assertRaises(security.AuthenticationError):
                auth.authenticate("POST", "/v1/events", headers, b"{}")

    def test_generic_error_hides_failure_reason(self):
        auth = make_authenticator()
        messages = set()
        # Unknown tenant, unknown key, bad signature, stale timestamp, replay.
        cases = [
            signed_headers(tenant="ghost", nonce="n-g1"),
            signed_headers(key="ghost", nonce="n-g2"),
            signed_headers(timestamp=NOW - 9999, nonce="n-g4"),
        ]
        bad_signature = signed_headers(nonce="n-g3")
        bad_signature["x-signature"] = ["f" * 64]
        cases.append(bad_signature)
        replay = signed_headers(nonce="n-g5")
        auth.authenticate("POST", "/v1/events", replay, b"{}")
        cases.append(replay)
        for headers in cases:
            with self.assertRaises(security.AuthenticationError) as caught:
                auth.authenticate("POST", "/v1/events", headers, b"{}")
            messages.add(str(caught.exception))
        self.assertEqual(messages, {security.GENERIC_AUTH_ERROR})


class CallbackURLTests(unittest.TestCase):
    def resolver(self, table):
        def resolve(hostname):
            if hostname not in table:
                raise LookupError("no such host")
            return list(table[hostname])

        return resolve

    def test_valid_hostname_url(self):
        resolver = self.resolver({"hooks.example.test": ["93.184.216.34"]})
        result = security.validate_callback_url(
            "https://hooks.example.test/delivery?a=1", resolver
        )
        self.assertEqual(result.host, "hooks.example.test")
        self.assertEqual(result.ip, "93.184.216.34")
        self.assertEqual(result.port, 443)
        self.assertEqual(result.request_target, "/delivery?a=1")

    def test_port_8443_allowed_other_ports_rejected(self):
        resolver = self.resolver({"h.example.test": ["93.184.216.34"]})
        ok = security.validate_callback_url("https://h.example.test:8443/x", resolver)
        self.assertEqual(ok.port, 8443)
        for url in (
            "https://h.example.test:80/x",
            "https://h.example.test:444/x",
            "https://h.example.test:8080/x",
            "https://h.example.test:0/x",
        ):
            with self.assertRaises(security.CallbackURLError):
                security.validate_callback_url(url, resolver)

    def test_scheme_userinfo_fragment_and_host_shape_rejected(self):
        resolver = self.resolver({"h.example.test": ["93.184.216.34"]})
        for url in (
            "http://h.example.test/x",
            "ftp://h.example.test/x",
            "https://user@h.example.test/x",
            "https://user:pw@h.example.test/x",
            "https://h.example.test/x#frag",
            "https://h.example.test/x#",
            "https:///x",
            "https://:443/x",
            "https://bad_host!.example/x",
            "https://h.example.test:99999999999/x",
            "",
        ):
            with self.assertRaises(security.CallbackURLError):
                security.validate_callback_url(url, resolver)

    def test_non_global_ip_literals_rejected(self):
        resolver = self.resolver({})
        for host in (
            "127.0.0.1",          # loopback
            "10.0.0.8",           # private
            "192.168.1.4",        # private
            "172.16.0.9",         # private
            "169.254.9.1",        # link-local
            "224.0.0.1",          # multicast
            "240.0.0.1",          # reserved
            "0.0.0.0",            # unspecified
            "100.64.0.7",         # shared address space; not global
            "[::1]",              # IPv6 loopback
            "[fe80::1]",          # IPv6 link-local
            "[fc00::1]",          # IPv6 unique-local
            "[ff02::1]",          # IPv6 multicast
            "[::]",               # IPv6 unspecified
            "[::ffff:192.168.0.1]",  # IPv4-mapped private
            "[::ffff:127.0.0.1]",    # IPv4-mapped loopback
        ):
            with self.assertRaises(security.CallbackURLError):
                security.validate_callback_url("https://%s/x" % host, resolver)

    def test_global_ip_literals_accepted(self):
        resolver = self.resolver({})
        v4 = security.validate_callback_url("https://93.184.216.34/x", resolver)
        self.assertEqual(v4.ip, "93.184.216.34")
        v6 = security.validate_callback_url("https://[2606:4700::1111]/x", resolver)
        self.assertEqual(v6.ip, "2606:4700::1111")
        self.assertEqual(v6.host, "2606:4700::1111")

    def test_hostname_resolving_to_private_addresses_rejected(self):
        for answer in ("127.0.0.1", "10.1.2.3", "169.254.0.5", "::ffff:10.0.0.1"):
            resolver = self.resolver({"h.example.test": [answer]})
            with self.assertRaises(security.CallbackURLError):
                security.validate_callback_url("https://h.example.test/x", resolver)

    def test_mixed_safe_and_unsafe_dns_answers_rejected(self):
        resolver = self.resolver(
            {"h.example.test": ["93.184.216.34", "10.0.0.5"]}
        )
        with self.assertRaises(security.CallbackURLError):
            security.validate_callback_url("https://h.example.test/x", resolver)

    def test_multiple_safe_answers_accepted(self):
        resolver = self.resolver(
            {"h.example.test": ["93.184.216.34", "2606:4700::1111"]}
        )
        result = security.validate_callback_url("https://h.example.test/x", resolver)
        self.assertEqual(result.addresses, ("93.184.216.34", "2606:4700::1111"))
        self.assertEqual(result.ip, "93.184.216.34")

    def test_resolution_failure_and_empty_answers_rejected(self):
        with self.assertRaises(security.CallbackURLError):
            security.validate_callback_url(
                "https://h.example.test/x", self.resolver({})
            )
        with self.assertRaises(security.CallbackURLError):
            security.validate_callback_url(
                "https://h.example.test/x", self.resolver({"h.example.test": []})
            )

    def test_rejection_reveals_no_address_details(self):
        resolver = self.resolver({"h.example.test": ["10.9.8.7"]})
        with self.assertRaises(security.CallbackURLError) as caught:
            security.validate_callback_url("https://h.example.test/x", resolver)
        self.assertNotIn("10.9.8.7", str(caught.exception))


class RedactionTests(unittest.TestCase):
    def test_sensitive_fields_masked_recursively(self):
        record = {
            "event": "auth",
            "tenant_id": "t1",
            "signature": "deadbeef",
            "client_secret": "hunter2",
            "Authorization": "Bearer abc",
            "payload": {"card": "4111"},
            "body": b"raw",
            "nested": {"api_token": "tok-value-1234", "job_id": "j1"},
            "items": [{"password": "pw", "ok": 1}],
        }
        redacted = security.redact(record)
        self.assertEqual(redacted["tenant_id"], "t1")
        self.assertEqual(redacted["nested"]["job_id"], "j1")
        self.assertEqual(redacted["items"][0]["ok"], 1)
        for value in (
            redacted["signature"],
            redacted["client_secret"],
            redacted["Authorization"],
            redacted["payload"],
            redacted["body"],
            redacted["nested"]["api_token"],
            redacted["items"][0]["password"],
        ):
            self.assertEqual(value, security.REDACTED)
        text = repr(redacted)
        for leaked in ("deadbeef", "hunter2", "Bearer abc", "4111", "tok-value-1234", "pw"):
            self.assertNotIn(leaked, text)


if __name__ == "__main__":
    unittest.main()
