"""Tests for store.py (idempotency, leasing) and worker.py (delivery)."""
import json
import os
import tempfile
import threading
import unittest

from security import StructuredLogger
from store import LeaseError, MAX_ATTEMPTS, Store, retry_delay
from worker import (
    DeliveryRequest,
    OversizedResponseError,
    RESPONSE_RETENTION_BYTES,
    TransportTimeoutError,
    Worker,
    classify_status,
)

NOW = 1_700_000_000
SAFE_IP = "93.184.216.34"
HOST = "hooks.example.test"
URL = f"https://{HOST}/delivery"


def new_db_path(case):
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    return os.path.join(tmp.name, "relayvault.sqlite3")


def make_store(case, path=None):
    store = Store(path or new_db_path(case))
    case.addCleanup(store.close)
    return store


def create_job(store, *, tenant="t1", key="idem-key-0001", body_hash="h1",
               job_id="job_1", event_id="evt_1", url=URL, now=NOW):
    return store.create_event_job(
        tenant_id=tenant,
        endpoint="POST /v1/events",
        idempotency_key=key,
        body_hash=body_hash,
        job_id=job_id,
        event_id=event_id,
        event_type="build.completed",
        callback_url=url,
        payload_json="{}",
        now=now,
    )


class IdempotencyTests(unittest.TestCase):
    def test_create_then_duplicate_then_conflict(self):
        store = make_store(self)
        outcome, job = create_job(store)
        self.assertEqual(outcome, "created")
        self.assertEqual(job["status"], "queued")

        outcome, dup = create_job(store, job_id="job_other")
        self.assertEqual(outcome, "duplicate")
        self.assertEqual(dup["job_id"], "job_1")

        outcome, none = create_job(store, job_id="job_x", body_hash="h2",
                                   event_id="evt_2")
        self.assertEqual(outcome, "idempotency_conflict")
        self.assertIsNone(none)

    def test_different_tenants_may_reuse_key(self):
        store = make_store(self)
        self.assertEqual(create_job(store)[0], "created")
        outcome, job = create_job(store, tenant="t2", job_id="job_2",
                                  body_hash="h9")
        self.assertEqual(outcome, "created")
        self.assertEqual(job["tenant_id"], "t2")

    def test_event_id_conflict_with_new_key_is_rejected(self):
        store = make_store(self)
        self.assertEqual(create_job(store)[0], "created")
        outcome, job = create_job(store, key="idem-key-0002", job_id="job_2",
                                  body_hash="h2", event_id="evt_1")
        self.assertEqual(outcome, "event_id_conflict")
        self.assertIsNone(job)
        # Nothing was written for the rejected request.
        self.assertIsNone(store.get_job("t1", "job_2"))

    def test_concurrent_idempotency_separate_connections(self):
        path = new_db_path(self)
        make_store(self, path)  # creates schema
        outcomes = []
        barrier = threading.Barrier(4)

        def submit(i):
            store = Store(path)
            try:
                barrier.wait()
                outcome, job = create_job(store, job_id=f"job_{i}")
                outcomes.append((outcome, job["job_id"]))
            finally:
                store.close()

        threads = [threading.Thread(target=submit, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        kinds = [o for o, _ in outcomes]
        self.assertEqual(kinds.count("created"), 1)
        self.assertEqual(kinds.count("duplicate"), 3)
        winner = next(j for o, j in outcomes if o == "created")
        self.assertEqual({j for _, j in outcomes}, {winner})


class LookupTests(unittest.TestCase):
    def test_cross_tenant_lookup_returns_none(self):
        store = make_store(self)
        create_job(store)
        self.assertIsNotNone(store.get_job("t1", "job_1"))
        self.assertIsNone(store.get_job("t2", "job_1"))
        self.assertIsNone(store.get_job("t1", "missing"))

    def test_hostile_job_ids_are_parameterized(self):
        store = make_store(self)
        create_job(store)
        hostile = [
            "job_1' OR '1'='1",
            "job_1; DROP TABLE jobs;--",
            'job_1" UNION SELECT * FROM idempotency_keys--',
            "%",
            "job_1\x00",
        ]
        for job_id in hostile:
            self.assertIsNone(store.get_job("t1", job_id), job_id)
        # Table still intact and legitimate lookups still work.
        self.assertEqual(store.get_job("t1", "job_1")["event_id"], "evt_1")


class LeaseTests(unittest.TestCase):
    def test_two_workers_race_for_one_job(self):
        path = new_db_path(self)
        make_store(self, path)
        seed = Store(path)
        create_job(seed)
        seed.close()
        claims = []
        barrier = threading.Barrier(2)

        def claim(worker_id):
            store = Store(path)
            try:
                barrier.wait()
                claims.append((worker_id, store.claim_due(worker_id, 5, 30, NOW)))
            finally:
                store.close()

        threads = [threading.Thread(target=claim, args=(w,)) for w in ("wA", "wB")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        total = sum(len(jobs) for _, jobs in claims)
        self.assertEqual(total, 1)

    def test_claim_respects_limit_atomically(self):
        store = make_store(self)
        for i in range(5):
            create_job(store, key=f"idem-key-{i:04d}", job_id=f"job_{i}",
                       event_id=f"evt_{i}", body_hash=f"h{i}")
        claimed = store.claim_due("w1", 3, 30, NOW)
        self.assertEqual(len(claimed), 3)
        self.assertEqual(len(store.claim_due("w2", 10, 30, NOW)), 2)

    def test_claim_increments_attempts_exactly_once(self):
        store = make_store(self)
        create_job(store)
        job = store.claim_due("w1", 1, 30, NOW)[0]
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(job["status"], "leased")
        self.assertEqual(job["lease_owner"], "w1")
        self.assertEqual(job["lease_expires_at"], NOW + 30)
        store.complete("job_1", "w1", NOW + 1)
        self.assertEqual(store.get_job("t1", "job_1")["attempts"], 1)

    def test_active_lease_not_reclaimable_but_expired_is(self):
        store = make_store(self)
        create_job(store)
        store.claim_due("w1", 1, 30, NOW)
        self.assertEqual(store.claim_due("w2", 1, 30, NOW + 29), [])
        reclaimed = store.claim_due("w2", 1, 30, NOW + 30)
        self.assertEqual(len(reclaimed), 1)
        self.assertEqual(reclaimed[0]["lease_owner"], "w2")
        self.assertEqual(reclaimed[0]["attempts"], 2)
        # Original worker lost the lease and cannot complete or fail it.
        with self.assertRaises(LeaseError):
            store.complete("job_1", "w1", NOW + 31)
        with self.assertRaises(LeaseError):
            store.fail("job_1", "w1", True, NOW + 31, "timeout")

    def test_wrong_worker_cannot_complete_or_fail(self):
        store = make_store(self)
        create_job(store)
        store.claim_due("w1", 1, 30, NOW)
        with self.assertRaises(LeaseError):
            store.complete("job_1", "intruder", NOW + 1)
        with self.assertRaises(LeaseError):
            store.fail("job_1", "intruder", True, NOW + 1, "timeout")
        # The rightful owner still can.
        store.complete("job_1", "w1", NOW + 2)
        self.assertEqual(store.get_job("t1", "job_1")["status"], "delivered")

    def test_terminal_jobs_never_reclaimed(self):
        store = make_store(self)
        create_job(store)
        store.claim_due("w1", 1, 30, NOW)
        store.fail("job_1", "w1", False, NOW, "http_400")
        self.assertEqual(store.get_job("t1", "job_1")["status"], "failed")
        self.assertEqual(store.claim_due("w2", 10, 30, NOW + 10_000), [])

        create_job(store, key="idem-key-0002", job_id="job_2", event_id="evt_2",
                   body_hash="h2")
        store.claim_due("w1", 1, 30, NOW)
        store.complete("job_2", "w1", NOW)
        self.assertEqual(store.claim_due("w2", 10, 30, NOW + 10_000), [])

    def test_retry_schedule_and_terminal_after_five_attempts(self):
        store = make_store(self)
        create_job(store)
        now = NOW
        for attempt in range(1, MAX_ATTEMPTS + 1):
            jobs = store.claim_due("w1", 1, 30, now)
            self.assertEqual(len(jobs), 1, f"attempt {attempt}")
            self.assertEqual(jobs[0]["attempts"], attempt)
            updated = store.fail("job_1", "w1", True, now, "http_503")
            if attempt < MAX_ATTEMPTS:
                self.assertEqual(updated["status"], "queued")
                delay = updated["next_attempt_at"] - now
                self.assertEqual(delay, min(2 ** attempt, 300))
                now = updated["next_attempt_at"]
            else:
                self.assertEqual(updated["status"], "failed")
                self.assertEqual(updated["last_error"], "http_503")
        self.assertEqual(store.claim_due("w1", 1, 30, now + 10_000), [])

    def test_retry_delay_is_capped(self):
        self.assertEqual(retry_delay(1), 2)
        self.assertEqual(retry_delay(4), 16)
        self.assertEqual(retry_delay(9), 300)
        self.assertEqual(retry_delay(30), 300)

    def test_job_not_due_yet_is_not_claimed(self):
        store = make_store(self)
        create_job(store, now=NOW)
        self.assertEqual(store.claim_due("w1", 1, 30, NOW - 1), [])
        self.assertEqual(len(store.claim_due("w1", 1, 30, NOW)), 1)


class FakeResolver:
    def __init__(self, mapping):
        self.mapping = dict(mapping)

    def __call__(self, hostname):
        return list(self.mapping[hostname])


class FakeTransport:
    def __init__(self, responses=None, error=None):
        self.responses = list(responses or [])
        self.error = error
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)


class WorkerTests(unittest.TestCase):
    def make_worker(self, resolver=None, transport=None, events=None):
        store = make_store(self)
        create_job(store)
        resolver = resolver or FakeResolver({HOST: [SAFE_IP]})
        transport = transport if transport is not None else FakeTransport([(200, b"ok")])
        clock = [NOW]
        worker = Worker(
            store=store,
            resolver=resolver,
            transport=transport,
            wall_clock=lambda: clock[0],
            worker_id="w1",
            logger=StructuredLogger(events.append if events is not None else None),
            monotonic_clock=iter(range(10_000)).__next__,
        )
        return store, worker, transport

    def test_successful_delivery_uses_validated_ip_and_preserves_host(self):
        store, worker, transport = self.make_worker()
        results = worker.run_once()
        self.assertEqual(results[0].outcome, "delivered")
        self.assertEqual(store.get_job("t1", "job_1")["status"], "delivered")
        request = transport.requests[0]
        self.assertEqual(request.ip, SAFE_IP)          # transport gets the IP
        self.assertEqual(request.hostname, HOST)       # hostname only for SNI
        self.assertEqual(request.headers["Host"], HOST)
        self.assertEqual(request.port, 443)
        payload = json.loads(request.body)
        self.assertEqual(payload["event_id"], "evt_1")

    def test_dns_rebinding_between_enqueue_and_delivery_blocks_transport(self):
        resolver = FakeResolver({HOST: [SAFE_IP]})
        transport = FakeTransport([(200, b"ok")])
        store, worker, transport = self.make_worker(resolver, transport)
        # The attacker re-points DNS after enqueue-time validation.
        resolver.mapping[HOST] = ["10.0.0.1"]
        results = worker.run_once()
        self.assertEqual(results[0].outcome, "failed")
        self.assertEqual(results[0].error_code, "unsafe_address")
        self.assertEqual(transport.requests, [])  # never reached the network
        self.assertEqual(store.get_job("t1", "job_1")["status"], "failed")

    def test_mixed_safe_and_unsafe_answers_rejected(self):
        resolver = FakeResolver({HOST: [SAFE_IP, "::ffff:192.168.0.7"]})
        store, worker, transport = self.make_worker(resolver)
        results = worker.run_once()
        self.assertEqual(results[0].error_code, "unsafe_address")
        self.assertEqual(transport.requests, [])

    def test_redirects_are_not_followed_and_are_terminal(self):
        transport = FakeTransport(
            [(302, b"see https://internal.example/loot")]
        )
        store, worker, transport = self.make_worker(transport=transport)
        results = worker.run_once()
        self.assertEqual(len(transport.requests), 1)  # exactly one request
        self.assertEqual(results[0].outcome, "failed")
        self.assertEqual(results[0].error_code, "http_302")
        self.assertEqual(store.get_job("t1", "job_1")["status"], "failed")

    def test_status_classification(self):
        self.assertEqual(classify_status(204), "success")
        for code in (408, 429, 500, 503, 599):
            self.assertEqual(classify_status(code), "retryable")
        for code in (301, 302, 400, 404, 410):
            self.assertEqual(classify_status(code), "terminal")

    def test_retryable_status_requeues(self):
        store, worker, _ = self.make_worker(
            transport=FakeTransport([(503, b"busy")])
        )
        results = worker.run_once()
        self.assertEqual(results[0].outcome, "requeued")
        job = store.get_job("t1", "job_1")
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["next_attempt_at"], NOW + 2)

    def test_timeout_and_transport_failures_are_retryable(self):
        for error, code in [
            (TransportTimeoutError(), "timeout"),
            (ConnectionError("boom"), "transport_error"),
        ]:
            store, worker, _ = self.make_worker(
                transport=FakeTransport(error=error)
            )
            results = worker.run_once()
            self.assertEqual(results[0].outcome, "requeued", code)
            self.assertEqual(results[0].error_code, code)

    def test_oversized_response_is_terminal(self):
        store, worker, _ = self.make_worker(
            transport=FakeTransport(error=OversizedResponseError())
        )
        results = worker.run_once()
        self.assertEqual(results[0].outcome, "failed")
        self.assertEqual(results[0].error_code, "oversized_response")

    def test_response_retention_is_truncated_and_never_persisted(self):
        big = b"A" * (RESPONSE_RETENTION_BYTES + 5000)
        store, worker, _ = self.make_worker(transport=FakeTransport([(200, big)]))
        results = worker.run_once()
        self.assertEqual(len(results[0].response_snippet), RESPONSE_RETENTION_BYTES)
        row = store.get_job("t1", "job_1")
        self.assertNotIn("AAAA", json.dumps(row, default=str))

    def test_worker_logs_contain_no_response_bodies_or_urls(self):
        events = []
        secret_body = b"super-secret-response-body"
        store, worker, _ = self.make_worker(
            transport=FakeTransport([(503, secret_body)]), events=events
        )
        worker.run_once()
        blob = repr(events)
        self.assertNotIn("super-secret-response-body", blob)
        self.assertNotIn(URL, blob)
        self.assertTrue(any(e["event"] == "delivery.attempted" for e in events))


if __name__ == "__main__":
    unittest.main()
