"""End-to-end API tests through Application.handle (no network involved)."""
import hashlib
import itertools
import json
import os
import tempfile
import threading
import unittest

from app import Application, MAX_BODY_BYTES, body_length_from_headers
from security import Authenticator, StructuredLogger, compute_signature
from store import Store

NOW = 1_700_000_000
SAFE_IP = "93.184.216.34"
HOST = "hooks.example.test"
URL = f"https://{HOST}/delivery"

SECRETS = {
    ("t1", "k1"): b"tenant-one-secret-for-tests-only",
    ("t2", "k1"): b"tenant-two-secret-for-tests-only",
}

_nonce_counter = itertools.count()


class Harness:
    """Bag of injected collaborators plus the Application under test."""


def _lookup(tenant, key):
    return SECRETS.get((tenant, key))


def make_harness(case, resolver=None):
    h = Harness()
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    h.db_path = os.path.join(tmp.name, "api.sqlite3")
    h.store = Store(h.db_path)
    case.addCleanup(h.store.close)
    h.clock_value = NOW
    h.events = []
    h.resolver = resolver or (lambda host: {HOST: [SAFE_IP]}[host])
    ids = itertools.count()
    h.clock = lambda: h.clock_value
    h.app = Application(
        store=h.store,
        authenticator=Authenticator(_lookup, h.clock),
        resolver=h.resolver,
        clock=h.clock,
        id_factory=lambda: f"job_{next(ids):04d}",
        logger=StructuredLogger(h.events.append),
    )
    return h


def signed(method, target, body=b"", *, tenant="t1", key="k1", ts=None,
           nonce=None, secret=None, extra=None, mutate_target=None):
    ts = ts if ts is not None else str(NOW)
    nonce = nonce or f"nonce-{next(_nonce_counter):08d}"
    secret = secret or SECRETS[(tenant, key)]
    headers = [
        ("X-Tenant-ID", tenant),
        ("X-Key-ID", key),
        ("X-Timestamp", ts),
        ("X-Nonce", nonce),
        (
            "X-Signature",
            compute_signature(secret, tenant, key, ts, nonce, method, target, body),
        ),
    ]
    headers.extend(extra or [])
    sent_target = mutate_target if mutate_target is not None else target
    return method, sent_target, headers, body


def event_body(event_id="evt_123", event_type="build.completed", url=URL,
               payload=None, raw=None):
    if raw is not None:
        return raw
    return json.dumps(
        {
            "event_id": event_id,
            "type": event_type,
            "callback_url": url,
            "payload": payload if payload is not None else {},
        }
    ).encode("utf-8")


def post_headers(idem="idem-key-00000001"):
    return [("Content-Type", "application/json"), ("Idempotency-Key", idem)]


def parse(response):
    return response.status, json.loads(response.body.decode("utf-8"))


class AuthApiTests(unittest.TestCase):
    def test_valid_post_and_get_roundtrip(self):
        h = make_harness(self)
        body = event_body()
        status, doc = parse(
            h.app.handle(*signed("POST", "/v1/events", body, extra=post_headers()))
        )
        self.assertEqual(status, 202)
        self.assertEqual(doc["status"], "queued")
        self.assertEqual(doc["event_id"], "evt_123")
        job_id = doc["job_id"]

        status, doc = parse(h.app.handle(*signed("GET", f"/v1/jobs/{job_id}")))
        self.assertEqual(status, 200)
        self.assertEqual(doc["job_id"], job_id)
        self.assertNotIn("payload", doc)

    def test_body_mutation_yields_401(self):
        h = make_harness(self)
        method, target, headers, _ = signed(
            "POST", "/v1/events", event_body(), extra=post_headers()
        )
        tampered = event_body(event_id="evt_evil")
        status, doc = parse(h.app.handle(method, target, headers, tampered))
        self.assertEqual((status, doc["error"]), (401, "authentication_failed"))

    def test_raw_target_mutation_yields_401(self):
        h = make_harness(self)
        req = signed("GET", "/v1/jobs/abc", mutate_target="/v1/jobs/abc?x=1")
        status, doc = parse(h.app.handle(*req))
        self.assertEqual((status, doc["error"]), (401, "authentication_failed"))

    def test_timestamp_outside_window_yields_401(self):
        h = make_harness(self)
        status, _ = parse(h.app.handle(*signed("GET", "/v1/jobs/x",
                                               ts=str(NOW - 301))))
        self.assertEqual(status, 401)
        status, _ = parse(h.app.handle(*signed("GET", "/v1/jobs/x",
                                               ts=str(NOW - 300))))
        self.assertEqual(status, 404)  # authenticated, job simply absent

    def test_auth_errors_are_generic(self):
        h = make_harness(self)
        cases = [
            signed("GET", "/v1/jobs/x", tenant="ghost", secret=b"whatever"),
            signed("GET", "/v1/jobs/x", secret=b"wrong-secret"),
            signed("GET", "/v1/jobs/x", ts=str(NOW - 999)),
        ]
        bodies = set()
        for req in cases:
            status, doc = parse(h.app.handle(*req))
            self.assertEqual(status, 401)
            bodies.add(json.dumps(doc, sort_keys=True))
        self.assertEqual(len(bodies), 1)  # indistinguishable failures


class EventValidationTests(unittest.TestCase):
    def post(self, h, body, idem="idem-key-00000001", extra_headers=None):
        headers = post_headers(idem) + (extra_headers or [])
        return parse(
            h.app.handle(*signed("POST", "/v1/events", body, extra=headers))
        )

    def test_duplicate_json_keys_rejected_at_any_depth(self):
        h = make_harness(self)
        raw = (b'{"event_id":"e1","type":"t.t","callback_url":"' + URL.encode()
               + b'","payload":{"a":1,"a":2}}')
        status, doc = self.post(h, raw)
        self.assertEqual((status, doc["error"]), (400, "invalid_body"))
        raw = (b'{"event_id":"e1","event_id":"e1","type":"t.t","callback_url":"'
               + URL.encode() + b'","payload":{}}')
        self.assertEqual(self.post(h, raw)[0], 400)

    def test_non_finite_numbers_rejected(self):
        h = make_harness(self)
        for lit in (b"NaN", b"Infinity", b"-Infinity"):
            raw = (b'{"event_id":"e1","type":"t.t","callback_url":"'
                   + URL.encode() + b'","payload":{"n":' + lit + b"}}")
            status, doc = self.post(h, raw)
            self.assertEqual((status, doc["error"]), (400, "invalid_body"), lit)

    def test_invalid_utf8_rejected(self):
        h = make_harness(self)
        status, doc = self.post(h, b'{"event_id":"\xff\xfe"}')
        self.assertEqual((status, doc["error"]), (400, "invalid_body"))

    def test_unknown_fields_and_non_object_payloads_rejected(self):
        h = make_harness(self)
        body = event_body()
        doc = json.loads(body)
        doc["extra"] = 1
        status, _ = self.post(h, json.dumps(doc).encode())
        self.assertEqual(status, 400)
        status, _ = self.post(h, b'["not","an","object"]')
        self.assertEqual(status, 400)
        for bad_payload in ([1, 2], "text", 5, None, True):
            raw = json.dumps(
                {"event_id": "e1", "type": "t.t", "callback_url": URL,
                 "payload": bad_payload}
            ).encode()
            status, doc = self.post(h, raw)
            self.assertEqual((status, doc["error"]), (400, "invalid_payload"))

    def test_field_format_validation(self):
        h = make_harness(self)
        status, doc = self.post(h, event_body(event_id="bad id!"))
        self.assertEqual((status, doc["error"]), (400, "invalid_event_id"))
        status, doc = self.post(h, event_body(event_type="Build.Completed"))
        self.assertEqual((status, doc["error"]), (400, "invalid_type"))
        status, doc = self.post(h, event_body(event_id="e" * 65))
        self.assertEqual(status, 400)

    def test_content_type_and_encoding_enforced(self):
        h = make_harness(self)
        body = event_body()
        status, _ = parse(h.app.handle(*signed(
            "POST", "/v1/events", body,
            extra=[("Content-Type", "text/plain"),
                   ("Idempotency-Key", "idem-key-00000001")],
        )))
        self.assertEqual(status, 415)
        status, _ = self.post(h, body,
                              extra_headers=[("Content-Encoding", "gzip")])
        self.assertEqual(status, 415)

    def test_idempotency_key_required_and_validated(self):
        h = make_harness(self)
        body = event_body()
        status, doc = parse(h.app.handle(*signed(
            "POST", "/v1/events", body, extra=[("Content-Type", "application/json")]
        )))
        self.assertEqual((status, doc["error"]), (400, "invalid_idempotency_key"))
        status, _ = self.post(h, body, idem="short")
        self.assertEqual(status, 400)
        status, _ = self.post(h, body, idem="bad key with spaces!")
        self.assertEqual(status, 400)

    def test_body_size_limit_enforced(self):
        h = make_harness(self)
        oversized = b"x" * (MAX_BODY_BYTES + 1)
        response = h.app.handle(
            *signed("POST", "/v1/events", oversized, extra=post_headers())
        )
        status, doc = parse(response)
        self.assertEqual((status, doc["error"]), (413, "body_too_large"))
        # The HTTP adapter refuses from Content-Length alone, before reading.
        self.assertEqual(
            body_length_from_headers([("Content-Length", str(MAX_BODY_BYTES + 1))]),
            MAX_BODY_BYTES + 1,
        )
        with self.assertRaises(Exception):
            body_length_from_headers(
                [("Content-Length", "10"), ("Content-Length", "99")]
            )
        with self.assertRaises(Exception):
            body_length_from_headers([("Content-Length", "-1")])

    def test_unsafe_callback_urls_rejected_generically(self):
        resolver_map = {
            "internal.example.test": ["10.0.0.9"],
            "loop.example.test": ["127.0.0.1"],
            "link.example.test": ["169.254.9.9"],
            "mapped.example.test": ["::ffff:192.168.1.4"],
            "mixed.example.test": [SAFE_IP, "10.1.1.1"],
        }
        h = make_harness(self, resolver=lambda host: resolver_map[host])
        for host in resolver_map:
            body = event_body(url=f"https://{host}/hook")
            status, doc = self.post(h, body)
            self.assertEqual((status, doc["error"]), (422, "invalid_callback_url"))
            self.assertNotIn("10.0.0.9", json.dumps(doc))
        for bad in ["http://x.test/a", "https://u@x.test/a", "https://x.test/a#f",
                    "https://x.test:9443/a", "https://127.0.0.1/a"]:
            status, doc = self.post(h, event_body(url=bad))
            self.assertEqual((status, doc["error"]), (422, "invalid_callback_url"))


class IdempotencyApiTests(unittest.TestCase):
    def post(self, h, body, idem="idem-key-00000001", tenant="t1"):
        return parse(h.app.handle(*signed(
            "POST", "/v1/events", body, tenant=tenant,
            extra=[("Content-Type", "application/json"), ("Idempotency-Key", idem)],
        )))

    def test_same_body_returns_original_job_with_duplicate_flag(self):
        h = make_harness(self)
        body = event_body()
        status, first = self.post(h, body)
        self.assertEqual(status, 202)
        self.assertNotIn("duplicate", first)
        # Fresh timestamp/nonce/signature; same key and byte-identical body.
        status, second = self.post(h, body)
        self.assertEqual(status, 200)
        self.assertTrue(second["duplicate"])
        self.assertEqual(second["job_id"], first["job_id"])

    def test_conflicting_body_returns_409(self):
        h = make_harness(self)
        self.assertEqual(self.post(h, event_body())[0], 202)
        status, doc = self.post(h, event_body(payload={"other": 1}))
        self.assertEqual((status, doc["error"]), (409, "idempotency_conflict"))

    def test_event_id_reuse_under_new_key_is_409(self):
        h = make_harness(self)
        self.assertEqual(self.post(h, event_body())[0], 202)
        status, doc = self.post(h, event_body(), idem="idem-key-00000002")
        self.assertEqual((status, doc["error"]), (409, "event_id_conflict"))

    def test_tenants_do_not_share_idempotency_scope(self):
        h = make_harness(self)
        self.assertEqual(self.post(h, event_body())[0], 202)
        status, doc = self.post(h, event_body(payload={"t2": True}), tenant="t2")
        self.assertEqual(status, 202)

    def test_concurrent_idempotent_posts_separate_connections(self):
        h = make_harness(self)
        body = event_body()
        results = []
        barrier = threading.Barrier(4)

        def submit():
            store = Store(h.db_path)
            app = Application(
                store=store,
                authenticator=Authenticator(_lookup, h.clock),
                resolver=h.resolver,
                clock=h.clock,
            )
            req = signed("POST", "/v1/events", body, extra=post_headers())
            barrier.wait()
            try:
                results.append(parse(app.handle(*req)))
            finally:
                store.close()

        threads = [threading.Thread(target=submit) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        statuses = sorted(s for s, _ in results)
        self.assertEqual(statuses, [200, 200, 200, 202])
        job_ids = {doc["job_id"] for _, doc in results}
        self.assertEqual(len(job_ids), 1)


class JobLookupTests(unittest.TestCase):
    def test_cross_tenant_lookup_indistinguishable_from_missing(self):
        h = make_harness(self)
        status, doc = parse(h.app.handle(*signed(
            "POST", "/v1/events", event_body(), extra=post_headers()
        )))
        self.assertEqual(status, 202)
        job_id = doc["job_id"]

        s_foreign, d_foreign = parse(
            h.app.handle(*signed("GET", f"/v1/jobs/{job_id}", tenant="t2"))
        )
        s_missing, d_missing = parse(
            h.app.handle(*signed("GET", "/v1/jobs/job_nope", tenant="t2"))
        )
        self.assertEqual((s_foreign, s_missing), (404, 404))
        self.assertEqual(d_foreign, d_missing)

    def test_hostile_job_ids_handled_safely(self):
        h = make_harness(self)
        parse(h.app.handle(*signed(
            "POST", "/v1/events", event_body(), extra=post_headers()
        )))
        hostile_targets = [
            "/v1/jobs/job_0000%27%20OR%20%271%27%3D%271",
            "/v1/jobs/job_0000%3B%20DROP%20TABLE%20jobs%3B--",
            "/v1/jobs/%25",
        ]
        for target in hostile_targets:
            status, doc = parse(h.app.handle(*signed("GET", target)))
            self.assertEqual(status, 404, target)
            self.assertNotIn("sqlite", json.dumps(doc).lower())
        # Store unharmed.
        status, _ = parse(h.app.handle(*signed("GET", "/v1/jobs/job_0000")))
        self.assertEqual(status, 200)


class LoggingHygieneTests(unittest.TestCase):
    def test_logs_contain_no_secrets_signatures_or_payloads(self):
        h = make_harness(self)
        payload_marker = "payload-secret-marker-xyzzy"
        body = event_body(payload={"card": payload_marker})
        method, target, headers, _ = signed(
            "POST", "/v1/events", body, extra=post_headers()
        )
        signature = dict(headers)["X-Signature"]
        status, _ = parse(h.app.handle(method, target, headers, body))
        self.assertEqual(status, 202)
        # And a failed auth attempt also gets logged safely.
        h.app.handle(*signed("GET", "/v1/jobs/x", secret=b"wrong"))

        blob = repr(h.events)
        self.assertTrue(h.events)
        for secret in SECRETS.values():
            self.assertNotIn(secret.decode(), blob)
        self.assertNotIn(signature, blob)
        self.assertNotIn(payload_marker, blob)
        self.assertNotIn("Idempotency", blob)


if __name__ == "__main__":
    unittest.main()
