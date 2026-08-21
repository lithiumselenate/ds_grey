"""SQLite persistence, idempotency, and worker leasing for RelayVault.

Concurrency model
-----------------
Each :class:`Store` owns one SQLite connection.  Every mutating operation runs
inside an explicit ``BEGIN IMMEDIATE`` transaction, which takes the database
write lock up front, so check-then-insert sequences (idempotency, event-id
uniqueness, lease claims) are atomic even across separate connections /
processes sharing the same database file.  A busy timeout makes competing
writers queue instead of failing.

All values are bound as SQL parameters.  No SQL identifier or predicate is
ever built from untrusted strings.

Timestamps persisted here are wall-clock Unix seconds supplied by callers
(``now`` arguments).  Monotonic clocks are used only for in-process duration
measurement (see worker.py) and are never persisted.

Retry policy (documented, deterministic)
----------------------------------------
* ``attempts`` is incremented exactly once per delivery attempt, at claim time.
* A retryable failure with ``attempts < 5`` requeues the job with
  ``next_attempt_at = now + min(2 ** attempts, 300)``.
* A non-retryable failure, or a fifth failed attempt, makes the job terminal
  (status ``failed``).  Terminal jobs (``delivered``/``failed``) are never
  reclaimed.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from contextlib import contextmanager

__all__ = [
    "LeaseError",
    "Store",
    "MAX_ATTEMPTS",
    "MAX_RETRY_DELAY_SECONDS",
    "retry_delay",
]

MAX_ATTEMPTS = 5
MAX_RETRY_DELAY_SECONDS = 300

STATUS_QUEUED = "queued"
STATUS_LEASED = "leased"
STATUS_DELIVERED = "delivered"
STATUS_FAILED = "failed"
TERMINAL_STATUSES = (STATUS_DELIVERED, STATUS_FAILED)

_ERROR_CODE_RE = re.compile(r"[a-z0-9_]{1,64}")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    callback_url     TEXT NOT NULL,
    payload          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','leased','delivered','failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    lease_owner      TEXT,
    lease_expires_at INTEGER,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (tenant_id, event_id)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id  TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    idem_key   TEXT NOT NULL,
    body_hash  TEXT NOT NULL,
    job_id     TEXT NOT NULL REFERENCES jobs (job_id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, endpoint, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due
    ON jobs (status, next_attempt_at);
"""

_JOB_COLUMNS = (
    "job_id, tenant_id, event_id, event_type, callback_url, payload, status, "
    "attempts, next_attempt_at, lease_owner, lease_expires_at, last_error, "
    "created_at, updated_at"
)


class LeaseError(Exception):
    """The caller does not hold an active lease on the job."""


def retry_delay(attempt: int) -> int:
    """Deterministic backoff: ``min(2 ** attempt, 300)`` seconds."""
    return min(2 ** int(attempt), MAX_RETRY_DELAY_SECONDS)


def _safe_error_code(error_code) -> str:
    text = str(error_code) if error_code is not None else "error"
    return text if _ERROR_CODE_RE.fullmatch(text) else "error"


class Store:
    """One SQLite connection with explicit transactions and leasing."""

    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(
            db_path,
            timeout=30.0,
            isolation_level=None,  # explicit transaction control
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 30000")
        with self._txn() as cur:
            cur.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def _txn(self):
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                yield cur
            except BaseException:
                self._conn.rollback()
                raise
            else:
                self._conn.commit()
            finally:
                cur.close()

    # ------------------------------------------------------------------
    # Job creation with idempotency
    # ------------------------------------------------------------------

    def create_event_job(
        self,
        *,
        tenant_id: str,
        endpoint: str,
        idempotency_key: str,
        body_hash: str,
        job_id: str,
        event_id: str,
        event_type: str,
        callback_url: str,
        payload_json: str,
        now: int,
    ):
        """Atomically create a job, honouring idempotency.

        Returns ``(outcome, job_dict_or_None)`` where outcome is one of:

        * ``"created"``              – new job stored;
        * ``"duplicate"``            – same tenant/endpoint/key with a
          byte-identical body; the original job is returned;
        * ``"idempotency_conflict"`` – same key, different body;
        * ``"event_id_conflict"``    – a *different* idempotency key tried to
          reuse an event_id that already exists for this tenant (documented
          deterministic behaviour: rejected, nothing is written).
        """
        now = int(now)
        with self._txn() as cur:
            cur.execute(
                "SELECT body_hash, job_id FROM idempotency_keys "
                "WHERE tenant_id = ? AND endpoint = ? AND idem_key = ?",
                (tenant_id, endpoint, idempotency_key),
            )
            row = cur.fetchone()
            if row is not None:
                if row["body_hash"] == body_hash:
                    return "duplicate", self._fetch_job(cur, row["job_id"])
                return "idempotency_conflict", None

            cur.execute(
                "SELECT job_id FROM jobs WHERE tenant_id = ? AND event_id = ?",
                (tenant_id, event_id),
            )
            if cur.fetchone() is not None:
                return "event_id_conflict", None

            cur.execute(
                f"INSERT INTO jobs ({_JOB_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, ?)",
                (
                    job_id,
                    tenant_id,
                    event_id,
                    event_type,
                    callback_url,
                    payload_json,
                    now,
                    now,
                    now,
                ),
            )
            cur.execute(
                "INSERT INTO idempotency_keys "
                "(tenant_id, endpoint, idem_key, body_hash, job_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (tenant_id, endpoint, idempotency_key, body_hash, job_id, now),
            )
            return "created", self._fetch_job(cur, job_id)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get_job(self, tenant_id: str, job_id: str):
        """Fetch a job only if it belongs to ``tenant_id`` (else ``None``)."""
        cur = self._conn.execute(
            f"SELECT {_JOB_COLUMNS} FROM jobs WHERE job_id = ? AND tenant_id = ?",
            (str(job_id), str(tenant_id)),
        )
        row = cur.fetchone()
        return dict(row) if row is not None else None

    def _fetch_job(self, cur, job_id: str):
        cur.execute(
            f"SELECT {_JOB_COLUMNS} FROM jobs WHERE job_id = ?", (job_id,)
        )
        row = cur.fetchone()
        return dict(row) if row is not None else None

    # ------------------------------------------------------------------
    # Leasing
    # ------------------------------------------------------------------

    def claim_due(self, worker_id: str, limit: int, lease_seconds: int, now: int):
        """Atomically claim up to ``limit`` due jobs for ``worker_id``.

        Only non-terminal jobs whose ``next_attempt_at`` has passed and whose
        lease is absent or expired are claimable.  ``attempts`` is incremented
        here, exactly once per delivery attempt.
        """
        now = int(now)
        limit = int(limit)
        if limit <= 0:
            return []
        claimed = []
        with self._txn() as cur:
            cur.execute(
                "SELECT job_id FROM jobs "
                "WHERE status IN ('queued', 'leased') "
                "  AND next_attempt_at <= ? "
                "  AND (lease_owner IS NULL OR lease_expires_at <= ?) "
                "ORDER BY next_attempt_at ASC, job_id ASC LIMIT ?",
                (now, now, limit),
            )
            job_ids = [row["job_id"] for row in cur.fetchall()]
            for job_id in job_ids:
                cur.execute(
                    "UPDATE jobs SET status = 'leased', lease_owner = ?, "
                    "lease_expires_at = ?, attempts = attempts + 1, "
                    "updated_at = ? WHERE job_id = ?",
                    (worker_id, now + int(lease_seconds), now, job_id),
                )
                claimed.append(self._fetch_job(cur, job_id))
        return claimed

    def complete(self, job_id: str, worker_id: str, now: int) -> None:
        """Mark a leased job delivered.  Only the lease owner may do this."""
        now = int(now)
        with self._txn() as cur:
            cur.execute(
                "UPDATE jobs SET status = 'delivered', lease_owner = NULL, "
                "lease_expires_at = NULL, last_error = NULL, updated_at = ? "
                "WHERE job_id = ? AND status = 'leased' AND lease_owner = ?",
                (now, job_id, worker_id),
            )
            if cur.rowcount != 1:
                raise LeaseError("lease_not_held")

    def fail(
        self,
        job_id: str,
        worker_id: str,
        retryable: bool,
        now: int,
        error_code: str,
    ):
        """Record a failed attempt.  Only the lease owner may do this.

        Returns the updated job dict.  ``error_code`` is sanitised to a short
        machine code; response bodies, secrets, and payloads are never stored.
        """
        now = int(now)
        code = _safe_error_code(error_code)
        with self._txn() as cur:
            cur.execute(
                "SELECT status, lease_owner, attempts FROM jobs WHERE job_id = ?",
                (job_id,),
            )
            row = cur.fetchone()
            if (
                row is None
                or row["status"] != STATUS_LEASED
                or row["lease_owner"] != worker_id
            ):
                raise LeaseError("lease_not_held")
            attempts = int(row["attempts"])
            if retryable and attempts < MAX_ATTEMPTS:
                cur.execute(
                    "UPDATE jobs SET status = 'queued', lease_owner = NULL, "
                    "lease_expires_at = NULL, next_attempt_at = ?, "
                    "last_error = ?, updated_at = ? WHERE job_id = ?",
                    (now + retry_delay(attempts), code, now, job_id),
                )
            else:
                cur.execute(
                    "UPDATE jobs SET status = 'failed', lease_owner = NULL, "
                    "lease_expires_at = NULL, last_error = ?, updated_at = ? "
                    "WHERE job_id = ?",
                    (code, now, job_id),
                )
            return self._fetch_job(cur, job_id)
