"""Tests for RelayVault SQLite persistence, idempotency and worker leases."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import unittest

import store as store_module
from store import (
    MAX_ATTEMPTS,
    STATUS_DELIVERED,
    STATUS_FAILED,
    STATUS_LEASED,
    STATUS_PENDING,
    Store,
    retry_delay_seconds,
)

TENANT_A = "tenant_alpha"
TENANT_B = "tenant_beta"
ENDPOINT = "POST /v1/events"
NOW = 1_700_000_000


class FakeClock:
    def __init__(self, now: int = NOW) -> None:
        self.now = float(now)

    def __call__(self) -> float:
        return self.now


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.clock = FakeClock()
        self.store = Store(self.db_path, clock=self.clock)
        self.addCleanup(self.store.close)

    def new_store(self) -> Store:
        other = Store(self.db_path, clock=self.clock)
        self.addCleanup(other.close)
        return other

    def create(
        self,
        *,
        tenant: str = TENANT_A,
        idem_key: str = "idem-key-0001",
        body_sha256: str = "a" * 64,
        job_id: str = "job_0001",
        event_id: str = "evt_0001",
        callback_url: str = "https://hooks.example.test/delivery",
        payload_json: str = '{"k":1}',
        now: int | None = None,
        store: Store | None = None,
    ):
        target = store or self.store
        return target.create_or_get_job(
            tenant_id=tenant,
            endpoint=ENDPOINT,
            idem_key=idem_key,
            body_sha256=body_sha256,
            job_id=job_id,
            event_id=event_id,
            event_type="build.completed",
            callback_url=callback_url,
            payload_json=payload_json,
            now=NOW if now is None else now,
        )


class TestSchema(StoreTestCase):
    def test_foreign_keys_enabled(self) -> None:
        value = self.store.connection.execute("PRAGMA foreign_keys").fetchone()[0]
        self.assertEqual(value, 1)

    def test_idempotency_foreign_key_enforced(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.connection.execute(
                "INSERT INTO idempotency (tenant_id, endpoint, idem_key, "
                "body_sha256, job_id, created_at) VALUES (?,?,?,?,?,?)",
                (TENANT_A, ENDPOINT, "orphan-key-1", "b" * 64, "missing_job", NOW),
            )

    def test_status_check_constraint(self) -> None:
        self.create()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.connection.execute(
                "UPDATE jobs SET status = 'weird' WHERE id = ?", ("job_0001",)
            )


class TestIdempotency(StoreTestCase):
    def test_first_request_creates_job(self) -> None:
        result = self.create()
        self.assertTrue(result.created)
        self.assertIsNone(result.conflict)
        self.assertEqual(result.job.status, STATUS_PENDING)
        self.assertEqual(result.job.attempts, 0)
        self.assertEqual(result.job.next_attempt_at, NOW)
        self.assertEqual(result.job.created_at, NOW)

    def test_same_key_same_body_returns_original(self) -> None:
        first = self.create()
        second = self.create(job_id="job_other", event_id="evt_other")
        self.assertFalse(second.created)
        self.assertIsNone(second.conflict)
        self.assertEqual(second.job.id, first.job.id)
        self.assertEqual(self.store.count_jobs(), 1)

    def test_same_key_different_body_conflicts(self) -> None:
        self.create()
        clash = self.create(body_sha256="c" * 64, job_id="job_x", event_id="evt_x")
        self.assertEqual(clash.conflict, "idempotency_key_reuse")
        self.assertIsNone(clash.job)
        self.assertEqual(self.store.count_jobs(), 1)

    def test_different_tenants_may_reuse_key(self) -> None:
        first = self.create()
        second = self.create(
            tenant=TENANT_B, job_id="job_0002", body_sha256="d" * 64
        )
        self.assertTrue(second.created)
        self.assertNotEqual(first.job.id, second.job.id)
        self.assertEqual(self.store.count_jobs(), 2)

    def test_event_id_reuse_with_new_key_conflicts(self) -> None:
        self.create()
        clash = self.create(
            idem_key="idem-key-0002", job_id="job_0003", body_sha256="e" * 64
        )
        self.assertEqual(clash.conflict, "event_id_conflict")
        self.assertEqual(self.store.count_jobs(), 1)

    def test_event_id_unique_per_tenant_only(self) -> None:
        self.create()
        other = self.create(
            tenant=TENANT_B, idem_key="idem-key-0009", job_id="job_0004",
            body_sha256="f" * 64,
        )
        self.assertTrue(other.created)

    def test_concurrent_identical_requests_create_one_job(self) -> None:
        worker_count = 8
        barrier = threading.Barrier(worker_count)
        created: list[str] = []
        duplicates: list[str] = []
        conflicts: list[str] = []
        lock = threading.Lock()

        def attempt(index: int) -> None:
            connection_store = Store(self.db_path, clock=self.clock)
            try:
                barrier.wait()
                result = self.create(
                    job_id=f"job_race_{index}", store=connection_store
                )
                with lock:
                    if result.conflict:
                        conflicts.append(result.conflict)
                    elif result.created:
                        created.append(result.job.id)
                    else:
                        duplicates.append(result.job.id)
            finally:
                connection_store.close()

        threads = [
            threading.Thread(target=attempt, args=(i,)) for i in range(worker_count)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(conflicts, [])
        self.assertEqual(len(created), 1)
        self.assertEqual(len(duplicates), worker_count - 1)
        self.assertEqual(set(duplicates), {created[0]})
        self.assertEqual(self.store.count_jobs(), 1)


class TestTenantScopedLookup(StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create()

    def test_owner_can_read(self) -> None:
        job = self.store.get_job("job_0001", TENANT_A)
        self.assertIsNotNone(job)
        self.assertEqual(job.tenant_id, TENANT_A)

    def test_other_tenant_sees_nothing(self) -> None:
        self.assertIsNone(self.store.get_job("job_0001", TENANT_B))

    def test_public_projection_excludes_sensitive_fields(self) -> None:
        public = self.store.get_job("job_0001", TENANT_A).public_dict()
        self.assertNotIn("payload_json", public)
        self.assertNotIn("lease_owner", public)
        self.assertNotIn("callback_url", public)
        self.assertNotIn("tenant_id", public)

    def test_hostile_job_ids_are_parameterized_values(self) -> None:
        hostile = [
            "' OR '1'='1",
            "job_0001' --",
            "job_0001'); DROP TABLE jobs;--",
            "1 UNION SELECT id, tenant_id FROM jobs",
            "%",
            "_",
            "job_000%",
            'job_0001" OR "1"="1',
            "job_0001\x00",
        ]
        for job_id in hostile:
            with self.subTest(job_id=job_id):
                self.assertIsNone(self.store.get_job(job_id, TENANT_A))
        for tenant in ("' OR 1=1 --", "%", TENANT_A + "'"):
            with self.subTest(tenant=tenant):
                self.assertIsNone(self.store.get_job("job_0001", tenant))
        # Nothing was executed as SQL: the table and its row survive.
        self.assertEqual(self.store.count_jobs(), 1)
        self.assertIsNotNone(self.store.get_job("job_0001", TENANT_A))


class TestNonces(StoreTestCase):
    def test_first_claim_wins_and_replay_fails(self) -> None:
        self.assertTrue(self.store.claim_nonce(TENANT_A, "key_1", "n-1", NOW, 600))
        self.assertFalse(self.store.claim_nonce(TENANT_A, "key_1", "n-1", NOW, 600))

    def test_scoped_by_tenant_and_key(self) -> None:
        self.assertTrue(self.store.claim_nonce(TENANT_A, "key_1", "n-2", NOW, 600))
        self.assertTrue(self.store.claim_nonce(TENANT_B, "key_1", "n-2", NOW, 600))
        self.assertTrue(self.store.claim_nonce(TENANT_A, "key_2", "n-2", NOW, 600))

    def test_expired_nonce_is_reclaimable(self) -> None:
        self.assertTrue(self.store.claim_nonce(TENANT_A, "key_1", "n-3", NOW, 600))
        self.assertFalse(
            self.store.claim_nonce(TENANT_A, "key_1", "n-3", NOW + 599, 600)
        )
        self.assertTrue(
            self.store.claim_nonce(TENANT_A, "key_1", "n-3", NOW + 600, 600)
        )

    def test_atomic_across_separate_connections(self) -> None:
        worker_count = 10
        barrier = threading.Barrier(worker_count)
        results: list[bool] = []
        lock = threading.Lock()

        def attempt() -> None:
            connection_store = Store(self.db_path, clock=self.clock)
            try:
                barrier.wait()
                claimed = connection_store.claim_nonce(
                    TENANT_A, "key_1", "n-race", NOW, 600
                )
                with lock:
                    results.append(claimed)
            finally:
                connection_store.close()

        threads = [threading.Thread(target=attempt) for _ in range(worker_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(sum(1 for value in results if value), 1)
        self.assertEqual(len(results), worker_count)


class TestLeasing(StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create()

    def test_claim_marks_lease(self) -> None:
        claimed = self.store.claim_due("worker-a", 5, 60, NOW)
        self.assertEqual([job.id for job in claimed], ["job_0001"])
        job = self.store.get_job_unscoped("job_0001")
        self.assertEqual(job.status, STATUS_LEASED)
        self.assertEqual(job.lease_owner, "worker-a")
        self.assertEqual(job.lease_expires_at, NOW + 60)
        self.assertEqual(job.attempts, 0)

    def test_second_worker_cannot_steal_live_lease(self) -> None:
        self.assertEqual(len(self.store.claim_due("worker-a", 5, 60, NOW)), 1)
        other = self.new_store()
        self.assertEqual(other.claim_due("worker-b", 5, 60, NOW + 1), [])

    def test_two_workers_racing_one_job(self) -> None:
        barrier = threading.Barrier(2)
        outcomes: list[tuple[str, int]] = []
        lock = threading.Lock()

        def attempt(worker_id: str) -> None:
            connection_store = Store(self.db_path, clock=self.clock)
            try:
                barrier.wait()
                claimed = connection_store.claim_due(worker_id, 5, 60, NOW)
                with lock:
                    outcomes.append((worker_id, len(claimed)))
            finally:
                connection_store.close()

        threads = [
            threading.Thread(target=attempt, args=(name,))
            for name in ("worker-a", "worker-b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(sorted(count for _, count in outcomes), [0, 1])
        winner = [name for name, count in outcomes if count == 1][0]
        self.assertEqual(self.store.get_job_unscoped("job_0001").lease_owner, winner)

    def test_expired_lease_is_reclaimable(self) -> None:
        self.store.claim_due("worker-a", 5, 60, NOW)
        other = self.new_store()
        # Live lease (one second before expiry) is untouchable...
        self.assertEqual(other.claim_due("worker-b", 5, 60, NOW + 59), [])
        # ...and reclaimable from the expiry instant onwards.
        reclaimed = other.claim_due("worker-b", 5, 60, NOW + 60)
        self.assertEqual([job.id for job in reclaimed], ["job_0001"])
        self.assertEqual(
            self.store.get_job_unscoped("job_0001").lease_owner, "worker-b"
        )

    def test_future_jobs_are_not_claimed(self) -> None:
        self.create(
            idem_key="idem-key-later", job_id="job_later", event_id="evt_later",
            body_sha256="9" * 64,
        )
        self.store.connection.execute(
            "UPDATE jobs SET next_attempt_at = ? WHERE id = ?", (NOW + 30, "job_later")
        )
        claimed = self.store.claim_due("worker-a", 10, 60, NOW)
        self.assertEqual([job.id for job in claimed], ["job_0001"])

    def test_claim_limit_is_respected_and_atomic(self) -> None:
        for index in range(2, 7):
            self.create(
                idem_key=f"idem-key-{index:04d}", job_id=f"job_{index:04d}",
                event_id=f"evt_{index:04d}", body_sha256=f"{index}" * 64,
            )
        first = self.store.claim_due("worker-a", 3, 60, NOW)
        self.assertEqual(len(first), 3)
        other = self.new_store()
        second = other.claim_due("worker-b", 10, 60, NOW)
        self.assertEqual(len(second), 3)
        self.assertEqual(
            set(job.id for job in first) & set(job.id for job in second), set()
        )

    def test_terminal_jobs_are_never_reclaimed(self) -> None:
        self.store.claim_due("worker-a", 5, 60, NOW)
        self.assertTrue(self.store.complete("job_0001", "worker-a", NOW + 1))
        self.assertEqual(self.store.claim_due("worker-a", 5, 60, NOW + 10_000), [])

        self.create(
            idem_key="idem-key-dead", job_id="job_dead", event_id="evt_dead",
            body_sha256="8" * 64,
        )
        self.store.claim_due("worker-a", 5, 60, NOW)
        self.store.fail("job_dead", "worker-a", False, NOW + 1, "http_terminal")
        self.assertEqual(
            self.store.get_job_unscoped("job_dead").status, STATUS_FAILED
        )
        self.assertEqual(self.store.claim_due("worker-a", 5, 60, NOW + 10_000), [])


class TestCompletionOwnership(StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create()
        self.store.claim_due("worker-a", 5, 60, NOW)

    def test_owner_completes(self) -> None:
        self.assertTrue(self.store.complete("job_0001", "worker-a", NOW + 2))
        job = self.store.get_job_unscoped("job_0001")
        self.assertEqual(job.status, STATUS_DELIVERED)
        self.assertEqual(job.attempts, 1)
        self.assertIsNone(job.lease_owner)
        self.assertEqual(job.updated_at, NOW + 2)

    def test_wrong_worker_cannot_complete(self) -> None:
        other = self.new_store()
        self.assertFalse(other.complete("job_0001", "worker-b", NOW + 2))
        job = self.store.get_job_unscoped("job_0001")
        self.assertEqual(job.status, STATUS_LEASED)
        self.assertEqual(job.attempts, 0)

    def test_wrong_worker_cannot_fail(self) -> None:
        other = self.new_store()
        self.assertIsNone(
            other.fail("job_0001", "worker-b", True, NOW + 2, "timeout")
        )
        job = self.store.get_job_unscoped("job_0001")
        self.assertEqual(job.status, STATUS_LEASED)
        self.assertEqual(job.attempts, 0)
        self.assertIsNone(job.last_error_code)

    def test_double_complete_is_rejected(self) -> None:
        self.assertTrue(self.store.complete("job_0001", "worker-a", NOW + 2))
        self.assertFalse(self.store.complete("job_0001", "worker-a", NOW + 3))
        self.assertEqual(self.store.get_job_unscoped("job_0001").attempts, 1)

    def test_unleased_job_cannot_be_failed(self) -> None:
        self.create(
            idem_key="idem-key-free", job_id="job_free", event_id="evt_free",
            body_sha256="7" * 64,
        )
        self.assertIsNone(
            self.store.fail("job_free", "worker-a", True, NOW + 1, "timeout")
        )
        self.assertEqual(self.store.get_job_unscoped("job_free").attempts, 0)


class TestRetryAndTerminalTransitions(StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create()

    def test_retry_delay_formula(self) -> None:
        self.assertEqual(retry_delay_seconds(0), 1)
        self.assertEqual(retry_delay_seconds(1), 2)
        self.assertEqual(retry_delay_seconds(2), 4)
        self.assertEqual(retry_delay_seconds(3), 8)
        self.assertEqual(retry_delay_seconds(4), 16)
        self.assertEqual(retry_delay_seconds(8), 256)
        self.assertEqual(retry_delay_seconds(9), 300)
        self.assertEqual(retry_delay_seconds(40), 300)
        self.assertEqual(store_module.MAX_RETRY_DELAY_SECONDS, 300)

    def test_retry_schedule_and_terminal_boundary(self) -> None:
        expected_delays = [2, 4, 8, 16]
        now = NOW
        for attempt in range(1, MAX_ATTEMPTS):
            with self.subTest(attempt=attempt):
                claimed = self.store.claim_due("worker-a", 1, 60, now)
                self.assertEqual(len(claimed), 1)
                job = self.store.fail(
                    "job_0001", "worker-a", True, now, "http_retryable",
                    status_code=503,
                )
                self.assertEqual(job.attempts, attempt)
                self.assertEqual(job.status, STATUS_PENDING)
                self.assertEqual(
                    job.next_attempt_at, now + expected_delays[attempt - 1]
                )
                self.assertIsNone(job.lease_owner)
                self.assertEqual(job.last_error_code, "http_retryable")
                self.assertEqual(job.last_status_code, 503)
                now = job.next_attempt_at

        claimed = self.store.claim_due("worker-a", 1, 60, now)
        self.assertEqual(len(claimed), 1)
        job = self.store.fail(
            "job_0001", "worker-a", True, now, "http_retryable", status_code=503
        )
        self.assertEqual(job.attempts, MAX_ATTEMPTS)
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(self.store.claim_due("worker-a", 1, 60, now + 10_000), [])

    def test_non_retryable_failure_is_immediately_terminal(self) -> None:
        self.store.claim_due("worker-a", 1, 60, NOW)
        job = self.store.fail(
            "job_0001", "worker-a", False, NOW, "callback_rejected"
        )
        self.assertEqual(job.status, STATUS_FAILED)
        self.assertEqual(job.attempts, 1)

    def test_attempts_increase_exactly_once_per_attempt(self) -> None:
        self.store.claim_due("worker-a", 1, 60, NOW)
        job = self.store.fail("job_0001", "worker-a", True, NOW, "timeout")
        self.assertEqual(job.attempts, 1)
        # Re-claiming (e.g. after the retry delay) must not touch attempts.
        self.store.claim_due("worker-a", 1, 60, job.next_attempt_at)
        self.assertEqual(self.store.get_job_unscoped("job_0001").attempts, 1)

    def test_error_code_alphabet_is_constrained(self) -> None:
        self.store.claim_due("worker-a", 1, 60, NOW)
        job = self.store.fail(
            "job_0001", "worker-a", True, NOW, "'; DROP TABLE jobs; --"
        )
        self.assertRegex(job.last_error_code, r"\A[a-z0-9_]{1,40}\Z")
        self.assertEqual(self.store.count_jobs(), 1)

    def test_persisted_times_are_wall_clock_integers(self) -> None:
        job = self.store.get_job_unscoped("job_0001")
        for value in (job.created_at, job.updated_at, job.next_attempt_at):
            self.assertIsInstance(value, int)
            self.assertGreater(value, 1_600_000_000)

    def test_claim_arguments_are_validated(self) -> None:
        with self.assertRaises(ValueError):
            self.store.claim_due("worker-a", 0, 60, NOW)
        with self.assertRaises(ValueError):
            self.store.claim_due("worker-a", 5, 0, NOW)


if __name__ == "__main__":
    unittest.main()
