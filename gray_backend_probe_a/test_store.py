"""Deterministic tests for RelayVault persistence, idempotency and leasing.

Concurrency tests always use *separate* :class:`Store` instances, i.e. separate
SQLite connections to the same file.  No network access.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import unittest

from store import (
    MAX_ATTEMPTS,
    MAX_RETAINED_RESPONSE_BYTES,
    STATUS_DELIVERED,
    STATUS_FAILED,
    STATUS_LEASED,
    STATUS_PENDING,
    STATUS_RETRYING,
    EventIdConflict,
    IdempotencyConflict,
    Store,
    retry_delay_seconds,
)

TENANT_A = "tenant_a"
TENANT_B = "tenant_b"
ENDPOINT = "POST /v1/events"
NOW = 1_700_000_000
CALLBACK = "https://hooks.example.test/deliver"
PAYLOAD = '{"k":"v"}'


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.stores: list[Store] = []
        self.store = self.new_store()
        self.store.ensure_tenants([TENANT_A, TENANT_B], now=NOW)

    def tearDown(self):
        for store in self.stores:
            store.close()
        self._tmp.cleanup()

    def new_store(self) -> Store:
        store = Store(self.db_path)
        self.stores.append(store)
        return store

    def create(
        self,
        store=None,
        *,
        tenant=TENANT_A,
        idem_key="idem-key-0001",
        request_sha256="a" * 64,
        job_id="job_0001",
        event_id="evt_1",
        callback_url=CALLBACK,
        payload=PAYLOAD,
        now=NOW,
    ):
        store = store or self.store
        return store.create_job_idempotent(
            tenant_id=tenant,
            endpoint=ENDPOINT,
            idem_key=idem_key,
            request_sha256=request_sha256,
            job_id=job_id,
            event_id=event_id,
            event_type="build.completed",
            callback_url=callback_url,
            payload_json=payload,
            now=now,
        )


class SchemaTests(StoreTestCase):
    def test_new_job_starts_pending_and_unleased(self):
        job, created = self.create()
        self.assertTrue(created)
        self.assertEqual(job.status, STATUS_PENDING)
        self.assertEqual(job.attempts, 0)
        self.assertEqual(job.max_attempts, MAX_ATTEMPTS)
        self.assertEqual(job.next_attempt_at, NOW)
        self.assertEqual(job.created_at, NOW)
        self.assertEqual(job.updated_at, NOW)
        self.assertIsNone(job.lease_owner)
        self.assertIsNone(job.lease_expires_at)
        self.assertEqual(job.payload_bytes, len(PAYLOAD.encode()))

    def test_foreign_keys_are_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.create(tenant="tenant_does_not_exist")

    def test_no_response_body_column_exists(self):
        with self.store._tx("DEFERRED") as conn:
            job_columns = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
            attempt_columns = {r[1] for r in conn.execute("PRAGMA table_info(attempt_log)")}
        for columns in (job_columns, attempt_columns):
            self.assertNotIn("response_body", columns)
            self.assertNotIn("signature", columns)
            self.assertNotIn("secret", columns)
        self.assertIn("payload_json", job_columns)
        self.assertIn("response_bytes", job_columns)


class IdempotencyTests(StoreTestCase):
    def test_same_key_and_body_returns_the_original_job(self):
        first, created_first = self.create()
        second, created_second = self.create(job_id="job_0002")
        self.assertTrue(created_first)
        self.assertFalse(created_second)
        self.assertEqual(first.job_id, second.job_id)
        self.assertEqual(second.job_id, "job_0001")

    def test_same_key_with_different_body_conflicts(self):
        self.create()
        with self.assertRaises(IdempotencyConflict):
            self.create(request_sha256="b" * 64, job_id="job_0002", event_id="evt_2")
        self.assertIsNotNone(self.store.get_job(TENANT_A, "job_0001"))
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0002"))

    def test_different_tenants_may_reuse_a_key(self):
        job_a, _ = self.create(tenant=TENANT_A)
        job_b, created = self.create(tenant=TENANT_B, job_id="job_0002")
        self.assertTrue(created)
        self.assertNotEqual(job_a.job_id, job_b.job_id)
        self.assertEqual(job_b.tenant_id, TENANT_B)

    def test_event_id_is_unique_per_tenant_and_conflicts_deterministically(self):
        self.create(event_id="evt_dup")
        with self.assertRaises(EventIdConflict):
            self.create(idem_key="idem-key-0002", job_id="job_0002", event_id="evt_dup")
        # The original job is untouched and no second job appeared.
        self.assertIsNone(self.store.get_job(TENANT_A, "job_0002"))
        self.assertEqual(self.store.get_job(TENANT_A, "job_0001").event_id, "evt_dup")
        # Another tenant may use the same event id.
        job_b, created = self.create(tenant=TENANT_B, job_id="job_0003", event_id="evt_dup")
        self.assertTrue(created)
        self.assertEqual(job_b.event_id, "evt_dup")

    def test_concurrent_identical_requests_create_exactly_one_job(self):
        worker_count = 10
        stores = [self.new_store() for _ in range(worker_count)]
        barrier = threading.Barrier(worker_count)
        results: list[tuple[str, bool]] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def attempt(index, store):
            try:
                barrier.wait()
                job, created = self.create(store, job_id="job_%04d" % index)
                with lock:
                    results.append((job.job_id, created))
            except BaseException as exc:  # pragma: no cover - failure diagnostics
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=attempt, args=(i, s)) for i, s in enumerate(stores)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(results), worker_count)
        self.assertEqual([created for _, created in results].count(True), 1)
        self.assertEqual(len({job_id for job_id, _ in results}), 1)

    def test_concurrent_distinct_keys_with_one_event_id_yield_one_job(self):
        worker_count = 8
        stores = [self.new_store() for _ in range(worker_count)]
        barrier = threading.Barrier(worker_count)
        created_count = []
        conflicts = []
        lock = threading.Lock()

        def attempt(index, store):
            barrier.wait()
            try:
                _job, created = self.create(
                    store,
                    idem_key="idem-key-%04d" % index,
                    request_sha256="%064d" % index,
                    job_id="job_%04d" % index,
                    event_id="evt_shared",
                )
                with lock:
                    created_count.append(created)
            except EventIdConflict:
                with lock:
                    conflicts.append(index)

        threads = [threading.Thread(target=attempt, args=(i, s)) for i, s in enumerate(stores)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(created_count, [True])
        self.assertEqual(len(conflicts), worker_count - 1)


class TenantScopingTests(StoreTestCase):
    def test_get_job_is_tenant_scoped(self):
        self.create(tenant=TENANT_A)
        self.assertIsNotNone(self.store.get_job(TENANT_A, "job_0001"))
        self.assertIsNone(self.store.get_job(TENANT_B, "job_0001"))
        self.assertIsNone(self.store.get_job(TENANT_A, "job_missing"))

    def test_hostile_job_ids_are_parameterised(self):
        self.create()
        hostile = [
            "job_0001' OR '1'='1",
            "'; DROP TABLE jobs; --",
            "job_0001; DELETE FROM jobs WHERE 1=1;",
            '" OR 1=1 --',
            "job_0001%",
            "job_0001\x00",
            "1 UNION SELECT job_id, tenant_id FROM jobs",
            "job_0001' UNION ALL SELECT payload_json FROM jobs --",
        ]
        for job_id in hostile:
            with self.subTest(job_id=job_id):
                self.assertIsNone(self.store.get_job(TENANT_A, job_id))
        for tenant_id in ("tenant_a' OR '1'='1", "' OR 1=1 --"):
            with self.subTest(tenant_id=tenant_id):
                self.assertIsNone(self.store.get_job(tenant_id, "job_0001"))
        # Nothing was dropped, deleted or leaked.
        self.assertIsNotNone(self.store.get_job(TENANT_A, "job_0001"))


class LeaseTests(StoreTestCase):
    def test_claim_increments_attempts_exactly_once(self):
        self.create()
        claimed = self.store.claim_due("worker-1", 5, 60, NOW)
        self.assertEqual([job.job_id for job in claimed], ["job_0001"])
        self.assertEqual(claimed[0].attempts, 1)
        self.assertEqual(claimed[0].status, STATUS_LEASED)
        self.assertEqual(claimed[0].lease_owner, "worker-1")
        self.assertEqual(claimed[0].lease_expires_at, NOW + 60)

        self.assertTrue(self.store.complete("job_0001", "worker-1", NOW + 1, status_code=200))
        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertEqual(job.attempts, 1, "completing must not change the attempt count")
        self.assertEqual(job.status, STATUS_DELIVERED)
        self.assertIsNone(job.lease_owner)

    def test_claim_respects_limit_and_due_time(self):
        for index in range(5):
            self.create(
                idem_key="idem-key-%04d" % index,
                request_sha256="%064d" % index,
                job_id="job_%04d" % index,
                event_id="evt_%d" % index,
            )
        future, _ = self.create(
            idem_key="idem-key-future",
            request_sha256="f" * 64,
            job_id="job_future",
            event_id="evt_future",
            now=NOW + 1000,
        )
        self.assertEqual(future.next_attempt_at, NOW + 1000)

        first = self.store.claim_due("worker-1", 3, 60, NOW)
        self.assertEqual([job.job_id for job in first], ["job_0000", "job_0001", "job_0002"])
        second = self.store.claim_due("worker-2", 10, 60, NOW)
        self.assertEqual([job.job_id for job in second], ["job_0003", "job_0004"])
        self.assertEqual(self.store.claim_due("worker-3", 10, 60, NOW), [])

    def test_two_workers_never_claim_the_same_lease(self):
        self.create()
        attempts = 16
        stores = [self.new_store() for _ in range(attempts)]
        barrier = threading.Barrier(attempts)
        claims: list[str] = []
        lock = threading.Lock()

        def race(store, index):
            barrier.wait()
            claimed = store.claim_due("worker-%d" % index, 1, 60, NOW)
            with lock:
                claims.extend(job.job_id for job in claimed)

        threads = [threading.Thread(target=race, args=(s, i)) for i, s in enumerate(stores)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(claims, ["job_0001"], "exactly one worker may hold the lease")
        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertEqual(job.attempts, 1, "one delivery attempt means one increment")

    def test_live_lease_is_not_reclaimable_but_expired_one_is(self):
        self.create()
        self.assertEqual(len(self.store.claim_due("worker-1", 1, 60, NOW)), 1)
        other = self.new_store()
        self.assertEqual(other.claim_due("worker-2", 1, 60, NOW + 1), [])
        self.assertEqual(other.claim_due("worker-2", 1, 60, NOW + 59), [])
        reclaimed = other.claim_due("worker-2", 1, 60, NOW + 60)
        self.assertEqual([job.job_id for job in reclaimed], ["job_0001"])
        self.assertEqual(reclaimed[0].lease_owner, "worker-2")
        self.assertEqual(reclaimed[0].attempts, 2)
        # The original worker can no longer settle the job.
        self.assertFalse(self.store.complete("job_0001", "worker-1", NOW + 61))
        self.assertIsNone(self.store.fail("job_0001", "worker-1", True, NOW + 61, "timeout"))
        self.assertEqual(self.store.get_job(TENANT_A, "job_0001").status, STATUS_LEASED)

    def test_wrong_worker_cannot_complete_or_fail(self):
        self.create()
        self.store.claim_due("worker-1", 1, 60, NOW)
        self.assertFalse(self.store.complete("job_0001", "worker-2", NOW + 1))
        self.assertIsNone(self.store.fail("job_0001", "worker-2", True, NOW + 1, "timeout"))
        self.assertEqual(self.store.get_job(TENANT_A, "job_0001").status, STATUS_LEASED)
        self.assertEqual(self.store.count_attempt_log("job_0001"), 0)
        self.assertTrue(self.store.complete("job_0001", "worker-1", NOW + 2, status_code=204))
        self.assertEqual(self.store.count_attempt_log("job_0001"), 1)

    def test_unknown_or_unleased_jobs_cannot_be_settled(self):
        self.create()
        self.assertFalse(self.store.complete("job_missing", "worker-1", NOW))
        self.assertIsNone(self.store.fail("job_missing", "worker-1", True, NOW, "timeout"))
        self.assertFalse(self.store.complete("job_0001", "worker-1", NOW))

    def test_terminal_jobs_are_never_reclaimed(self):
        for index, terminal in enumerate(("complete", "fail")):
            job_id = "job_term_%d" % index
            self.create(
                idem_key="idem-key-t%04d" % index,
                request_sha256="%064d" % index,
                job_id=job_id,
                event_id="evt_t%d" % index,
            )
            self.store.claim_due("worker-1", 10, 60, NOW)
            if terminal == "complete":
                self.assertTrue(self.store.complete(job_id, "worker-1", NOW, status_code=200))
                expected = STATUS_DELIVERED
            else:
                outcome = self.store.fail(job_id, "worker-1", False, NOW, "http_terminal")
                self.assertTrue(outcome.terminal)
                expected = STATUS_FAILED
            self.assertEqual(self.store.get_job(TENANT_A, job_id).status, expected)
            for offset in (0, 60, 100_000):
                self.assertEqual(
                    [j.job_id for j in self.store.claim_due("worker-9", 10, 60, NOW + offset)],
                    [],
                )


class RetryPolicyTests(StoreTestCase):
    def test_retry_delay_is_deterministic_and_capped(self):
        self.assertEqual(retry_delay_seconds(0), 1)
        self.assertEqual(retry_delay_seconds(1), 2)
        self.assertEqual(retry_delay_seconds(2), 4)
        self.assertEqual(retry_delay_seconds(3), 8)
        self.assertEqual(retry_delay_seconds(4), 16)
        self.assertEqual(retry_delay_seconds(8), 256)
        self.assertEqual(retry_delay_seconds(9), 300)
        self.assertEqual(retry_delay_seconds(64), 300)

    def test_retryable_failures_walk_to_a_terminal_state(self):
        self.create()
        now = NOW
        expected_delays = [2, 4, 8, 16]
        for attempt in range(1, MAX_ATTEMPTS + 1):
            claimed = self.store.claim_due("worker-1", 1, 60, now)
            self.assertEqual(len(claimed), 1, "attempt %d should be claimable" % attempt)
            self.assertEqual(claimed[0].attempts, attempt)
            outcome = self.store.fail("job_0001", "worker-1", True, now, "http_retryable")
            self.assertIsNotNone(outcome)
            self.assertEqual(outcome.attempts, attempt)
            if attempt < MAX_ATTEMPTS:
                self.assertFalse(outcome.terminal)
                self.assertEqual(outcome.status, STATUS_RETRYING)
                self.assertEqual(outcome.retry_delay, expected_delays[attempt - 1])
                self.assertEqual(outcome.next_attempt_at, now + expected_delays[attempt - 1])
                self.assertEqual(self.store.claim_due("worker-1", 1, 60, now), [])
                now = outcome.next_attempt_at
            else:
                self.assertTrue(outcome.terminal)
                self.assertEqual(outcome.status, STATUS_FAILED)
                self.assertEqual(outcome.retry_delay, 0)

        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.attempts, MAX_ATTEMPTS)
        self.assertEqual(job.last_error_code, "http_retryable")
        self.assertEqual(self.store.count_attempt_log("job_0001"), MAX_ATTEMPTS)
        self.assertEqual(self.store.claim_due("worker-1", 1, 60, now + 100_000), [])

    def test_non_retryable_failure_is_immediately_terminal(self):
        self.create()
        self.store.claim_due("worker-1", 1, 60, NOW)
        outcome = self.store.fail("job_0001", "worker-1", False, NOW, "callback_url_rejected")
        self.assertTrue(outcome.terminal)
        self.assertEqual(outcome.attempts, 1)
        self.assertEqual(outcome.status, STATUS_FAILED)
        self.assertEqual(self.store.get_job(TENANT_A, "job_0001").last_error_code, "callback_url_rejected")

    def test_response_bytes_are_clamped_to_the_retention_cap(self):
        self.create()
        self.store.claim_due("worker-1", 1, 60, NOW)
        self.store.complete("job_0001", "worker-1", NOW, status_code=200, response_bytes=10 ** 6)
        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertEqual(job.response_bytes, MAX_RETAINED_RESPONSE_BYTES)
        rows = self.store.attempt_log_rows("job_0001")
        self.assertEqual(rows[0]["response_bytes"], MAX_RETAINED_RESPONSE_BYTES)
        self.assertNotIn("response_body", rows[0])

    def test_error_codes_are_truncated_and_persisted_times_are_wall_clock(self):
        self.create()
        self.store.claim_due("worker-1", 1, 60, NOW)
        outcome = self.store.fail("job_0001", "worker-1", True, NOW + 5, "x" * 200)
        self.assertEqual(len(outcome.error_code), 64)
        job = self.store.get_job(TENANT_A, "job_0001")
        self.assertEqual(job.updated_at, NOW + 5)
        self.assertEqual(job.next_attempt_at, NOW + 5 + 2)
        self.assertGreater(job.next_attempt_at, 1_600_000_000, "must be a wall-clock timestamp")


if __name__ == "__main__":
    unittest.main()
