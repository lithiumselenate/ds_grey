"""Tests for SQLite persistence, idempotency atomicity, and worker leases."""
import hashlib
import os
import tempfile
import threading
import unittest

import store

NOW = 1_700_000_000


def body_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.store = store.Store(self.path)
        self.addCleanup(self.store.close)

    def create_job(
        self,
        job_id="job-1",
        tenant="t1",
        idem="idem-key-00000001",
        body=b'{"n":1}',
        event_id="evt_1",
        now=NOW,
        **kwargs,
    ):
        return self.store.create_job(
            tenant_id=tenant,
            idempotency_key=idem,
            body_sha256=body_hash(body),
            event_id=event_id,
            event_type=kwargs.get("event_type", "build.completed"),
            callback_url=kwargs.get("callback_url", "https://h.example.test/cb"),
            payload_json=kwargs.get("payload_json", "{}"),
            job_id=job_id,
            now=now,
        )


class IdempotencyTests(StoreTestCase):
    def test_create_and_get_job(self):
        job, created = self.create_job()
        self.assertTrue(created)
        fetched = self.store.get_job("t1", "job-1")
        self.assertEqual(fetched["event_id"], "evt_1")
        self.assertEqual(fetched["status"], "pending")
        self.assertEqual(fetched["attempts"], 0)
        self.assertEqual(fetched["created_at"], NOW)

    def test_same_key_same_body_returns_original(self):
        first, created = self.create_job()
        replay, created_again = self.create_job(job_id="job-ignored")
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(replay["job_id"], first["job_id"])
        self.assertIsNone(self.store.get_job("t1", "job-ignored"))

    def test_same_key_different_body_conflicts(self):
        self.create_job()
        with self.assertRaises(store.IdempotencyConflict):
            self.create_job(job_id="job-2", body=b'{"n":2}')

    def test_existing_event_id_with_different_key_conflicts(self):
        self.create_job()
        with self.assertRaises(store.EventIdConflict):
            self.create_job(job_id="job-2", idem="idem-key-00000002")
        # Deterministic: nothing was created or modified.
        self.assertIsNone(self.store.get_job("t1", "job-2"))
        self.assertEqual(self.store.get_job("t1", "job-1")["updated_at"], NOW)

    def test_different_tenants_may_reuse_key_and_event_id(self):
        self.create_job()
        other, created = self.create_job(job_id="job-2", tenant="t2")
        self.assertTrue(created)
        self.assertEqual(other["tenant_id"], "t2")

    def test_concurrent_idempotency_across_connections(self):
        results = []
        errors = []
        barrier = threading.Barrier(2)
        lock = threading.Lock()

        def submit(job_id):
            connection = store.Store(self.path)
            try:
                barrier.wait()
                job, created = connection.create_job(
                    tenant_id="t1",
                    idempotency_key="idem-key-racehorse",
                    body_sha256=body_hash(b'{"n":9}'),
                    event_id="evt_race",
                    event_type="build.completed",
                    callback_url="https://h.example.test/cb",
                    payload_json="{}",
                    job_id=job_id,
                    now=NOW,
                )
                with lock:
                    results.append((job["job_id"], created))
            except Exception as exc:  # pragma: no cover - failure diagnostics
                with lock:
                    errors.append(exc)
            finally:
                connection.close()

        threads = [
            threading.Thread(target=submit, args=("job-a",)),
            threading.Thread(target=submit, args=("job-b",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        created_flags = sorted(flag for _, flag in results)
        self.assertEqual(created_flags, [False, True])
        job_ids = {job_id for job_id, _ in results}
        self.assertEqual(len(job_ids), 1)


class HostileInputTests(StoreTestCase):
    def test_hostile_job_ids_are_parameterized(self):
        self.create_job()
        for hostile in (
            "job-1' OR '1'='1",
            "job-1'; DROP TABLE jobs; --",
            'job-1" OR ""="',
            "job-1 UNION SELECT * FROM jobs",
            "%",
            "_",
        ):
            self.assertIsNone(self.store.get_job("t1", hostile))
        for hostile_tenant in ("t1' OR '1'='1", "t1; DROP TABLE jobs"):
            self.assertIsNone(self.store.get_job(hostile_tenant, "job-1"))
        # The table survived and normal lookups still work.
        self.assertIsNotNone(self.store.get_job("t1", "job-1"))

    def test_cross_tenant_lookup_returns_none(self):
        self.create_job()
        self.assertIsNone(self.store.get_job("t2", "job-1"))


class LeaseTests(StoreTestCase):
    def test_claim_marks_lease_and_increments_attempts_once(self):
        self.create_job()
        claimed = self.store.claim_due("w1", 5, 60, NOW)
        self.assertEqual(len(claimed), 1)
        job = claimed[0]
        self.assertEqual(job["status"], "leased")
        self.assertEqual(job["lease_owner"], "w1")
        self.assertEqual(job["lease_expires_at"], NOW + 60)
        self.assertEqual(job["attempts"], 1)
        # Failing the attempt does not change the attempt counter again.
        self.store.fail("job-1", "w1", True, NOW + 1, "http_500")
        self.assertEqual(self.store.get_job("t1", "job-1")["attempts"], 1)

    def test_two_workers_racing_claim_one_job_exactly_once(self):
        self.create_job()
        barrier = threading.Barrier(2)
        claims = {}
        lock = threading.Lock()

        def claim(worker_id):
            connection = store.Store(self.path)
            try:
                barrier.wait()
                got = connection.claim_due(worker_id, 5, 60, NOW)
                with lock:
                    claims[worker_id] = got
            finally:
                connection.close()

        threads = [
            threading.Thread(target=claim, args=("w1",)),
            threading.Thread(target=claim, args=("w2",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        total = sum(len(got) for got in claims.values())
        self.assertEqual(total, 1)
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["attempts"], 1)
        self.assertIn(job["lease_owner"], {"w1", "w2"})

    def test_claim_up_to_limit_is_atomic(self):
        for index in range(5):
            self.create_job(
                job_id="job-%d" % index,
                idem="idem-key-limit-%04d" % index,
                event_id="evt_%d" % index,
            )
        first = self.store.claim_due("w1", 3, 60, NOW)
        second = self.store.claim_due("w2", 10, 60, NOW)
        self.assertEqual(len(first), 3)
        self.assertEqual(len(second), 2)
        owners = {job["job_id"]: job["lease_owner"] for job in first + second}
        self.assertEqual(len(owners), 5)

    def test_future_jobs_not_claimed(self):
        self.create_job()
        self.store.claim_due("w1", 5, 60, NOW)
        self.store.fail("job-1", "w1", True, NOW, "timeout")  # next attempt NOW+2
        self.assertEqual(self.store.claim_due("w1", 5, 60, NOW + 1), [])
        self.assertEqual(len(self.store.claim_due("w1", 5, 60, NOW + 2)), 1)

    def test_expired_lease_recovered_by_other_worker(self):
        self.create_job()
        self.store.claim_due("w1", 5, 60, NOW)
        self.assertEqual(self.store.claim_due("w2", 5, 60, NOW + 59), [])
        reclaimed = self.store.claim_due("w2", 5, 60, NOW + 60)
        self.assertEqual(len(reclaimed), 1)
        self.assertEqual(reclaimed[0]["lease_owner"], "w2")
        self.assertEqual(reclaimed[0]["attempts"], 2)
        # The original worker lost the lease and can no longer act on it.
        with self.assertRaises(store.LeaseError):
            self.store.complete("job-1", "w1", NOW + 61)

    def test_wrong_worker_cannot_complete_or_fail(self):
        self.create_job()
        self.store.claim_due("w1", 5, 60, NOW)
        with self.assertRaises(store.LeaseError):
            self.store.complete("job-1", "w2", NOW)
        with self.assertRaises(store.LeaseError):
            self.store.fail("job-1", "w2", True, NOW, "http_500")
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "leased")
        self.assertEqual(job["lease_owner"], "w1")
        # The rightful owner still can.
        self.store.complete("job-1", "w1", NOW + 1)
        self.assertEqual(self.store.get_job("t1", "job-1")["status"], "delivered")

    def test_terminal_jobs_never_reclaimed(self):
        self.create_job()
        self.store.claim_due("w1", 5, 60, NOW)
        self.store.complete("job-1", "w1", NOW)
        self.create_job(job_id="job-2", idem="idem-key-00000002", event_id="evt_2")
        self.store.claim_due("w1", 1, 60, NOW)
        self.store.fail("job-2", "w1", False, NOW, "http_400")
        far_future = NOW + 10_000_000
        self.assertEqual(self.store.claim_due("w2", 10, 60, far_future), [])


class RetryPolicyTests(StoreTestCase):
    def test_retry_delay_formula_and_cap(self):
        self.assertEqual(store.retry_delay(1), 2)
        self.assertEqual(store.retry_delay(4), 16)
        self.assertEqual(store.retry_delay(8), 256)
        self.assertEqual(store.retry_delay(9), 300)
        self.assertEqual(store.retry_delay(100), 300)

    def test_retryable_failures_until_terminal_at_five_attempts(self):
        self.create_job()
        now = NOW
        for attempt in range(1, 5):
            claimed = self.store.claim_due("w1", 1, 60, now)
            self.assertEqual(len(claimed), 1)
            self.assertEqual(claimed[0]["attempts"], attempt)
            self.store.fail("job-1", "w1", True, now, "http_503")
            job = self.store.get_job("t1", "job-1")
            self.assertEqual(job["status"], "pending")
            self.assertEqual(job["next_attempt_at"], now + min(2 ** attempt, 300))
            self.assertEqual(job["last_error_code"], "http_503")
            now = job["next_attempt_at"]
        # Fifth attempt: retryable failure becomes terminal.
        claimed = self.store.claim_due("w1", 1, 60, now)
        self.assertEqual(claimed[0]["attempts"], 5)
        self.store.fail("job-1", "w1", True, now, "http_503")
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["attempts"], 5)
        self.assertEqual(self.store.claim_due("w1", 1, 60, now + 100000), [])

    def test_non_retryable_failure_is_immediately_terminal(self):
        self.create_job()
        self.store.claim_due("w1", 1, 60, NOW)
        self.store.fail("job-1", "w1", False, NOW, "http_404")
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(job["last_error_code"], "http_404")

    def test_complete_marks_delivered_and_clears_lease(self):
        self.create_job()
        self.store.claim_due("w1", 1, 60, NOW)
        self.store.complete("job-1", "w1", NOW + 3)
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "delivered")
        self.assertIsNone(job["lease_owner"])
        self.assertIsNone(job["lease_expires_at"])
        self.assertEqual(job["updated_at"], NOW + 3)
        with self.assertRaises(store.LeaseError):
            self.store.complete("job-1", "w1", NOW + 4)

    def test_response_snippet_truncated_to_cap(self):
        self.create_job()
        self.store.claim_due("w1", 1, 60, NOW)
        oversized = b"x" * (store.MAX_RESPONSE_SNIPPET_BYTES + 5000)
        self.store.fail(
            "job-1", "w1", True, NOW, "http_500", response_snippet=oversized
        )
        job = self.store.get_job("t1", "job-1")
        self.assertLessEqual(
            len(job["response_snippet"].encode("utf-8")),
            store.MAX_RESPONSE_SNIPPET_BYTES,
        )


if __name__ == "__main__":
    unittest.main()
