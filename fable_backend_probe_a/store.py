"""SQLite persistence: jobs, tenant-scoped idempotency, and worker leases.

Every statement uses parameterized data values; SQL text never embeds
untrusted strings.  All multi-step operations run inside explicit
``BEGIN IMMEDIATE`` transactions so separate connections observe atomic
check-and-insert and atomic lease claims.  Persisted timestamps are
wall-clock Unix seconds supplied by callers; monotonic clock values must
never be passed in.
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Optional

MAX_ATTEMPTS = 5
MAX_RETRY_DELAY_SECONDS = 300
MAX_RESPONSE_SNIPPET_BYTES = 8192

STATUS_PENDING = "pending"
STATUS_LEASED = "leased"
STATUS_DELIVERED = "delivered"
STATUS_FAILED = "failed"
TERMINAL_STATUSES = (STATUS_DELIVERED, STATUS_FAILED)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    callback_url     TEXT NOT NULL,
    payload          TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL,
    body_sha256      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','leased','delivered','failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    lease_owner      TEXT,
    lease_expires_at INTEGER,
    last_error_code  TEXT,
    response_snippet TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (tenant_id, event_id),
    UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS job_attempts (
    attempt_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    attempt     INTEGER NOT NULL,
    outcome     TEXT NOT NULL,
    error_code  TEXT,
    recorded_at INTEGER NOT NULL
);
"""


class StoreError(Exception):
    """Base class for store failures."""


class IdempotencyConflict(StoreError):
    """Same tenant + idempotency key with a different request body."""


class EventIdConflict(StoreError):
    """Same tenant + event_id already exists under another idempotency key."""


class LeaseError(StoreError):
    """Lease is missing, expired away, or owned by a different worker."""


def retry_delay(attempt: int) -> int:
    """Deterministic backoff: min(2 ** attempt, 300) seconds."""
    return min(2 ** attempt, MAX_RETRY_DELAY_SECONDS)


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


class Store:
    """One SQLite connection.  Open one Store per worker/thread for real
    cross-connection concurrency; an internal lock also makes a single
    instance safe to share between threads."""

    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 10000")
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- idempotent job creation -------------------------------------------

    def create_job(
        self,
        tenant_id: str,
        idempotency_key: str,
        body_sha256: str,
        event_id: str,
        event_type: str,
        callback_url: str,
        payload_json: str,
        job_id: str,
        now: int,
    ):
        """Atomically create or replay a job for (tenant, idempotency key).

        Returns ``(job_dict, created)``.  ``created`` is False when the same
        key replays a byte-identical body (the original job is returned).
        Raises IdempotencyConflict for the same key with a different body and
        EventIdConflict when a different key reuses an existing event_id.
        """
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                existing = self._conn.execute(
                    "SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?",
                    (tenant_id, idempotency_key),
                ).fetchone()
                if existing is not None:
                    if existing["body_sha256"] == body_sha256:
                        self._conn.execute("COMMIT")
                        return _row_to_dict(existing), False
                    raise IdempotencyConflict()
                clashing = self._conn.execute(
                    "SELECT job_id FROM jobs WHERE tenant_id = ? AND event_id = ?",
                    (tenant_id, event_id),
                ).fetchone()
                if clashing is not None:
                    raise EventIdConflict()
                self._conn.execute(
                    "INSERT INTO jobs (job_id, tenant_id, event_id, event_type,"
                    " callback_url, payload, idempotency_key, body_sha256, status,"
                    " attempts, next_attempt_at, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
                    (
                        job_id,
                        tenant_id,
                        event_id,
                        event_type,
                        callback_url,
                        payload_json,
                        idempotency_key,
                        body_sha256,
                        now,
                        now,
                        now,
                    ),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
        job = self.get_job(tenant_id, job_id)
        assert job is not None
        return job, True

    # -- reads ---------------------------------------------------------------

    def get_job(self, tenant_id: str, job_id: str) -> Optional[dict]:
        """Tenant-scoped, fully parameterized lookup."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE tenant_id = ? AND job_id = ?",
                (tenant_id, job_id),
            ).fetchone()
        return None if row is None else _row_to_dict(row)

    def get_job_any_tenant(self, job_id: str) -> Optional[dict]:
        """Internal/test helper; not exposed through the API layer."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return None if row is None else _row_to_dict(row)

    # -- leasing ---------------------------------------------------------------

    def claim_due(self, worker_id: str, limit: int, lease_seconds: int, now: int):
        """Atomically claim up to ``limit`` due jobs for ``worker_id``.

        Claims pending jobs whose next_attempt_at has arrived plus leased
        jobs whose lease expired.  Terminal jobs are never claimed.  The
        attempt counter increments exactly once here, at the start of each
        delivery attempt.
        """
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                rows = self._conn.execute(
                    "SELECT job_id FROM jobs"
                    " WHERE status NOT IN ('delivered', 'failed')"
                    " AND ((status = 'pending' AND next_attempt_at <= ?)"
                    "      OR (status = 'leased' AND lease_expires_at <= ?))"
                    " ORDER BY next_attempt_at, job_id LIMIT ?",
                    (now, now, limit),
                ).fetchall()
                claimed_ids = [row["job_id"] for row in rows]
                for job_id in claimed_ids:
                    self._conn.execute(
                        "UPDATE jobs SET status = 'leased', lease_owner = ?,"
                        " lease_expires_at = ?, attempts = attempts + 1,"
                        " updated_at = ? WHERE job_id = ?",
                        (worker_id, now + lease_seconds, now, job_id),
                    )
                claimed = [
                    _row_to_dict(row)
                    for row in self._conn.execute(
                        "SELECT * FROM jobs WHERE job_id IN (%s)"
                        % ",".join("?" * len(claimed_ids)),
                        claimed_ids,
                    ).fetchall()
                ] if claimed_ids else []
                self._conn.execute("COMMIT")
                return claimed
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def complete(self, job_id: str, worker_id: str, now: int) -> None:
        """Mark a leased job delivered; only the lease owner may do this."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                cursor = self._conn.execute(
                    "UPDATE jobs SET status = 'delivered', lease_owner = NULL,"
                    " lease_expires_at = NULL, last_error_code = NULL,"
                    " updated_at = ? WHERE job_id = ? AND lease_owner = ?"
                    " AND status = 'leased'",
                    (now, job_id, worker_id),
                )
                if cursor.rowcount != 1:
                    raise LeaseError()
                self._record_attempt(job_id, "delivered", None, now)
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def fail(
        self,
        job_id: str,
        worker_id: str,
        retryable: bool,
        now: int,
        error_code: str,
        response_snippet: Optional[bytes] = None,
    ) -> None:
        """Record a failed attempt; only the lease owner may do this.

        Retryable failures below MAX_ATTEMPTS reschedule the job after
        ``retry_delay(attempts)`` seconds; everything else becomes terminal
        'failed'.  At most MAX_RESPONSE_SNIPPET_BYTES of the callback
        response are retained; snippets are never logged.
        """
        snippet_text = None
        if response_snippet is not None:
            snippet_text = response_snippet[:MAX_RESPONSE_SNIPPET_BYTES].decode(
                "utf-8", errors="replace"
            )
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                row = self._conn.execute(
                    "SELECT attempts FROM jobs WHERE job_id = ? AND lease_owner = ?"
                    " AND status = 'leased'",
                    (job_id, worker_id),
                ).fetchone()
                if row is None:
                    raise LeaseError()
                attempts = row["attempts"]
                if retryable and attempts < MAX_ATTEMPTS:
                    self._conn.execute(
                        "UPDATE jobs SET status = 'pending', lease_owner = NULL,"
                        " lease_expires_at = NULL, next_attempt_at = ?,"
                        " last_error_code = ?, response_snippet = ?, updated_at = ?"
                        " WHERE job_id = ?",
                        (now + retry_delay(attempts), error_code, snippet_text, now, job_id),
                    )
                    outcome = "retry_scheduled"
                else:
                    self._conn.execute(
                        "UPDATE jobs SET status = 'failed', lease_owner = NULL,"
                        " lease_expires_at = NULL, last_error_code = ?,"
                        " response_snippet = ?, updated_at = ? WHERE job_id = ?",
                        (error_code, snippet_text, now, job_id),
                    )
                    outcome = "failed_terminal"
                self._record_attempt(job_id, outcome, error_code, now)
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def _record_attempt(self, job_id: str, outcome: str, error_code, now: int) -> None:
        self._conn.execute(
            "INSERT INTO job_attempts (job_id, attempt, outcome, error_code, recorded_at)"
            " SELECT job_id, attempts, ?, ?, ? FROM jobs WHERE job_id = ?",
            (outcome, error_code, now, job_id),
        )
