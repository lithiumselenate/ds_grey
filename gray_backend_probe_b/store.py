"""RelayVault persistence layer.

SQLite storage for jobs, idempotency records and authentication nonces,
plus worker leasing primitives.

Design notes
------------
* Every SQL statement is a fixed literal; **all** untrusted values travel as
  bound parameters.  No identifier or predicate is built from input.
* ``PRAGMA foreign_keys = ON`` on every connection, WAL journalling and a
  busy timeout so independent connections can contend safely.
* Writes run inside explicit ``BEGIN IMMEDIATE`` transactions, which makes
  "check then insert" (idempotency) and "select then update" (leasing)
  atomic across separate connections.
* Persisted timestamps are integer wall-clock Unix seconds supplied by an
  injected clock.  Monotonic values are never persisted.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Sequence

MAX_ATTEMPTS = 5
MAX_RETRY_DELAY_SECONDS = 300
MAX_RESPONSE_RETAINED_BYTES = 8192

STATUS_PENDING = "pending"
STATUS_LEASED = "leased"
STATUS_DELIVERED = "delivered"
STATUS_FAILED = "failed"
TERMINAL_STATUSES = (STATUS_DELIVERED, STATUS_FAILED)

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS jobs (
        id               TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        event_id         TEXT NOT NULL,
        event_type       TEXT NOT NULL,
        callback_url     TEXT NOT NULL,
        payload_json     TEXT NOT NULL,
        status           TEXT NOT NULL
                         CHECK (status IN ('pending','leased','delivered','failed')),
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_attempt_at  INTEGER NOT NULL,
        lease_owner      TEXT,
        lease_expires_at INTEGER,
        last_error_code  TEXT,
        last_status_code INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_event ON jobs(tenant_id, event_id)",
    "CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_attempt_at)",
    """
    CREATE TABLE IF NOT EXISTS idempotency (
        tenant_id   TEXT NOT NULL,
        endpoint    TEXT NOT NULL,
        idem_key    TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, endpoint, idem_key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS nonces (
        tenant_id  TEXT NOT NULL,
        key_id     TEXT NOT NULL,
        nonce      TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, key_id, nonce)
    )
    """,
    "CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces(expires_at)",
)

_JOB_COLUMNS = (
    "id, tenant_id, event_id, event_type, callback_url, payload_json, status, "
    "attempts, next_attempt_at, lease_owner, lease_expires_at, last_error_code, "
    "last_status_code, created_at, updated_at"
)


class StoreError(Exception):
    """Unexpected persistence failure (never surfaced verbatim to clients)."""


@dataclass(frozen=True)
class Job:
    id: str
    tenant_id: str
    event_id: str
    event_type: str
    callback_url: str
    payload_json: str
    status: str
    attempts: int
    next_attempt_at: int
    lease_owner: str | None
    lease_expires_at: int | None
    last_error_code: str | None
    last_status_code: int | None
    created_at: int
    updated_at: int

    @classmethod
    def from_row(cls, row: Sequence[Any]) -> "Job":
        return cls(*row)

    def public_dict(self) -> dict[str, Any]:
        """Client-visible projection.

        Deliberately excludes the serialized payload, the lease owner and any
        callback response data.
        """
        return {
            "job_id": self.id,
            "event_id": self.event_id,
            "type": self.event_type,
            "status": self.status,
            "attempts": self.attempts,
            "next_attempt_at": self.next_attempt_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class IdempotentResult:
    job: Job | None
    created: bool
    conflict: str | None = None


def retry_delay_seconds(attempts: int) -> int:
    """Deterministic backoff: ``min(2 ** attempt, 300)`` seconds."""
    if attempts < 0:
        raise ValueError("attempts must be >= 0")
    if attempts > 32:
        return MAX_RETRY_DELAY_SECONDS
    return min(2 ** attempts, MAX_RETRY_DELAY_SECONDS)


class Store:
    """SQLite-backed store.

    One connection per (Store instance, thread).  Tests create several Store
    instances over the same file to exercise genuinely separate connections.
    """

    def __init__(
        self,
        path: str,
        *,
        clock: Callable[[], float] | None = None,
        busy_timeout_seconds: float = 10.0,
    ) -> None:
        self.path = str(path)
        self._clock = clock
        self._busy_timeout = float(busy_timeout_seconds)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        self._initialise()

    # -- connection management ------------------------------------------
    def _new_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.path, timeout=self._busy_timeout, isolation_level=None
        )
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(f"PRAGMA busy_timeout = {int(self._busy_timeout * 1000)}")
        return conn

    @property
    def connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def _initialise(self) -> None:
        conn = self.connection
        with self._transaction():
            for statement in _SCHEMA:
                conn.execute(statement)

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connection
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")

    def _now(self, now: int | float | None) -> int:
        if now is not None:
            return int(now)
        if self._clock is None:
            raise StoreError("no clock available")
        return int(self._clock())

    # -- nonces ---------------------------------------------------------
    def claim_nonce(
        self, tenant_id: str, key_id: str, nonce: str, now: int, ttl_seconds: int
    ) -> bool:
        """Atomically claim a (tenant, key, nonce) triple exactly once.

        Returns ``False`` when the nonce is still within its TTL.  Atomicity
        comes from the primary key plus the IMMEDIATE transaction, so
        concurrent connections cannot both win.
        """
        now = int(now)
        expires_at = now + int(ttl_seconds)
        with self._transaction() as conn:
            conn.execute("DELETE FROM nonces WHERE expires_at <= ?", (now,))
            try:
                conn.execute(
                    "INSERT INTO nonces (tenant_id, key_id, nonce, expires_at) "
                    "VALUES (?, ?, ?, ?)",
                    (tenant_id, key_id, nonce, expires_at),
                )
            except sqlite3.IntegrityError:
                return False
        return True

    # -- jobs / idempotency ---------------------------------------------
    def create_or_get_job(
        self,
        *,
        tenant_id: str,
        endpoint: str,
        idem_key: str,
        body_sha256: str,
        job_id: str,
        event_id: str,
        event_type: str,
        callback_url: str,
        payload_json: str,
        now: int | float | None = None,
    ) -> IdempotentResult:
        """Idempotent job creation, atomic across connections.

        * unknown key -> insert, ``created=True``
        * known key, identical body hash -> original job, ``created=False``
        * known key, different body hash -> ``conflict='idempotency_key_reuse'``
        * different key reusing an existing ``event_id`` of the same tenant ->
          ``conflict='event_id_conflict'`` (documented in README.md)
        """
        timestamp = self._now(now)
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT job_id, body_sha256 FROM idempotency "
                "WHERE tenant_id = ? AND endpoint = ? AND idem_key = ?",
                (tenant_id, endpoint, idem_key),
            ).fetchone()
            if row is not None:
                existing_job_id, existing_hash = row
                if existing_hash != body_sha256:
                    return IdempotentResult(None, False, "idempotency_key_reuse")
                job_row = conn.execute(
                    f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ? AND tenant_id = ?",
                    (existing_job_id, tenant_id),
                ).fetchone()
                if job_row is None:
                    return IdempotentResult(None, False, "idempotency_key_reuse")
                return IdempotentResult(Job.from_row(job_row), False, None)

            clash = conn.execute(
                "SELECT id FROM jobs WHERE tenant_id = ? AND event_id = ?",
                (tenant_id, event_id),
            ).fetchone()
            if clash is not None:
                return IdempotentResult(None, False, "event_id_conflict")

            try:
                conn.execute(
                    "INSERT INTO jobs (id, tenant_id, event_id, event_type, "
                    "callback_url, payload_json, status, attempts, next_attempt_at, "
                    "lease_owner, lease_expires_at, last_error_code, "
                    "last_status_code, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?)",
                    (
                        job_id, tenant_id, event_id, event_type, callback_url,
                        payload_json, STATUS_PENDING, timestamp, timestamp, timestamp,
                    ),
                )
                conn.execute(
                    "INSERT INTO idempotency (tenant_id, endpoint, idem_key, "
                    "body_sha256, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (tenant_id, endpoint, idem_key, body_sha256, job_id, timestamp),
                )
            except sqlite3.IntegrityError:
                # Lost a race (or duplicate job id): fall back to a read.
                row = conn.execute(
                    "SELECT job_id, body_sha256 FROM idempotency "
                    "WHERE tenant_id = ? AND endpoint = ? AND idem_key = ?",
                    (tenant_id, endpoint, idem_key),
                ).fetchone()
                if row is None or row[1] != body_sha256:
                    return IdempotentResult(None, False, "idempotency_key_reuse")
                job_row = conn.execute(
                    f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ? AND tenant_id = ?",
                    (row[0], tenant_id),
                ).fetchone()
                if job_row is None:
                    return IdempotentResult(None, False, "idempotency_key_reuse")
                return IdempotentResult(Job.from_row(job_row), False, None)

            job_row = conn.execute(
                f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return IdempotentResult(Job.from_row(job_row), True, None)

    def get_job(self, job_id: str, tenant_id: str) -> Job | None:
        """Tenant-scoped lookup.  Foreign tenants observe exactly "not found"."""
        row = self.connection.execute(
            f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ? AND tenant_id = ?",
            (str(job_id), str(tenant_id)),
        ).fetchone()
        return Job.from_row(row) if row is not None else None

    def get_job_unscoped(self, job_id: str) -> Job | None:
        """Internal/worker lookup (not reachable from the HTTP surface)."""
        row = self.connection.execute(
            f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (str(job_id),)
        ).fetchone()
        return Job.from_row(row) if row is not None else None

    def count_jobs(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])

    # -- leasing ---------------------------------------------------------
    def claim_due(
        self, worker_id: str, limit: int, lease_seconds: int, now: int | float
    ) -> list[Job]:
        """Atomically lease up to ``limit`` due jobs.

        A job is claimable when it is not terminal, its ``next_attempt_at``
        has passed and it holds no live lease.  Expired leases are therefore
        reclaimable; delivered/failed jobs never are.
        """
        limit = int(limit)
        if limit < 1:
            raise ValueError("limit must be >= 1")
        lease_seconds = int(lease_seconds)
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be >= 1")
        timestamp = int(now)
        expires_at = timestamp + lease_seconds
        claimed: list[Job] = []
        with self._transaction() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status IN (?, ?) AND next_attempt_at <= ? "
                "AND (lease_owner IS NULL OR lease_expires_at IS NULL "
                "OR lease_expires_at <= ?) "
                "ORDER BY next_attempt_at ASC, id ASC LIMIT ?",
                (STATUS_PENDING, STATUS_LEASED, timestamp, timestamp, limit),
            ).fetchall()
            for (job_id,) in rows:
                conn.execute(
                    "UPDATE jobs SET status = ?, lease_owner = ?, "
                    "lease_expires_at = ?, updated_at = ? WHERE id = ?",
                    (STATUS_LEASED, worker_id, expires_at, timestamp, job_id),
                )
                job_row = conn.execute(
                    f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)
                ).fetchone()
                claimed.append(Job.from_row(job_row))
        return claimed

    def complete(self, job_id: str, worker_id: str, now: int | float) -> bool:
        """Mark a leased job delivered.  Only the lease owner may do so."""
        timestamp = int(now)
        with self._transaction() as conn:
            cursor = conn.execute(
                "UPDATE jobs SET status = ?, attempts = attempts + 1, "
                "lease_owner = NULL, lease_expires_at = NULL, "
                "last_error_code = NULL, updated_at = ? "
                "WHERE id = ? AND status = ? AND lease_owner = ?",
                (STATUS_DELIVERED, timestamp, str(job_id), STATUS_LEASED,
                 str(worker_id)),
            )
            return cursor.rowcount == 1

    def fail(
        self,
        job_id: str,
        worker_id: str,
        retryable: bool,
        now: int | float,
        error_code: str,
        *,
        status_code: int | None = None,
    ) -> Job | None:
        """Record one failed attempt.  Only the lease owner may do so.

        Increments ``attempts`` exactly once, then either schedules a retry
        at ``now + min(2 ** attempts, 300)`` or makes the job terminal (on a
        non-retryable classification or once five attempts have been made).
        Returns the updated job, or ``None`` when the lease did not match.
        """
        timestamp = int(now)
        code = _safe_error_code(error_code)
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT attempts FROM jobs WHERE id = ? AND status = ? "
                "AND lease_owner = ?",
                (str(job_id), STATUS_LEASED, str(worker_id)),
            ).fetchone()
            if row is None:
                return None
            attempts = int(row[0]) + 1
            if retryable and attempts < MAX_ATTEMPTS:
                conn.execute(
                    "UPDATE jobs SET status = ?, attempts = ?, next_attempt_at = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL, "
                    "last_error_code = ?, last_status_code = ?, updated_at = ? "
                    "WHERE id = ?",
                    (
                        STATUS_PENDING, attempts,
                        timestamp + retry_delay_seconds(attempts), code,
                        status_code, timestamp, str(job_id),
                    ),
                )
            else:
                conn.execute(
                    "UPDATE jobs SET status = ?, attempts = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL, "
                    "last_error_code = ?, last_status_code = ?, updated_at = ? "
                    "WHERE id = ?",
                    (
                        STATUS_FAILED, attempts, code, status_code, timestamp,
                        str(job_id),
                    ),
                )
            job_row = conn.execute(
                f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (str(job_id),)
            ).fetchone()
        return Job.from_row(job_row) if job_row is not None else None


_ALLOWED_ERROR_CODE = set("abcdefghijklmnopqrstuvwxyz0123456789_")


def _safe_error_code(error_code: str) -> str:
    """Keep stored error codes to a small, non-sensitive alphabet."""
    text = str(error_code)[:40].lower()
    cleaned = "".join(ch if ch in _ALLOWED_ERROR_CODE else "_" for ch in text)
    return cleaned or "unknown"
