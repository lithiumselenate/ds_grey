"""End-to-end tests for the RelayVault application layer and delivery worker.

Everything runs through ``Application.handle`` and fake resolvers/transports;
no socket is ever opened.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest

import app as app_module
import worker as worker_module
from app import Application, Headers, MAX_BODY_BYTES, build_application, plan_body_read
from security import compute_signature
from store import STATUS_DELIVERED, STATUS_FAILED, STATUS_PENDING, Store
from worker import (
    DeliveryResponse,
    DeliveryWorker,
    ResponseTooLarge,
    TransportFailure,
    TransportTimeout,
)

TENANT_A = "tenant_alpha"
TENANT_B = "tenant_beta"
KEY_ID = "key_1"
# Test-only material; the service receives secrets through injection.
SECRET_A = b"unit-test-secret-alpha-0001"
SECRET_B = b"unit-test-secret-beta-0002"
NOW = 1_700_000_000
SAFE_URL = "https://hooks.example.test/delivery"
PAYLOAD_MARKER = "marker-8f3c-payload-must-not-be-logged"


class FakeClock:
    def __init__(self, now: int = NOW) -> None:
        self.now = float(now)

    def __call__(self) -> float:
        return self.now


class FakeMonotonic:
    """Monotonic source that is deliberately unusable as a wall clock."""

    def __init__(self) -> None:
        self.value = 1.0

    def __call__(self) -> float:
        self.value += 0.25
        return self.value


class FakeResolver:
    def __init__(self, table: dict[str, list[str]] | None = None) -> None:
        self.table = dict(table or {"hooks.example.test": ["93.184.216.34"]})
        self.calls: list[str] = []
        self.error: Exception | None = None

    def __call__(self, hostname: str) -> list[str]:
        self.calls.append(hostname)
        if self.error is not None:
            raise self.error
        return list(self.table.get(hostname, []))


class FakeTransport:
    """Records outbound attempts; never touches the network."""

    def __init__(self, script: list[object] | None = None) -> None:
        self.script = list(script or [])
        self.requests: list[worker_module.DeliveryRequest] = []

    def send(self, request: worker_module.DeliveryRequest) -> DeliveryResponse:
        self.requests.append(request)
        action: object = (
            self.script.pop(0) if self.script else DeliveryResponse(status=200)
        )
        if isinstance(action, BaseException):
            raise action
        if isinstance(action, int):
            return DeliveryResponse(status=action)
        assert isinstance(action, DeliveryResponse)
        return action


def event_body(
    *,
    event_id: str = "evt_123",
    event_type: str = "build.completed",
    callback_url: str = SAFE_URL,
    payload: dict | None = None,
) -> bytes:
    document = {
        "event_id": event_id,
        "type": event_type,
        "callback_url": callback_url,
        "payload": payload if payload is not None else {"marker": PAYLOAD_MARKER},
    }
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


class ApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = os.path.join(self._tmp.name, "api.sqlite3")
        self.clock = FakeClock()
        self.monotonic = FakeMonotonic()
        self.resolver = FakeResolver()
        self.logs: list[tuple[str, dict]] = []
        self.job_ids = iter(f"job_{index:04d}" for index in range(1, 500))
        self.store = Store(self.db_path, clock=self.clock)
        self.addCleanup(self.store.close)
        self.app = build_application(
            db_path=self.db_path,
            secrets={(TENANT_A, KEY_ID): SECRET_A, (TENANT_B, KEY_ID): SECRET_B},
            clock=self.clock,
            resolver=self.resolver,
            id_factory=lambda: next(self.job_ids),
            log=lambda event, fields: self.logs.append((event, dict(fields))),
            store=self.store,
        )
        self._nonce = 0

    # -- request helpers -------------------------------------------------
    def next_nonce(self) -> str:
        self._nonce += 1
        return f"nonce-{self._nonce:08d}"

    def call(
        self,
        method: str,
        target: str,
        body: bytes = b"",
        *,
        tenant: str = TENANT_A,
        secret: bytes | None = None,
        key_id: str = KEY_ID,
        timestamp: int | None = None,
        nonce: str | None = None,
        signature: str | None = None,
        extra: list[tuple[str, str]] | None = None,
        json_headers: bool | None = None,
        idem_key: str | None = None,
        sign_body: bytes | None = None,
        sign_target: str | None = None,
    ):
        secret = SECRET_A if secret is None else secret
        timestamp = int(self.clock.now) if timestamp is None else timestamp
        nonce = self.next_nonce() if nonce is None else nonce
        if signature is None:
            signature = compute_signature(
                secret, tenant, key_id, str(timestamp), nonce, method,
                sign_target if sign_target is not None else target,
                sign_body if sign_body is not None else body,
            )
        headers = [
            ("X-Tenant-ID", tenant),
            ("X-Key-ID", key_id),
            ("X-Timestamp", str(timestamp)),
            ("X-Nonce", nonce),
            ("X-Signature", signature),
        ]
        wants_json = json_headers if json_headers is not None else method == "POST"
        if wants_json:
            headers.append(("Content-Type", "application/json"))
            headers.append(
                ("Idempotency-Key", idem_key or "idem-key-000001")
            )
        headers.extend(extra or [])
        return self.app.handle(method, target, headers, body)

    def post_event(self, body: bytes | None = None, **kwargs):
        return self.call("POST", "/v1/events", body if body is not None else
                         event_body(), **kwargs)

    def new_worker(
        self,
        transport: FakeTransport | None = None,
        *,
        worker_id: str = "worker-1",
        resolver=None,
        store: Store | None = None,
    ) -> tuple[DeliveryWorker, FakeTransport]:
        transport = transport or FakeTransport()
        instance = DeliveryWorker(
            store or self.store,
            resolver=resolver or self.resolver,
            transport=transport,
            clock=self.clock,
            monotonic=self.monotonic,
            worker_id=worker_id,
            log=lambda event, fields: self.logs.append((event, dict(fields))),
        )
        return instance, transport

    def log_text(self) -> str:
        return json.dumps(self.logs, default=str)


class TestHappyPath(ApiTestCase):
    def test_post_event_accepted(self) -> None:
        response = self.post_event()
        self.assertEqual(response.status, 202)
        self.assertIn(("Content-Type", "application/json"), response.headers)
        document = response.json()
        self.assertTrue(document["ok"])
        data = document["data"]
        self.assertEqual(data["job_id"], "job_0001")
        self.assertEqual(data["event_id"], "evt_123")
        self.assertEqual(data["type"], "build.completed")
        self.assertEqual(data["status"], STATUS_PENDING)
        self.assertEqual(data["attempts"], 0)
        self.assertFalse(data["duplicate"])
        self.assertNotIn("payload", data)
        self.assertNotIn("callback_url", data)

    def test_get_job_returns_status(self) -> None:
        self.post_event()
        response = self.call("GET", "/v1/jobs/job_0001")
        self.assertEqual(response.status, 200)
        data = response.json()["data"]
        self.assertEqual(data["job_id"], "job_0001")
        self.assertEqual(data["status"], STATUS_PENDING)

    def test_compact_json_body(self) -> None:
        response = self.post_event()
        self.assertNotIn(b", ", response.body)
        self.assertNotIn(b'": ', response.body)
        self.assertEqual(
            dict(response.headers)["Content-Length"], str(len(response.body))
        )

    def test_error_shape_is_stable(self) -> None:
        response = self.call("GET", "/v1/jobs/job_missing")
        self.assertEqual(response.status, 404)
        document = response.json()
        self.assertFalse(document["ok"])
        self.assertEqual(set(document["error"]), {"code", "message"})


class TestAuthenticationAtApi(ApiTestCase):
    def test_unauthenticated_request_rejected(self) -> None:
        response = self.app.handle("POST", "/v1/events", [], event_body())
        self.assertEqual(response.status, 401)
        self.assertEqual(response.json()["error"]["code"], "unauthorized")

    def test_forged_signature_rejected_and_no_job_created(self) -> None:
        response = self.post_event(secret=b"not-the-secret")
        self.assertEqual(response.status, 401)
        self.assertEqual(self.store.count_jobs(), 0)

    def test_body_mutation_after_signing_rejected(self) -> None:
        response = self.post_event(
            body=event_body(payload={"a": 1}), sign_body=event_body(payload={"a": 2})
        )
        self.assertEqual(response.status, 401)

    def test_replayed_nonce_rejected_at_api(self) -> None:
        body = event_body()
        nonce = "nonce-api-replay"
        first = self.post_event(body=body, nonce=nonce)
        self.assertEqual(first.status, 202)
        second = self.post_event(body=body, nonce=nonce)
        self.assertEqual(second.status, 401)
        self.assertEqual(self.store.count_jobs(), 1)

    def test_unknown_route_requires_authentication_first(self) -> None:
        anonymous = self.app.handle("GET", "/v1/secret-admin", [], b"")
        self.assertEqual(anonymous.status, 401)
        authenticated = self.call("GET", "/v1/secret-admin")
        self.assertEqual(authenticated.status, 404)

    def test_method_not_allowed(self) -> None:
        response = self.call("PUT", "/v1/events", event_body(), json_headers=True)
        self.assertEqual(response.status, 405)

    def test_generic_401_does_not_leak_which_field_failed(self) -> None:
        bodies = set()
        bodies.add(self.post_event(tenant="tenant_ghost", secret=b"x").body)
        bodies.add(self.post_event(secret=b"wrong-secret").body)
        bodies.add(self.post_event(timestamp=NOW + 5000).body)
        replayed = "nonce-shared-01"
        self.post_event(nonce=replayed)
        bodies.add(self.post_event(nonce=replayed).body)
        self.assertEqual(len(bodies), 1)


class TestRawTargetHandling(ApiTestCase):
    def test_query_string_is_signed_and_route_still_matches(self) -> None:
        response = self.post_event(sign_target="/v1/events?trace=abc")
        self.assertEqual(response.status, 401)  # signed target != actual target
        response = self.call(
            "POST", "/v1/events?trace=abc", event_body(), json_headers=True
        )
        self.assertEqual(response.status, 202)

    def test_encoded_separator_is_rejected_not_silently_decoded(self) -> None:
        self.post_event()
        response = self.call("GET", "/v1/jobs%2Fjob_0001")
        self.assertEqual(response.status, 400)
        self.assertEqual(response.json()["error"]["code"], "bad_request")

    def test_percent_encoded_job_id_is_routed_but_signature_uses_raw(self) -> None:
        self.post_event()
        target = "/v1/jobs/job%5F0001"  # %5F == "_"
        response = self.call("GET", target)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json()["data"]["job_id"], "job_0001")
        # The signature must be over the raw, still-encoded target.
        decoded_signature = compute_signature(
            SECRET_A, TENANT_A, KEY_ID, str(NOW), "nonce-raw-target-1", "GET",
            "/v1/jobs/job_0001", b"",
        )
        response = self.call(
            "GET", target, nonce="nonce-raw-target-1", signature=decoded_signature
        )
        self.assertEqual(response.status, 401)

    def test_malformed_target_rejected(self) -> None:
        response = self.call("GET", "v1/jobs/job_0001")
        self.assertEqual(response.status, 400)


class TestBodyValidation(ApiTestCase):
    def _expect_400(self, body: bytes, code: str | None = None) -> None:
        response = self.post_event(body=body)
        self.assertEqual(response.status, 400, response.body)
        if code:
            self.assertEqual(response.json()["error"]["code"], code)
        self.assertEqual(self.store.count_jobs(), 0)

    def test_duplicate_top_level_keys_rejected(self) -> None:
        self._expect_400(
            b'{"event_id":"evt_1","event_id":"evt_2","type":"a.b",'
            b'"callback_url":"' + SAFE_URL.encode() + b'","payload":{}}',
            "invalid_json",
        )

    def test_duplicate_nested_keys_rejected(self) -> None:
        self._expect_400(
            b'{"event_id":"evt_1","type":"a.b","callback_url":"'
            + SAFE_URL.encode()
            + b'","payload":{"deep":{"x":1,"x":2}}}',
            "invalid_json",
        )

    def test_non_finite_numbers_rejected(self) -> None:
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e400", b"-1e400"):
            with self.subTest(literal=literal):
                body = (
                    b'{"event_id":"evt_1","type":"a.b","callback_url":"'
                    + SAFE_URL.encode()
                    + b'","payload":{"n":' + literal + b"}}"
                )
                response = self.post_event(body=body)
                self.assertEqual(response.status, 400, literal)
                self.assertEqual(response.json()["error"]["code"], "invalid_json")

    def test_invalid_utf8_rejected(self) -> None:
        self._expect_400(b'{"event_id":"\xff\xfe","type":"a.b"}', "invalid_body")

    def test_non_object_payload_rejected(self) -> None:
        for value in (b'"text"', b"[]", b"7", b"null", b"true"):
            with self.subTest(value=value):
                body = (
                    b'{"event_id":"evt_1","type":"a.b","callback_url":"'
                    + SAFE_URL.encode() + b'","payload":' + value + b"}"
                )
                response = self.post_event(body=body)
                self.assertEqual(response.status, 400)
                self.assertEqual(response.json()["error"]["code"], "invalid_field")

    def test_non_object_document_rejected(self) -> None:
        self._expect_400(b'["not","an","object"]', "invalid_json")
        self._expect_400(b"", "invalid_body")

    def test_unknown_top_level_field_rejected(self) -> None:
        document = json.loads(event_body())
        document["extra"] = 1
        self._expect_400(
            json.dumps(document, separators=(",", ":")).encode(), "unknown_field"
        )

    def test_missing_field_rejected(self) -> None:
        document = json.loads(event_body())
        del document["callback_url"]
        self._expect_400(
            json.dumps(document, separators=(",", ":")).encode(), "missing_field"
        )

    def test_invalid_event_id_and_type(self) -> None:
        cases = [
            event_body(event_id=""),
            event_body(event_id="evt/1"),
            event_body(event_id="e" * 65),
            event_body(event_id="evt_\u00e9"),
            event_body(event_type="Build.Completed"),
            event_body(event_type=""),
            event_body(event_type="t" * 81),
            event_body(event_type="build completed"),
        ]
        for body in cases:
            with self.subTest(body=body[:60]):
                self._expect_400(body, "invalid_field")

    def test_body_size_limit_enforced(self) -> None:
        filler = "x" * (MAX_BODY_BYTES + 1)
        body = event_body(payload={"blob": filler})
        self.assertGreater(len(body), MAX_BODY_BYTES)
        response = self.post_event(body=body)
        self.assertEqual(response.status, 413)
        self.assertEqual(response.json()["error"]["code"], "payload_too_large")
        self.assertEqual(self.store.count_jobs(), 0)

    def test_body_just_under_limit_accepted(self) -> None:
        base = len(event_body(payload={"blob": ""}))
        body = event_body(payload={"blob": "x" * (MAX_BODY_BYTES - base)})
        self.assertEqual(len(body), MAX_BODY_BYTES)
        self.assertEqual(self.post_event(body=body).status, 202)

    def test_content_type_and_encoding_rules(self) -> None:
        body = event_body()
        cases = [
            ([("Content-Type", "text/plain"), ("Idempotency-Key", "idem-key-0001")], 415),
            ([("Idempotency-Key", "idem-key-0001")], 415),
            (
                [("Content-Type", "application/json; charset=iso-8859-1"),
                 ("Idempotency-Key", "idem-key-0001")],
                415,
            ),
            (
                [("Content-Type", "application/json"), ("Content-Encoding", "gzip"),
                 ("Idempotency-Key", "idem-key-0001")],
                415,
            ),
        ]
        for headers, status in cases:
            with self.subTest(headers=headers):
                response = self.call(
                    "POST", "/v1/events", body, json_headers=False, extra=headers
                )
                self.assertEqual(response.status, status)
        accepted = self.call(
            "POST", "/v1/events", body, json_headers=False,
            extra=[("Content-Type", "application/json; charset=utf-8"),
                   ("Content-Encoding", "identity"),
                   ("Idempotency-Key", "idem-key-0001")],
        )
        self.assertEqual(accepted.status, 202)

    def test_idempotency_key_rules(self) -> None:
        for key in ("short", "k" * 81, "bad key!", ""):
            with self.subTest(key=key):
                response = self.call(
                    "POST", "/v1/events", event_body(), json_headers=False,
                    extra=[("Content-Type", "application/json"),
                           ("Idempotency-Key", key)],
                )
                self.assertEqual(response.status, 400)
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_idempotency_key"
                )
        missing = self.call(
            "POST", "/v1/events", event_body(), json_headers=False,
            extra=[("Content-Type", "application/json")],
        )
        self.assertEqual(missing.status, 400)
        repeated = self.call(
            "POST", "/v1/events", event_body(), json_headers=False,
            extra=[("Content-Type", "application/json"),
                   ("Idempotency-Key", "idem-key-0001"),
                   ("Idempotency-Key", "idem-key-0002")],
        )
        self.assertEqual(repeated.status, 400)

    def test_get_with_body_rejected(self) -> None:
        response = self.call("GET", "/v1/jobs/job_0001", b"{}", json_headers=False)
        self.assertEqual(response.status, 400)


class TestAdapterEnvelopePlanning(unittest.TestCase):
    """Adapter-side guards, exercised without opening a socket."""

    def test_oversized_content_length_refused_before_read(self) -> None:
        plan = plan_body_read(
            "POST", Headers([("Content-Length", str(MAX_BODY_BYTES + 1))])
        )
        self.assertIsNotNone(plan.error)
        self.assertEqual(plan.error.status, 413)
        self.assertEqual(plan.length, 0)

    def test_limit_boundary_allowed(self) -> None:
        plan = plan_body_read(
            "POST", Headers([("Content-Length", str(MAX_BODY_BYTES))])
        )
        self.assertIsNone(plan.error)
        self.assertEqual(plan.length, MAX_BODY_BYTES)

    def test_missing_length_on_post_is_411(self) -> None:
        plan = plan_body_read("POST", Headers([]))
        self.assertEqual(plan.error.status, 411)

    def test_ambiguous_length_rejected(self) -> None:
        plan = plan_body_read(
            "POST", Headers([("Content-Length", "10"), ("Content-Length", "20")])
        )
        self.assertEqual(plan.error.status, 400)

    def test_invalid_length_rejected(self) -> None:
        for value in ("-1", "0x10", "1 0", "+5", ""):
            with self.subTest(value=value):
                plan = plan_body_read("POST", Headers([("Content-Length", value)]))
                self.assertEqual(plan.error.status, 400)

    def test_transfer_encoding_rejected(self) -> None:
        plan = plan_body_read(
            "POST", Headers([("Transfer-Encoding", "chunked")])
        )
        self.assertEqual(plan.error.status, 501)

    def test_get_without_length_is_empty(self) -> None:
        plan = plan_body_read("GET", Headers([]))
        self.assertIsNone(plan.error)
        self.assertEqual(plan.length, 0)


class TestIdempotency(ApiTestCase):
    def test_identical_body_returns_original_job(self) -> None:
        body = event_body()
        first = self.post_event(body=body)
        self.assertEqual(first.status, 202)
        second = self.post_event(body=body)
        self.assertEqual(second.status, 200)
        data = second.json()["data"]
        self.assertTrue(data["duplicate"])
        self.assertEqual(data["job_id"], first.json()["data"]["job_id"])
        self.assertEqual(self.store.count_jobs(), 1)

    def test_conflicting_body_returns_409(self) -> None:
        self.post_event(body=event_body(payload={"a": 1}))
        response = self.post_event(body=event_body(payload={"a": 2}))
        self.assertEqual(response.status, 409)
        self.assertEqual(
            response.json()["error"]["code"], "idempotency_key_reuse"
        )
        self.assertEqual(self.store.count_jobs(), 1)

    def test_different_tenants_may_reuse_key(self) -> None:
        self.post_event()
        response = self.post_event(tenant=TENANT_B, secret=SECRET_B)
        self.assertEqual(response.status, 202)
        self.assertEqual(self.store.count_jobs(), 2)

    def test_new_key_with_existing_event_id_conflicts(self) -> None:
        self.post_event()
        response = self.post_event(idem_key="idem-key-000002")
        self.assertEqual(response.status, 409)
        self.assertEqual(response.json()["error"]["code"], "event_id_conflict")
        self.assertEqual(self.store.count_jobs(), 1)

    def test_duplicate_request_needs_fresh_nonce(self) -> None:
        body = event_body()
        nonce = "nonce-dup-0001"
        self.post_event(body=body, nonce=nonce)
        replay = self.post_event(body=body, nonce=nonce)
        self.assertEqual(replay.status, 401)  # replay protection is independent
        fresh = self.post_event(body=body)
        self.assertEqual(fresh.status, 200)
        self.assertTrue(fresh.json()["data"]["duplicate"])

    def test_concurrent_requests_over_separate_connections(self) -> None:
        body = event_body()
        worker_count = 6
        barrier = threading.Barrier(worker_count)
        statuses: list[int] = []
        job_ids: list[str] = []
        lock = threading.Lock()
        counter = iter(f"job_c{index:04d}" for index in range(worker_count))
        counter_lock = threading.Lock()

        def next_job_id() -> str:
            with counter_lock:
                return next(counter)

        def attempt(index: int) -> None:
            connection_store = Store(self.db_path, clock=self.clock)
            application = build_application(
                db_path=self.db_path,
                secrets={(TENANT_A, KEY_ID): SECRET_A},
                clock=self.clock,
                resolver=FakeResolver(),
                id_factory=next_job_id,
                log=lambda event, fields: None,
                store=connection_store,
            )
            nonce = f"nonce-concurrent-{index}"
            signature = compute_signature(
                SECRET_A, TENANT_A, KEY_ID, str(NOW), nonce, "POST", "/v1/events",
                body,
            )
            headers = [
                ("X-Tenant-ID", TENANT_A),
                ("X-Key-ID", KEY_ID),
                ("X-Timestamp", str(NOW)),
                ("X-Nonce", nonce),
                ("X-Signature", signature),
                ("Content-Type", "application/json"),
                ("Idempotency-Key", "idem-key-shared01"),
            ]
            try:
                barrier.wait()
                response = application.handle("POST", "/v1/events", headers, body)
                with lock:
                    statuses.append(response.status)
                    if response.status in (200, 202):
                        job_ids.append(response.json()["data"]["job_id"])
            finally:
                connection_store.close()

        threads = [
            threading.Thread(target=attempt, args=(i,)) for i in range(worker_count)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(len(statuses), worker_count)
        self.assertEqual(statuses.count(202), 1)
        self.assertEqual(statuses.count(200), worker_count - 1)
        self.assertEqual(len(set(job_ids)), 1)
        self.assertEqual(self.store.count_jobs(), 1)


class TestTenantIsolation(ApiTestCase):
    def test_cross_tenant_lookup_is_indistinguishable_from_missing(self) -> None:
        self.post_event()
        foreign = self.call(
            "GET", "/v1/jobs/job_0001", tenant=TENANT_B, secret=SECRET_B
        )
        missing = self.call(
            "GET", "/v1/jobs/job_9999", tenant=TENANT_B, secret=SECRET_B
        )
        self.assertEqual(foreign.status, 404)
        self.assertEqual(missing.status, 404)
        self.assertEqual(foreign.body, missing.body)
        self.assertEqual(foreign.headers, missing.headers)

    def test_hostile_job_ids_return_404_and_leave_data_intact(self) -> None:
        self.post_event()
        from urllib.parse import quote

        hostile = [
            "' OR '1'='1",
            "job_0001' --",
            "job_0001'); DROP TABLE jobs;--",
            "1 UNION SELECT tenant_id FROM jobs",
            "%",
            "_",
            "job_000%",
        ]
        for job_id in hostile:
            target = "/v1/jobs/" + quote(job_id, safe="")
            with self.subTest(job_id=job_id):
                response = self.call("GET", target)
                self.assertEqual(response.status, 404)
                self.assertEqual(
                    response.json()["error"]["code"], "not_found"
                )
                self.assertNotIn(b"SELECT", response.body)
                self.assertNotIn(b"sqlite", response.body.lower())
        self.assertEqual(self.store.count_jobs(), 1)
        self.assertEqual(self.call("GET", "/v1/jobs/job_0001").status, 200)


class TestCallbackUrlAtCreation(ApiTestCase):
    def test_unsafe_callback_urls_rejected(self) -> None:
        self.resolver.table["internal.example.test"] = ["10.0.0.5"]
        self.resolver.table["meta.example.test"] = ["169.254.169.254"]
        self.resolver.table["mixed.example.test"] = ["93.184.216.34", "127.0.0.1"]
        urls = [
            "http://hooks.example.test/x",
            "https://hooks.example.test:9000/x",
            "https://user:pass@hooks.example.test/x",
            "https://hooks.example.test/x#frag",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://[::ffff:10.0.0.1]/x",
            "https://internal.example.test/x",
            "https://meta.example.test/x",
            "https://mixed.example.test/x",
            "https://unknown.example.test/x",
        ]
        for index, url in enumerate(urls):
            with self.subTest(url=url):
                response = self.post_event(
                    body=event_body(event_id=f"evt_{index}", callback_url=url),
                    idem_key=f"idem-key-{index:06d}",
                )
                self.assertEqual(response.status, 400)
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_callback_url"
                )
        self.assertEqual(self.store.count_jobs(), 0)

    def test_rejection_message_leaks_no_address(self) -> None:
        self.resolver.table["internal.example.test"] = ["10.11.12.13"]
        response = self.post_event(
            body=event_body(callback_url="https://internal.example.test/x")
        )
        self.assertNotIn(b"10.11.12.13", response.body)
        self.assertNotIn(b"10.", response.json()["error"]["message"].encode())
        self.assertNotIn("10.11.12.13", self.log_text())

    def test_alternate_port_accepted(self) -> None:
        response = self.post_event(
            body=event_body(callback_url="https://hooks.example.test:8443/x")
        )
        self.assertEqual(response.status, 202)


class TestDelivery(ApiTestCase):
    def enqueue(self, **kwargs) -> str:
        response = self.post_event(**kwargs)
        self.assertEqual(response.status, 202, response.body)
        return response.json()["data"]["job_id"]

    def test_successful_delivery(self) -> None:
        job_id = self.enqueue()
        instance, transport = self.new_worker(FakeTransport([DeliveryResponse(200)]))
        outcomes = instance.run_once()
        self.assertEqual(len(outcomes), 1)
        self.assertTrue(outcomes[0].success)
        job = self.store.get_job_unscoped(job_id)
        self.assertEqual(job.status, STATUS_DELIVERED)
        self.assertEqual(job.attempts, 1)
        self.assertIsNone(job.lease_owner)

    def test_transport_receives_ip_separately_from_hostname(self) -> None:
        self.enqueue()
        instance, transport = self.new_worker()
        instance.run_once()
        request = transport.requests[0]
        self.assertEqual(request.ip, "93.184.216.34")
        self.assertEqual(request.hostname, "hooks.example.test")
        self.assertEqual(request.headers["Host"], "hooks.example.test")
        self.assertEqual(request.port, 443)
        self.assertEqual(request.target, "/delivery")
        self.assertEqual(request.max_response_bytes, 8192)
        body = json.loads(request.body.decode("utf-8"))
        self.assertEqual(body["event_id"], "evt_123")
        self.assertEqual(body["payload"]["marker"], PAYLOAD_MARKER)

    def test_host_header_includes_non_default_port(self) -> None:
        self.enqueue(body=event_body(callback_url="https://hooks.example.test:8443/x"))
        instance, transport = self.new_worker()
        instance.run_once()
        self.assertEqual(
            transport.requests[0].headers["Host"], "hooks.example.test:8443"
        )

    def test_all_2xx_are_success(self) -> None:
        for index, status in enumerate((200, 201, 202, 204, 299)):
            with self.subTest(status=status):
                job_id = self.enqueue(
                    body=event_body(event_id=f"evt_ok_{index}"),
                    idem_key=f"idem-key-ok{index:05d}",
                )
                instance, _ = self.new_worker(FakeTransport([DeliveryResponse(status)]))
                instance.run_once()
                self.assertEqual(
                    self.store.get_job_unscoped(job_id).status, STATUS_DELIVERED
                )

    def test_retryable_statuses_reschedule(self) -> None:
        for index, status in enumerate((408, 429, 500, 503, 599)):
            with self.subTest(status=status):
                job_id = self.enqueue(
                    body=event_body(event_id=f"evt_retry_{index}"),
                    idem_key=f"idem-key-rt{index:05d}",
                )
                instance, _ = self.new_worker(FakeTransport([DeliveryResponse(status)]))
                outcome = instance.run_once()[0]
                job = self.store.get_job_unscoped(job_id)
                self.assertEqual(job.status, STATUS_PENDING)
                self.assertEqual(job.attempts, 1)
                self.assertEqual(job.next_attempt_at, int(self.clock.now) + 2)
                self.assertEqual(job.last_error_code, "http_retryable")
                self.assertFalse(outcome.terminal)

    def test_other_statuses_are_terminal(self) -> None:
        for index, status in enumerate((300, 301, 302, 307, 400, 401, 403, 404, 410)):
            with self.subTest(status=status):
                job_id = self.enqueue(
                    body=event_body(event_id=f"evt_term_{index}"),
                    idem_key=f"idem-key-tm{index:05d}",
                )
                instance, transport = self.new_worker(
                    FakeTransport([DeliveryResponse(status)])
                )
                outcome = instance.run_once()[0]
                job = self.store.get_job_unscoped(job_id)
                self.assertEqual(job.status, STATUS_FAILED)
                self.assertEqual(job.attempts, 1)
                self.assertEqual(job.last_error_code, "http_terminal")
                self.assertTrue(outcome.terminal)

    def test_redirects_are_not_followed(self) -> None:
        job_id = self.enqueue()
        instance, transport = self.new_worker(
            FakeTransport([DeliveryResponse(302), DeliveryResponse(200)])
        )
        instance.run_once()
        self.assertEqual(len(transport.requests), 1)  # no second hop
        job = self.store.get_job_unscoped(job_id)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.last_status_code, 302)
        self.assertEqual(job.last_error_code, "http_terminal")

    def test_transport_failure_classifications(self) -> None:
        cases = [
            (TransportTimeout("t"), True, "timeout"),
            (TransportFailure("f"), True, "transport_error"),
            (ResponseTooLarge("big"), False, "response_too_large"),
            (RuntimeError("boom"), True, "internal_error"),
        ]
        for index, (error, retryable, code) in enumerate(cases):
            with self.subTest(code=code):
                job_id = self.enqueue(
                    body=event_body(event_id=f"evt_err_{index}"),
                    idem_key=f"idem-key-er{index:05d}",
                )
                instance, _ = self.new_worker(FakeTransport([error]))
                instance.run_once()
                job = self.store.get_job_unscoped(job_id)
                self.assertEqual(job.last_error_code, code)
                self.assertEqual(
                    job.status, STATUS_PENDING if retryable else STATUS_FAILED
                )

    def test_resolver_exception_is_retryable(self) -> None:
        job_id = self.enqueue()
        broken = FakeResolver()
        broken.error = OSError("temporary failure in name resolution")
        instance, transport = self.new_worker(resolver=broken)
        instance.run_once()
        job = self.store.get_job_unscoped(job_id)
        self.assertEqual(job.last_error_code, "resolver_error")
        self.assertEqual(job.status, STATUS_PENDING)
        self.assertEqual(transport.requests, [])

    def test_dns_rebinding_between_enqueue_and_delivery(self) -> None:
        job_id = self.enqueue()
        # The name now points at loopback: re-validation must stop delivery.
        self.resolver.table["hooks.example.test"] = ["127.0.0.1"]
        instance, transport = self.new_worker()
        outcome = instance.run_once()[0]
        self.assertEqual(transport.requests, [])
        job = self.store.get_job_unscoped(job_id)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.last_error_code, "callback_rejected")
        self.assertTrue(outcome.terminal)
        self.assertNotIn("127.0.0.1", self.log_text())

    def test_rebinding_to_mixed_answer_also_blocked(self) -> None:
        job_id = self.enqueue()
        self.resolver.table["hooks.example.test"] = ["93.184.216.34", "192.168.5.5"]
        instance, transport = self.new_worker()
        instance.run_once()
        self.assertEqual(transport.requests, [])
        self.assertEqual(
            self.store.get_job_unscoped(job_id).last_error_code, "callback_rejected"
        )

    def test_resolution_happens_on_every_attempt(self) -> None:
        self.enqueue()
        before = len(self.resolver.calls)
        instance, _ = self.new_worker(FakeTransport([DeliveryResponse(503)]))
        instance.run_once()
        self.clock.now += 10
        instance.run_once()
        self.assertGreaterEqual(len(self.resolver.calls) - before, 2)

    def test_retry_until_terminal_after_five_attempts(self) -> None:
        job_id = self.enqueue()
        instance, transport = self.new_worker(
            FakeTransport([DeliveryResponse(503) for _ in range(6)])
        )
        delays = []
        for _ in range(5):
            outcomes = instance.run_once()
            self.assertEqual(len(outcomes), 1)
            job = self.store.get_job_unscoped(job_id)
            if job.status == STATUS_PENDING:
                delays.append(job.next_attempt_at - int(self.clock.now))
                self.clock.now = job.next_attempt_at
        job = self.store.get_job_unscoped(job_id)
        self.assertEqual(delays, [2, 4, 8, 16])
        self.assertEqual(job.attempts, 5)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(len(transport.requests), 5)
        self.assertEqual(instance.run_once(), [])

    def test_two_workers_do_not_deliver_the_same_job_twice(self) -> None:
        job_id = self.enqueue()
        other_store = Store(self.db_path, clock=self.clock)
        self.addCleanup(other_store.close)
        first, first_transport = self.new_worker(worker_id="worker-1")
        second, second_transport = self.new_worker(
            worker_id="worker-2", store=other_store
        )
        first.run_once()
        second.run_once()
        self.assertEqual(len(first_transport.requests), 1)
        self.assertEqual(len(second_transport.requests), 0)
        self.assertEqual(self.store.get_job_unscoped(job_id).attempts, 1)

    def test_job_status_visible_through_api_after_delivery(self) -> None:
        job_id = self.enqueue()
        instance, _ = self.new_worker()
        instance.run_once()
        response = self.call("GET", f"/v1/jobs/{job_id}")
        data = response.json()["data"]
        self.assertEqual(data["status"], STATUS_DELIVERED)
        self.assertEqual(data["attempts"], 1)

    def test_wall_clock_not_monotonic_is_persisted(self) -> None:
        job_id = self.enqueue()
        instance, _ = self.new_worker(FakeTransport([DeliveryResponse(503)]))
        instance.run_once()
        job = self.store.get_job_unscoped(job_id)
        self.assertGreater(job.updated_at, 1_600_000_000)
        self.assertEqual(job.updated_at, int(self.clock.now))
        self.assertGreater(self.monotonic.value, 1.0)


class TestLoggingHygiene(ApiTestCase):
    def test_logs_contain_no_secrets_signatures_or_payloads(self) -> None:
        body = event_body()
        signature = compute_signature(
            SECRET_A, TENANT_A, KEY_ID, str(NOW), "nonce-log-0001", "POST",
            "/v1/events", body,
        )
        self.post_event(body=body, nonce="nonce-log-0001", signature=signature)
        self.post_event(secret=b"forged-secret-value")  # rejected attempt
        instance, _ = self.new_worker(FakeTransport([DeliveryResponse(503)]))
        instance.run_once()
        self.clock.now += 100
        instance.run_once()

        text = self.log_text()
        self.assertNotIn(SECRET_A.decode(), text)
        self.assertNotIn("forged-secret-value", text)
        self.assertNotIn(signature, text)
        self.assertNotIn(PAYLOAD_MARKER, text)
        self.assertNotIn("93.184.216.34", text)
        self.assertNotIn("sqlite", text.lower())
        self.assertNotIn("Traceback", text)
        events = [event for event, _ in self.logs]
        self.assertIn("event.accepted", events)
        self.assertIn("auth.rejected", events)
        self.assertIn("delivery.failed", events)

    def test_internal_errors_are_generic(self) -> None:
        class ExplodingStore:
            def __getattr__(self, name):
                raise sqlite_error()

        def sqlite_error() -> Exception:
            return RuntimeError(
                "no such table: jobs; SELECT * FROM jobs WHERE secret='abc'"
            )

        application = Application(
            store=ExplodingStore(),
            verifier=self.app._verifier,
            clock=self.clock,
            resolver=self.resolver,
            id_factory=lambda: "job_boom",
            log=lambda event, fields: self.logs.append((event, dict(fields))),
        )
        signature = compute_signature(
            SECRET_A, TENANT_A, KEY_ID, str(NOW), "nonce-boom-0001", "GET",
            "/v1/jobs/job_0001", b"",
        )
        headers = [
            ("X-Tenant-ID", TENANT_A),
            ("X-Key-ID", KEY_ID),
            ("X-Timestamp", str(NOW)),
            ("X-Nonce", "nonce-boom-0001"),
            ("X-Signature", signature),
        ]
        response = application.handle("GET", "/v1/jobs/job_0001", headers, b"")
        self.assertEqual(response.status, 500)
        self.assertEqual(response.json()["error"]["code"], "internal_error")
        self.assertNotIn(b"SELECT", response.body)
        self.assertNotIn(b"Traceback", response.body)
        self.assertNotIn("SELECT", self.log_text())

    def test_redaction_is_applied_to_log_fields(self) -> None:
        captured: list[tuple[str, dict]] = []
        application = build_application(
            db_path=os.path.join(self._tmp.name, "logs.sqlite3"),
            secrets={(TENANT_A, KEY_ID): SECRET_A},
            clock=self.clock,
            resolver=self.resolver,
            id_factory=lambda: "job_log01",
            log=lambda event, fields: captured.append((event, dict(fields))),
        )
        application._emit("test.event", secret="hunter2", payload={"x": 1}, safe="ok")
        self.assertEqual(captured[-1][1]["secret"], "[redacted]")
        self.assertEqual(captured[-1][1]["payload"], "[redacted]")
        self.assertEqual(captured[-1][1]["safe"], "ok")


class TestModuleHygiene(unittest.TestCase):
    def test_no_hard_coded_secret_material_in_service_modules(self) -> None:
        here = os.path.dirname(os.path.abspath(__file__))
        for name in ("app.py", "security.py", "store.py", "worker.py"):
            with open(os.path.join(here, name), "r", encoding="utf-8") as handle:
                text = handle.read()
            with self.subTest(module=name):
                self.assertNotIn(SECRET_A.decode(), text)
                self.assertNotIn("hunter2", text)

    def test_worker_documents_classifications(self) -> None:
        doc = worker_module.__doc__ or ""
        for token in (
            "http_retryable", "http_terminal", "callback_rejected",
            "resolver_error", "timeout", "transport_error", "response_too_large",
        ):
            self.assertIn(token, doc)

    def test_response_retention_budget(self) -> None:
        self.assertEqual(worker_module.MAX_RESPONSE_RETAINED_BYTES, 8192)
        self.assertEqual(app_module.MAX_BODY_BYTES, 65536)


if __name__ == "__main__":
    unittest.main()
