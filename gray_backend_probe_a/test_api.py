"""End-to-end tests for the RelayVault application layer, the HTTP adapter and
the delivery worker.

Everything is deterministic and offline: the clock, job ids, DNS resolver and
outbound transport are injected fakes, and the HTTP adapter is driven with
in-memory buffers instead of a socket.  No real network connection is made.
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import types
import unittest

from app import (
    MAX_BODY_BYTES,
    Application,
    RelayVaultHTTPRequestHandler,
    Response,
    build_application,
    load_config_from_env,
    parse_target,
)
from security import Config, JsonLogger, RequestError, sign
from store import STATUS_FAILED, STATUS_PENDING, STATUS_RETRYING, Store
from worker import (
    CLASSIFICATIONS,
    DeliveryResponse,
    DeliveryWorker,
    ResponseTooLarge,
    TransportError,
    TransportTimeout,
    classify_status,
)

TENANT_A = "tenant_a"
TENANT_B = "tenant_b"
KEY = "key_1"
SECRET_A = b"api-test-secret-value-aaaaaaaaaa1"
SECRET_B = b"api-test-secret-value-bbbbbbbbbb2"
NOW = 1_700_000_000
SAFE_V4 = "93.184.216.34"
SAFE_V4_ALT = "8.8.8.8"
CALLBACK = "https://hooks.example.test/delivery"


class FakeClock:
    def __init__(self, value=NOW):
        self.value = int(value)

    def __call__(self):
        return int(self.value)

    def advance(self, seconds):
        self.value += int(seconds)
        return self.value


class FakeMonotonic:
    """Monotonic source that never goes backwards and is never persisted."""

    def __init__(self, start=1000.0, step=0.25):
        self.value = float(start)
        self.step = float(step)

    def __call__(self):
        current = self.value
        self.value += self.step
        return current


class FakeResolver:
    def __init__(self, answers=(SAFE_V4,)):
        self.answers = list(answers)
        self.calls: list[str] = []

    def __call__(self, hostname):
        self.calls.append(hostname)
        return list(self.answers)


class FakeTransport:
    def __init__(self, responses=None, exception=None):
        self.requests = []
        self.responses = list(responses or [])
        self.exception = exception

    def __call__(self, request):
        self.requests.append(request)
        if self.exception is not None:
            raise self.exception
        if self.responses:
            return self.responses.pop(0)
        return DeliveryResponse(status_code=200, response_bytes=11)


class Recorder:
    """Structured log sink that keeps raw JSON lines for inspection."""

    def __init__(self):
        self.lines: list[str] = []
        self.log = JsonLogger(self.lines.append)

    def __call__(self, event, **fields):
        self.log(event, **fields)

    def events(self):
        return [json.loads(line)["event"] for line in self.lines]

    def text(self):
        return "\n".join(self.lines)


_UNSET = object()


def event_body(
    event_id="evt_123",
    event_type="build.completed",
    callback_url=CALLBACK,
    payload=_UNSET,
    extra=None,
):
    document = {
        "event_id": event_id,
        "type": event_type,
        "callback_url": callback_url,
        "payload": {"build": 7} if payload is _UNSET else payload,
    }
    if extra:
        document.update(extra)
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.config = Config({TENANT_A: {KEY: SECRET_A}, TENANT_B: {KEY: SECRET_B}})
        self.clock = FakeClock()
        self.monotonic = FakeMonotonic()
        self.resolver = FakeResolver()
        self.recorder = Recorder()
        self.stores: list[Store] = []
        self.ids = 0
        self.nonce_seq = 0
        self.app, self.store = self.build_app()

    def tearDown(self):
        for store in self.stores:
            store.close()
        self._tmp.cleanup()

    def next_id(self):
        self.ids += 1
        return "job_%04d" % self.ids

    def build_app(self, *, id_factory=None, resolver=None, log=None):
        app, store = build_application(
            db_path=self.db_path,
            config=self.config,
            clock=self.clock,
            monotonic=self.monotonic,
            resolver=resolver if resolver is not None else self.resolver,
            id_factory=id_factory or self.next_id,
            log=log if log is not None else self.recorder,
        )
        self.stores.append(store)
        return app, store

    # -- request helpers ------------------------------------------------- #

    def headers(
        self,
        *,
        method="POST",
        target="/v1/events",
        body=b"",
        tenant=TENANT_A,
        secret=None,
        key=KEY,
        timestamp=None,
        nonce=None,
        signature=None,
        content_type="application/json",
        idem_key="idem-key-0001",
        extra=(),
        sign_target=None,
        sign_body=None,
    ):
        secret = secret if secret is not None else (SECRET_A if tenant == TENANT_A else SECRET_B)
        timestamp = self.clock.value if timestamp is None else timestamp
        if nonce is None:
            self.nonce_seq += 1
            nonce = "nonce-auto-%08d" % self.nonce_seq
        computed = sign(
            secret,
            tenant,
            key,
            str(timestamp),
            nonce,
            method,
            target if sign_target is None else sign_target,
            body if sign_body is None else sign_body,
        )
        headers = [
            ("X-Tenant-ID", tenant),
            ("X-Key-ID", key),
            ("X-Timestamp", str(timestamp)),
            ("X-Nonce", nonce),
            ("X-Signature", computed if signature is None else signature),
        ]
        if method == "POST":
            if content_type is not None:
                headers.append(("Content-Type", content_type))
            if idem_key is not None:
                headers.append(("Idempotency-Key", idem_key))
        headers.extend(extra)
        return headers

    def post(self, body=None, *, app=None, **kwargs):
        body = event_body() if body is None else body
        app = app or self.app
        headers = kwargs.pop("headers", None)
        if headers is None:
            headers = self.headers(method="POST", target="/v1/events", body=body, **kwargs)
        return app.handle("POST", "/v1/events", headers, body)

    def get_job(self, job_id, *, app=None, tenant=TENANT_A, **kwargs):
        target = "/v1/jobs/" + job_id
        app = app or self.app
        headers = kwargs.pop("headers", None)
        if headers is None:
            headers = self.headers(method="GET", target=target, tenant=tenant, **kwargs)
        return app.handle("GET", target, headers, b"")

    def assert_json_error(self, response, status, code):
        self.assertEqual(response.status, status)
        self.assertEqual(response.content_type, "application/json")
        document = response.json()
        self.assertIs(document["ok"], False)
        self.assertEqual(document["error"]["code"], code)
        self.assertEqual(set(document), {"ok", "error"})
        self.assertEqual(set(document["error"]), {"code", "message"})
        blob = response.body.decode()
        for forbidden in ("Traceback", "SELECT", "sqlite", "INSERT", SECRET_A.decode()):
            self.assertNotIn(forbidden, blob)
        return document


class CreateEventTests(ApiTestCase):
    # 1. valid authentication
    def test_valid_request_creates_a_job(self):
        response = self.post()
        self.assertEqual(response.status, 202)
        self.assertEqual(response.content_type, "application/json")
        document = response.json()
        self.assertIs(document["ok"], True)
        data = document["data"]
        self.assertEqual(data["job_id"], "job_0001")
        self.assertEqual(data["event_id"], "evt_123")
        self.assertEqual(data["type"], "build.completed")
        self.assertEqual(data["status"], STATUS_PENDING)
        self.assertEqual(data["attempts"], 0)
        self.assertIs(data["duplicate"], False)
        self.assertNotIn("payload", data)
        self.assertEqual(dict(response.headers)["Cache-Control"], "no-store")
        self.assertEqual(dict(response.headers)["X-Content-Type-Options"], "nosniff")
        self.assertEqual(int(dict(response.headers)["Content-Length"]), len(response.body))
        # compact JSON, no padding
        self.assertNotIn(b", ", response.body)

    def test_stored_job_is_scoped_and_holds_the_payload_only_in_the_store(self):
        self.post(event_body(payload={"secret_marker": "top-secret-payload"}))
        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertIn("top-secret-payload", job.payload_json)
        self.assertNotIn("top-secret-payload", self.recorder.text())

    # 2. mutation invalidates a signature
    def test_body_mutation_is_rejected(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body)
        mutated = body.replace(b"evt_123", b"evt_999")
        self.assert_json_error(self.app.handle("POST", "/v1/events", headers, mutated), 401, "unauthenticated")
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0001"))

    def test_raw_target_mutation_is_rejected(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events?trace=1", body=body)
        self.assert_json_error(
            self.app.handle("POST", "/v1/events?trace=2", headers, body), 401, "unauthenticated"
        )
        # The signed query string is honoured when it is not tampered with.
        headers = self.headers(method="POST", target="/v1/events?trace=1", body=body)
        self.assertEqual(self.app.handle("POST", "/v1/events?trace=1", headers, body).status, 202)

    def test_signature_must_cover_the_raw_not_the_decoded_target(self):
        self.post()
        raw_target = "/v1/jobs/job_%30001"  # decodes to /v1/jobs/job_0001
        decoded_target = "/v1/jobs/job_0001"
        self.assertEqual(parse_target(raw_target).segments[2], "job_0001")

        signed_over_decoded = self.headers(method="GET", target=raw_target, sign_target=decoded_target)
        self.assert_json_error(
            self.app.handle("GET", raw_target, signed_over_decoded, b""), 401, "unauthenticated"
        )
        signed_over_raw = self.headers(method="GET", target=raw_target)
        response = self.app.handle("GET", raw_target, signed_over_raw, b"")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json()["data"]["job_id"], "job_0001")

    # 3. malformed signatures
    def test_malformed_signature_is_a_generic_401(self):
        body = event_body()
        for candidate in ("", "zz", "0" * 63, "0" * 65, "A" * 64, "not-a-signature"):
            with self.subTest(signature=candidate):
                response = self.post(body, signature=candidate, nonce="nonce-malformed-0001")
                self.assert_json_error(response, 401, "unauthenticated")
                self.assertEqual(response.json()["error"]["message"], "authentication failed")
        self.assertEqual(self.store.count_nonces(), 0)

    # 4. timestamp boundaries
    def test_timestamp_boundaries(self):
        for offset, expected in ((-300, 202), (300, 202), (-301, 401), (301, 401)):
            with self.subTest(offset=offset):
                body = event_body(event_id="evt_%d" % (offset + 1000))
                response = self.post(
                    body,
                    timestamp=self.clock.value + offset,
                    nonce="nonce-ts-%d" % offset,
                    idem_key="idem-key-ts%04d" % (offset + 1000),
                )
                self.assertEqual(response.status, expected)

    # 5. an invalid signature must not burn the nonce
    def test_invalid_signature_does_not_consume_the_nonce(self):
        body = event_body()
        nonce = "nonce-not-burned-1"
        self.assert_json_error(
            self.post(body, nonce=nonce, secret=SECRET_B), 401, "unauthenticated"
        )
        self.assertEqual(self.store.count_nonces(), 0)
        self.assertEqual(self.post(body, nonce=nonce).status, 202)
        self.assertEqual(self.store.count_nonces(), 1)

    def test_nonce_replay_is_rejected_even_with_a_valid_signature(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body, nonce="nonce-replayed-1")
        self.assertEqual(self.app.handle("POST", "/v1/events", headers, body).status, 202)
        self.assert_json_error(
            self.app.handle("POST", "/v1/events", headers, body), 401, "unauthenticated"
        )

    # 6. concurrent reuse of one nonce through separate SQLite connections
    def test_concurrent_nonce_reuse_admits_exactly_one_request(self):
        worker_count = 10
        body = event_body()
        apps = [self.build_app(id_factory=lambda: "job_shared")[0] for _ in range(worker_count)]
        headers = self.headers(method="POST", target="/v1/events", body=body, nonce="nonce-contended-1")
        barrier = threading.Barrier(worker_count)
        statuses: list[int] = []
        lock = threading.Lock()

        def attempt(app):
            barrier.wait()
            response = app.handle("POST", "/v1/events", list(headers), body)
            with lock:
                statuses.append(response.status)

        threads = [threading.Thread(target=attempt, args=(a,)) for a in apps]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(statuses), worker_count)
        self.assertEqual(statuses.count(202), 1)
        self.assertEqual(statuses.count(401), worker_count - 1)
        self.assertEqual(self.store.count_nonces(), 1)


class BodyPolicyTests(ApiTestCase):
    # 7. duplicate JSON keys and non-finite numbers
    def test_duplicate_json_keys_are_rejected_at_any_depth(self):
        bodies = [
            b'{"event_id":"evt_1","event_id":"evt_2","type":"a.b","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{}}',
            b'{"event_id":"evt_1","type":"a.b","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{"a":1,"a":2}}',
            b'{"event_id":"evt_1","type":"a.b","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{"outer":{"deep":{"x":1,"x":2}}}}',
            b'{"event_id":"evt_1","type":"a.b","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{"list":[{"y":1,"y":2}]}}',
        ]
        for body in bodies:
            with self.subTest(body=body[:60]):
                self.assert_json_error(self.post(body), 400, "duplicate_json_key")

    def test_non_finite_numbers_are_rejected(self):
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e999", b"-1e999"):
            with self.subTest(literal=literal):
                body = (
                    b'{"event_id":"evt_1","type":"a.b","callback_url":"'
                    + CALLBACK.encode()
                    + b'","payload":{"n":'
                    + literal
                    + b"}}"
                )
                self.assert_json_error(self.post(body), 400, "non_finite_number")

    def test_absurd_integer_literals_are_rejected(self):
        body = (
            b'{"event_id":"evt_1","type":"a.b","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{"n":'
            + b"9" * 400
            + b"}}"
        )
        self.assert_json_error(self.post(body), 400, "number_out_of_range")

    def test_invalid_utf8_and_broken_json_are_rejected(self):
        self.assert_json_error(self.post(b'{"event_id":"\xff\xfe"}'), 400, "invalid_encoding")
        self.assert_json_error(self.post(b"{not json"), 400, "invalid_json")
        self.assert_json_error(self.post(b""), 400, "empty_body")
        self.assert_json_error(self.post(b'"a string"'), 400, "body_not_object")
        self.assert_json_error(self.post(b"[1,2,3]"), 400, "body_not_object")

    def test_unknown_fields_and_bad_field_types_are_rejected(self):
        cases = [
            (event_body(extra={"surprise": 1}), "unknown_field"),
            (b'{"event_id":"evt_1","type":"a.b","callback_url":"' + CALLBACK.encode() + b'"}', "missing_field"),
            (event_body(payload=[1, 2]), "invalid_payload"),
            (event_body(payload="text"), "invalid_payload"),
            (event_body(payload=None), "invalid_payload"),
            (event_body(event_id=""), "invalid_event_id"),
            (event_body(event_id="evt with spaces"), "invalid_event_id"),
            (event_body(event_id="e" * 65), "invalid_event_id"),
            (event_body(event_id=12), "invalid_event_id"),
            (event_body(event_type="Build.Completed"), "invalid_type"),
            (event_body(event_type="t" * 81), "invalid_type"),
            (event_body(event_type=""), "invalid_type"),
            (event_body(callback_url=17), "invalid_callback_url"),
        ]
        for body, code in cases:
            with self.subTest(code=code, body=body[:70]):
                self.assert_json_error(self.post(body), 400, code)

    def test_content_type_and_encoding_policy(self):
        body = event_body()
        self.assertEqual(
            self.post(
                event_body(event_id="evt_charset"),
                content_type="application/json; charset=utf-8",
                idem_key="idem-key-ct00001",
            ).status,
            202,
        )
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/json+evil", None,
                             "application/json; charset=utf-16", "application/json; boundary=x"):
            with self.subTest(content_type=content_type):
                self.assert_json_error(
                    self.post(body, content_type=content_type), 415, "unsupported_media_type"
                )
        self.assert_json_error(
            self.post(body, extra=(("Content-Encoding", "gzip"),)), 415, "unsupported_content_encoding"
        )
        self.assertEqual(
            self.post(
                event_body(event_id="evt_identity"),
                extra=(("Content-Encoding", "identity"),),
                idem_key="idem-key-ct00002",
            ).status,
            202,
        )

    # 8. body size enforcement at the application layer
    def test_oversized_body_is_rejected_by_the_application(self):
        payload = {"blob": "x" * (MAX_BODY_BYTES + 100)}
        body = event_body(payload=payload)
        self.assertGreater(len(body), MAX_BODY_BYTES)
        self.assert_json_error(self.post(body), 413, "payload_too_large")

    def test_body_at_the_limit_is_accepted(self):
        base = len(event_body(payload={"blob": ""}))
        filler = "x" * (MAX_BODY_BYTES - base)
        body = event_body(payload={"blob": filler})
        self.assertEqual(len(body), MAX_BODY_BYTES)
        self.assertEqual(self.post(body).status, 202)

    def test_idempotency_key_is_required_and_validated(self):
        body = event_body()
        for key in (None, "short", "bad key!", "k" * 81, "has/slash"):
            with self.subTest(key=key):
                self.assert_json_error(
                    self.post(body, idem_key=key), 400, "invalid_idempotency_key"
                )


class IdempotencyApiTests(ApiTestCase):
    # 9. same-body and conflicting-body idempotency
    def test_repeat_with_identical_body_returns_the_original_job(self):
        body = event_body()
        first = self.post(body, idem_key="idem-key-repeat1", nonce="nonce-first-0001")
        self.assertEqual(first.status, 202)
        self.clock.advance(30)
        second = self.post(body, idem_key="idem-key-repeat1", nonce="nonce-second-001")
        self.assertEqual(second.status, 200)
        self.assertIs(second.json()["data"]["duplicate"], True)
        self.assertEqual(second.json()["data"]["job_id"], first.json()["data"]["job_id"])
        self.assertEqual(second.json()["data"]["created_at"], NOW)
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0002"))

    def test_repeat_with_different_body_conflicts(self):
        self.post(event_body(), idem_key="idem-key-repeat2")
        response = self.post(event_body(event_id="evt_other"), idem_key="idem-key-repeat2")
        self.assert_json_error(response, 409, "idempotency_conflict")

    def test_byte_identical_means_byte_identical(self):
        first = json.dumps(
            {"event_id": "evt_1", "type": "a.b", "callback_url": CALLBACK, "payload": {"a": 1, "b": 2}},
            separators=(",", ":"),
        ).encode()
        reordered = json.dumps(
            {"payload": {"b": 2, "a": 1}, "callback_url": CALLBACK, "type": "a.b", "event_id": "evt_1"},
            separators=(",", ":"),
        ).encode()
        self.assertNotEqual(first, reordered)
        self.assertEqual(self.post(first, idem_key="idem-key-bytes01").status, 202)
        self.assert_json_error(
            self.post(reordered, idem_key="idem-key-bytes01"), 409, "idempotency_conflict"
        )

    def test_same_key_is_independent_per_tenant(self):
        body = event_body()
        first = self.post(body, tenant=TENANT_A, idem_key="idem-key-shared1")
        second = self.post(body, tenant=TENANT_B, idem_key="idem-key-shared1")
        self.assertEqual(first.status, 202)
        self.assertEqual(second.status, 202)
        self.assertNotEqual(first.json()["data"]["job_id"], second.json()["data"]["job_id"])

    def test_new_event_id_needs_a_new_key_and_duplicate_event_id_conflicts(self):
        self.post(event_body(event_id="evt_dup"), idem_key="idem-key-evt0001")
        response = self.post(event_body(event_id="evt_dup"), idem_key="idem-key-evt0002")
        self.assert_json_error(response, 409, "event_id_conflict")
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0002"))
        # Another tenant is unaffected.
        self.assertEqual(
            self.post(event_body(event_id="evt_dup"), tenant=TENANT_B, idem_key="idem-key-evt0003").status,
            202,
        )

    # 10. concurrent idempotency across separate SQLite connections
    def test_concurrent_identical_requests_yield_one_job(self):
        worker_count = 10
        body = event_body()
        apps = []
        for index in range(worker_count):
            app, _store = self.build_app(id_factory=lambda index=index: "job_c%04d" % index)
            apps.append(app)
        header_sets = [
            self.headers(
                method="POST",
                target="/v1/events",
                body=body,
                nonce="nonce-concurrent-%04d" % index,
                idem_key="idem-key-conc001",
            )
            for index in range(worker_count)
        ]
        barrier = threading.Barrier(worker_count)
        outcomes: list[tuple[int, str]] = []
        lock = threading.Lock()

        def attempt(app, headers):
            barrier.wait()
            response = app.handle("POST", "/v1/events", headers, body)
            document = response.json()
            job_id = document["data"]["job_id"] if response.status < 400 else ""
            with lock:
                outcomes.append((response.status, job_id))

        threads = [
            threading.Thread(target=attempt, args=(app, headers))
            for app, headers in zip(apps, header_sets)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        statuses = [status for status, _ in outcomes]
        job_ids = {job_id for _, job_id in outcomes}
        self.assertEqual(len(outcomes), worker_count)
        self.assertEqual(statuses.count(202), 1)
        self.assertEqual(statuses.count(200), worker_count - 1)
        self.assertEqual(len(job_ids), 1)


class JobLookupTests(ApiTestCase):
    # 11. cross-tenant lookups are indistinguishable from missing jobs
    def test_cross_tenant_and_missing_jobs_look_identical(self):
        self.post()
        owner = self.get_job("job_0001", tenant=TENANT_A)
        self.assertEqual(owner.status, 200)
        self.assertEqual(owner.json()["data"]["job_id"], "job_0001")

        stranger = self.get_job("job_0001", tenant=TENANT_B)
        missing = self.get_job("job_does_not_exist", tenant=TENANT_B)
        for response in (stranger, missing):
            self.assert_json_error(response, 404, "not_found")
        self.assertEqual(stranger.body, missing.body)
        self.assertEqual(stranger.status, missing.status)

    def test_get_requires_authentication_and_an_empty_body(self):
        self.post()
        self.assert_json_error(
            self.app.handle("GET", "/v1/jobs/job_0001", [], b""), 401, "unauthenticated"
        )
        headers = self.headers(method="GET", target="/v1/jobs/job_0001")
        self.assert_json_error(
            self.app.handle("GET", "/v1/jobs/job_0001", headers, b"{}"), 400, "unexpected_body"
        )

    # 12. hostile job ids are parameterised, never interpolated
    def test_hostile_job_ids_are_safe(self):
        self.post()
        # These reach the SQL layer as bound parameters and simply miss.
        sql_hostile = [
            "job_0001'%20OR%20'1'='1",
            "%27%3B%20DROP%20TABLE%20jobs%3B%20--",
            "job_0001%22%20OR%201=1--",
            "job_0001%3B%20DELETE%20FROM%20jobs",
            "1%20UNION%20SELECT%20payload_json%20FROM%20jobs",
            "job_0001%20AND%201=1",
            "j" * 600,
        ]
        for job_id in sql_hostile:
            with self.subTest(job_id=job_id):
                response = self.get_job(job_id)
                self.assert_json_error(response, 404, "not_found")
                self.assertNotIn("payload", response.body.decode())
        # These never reach the store at all: the encoding itself is refused.
        for job_id in ("job_0001%00", "job_0001%25", "a%2fb"):
            with self.subTest(job_id=job_id):
                response = self.get_job(job_id)
                self.assertEqual(response.status, 400)
                self.assertIs(response.json()["ok"], False)
        # The table and the original row survived.
        self.assertEqual(self.get_job("job_0001").status, 200)
        self.assertIsNotNone(self.store.get_job(TENANT_A, "job_0001"))

    def test_routing_rejects_encoded_separators_and_traversal(self):
        for target in (
            "/v1/jobs/a%2fb",
            "/v1/jobs/a%2Fb",
            "/v1/jobs/%00",
            "/v1/jobs/a%25b",
            "/v1/../v1/events",
            "/v1//jobs/job_0001",
            "/v1/jobs/job_0001/..",
        ):
            with self.subTest(target=target):
                with self.assertRaises(RequestError):
                    parse_target(target)
                response = self.app.handle("GET", target, [], b"")
                self.assertIn(response.status, (400, 404))
                self.assertIs(response.json()["ok"], False)

    def test_unknown_routes_and_methods(self):
        self.assert_json_error(self.app.handle("GET", "/", [], b""), 404, "not_found")
        self.assert_json_error(self.app.handle("GET", "/v1/unknown", [], b""), 404, "not_found")
        self.assert_json_error(self.app.handle("GET", "/v1/events", [], b""), 405, "method_not_allowed")
        self.assert_json_error(
            self.app.handle("DELETE", "/v1/jobs/job_0001", [], b""), 405, "method_not_allowed"
        )
        response = self.app.handle("GET", "/v1/events", [], b"")
        self.assertEqual(dict(response.headers)["Allow"], "POST")

    def test_target_shape_is_validated(self):
        self.assert_json_error(self.app.handle("GET", "v1/events", [], b""), 400, "invalid_target")
        self.assert_json_error(self.app.handle("GET", "/v1/jobs/" + "j" * 4000, [], b""), 414, "target_too_long")


class CallbackUrlApiTests(ApiTestCase):
    # 13/14 at the API boundary
    def test_unsafe_callback_urls_are_refused_at_creation(self):
        cases = [
            ("http://hooks.example.test/x", [SAFE_V4]),
            ("https://hooks.example.test:8080/x", [SAFE_V4]),
            ("https://u:p@hooks.example.test/x", [SAFE_V4]),
            ("https://hooks.example.test/x#f", [SAFE_V4]),
            ("https://127.0.0.1/x", [SAFE_V4]),
            ("https://[::1]/x", [SAFE_V4]),
            ("https://169.254.169.254/latest", [SAFE_V4]),
            ("https://hooks.example.test/x", ["10.0.0.5"]),
            ("https://hooks.example.test/x", ["::ffff:127.0.0.1"]),
            ("https://hooks.example.test/x", [SAFE_V4, "192.168.0.1"]),
            ("https://hooks.example.test/x", []),
        ]
        for index, (url, answers) in enumerate(cases):
            with self.subTest(url=url, answers=answers):
                self.resolver.answers = list(answers)
                response = self.post(
                    event_body(event_id="evt_%d" % index, callback_url=url),
                    idem_key="idem-key-cb%05d" % index,
                )
                self.assert_json_error(response, 400, "invalid_callback_url")
                blob = response.body.decode()
                for answer in answers:
                    self.assertNotIn(answer, blob)
        self.assertNotIn("10.0.0.5", self.recorder.text())
        self.assertNotIn("169.254.169.254", self.recorder.text())

    def test_safe_callback_url_with_multiple_answers_is_accepted(self):
        self.resolver.answers = [SAFE_V4, SAFE_V4_ALT]
        self.assertEqual(self.post().status, 202)
        self.assertEqual(self.resolver.calls, ["hooks.example.test"])


class WorkerDeliveryTests(ApiTestCase):
    def make_worker(self, transport, *, resolver=None, worker_id="worker-1", store=None):
        return DeliveryWorker(
            store=store or self.store,
            resolver=resolver if resolver is not None else self.resolver,
            transport=transport,
            clock=self.clock,
            monotonic=self.monotonic,
            worker_id=worker_id,
            log=self.recorder,
        )

    def enqueue(self, **kwargs):
        response = self.post(**kwargs)
        self.assertEqual(response.status, 202)
        return response.json()["data"]["job_id"]

    def test_delivery_hands_the_validated_ip_to_the_transport(self):
        job_id = self.enqueue()
        transport = FakeTransport([DeliveryResponse(status_code=204, response_bytes=0)])
        summary = self.make_worker(transport).run_once()
        self.assertEqual(summary, {"claimed": 1, "delivered": 1, "retried": 0, "terminal": 0})
        self.assertEqual(len(transport.requests), 1)
        request = transport.requests[0]
        self.assertEqual(request.ip, SAFE_V4)
        self.assertEqual(request.ip_version, 4)
        self.assertEqual(request.hostname, "hooks.example.test")
        self.assertEqual(request.host_header, "hooks.example.test")
        self.assertEqual(request.port, 443)
        self.assertEqual(request.request_target, "/delivery")
        self.assertEqual(request.method, "POST")
        self.assertIs(request.follow_redirects, False)
        self.assertEqual(request.max_response_bytes, 8192)
        self.assertEqual(json.loads(request.body.decode()), {"build": 7})
        job = self.store.get_job(TENANT_A, job_id)
        self.assertEqual(job.status, "delivered")
        self.assertEqual(job.attempts, 1)
        self.assertEqual(job.last_status_code, 204)

    # 15. DNS rebinding between enqueue and delivery
    def test_dns_rebinding_between_enqueue_and_delivery_is_blocked(self):
        job_id = self.enqueue()
        self.assertEqual(self.resolver.calls, ["hooks.example.test"])
        self.resolver.answers = ["127.0.0.1"]  # rebind to loopback
        transport = FakeTransport()
        self.make_worker(transport).run_once()
        self.assertEqual(transport.requests, [], "no request may be sent after a rebind")
        job = self.store.get_job(TENANT_A, job_id)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.last_error_code, "callback_url_rejected")
        self.assertEqual(job.attempts, 1)
        self.assertEqual(self.resolver.calls, ["hooks.example.test", "hooks.example.test"])
        self.assertNotIn("127.0.0.1", self.recorder.text())

    def test_rebinding_to_a_mixed_answer_is_blocked(self):
        job_id = self.enqueue()
        self.resolver.answers = [SAFE_V4, "10.1.2.3"]
        transport = FakeTransport()
        self.make_worker(transport).run_once()
        self.assertEqual(transport.requests, [])
        self.assertEqual(self.store.get_job(TENANT_A, job_id).status, STATUS_FAILED)

    # 16. redirects are never followed
    def test_redirects_are_not_followed(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                job_id = self.enqueue(
                    body=event_body(event_id="evt_r%d" % status),
                    idem_key="idem-key-r%05d" % status,
                )
                transport = FakeTransport(
                    [DeliveryResponse(status_code=status, response_bytes=0,
                                      headers={"Location": "https://elsewhere.example.test/"})]
                )
                self.make_worker(transport).run_once()
                self.assertEqual(len(transport.requests), 1, "exactly one request, no follow-up")
                job = self.store.get_job(TENANT_A, job_id)
                self.assertEqual(job.status, STATUS_FAILED)
                self.assertEqual(job.last_error_code, "redirect_not_followed")
                self.assertEqual(job.attempts, 1)

    def test_transport_failures_are_classified(self):
        cases = [
            (TransportTimeout("t"), "timeout", STATUS_RETRYING),
            (TransportError("boom"), "transport_error", STATUS_RETRYING),
            (ResponseTooLarge("big"), "response_too_large", STATUS_FAILED),
            (RuntimeError("unexpected"), "internal_error", STATUS_RETRYING),
        ]
        for index, (exception, code, expected_status) in enumerate(cases):
            with self.subTest(code=code):
                job_id = self.enqueue(
                    body=event_body(event_id="evt_f%d" % index),
                    idem_key="idem-key-f%05d" % index,
                )
                transport = FakeTransport(exception=exception)
                self.make_worker(transport).run_once()
                job = self.store.get_job(TENANT_A, job_id)
                self.assertEqual(job.last_error_code, code)
                self.assertEqual(job.status, expected_status)
                if expected_status == STATUS_RETRYING:
                    self.assertEqual(job.next_attempt_at, self.clock.value + 2)

    def test_oversized_response_reported_by_the_transport_is_terminal(self):
        job_id = self.enqueue()
        transport = FakeTransport([DeliveryResponse(status_code=200, response_bytes=9000)])
        self.make_worker(transport).run_once()
        job = self.store.get_job(TENANT_A, job_id)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.last_error_code, "response_too_large")
        self.assertEqual(job.response_bytes, 8192)

    def test_status_classification_matrix(self):
        for status in (200, 201, 202, 204, 299):
            self.assertEqual(classify_status(status), (False, "ok"))
        for status in (408, 429, 500, 502, 503, 599):
            self.assertEqual(classify_status(status), (True, "http_retryable"))
        for status in (300, 301, 302, 307, 308, 399):
            self.assertEqual(classify_status(status), (False, "redirect_not_followed"))
        for status in (400, 401, 403, 404, 410, 418, 451):
            self.assertEqual(classify_status(status), (False, "http_terminal"))
        for code, spec in CLASSIFICATIONS.items():
            self.assertIn("retryable", spec)
            self.assertTrue(spec["detail"])

    # 20. retry and terminal transition boundaries through the worker
    def test_retryable_status_walks_to_terminal_after_five_attempts(self):
        job_id = self.enqueue()
        transport = FakeTransport()
        worker = self.make_worker(transport)
        expected_delays = [2, 4, 8, 16]
        for attempt in range(1, 6):
            transport.responses = [DeliveryResponse(status_code=503, response_bytes=3)]
            summary = worker.run_once()
            self.assertEqual(summary["claimed"], 1, "attempt %d" % attempt)
            job = self.store.get_job(TENANT_A, job_id)
            self.assertEqual(job.attempts, attempt)
            self.assertEqual(job.last_error_code, "http_retryable")
            self.assertEqual(job.last_status_code, 503)
            if attempt < 5:
                self.assertEqual(job.status, STATUS_RETRYING)
                self.assertEqual(job.next_attempt_at, self.clock.value + expected_delays[attempt - 1])
                self.assertEqual(worker.run_once()["claimed"], 0, "not due yet")
                self.clock.value = job.next_attempt_at
            else:
                self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(len(transport.requests), 5)
        self.clock.advance(100_000)
        self.assertEqual(worker.run_once()["claimed"], 0, "terminal jobs are never reclaimed")

    def test_non_retryable_status_is_terminal_on_the_first_attempt(self):
        job_id = self.enqueue()
        transport = FakeTransport([DeliveryResponse(status_code=404, response_bytes=2)])
        worker = self.make_worker(transport)
        worker.run_once()
        job = self.store.get_job(TENANT_A, job_id)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.attempts, 1)
        self.assertEqual(job.last_error_code, "http_terminal")
        self.clock.advance(100_000)
        self.assertEqual(worker.run_once()["claimed"], 0)

    # 17/18/19 at the worker level, with separate connections
    def test_two_workers_race_for_one_job(self):
        self.enqueue()
        other_store = Store(self.db_path)
        self.stores.append(other_store)
        transport_a = FakeTransport()
        transport_b = FakeTransport()
        worker_a = self.make_worker(transport_a, worker_id="worker-a")
        worker_b = self.make_worker(transport_b, worker_id="worker-b", store=other_store)
        results = []
        barrier = threading.Barrier(2)
        lock = threading.Lock()

        def race(worker):
            barrier.wait()
            summary = worker.run_once()
            with lock:
                results.append(summary["claimed"])

        threads = [threading.Thread(target=race, args=(w,)) for w in (worker_a, worker_b)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), [0, 1])
        self.assertEqual(len(transport_a.requests) + len(transport_b.requests), 1)

    def test_expired_lease_is_recovered_by_another_worker(self):
        job_id = self.enqueue()
        claimed = self.store.claim_due("worker-stalled", 1, 60, self.clock.value)
        self.assertEqual(len(claimed), 1)
        other_store = Store(self.db_path)
        self.stores.append(other_store)
        transport = FakeTransport([DeliveryResponse(status_code=200, response_bytes=4)])
        worker = self.make_worker(transport, worker_id="worker-fresh", store=other_store)
        self.assertEqual(worker.run_once()["claimed"], 0, "live lease is respected")
        self.clock.advance(60)
        self.assertEqual(worker.run_once()["delivered"], 1)
        job = other_store.get_job(TENANT_A, job_id)
        self.assertEqual(job.status, "delivered")
        self.assertEqual(job.attempts, 2)
        # The stalled worker can no longer settle the job.
        self.assertFalse(self.store.complete(job_id, "worker-stalled", self.clock.value))

    def test_worker_cannot_settle_another_workers_lease(self):
        job_id = self.enqueue()
        self.store.claim_due("worker-owner", 1, 60, self.clock.value)
        self.assertFalse(self.store.complete(job_id, "worker-thief", self.clock.value))
        self.assertIsNone(self.store.fail(job_id, "worker-thief", True, self.clock.value, "timeout"))
        job = self.store.get_job(TENANT_A, job_id)
        self.assertEqual(job.lease_owner, "worker-owner")
        self.assertEqual(job.attempts, 1)

    # 21. logs never contain secrets, signatures or payload contents
    def test_logs_never_contain_secrets_or_payload_contents(self):
        marker = "PAYLOAD-MARKER-8f2c"
        body = event_body(payload={"note": marker, "nested": {"deep": marker}})
        headers = self.headers(method="POST", target="/v1/events", body=body, nonce="nonce-logging-0001")
        signature = dict((k.lower(), v) for k, v in headers)["x-signature"]
        self.assertEqual(self.app.handle("POST", "/v1/events", headers, body).status, 202)
        self.get_job("job_0001")
        self.post(body, idem_key="idem-key-conflict", nonce="nonce-logging-0002")
        transport = FakeTransport([DeliveryResponse(status_code=500, response_bytes=6000)])
        self.make_worker(transport).run_once()

        text = self.recorder.text()
        self.assertTrue(text)
        for forbidden in (
            marker,
            signature,
            SECRET_A.decode(),
            SECRET_B.decode(),
            "nonce-logging-0001",
            "idem-key-conflict",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)
        self.assertIn("events.created", self.recorder.events())
        self.assertIn("delivery.failed", self.recorder.events())
        for line in self.recorder.lines:
            record = json.loads(line)
            self.assertIn("event", record)
            self.assertNotIn("\n", line)


class HttpAdapterTests(ApiTestCase):
    """The adapter must enforce the size limit before reading the body."""

    def drive(self, raw_request, *, app=None):
        handler = RelayVaultHTTPRequestHandler.__new__(RelayVaultHTTPRequestHandler)
        handler.rfile = io.BytesIO(raw_request)
        handler.wfile = io.BytesIO()
        handler.client_address = ("198.18.0.9", 44321)
        handler.connection = types.SimpleNamespace(
            settimeout=lambda *a: None, shutdown=lambda *a: None, close=lambda: None
        )
        handler.server = types.SimpleNamespace(application=app or self.app, log=self.recorder)
        handler.close_connection = True
        handler.request_version = "HTTP/1.1"
        handler.requestline = ""
        handler.handle_one_request()
        return handler

    @staticmethod
    def parse_response(blob):
        head, _, body = blob.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        status = int(lines[0].split(b" ")[1])
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(b":")
            headers[name.decode("latin-1").strip().lower()] = value.decode("latin-1").strip()
        return status, headers, body

    def build_request(self, method, target, body=b"", *, headers=None, content_length=None):
        headers = self.headers(method=method, target=target, body=body) if headers is None else headers
        declared = len(body) if content_length is None else content_length
        lines = ["%s %s HTTP/1.1" % (method, target), "Host: relayvault.example.test"]
        for name, value in headers:
            lines.append("%s: %s" % (name, value))
        if method == "POST":
            lines.append("Content-Length: %d" % declared)
        blob = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
        return blob + body

    def test_adapter_round_trip_creates_a_job(self):
        body = event_body()
        handler = self.drive(self.build_request("POST", "/v1/events", body))
        status, headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 202)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(int(headers["content-length"]), len(response_body))
        self.assertEqual(json.loads(response_body)["data"]["job_id"], "job_0001")

    def test_adapter_preserves_the_raw_query_string_for_signing(self):
        body = event_body()
        target = "/v1/events?tracer=abc"
        handler = self.drive(self.build_request("POST", target, body))
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 202, response_body)

    # 8. the limit is enforced before the body is read
    def test_oversized_declared_body_is_rejected_without_being_read(self):
        body = event_body()
        raw = self.build_request("POST", "/v1/events", body, content_length=MAX_BODY_BYTES + 1)
        handler = self.drive(raw)
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(response_body)["error"]["code"], "payload_too_large")
        # The body bytes are still sitting unread in the input buffer.
        self.assertEqual(handler.rfile.read(), body)
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0001"))

    def test_expect_100_continue_is_refused_for_oversized_bodies(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body)
        lines = ["POST /v1/events HTTP/1.1", "Host: relayvault.example.test", "Expect: 100-continue"]
        for name, value in headers:
            lines.append("%s: %s" % (name, value))
        lines.append("Content-Length: %d" % (MAX_BODY_BYTES + 5))
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body
        handler = self.drive(raw)
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 413)
        self.assertEqual(handler.rfile.read(), body)

    def test_missing_content_length_is_411(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body)
        lines = ["POST /v1/events HTTP/1.1", "Host: relayvault.example.test"]
        for name, value in headers:
            lines.append("%s: %s" % (name, value))
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
        handler = self.drive(raw)
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 411)
        self.assertEqual(json.loads(response_body)["error"]["code"], "length_required")

    def test_chunked_transfer_encoding_is_rejected(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body)
        lines = ["POST /v1/events HTTP/1.1", "Host: relayvault.example.test", "Transfer-Encoding: chunked"]
        for name, value in headers:
            lines.append("%s: %s" % (name, value))
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body
        handler = self.drive(raw)
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(response_body)["error"]["code"], "unsupported_transfer_encoding")

    def test_truncated_body_is_rejected(self):
        body = event_body()
        raw = self.build_request("POST", "/v1/events", body[:-5], content_length=len(body))
        handler = self.drive(raw)
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(response_body)["error"]["code"], "incomplete_body")

    def test_duplicate_security_header_over_the_wire_is_rejected(self):
        body = event_body()
        headers = self.headers(method="POST", target="/v1/events", body=body)
        headers = list(headers) + [("X-Nonce", "nonce-duplicate-002")]
        handler = self.drive(self.build_request("POST", "/v1/events", body, headers=headers))
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(response_body)["error"]["code"], "unauthenticated")

    def test_unsupported_method_gets_a_json_error(self):
        raw = b"FROBNICATE /v1/events HTTP/1.1\r\nHost: relayvault.example.test\r\n\r\n"
        handler = self.drive(raw)
        status, headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 501)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertIs(json.loads(response_body)["ok"], False)
        self.assertNotIn(b"<html", response_body.lower())

    def test_get_through_the_adapter_is_tenant_scoped(self):
        self.post()
        target = "/v1/jobs/job_0001"
        handler = self.drive(self.build_request("GET", target))
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response_body)["data"]["job_id"], "job_0001")

        stranger = self.headers(method="GET", target=target, tenant=TENANT_B)
        handler = self.drive(self.build_request("GET", target, headers=stranger))
        status, _headers, response_body = self.parse_response(handler.wfile.getvalue())
        self.assertEqual(status, 404)


class CompositionTests(ApiTestCase):
    def test_secrets_are_loaded_from_the_environment_not_hard_coded(self):
        with self.assertRaises(RuntimeError):
            load_config_from_env({})
        config = load_config_from_env(
            {"RELAYVAULT_SECRETS": json.dumps({TENANT_A: {KEY: SECRET_A.decode()}})}
        )
        self.assertEqual(config.tenant_ids(), (TENANT_A,))
        self.assertEqual(config.secret_for(TENANT_A, KEY), SECRET_A)

    def test_secrets_file_is_supported(self):
        path = os.path.join(self._tmp.name, "secrets.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({TENANT_B: {KEY: SECRET_B.decode()}}, handle)
        config = load_config_from_env({"RELAYVAULT_SECRETS_FILE": path})
        self.assertEqual(config.secret_for(TENANT_B, KEY), SECRET_B)

    def test_internal_errors_do_not_leak_details(self):
        class ExplodingStore:
            def ensure_tenants(self, *a, **k):
                return None

            def get_job(self, *a, **k):
                raise sqlite_style_error()

        def sqlite_style_error():
            return RuntimeError("near \"SELECT\": syntax error in jobs table")

        app = Application(
            config=self.config,
            store=ExplodingStore(),
            nonce_store=self.app.nonce_store,
            clock=self.clock,
            resolver=self.resolver,
            id_factory=self.next_id,
            log=self.recorder,
        )
        headers = self.headers(method="GET", target="/v1/jobs/job_0001")
        response = app.handle("GET", "/v1/jobs/job_0001", headers, b"")
        self.assertEqual(response.status, 500)
        document = response.json()
        self.assertEqual(document["error"]["code"], "internal_error")
        self.assertEqual(document["error"]["message"], "internal error")
        self.assertNotIn("SELECT", response.body.decode())
        self.assertNotIn("SELECT", self.recorder.text())
        self.assertIn("request.error", self.recorder.events())

    def test_response_objects_are_immutable_and_typed(self):
        response = self.post()
        self.assertIsInstance(response, Response)
        with self.assertRaises(Exception):
            response.status = 500


if __name__ == "__main__":
    unittest.main()
