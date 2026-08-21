"""SQLite persistence, idempotency and worker leasing for RelayVault.

Design rules enforced here
--------------------------
* One :class:`Store` instance owns exactly one SQLite connection, so tests (and
  real workers) obtain independent connections simply by building more stores
  against the same file.
* ``PRAGMA foreign_keys=ON`` plus explicit ``BEGIN IMMEDIATE`` transactions.
  ``IMMEDIATE`` serialises writers, which is what makes "claim up to N jobs"
  and "check-then-insert idempotency" atomic across connections.
* Every untrusted value is bound as a parameter.  No SQL text is ever built
  from tenant input; the only interpolated tokens are module constants.
* Persisted times are injected wall-clock seconds.  Monotonic values are used
  for durations only and are never written to a column.
* Callback response bodies are never stored -- only a status code and a byte
  count.  Secrets, signatures and nonces never reach this layer at all.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from typing import Any, Iterable, Iterator

__all__ = [
    "Store",
    "SqliteNonceStore",
    "Job",
    "FailOutcome",
    "IdempotencyConflict",
    "EventIdConflict",
    "STATUS_PENDING",
    "STATUS_LEASED",
    "STATUS_RETRYING",
    "STATUS_DELIVERED",
    "STATUS_FAILED",
    "TERMINAL_STATUSES",
    "MAX_ATTEMPTS",
    "MAX_RETRY_DELAY_SECONDS",
    "MAX_RETAINED_RESPONSE_BYTES",
    "retry_delay_seconds",
]

STATUS_PENDING = "pending"
STATUS_LEASED = "leased"
STATUS_RETRYING = "retrying"
STATUS_DELIVERED = "delivered"
STATUS_FAILED = "failed"

CLAIMABLE_STATUSES = (STATUS_PENDING, STATUS_RETRYING, STATUS_LEASED)
TERMINAL_STATUSES = (STATUS_DELIVERED, STATUS_FAILED)

MAX_ATTEMPTS = 5
MAX_RETRY_DELAY_SECONDS = 300
#: Upper bound on how much of a callback response may be read into memory.  The
#: bytes themselves are discarded; only this count is persisted.
MAX_RETAINED_RESPONSE_BYTES = 8192

_ALLOWED_TX_MODES = frozenset({"IMMEDIATE", "DEFERRED", "EXCLUSIVE"})

# A literal string built from module constants only -- never from user input.
_CLAIMABLE_SQL = "(" + ",".join("'" + s + "'" for s in CLAIMABLE_STATUSES) + ")"

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS tenants (
        tenant_id  TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS jobs (
        job_id           TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        event_id         TEXT NOT NULL,
        event_type       TEXT NOT NULL,
        callback_url     TEXT NOT NULL,
        payload_json     TEXT NOT NULL,
        payload_bytes    INTEGER NOT NULL,
        status           TEXT NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL,
        next_attempt_at  INTEGER NOT NULL,
        lease_owner      TEXT,
        lease_expires_at INTEGER,
        last_error_code  TEXT,
        last_status_code INTEGER,
        response_bytes   INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE (tenant_id, event_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, next_attempt_at)",
    """
    CREATE TABLE IF NOT EXISTS idempotency (
        tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        endpoint       TEXT NOT NULL,
        idem_key       TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        job_id         TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
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
    "CREATE INDEX IF NOT EXISTS nonces_expiry_idx ON nonces (expires_at)",
    """
    CREATE TABLE IF NOT EXISTS attempt_log (
        attempt_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        attempt        INTEGER NOT NULL,
        outcome        TEXT NOT NULL,
        error_code     TEXT,
        status_code    INTEGER,
        response_bytes INTEGER,
        duration_ms    INTEGER,
        created_at     INTEGER NOT NULL
    )
    """,
)


class IdempotencyConflict(Exception):
    """Same tenant + endpoint + idempotency key, different request body."""


class EventIdConflict(Exception):
    """``event_id`` already exists for this tenant under a different key."""


@dataclass(frozen=True)
class Job:
    job_id: str
    tenant_id: str
    event_id: str
    event_type: str
    callback_url: str
    payload_json: str
    payload_bytes: int
    status: str
    attempts: int
    max_attempts: int
    next_attempt_at: int
    lease_owner: str | None
    lease_expires_at: int | None
    last_error_code: str | None
    last_status_code: int | None
    response_bytes: int | None
    created_at: int
    updated_at: int

    def public_dict(self) -> dict[str, Any]:
        """Client-visible projection: no payload, no lease internals."""

        return {
            "job_id": self.job_id,
            "event_id": self.event_id,
            "type": self.event_type,
            "callback_url": self.callback_url,
            "status": self.status,
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "next_attempt_at": self.next_attempt_at,
            "last_error_code": self.last_error_code,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FailOutcome:
    job_id: str
    status: str
    attempts: int
    next_attempt_at: int
    retry_delay: int
    terminal: bool
    error_code: str


def retry_delay_seconds(attempts: int) -> int:
    """Deterministic backoff: ``min(2 ** attempt, 300)`` seconds.

    ``attempts`` is the post-increment attempt counter of the job, so the delay
    after the first failed attempt is 2s, then 4s, 8s, 16s, capped at 300s.
    """

    exponent = max(0, int(attempts))
    if exponent > 40:  # avoid pointless big-int shifts
        return MAX_RETRY_DELAY_SECONDS
    return min(2 ** exponent, MAX_RETRY_DELAY_SECONDS)


_JOB_COLUMNS = (
    "job_id, tenant_id, event_id, event_type, callback_url, payload_json, payload_bytes, "
    "status, attempts, max_attempts, next_attempt_at, lease_owner, lease_expires_at, "
    "last_error_code, last_status_code, response_bytes, created_at, updated_at"
)


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        job_id=row["job_id"],
        tenant_id=row["tenant_id"],
        event_id=row["event_id"],
        event_type=row["event_type"],
        callback_url=row["callback_url"],
        payload_json=row["payload_json"],
        payload_bytes=row["payload_bytes"],
        status=row["status"],
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
        next_attempt_at=row["next_attempt_at"],
        lease_owner=row["lease_owner"],
        lease_expires_at=row["lease_expires_at"],
        last_error_code=row["last_error_code"],
        last_status_code=row["last_status_code"],
        response_bytes=row["response_bytes"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class Store:
    """One SQLite connection with all RelayVault persistence operations."""

    def __init__(self, db_path: str, *, busy_timeout_ms: int = 10_000) -> None:
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            self.db_path,
            timeout=busy_timeout_ms / 1000.0,
            isolation_level=None,  # explicit transaction control
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=%d" % int(busy_timeout_ms))
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:  # pragma: no cover - e.g. exotic filesystems
            pass
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self.migrate()

    # -- lifecycle ------------------------------------------------------- #

    def migrate(self) -> None:
        with self._tx() as conn:
            for statement in SCHEMA:
                conn.execute(statement)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @contextmanager
    def _tx(self, mode: str = "IMMEDIATE") -> Iterator[sqlite3.Connection]:
        if mode not in _ALLOWED_TX_MODES:  # defensive: never accept outside input
            raise ValueError("unsupported transaction mode")
        with self._lock:
            self._conn.execute("BEGIN " + mode)
            try:
                yield self._conn
            except BaseException:
                try:
                    self._conn.execute("ROLLBACK")
                except sqlite3.Error:  # pragma: no cover - already rolled back
                    pass
                raise
            else:
                self._conn.execute("COMMIT")

    # -- tenants --------------------------------------------------------- #

    def ensure_tenants(self, tenant_ids: Iterable[str], now: int = 0) -> None:
        rows = [(str(t), int(now)) for t in tenant_ids]
        if not rows:
            return
        with self._tx() as conn:
            conn.executemany(
                "INSERT OR IGNORE INTO tenants (tenant_id, created_at) VALUES (?, ?)",
                rows,
            )

    def tenant_exists(self, tenant_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM tenants WHERE tenant_id = ?", (str(tenant_id),)
            ).fetchone()
        return row is not None

    # -- job creation / idempotency -------------------------------------- #

    def create_job_idempotent(
        self,
        *,
        tenant_id: str,
        endpoint: str,
        idem_key: str,
        request_sha256: str,
        job_id: str,
        event_id: str,
        event_type: str,
        callback_url: str,
        payload_json: str,
        now: int,
        max_attempts: int = MAX_ATTEMPTS,
    ) -> tuple[Job, bool]:
        """Atomically create a job or return the one this key already made.

        Returns ``(job, created)``.  Raises :class:`IdempotencyConflict` when
        the key was used with a different body and :class:`EventIdConflict`
        when the tenant already has that ``event_id`` under a different key.
        """

        now = int(now)
        with self._tx() as conn:
            existing = conn.execute(
                "SELECT request_sha256, job_id FROM idempotency "
                "WHERE tenant_id = ? AND endpoint = ? AND idem_key = ?",
                (str(tenant_id), str(endpoint), str(idem_key)),
            ).fetchone()
            if existing is not None:
                if existing["request_sha256"] != str(request_sha256):
                    raise IdempotencyConflict("idempotency key reused with a different body")
                row = conn.execute(
                    "SELECT " + _JOB_COLUMNS + " FROM jobs WHERE job_id = ? AND tenant_id = ?",
                    (existing["job_id"], str(tenant_id)),
                ).fetchone()
                if row is None:  # pragma: no cover - FK makes this unreachable
                    raise IdempotencyConflict("idempotency record without a job")
                return _row_to_job(row), False

            clash = conn.execute(
                "SELECT job_id FROM jobs WHERE tenant_id = ? AND event_id = ?",
                (str(tenant_id), str(event_id)),
            ).fetchone()
            if clash is not None:
                raise EventIdConflict("event_id already exists for this tenant")

            payload_json = str(payload_json)
            conn.execute(
                "INSERT INTO jobs (job_id, tenant_id, event_id, event_type, callback_url, "
                "payload_json, payload_bytes, status, attempts, max_attempts, next_attempt_at, "
                "lease_owner, lease_expires_at, last_error_code, last_status_code, "
                "response_bytes, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)",
                (
                    str(job_id),
                    str(tenant_id),
                    str(event_id),
                    str(event_type),
                    str(callback_url),
                    payload_json,
                    len(payload_json.encode("utf-8")),
                    STATUS_PENDING,
                    int(max_attempts),
                    now,
                    now,
                    now,
                ),
            )
            conn.execute(
                "INSERT INTO idempotency (tenant_id, endpoint, idem_key, request_sha256, job_id, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(tenant_id),
                    str(endpoint),
                    str(idem_key),
                    str(request_sha256),
                    str(job_id),
                    now,
                ),
            )
            row = conn.execute(
                "SELECT " + _JOB_COLUMNS + " FROM jobs WHERE job_id = ?", (str(job_id),)
            ).fetchone()
            return _row_to_job(row), True

    # -- reads ----------------------------------------------------------- #

    def get_job(self, tenant_id: str, job_id: str) -> Job | None:
        """Tenant-scoped lookup.  Both arguments are bound parameters."""

        with self._lock:
            row = self._conn.execute(
                "SELECT " + _JOB_COLUMNS + " FROM jobs WHERE job_id = ? AND tenant_id = ?",
                (str(job_id), str(tenant_id)),
            ).fetchone()
        return _row_to_job(row) if row is not None else None

    def get_job_unscoped(self, job_id: str) -> Job | None:
        """Operator/worker lookup that ignores tenancy.  Never used by the API."""

        with self._lock:
            row = self._conn.execute(
                "SELECT " + _JOB_COLUMNS + " FROM jobs WHERE job_id = ?", (str(job_id),)
            ).fetchone()
        return _row_to_job(row) if row is not None else None

    def count_attempt_log(self, job_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM attempt_log WHERE job_id = ?", (str(job_id),)
            ).fetchone()
        return int(row["n"])

    def attempt_log_rows(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT attempt, outcome, error_code, status_code, response_bytes, duration_ms, "
                "created_at FROM attempt_log WHERE job_id = ? ORDER BY attempt_row_id",
                (str(job_id),),
            ).fetchall()
        return [dict(r) for r in rows]

    # -- leasing --------------------------------------------------------- #

    def claim_due(
        self, worker_id: str, limit: int, lease_seconds: int, now: int
    ) -> list[Job]:
        """Atomically lease up to ``limit`` due jobs for ``worker_id``.

        A job is due when it is non-terminal, ``next_attempt_at <= now`` and it
        holds no live lease.  ``attempts`` is incremented here: one claim is one
        delivery attempt, so a crashed worker cannot retry for free.
        """

        worker_id = str(worker_id)
        limit = int(limit)
        lease_seconds = int(lease_seconds)
        now = int(now)
        if limit <= 0 or lease_seconds <= 0:
            return []
        lease_expiry = now + lease_seconds

        with self._tx() as conn:
            rows = conn.execute(
                "SELECT job_id FROM jobs WHERE status IN " + _CLAIMABLE_SQL + " "
                "AND next_attempt_at <= ? "
                "AND (lease_expires_at IS NULL OR lease_expires_at <= ?) "
                "ORDER BY next_attempt_at ASC, job_id ASC LIMIT ?",
                (now, now, limit),
            ).fetchall()
            claimed_ids: list[str] = []
            for row in rows:
                cur = conn.execute(
                    "UPDATE jobs SET status = ?, lease_owner = ?, lease_expires_at = ?, "
                    "attempts = attempts + 1, updated_at = ? "
                    "WHERE job_id = ? AND status IN " + _CLAIMABLE_SQL + " "
                    "AND next_attempt_at <= ? "
                    "AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
                    (STATUS_LEASED, worker_id, lease_expiry, now, row["job_id"], now, now),
                )
                if cur.rowcount == 1:
                    claimed_ids.append(row["job_id"])
            claimed: list[Job] = []
            for job_id in claimed_ids:
                fetched = conn.execute(
                    "SELECT " + _JOB_COLUMNS + " FROM jobs WHERE job_id = ?", (job_id,)
                ).fetchone()
                if fetched is not None:
                    claimed.append(_row_to_job(fetched))
            return claimed

    def complete(
        self,
        job_id: str,
        worker_id: str,
        now: int,
        *,
        status_code: int | None = None,
        response_bytes: int | None = None,
        duration_ms: int | None = None,
    ) -> bool:
        """Mark a leased job delivered.  Only the lease owner may succeed."""

        now = int(now)
        with self._tx() as conn:
            row = conn.execute(
                "SELECT attempts FROM jobs WHERE job_id = ? AND lease_owner = ? AND status = ?",
                (str(job_id), str(worker_id), STATUS_LEASED),
            ).fetchone()
            if row is None:
                return False
            conn.execute(
                "UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, "
                "last_error_code = NULL, last_status_code = ?, response_bytes = ?, updated_at = ? "
                "WHERE job_id = ? AND lease_owner = ? AND status = ?",
                (
                    STATUS_DELIVERED,
                    None if status_code is None else int(status_code),
                    None if response_bytes is None else min(int(response_bytes), MAX_RETAINED_RESPONSE_BYTES),
                    now,
                    str(job_id),
                    str(worker_id),
                    STATUS_LEASED,
                ),
            )
            self._insert_attempt(
                conn,
                job_id=str(job_id),
                attempt=int(row["attempts"]),
                outcome="delivered",
                error_code=None,
                status_code=status_code,
                response_bytes=response_bytes,
                duration_ms=duration_ms,
                now=now,
            )
            return True

    def fail(
        self,
        job_id: str,
        worker_id: str,
        retryable: bool,
        now: int,
        error_code: str,
        *,
        status_code: int | None = None,
        response_bytes: int | None = None,
        duration_ms: int | None = None,
    ) -> FailOutcome | None:
        """Record a failed attempt.  Returns ``None`` for a non-owner.

        Retryable failures are rescheduled at ``now + min(2 ** attempts, 300)``
        until ``attempts >= max_attempts`` (5), after which the job is terminal.
        Non-retryable failures are terminal immediately.
        """

        now = int(now)
        error_code = str(error_code)[:64]
        with self._tx() as conn:
            row = conn.execute(
                "SELECT attempts, max_attempts FROM jobs "
                "WHERE job_id = ? AND lease_owner = ? AND status = ?",
                (str(job_id), str(worker_id), STATUS_LEASED),
            ).fetchone()
            if row is None:
                return None
            attempts = int(row["attempts"])
            max_attempts = int(row["max_attempts"])
            exhausted = attempts >= max_attempts
            terminal = (not retryable) or exhausted
            if terminal:
                status = STATUS_FAILED
                delay = 0
                next_attempt_at = now
            else:
                status = STATUS_RETRYING
                delay = retry_delay_seconds(attempts)
                next_attempt_at = now + delay
            conn.execute(
                "UPDATE jobs SET status = ?, next_attempt_at = ?, lease_owner = NULL, "
                "lease_expires_at = NULL, last_error_code = ?, last_status_code = ?, "
                "response_bytes = ?, updated_at = ? "
                "WHERE job_id = ? AND lease_owner = ? AND status = ?",
                (
                    status,
                    next_attempt_at,
                    error_code,
                    None if status_code is None else int(status_code),
                    None if response_bytes is None else min(int(response_bytes), MAX_RETAINED_RESPONSE_BYTES),
                    now,
                    str(job_id),
                    str(worker_id),
                    STATUS_LEASED,
                ),
            )
            self._insert_attempt(
                conn,
                job_id=str(job_id),
                attempt=attempts,
                outcome="terminal" if terminal else "retry",
                error_code=error_code,
                status_code=status_code,
                response_bytes=response_bytes,
                duration_ms=duration_ms,
                now=now,
            )
            return FailOutcome(
                job_id=str(job_id),
                status=status,
                attempts=attempts,
                next_attempt_at=next_attempt_at,
                retry_delay=delay,
                terminal=terminal,
                error_code=error_code,
            )

    def _insert_attempt(
        self,
        conn: sqlite3.Connection,
        *,
        job_id: str,
        attempt: int,
        outcome: str,
        error_code: str | None,
        status_code: int | None,
        response_bytes: int | None,
        duration_ms: int | None,
        now: int,
    ) -> None:
        conn.execute(
            "INSERT INTO attempt_log (job_id, attempt, outcome, error_code, status_code, "
            "response_bytes, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                job_id,
                int(attempt),
                str(outcome),
                None if error_code is None else str(error_code)[:64],
                None if status_code is None else int(status_code),
                None
                if response_bytes is None
                else min(int(response_bytes), MAX_RETAINED_RESPONSE_BYTES),
                None if duration_ms is None else int(duration_ms),
                int(now),
            ),
        )

    # -- maintenance ----------------------------------------------------- #

    def purge_expired_nonces(self, now: int) -> int:
        with self._tx() as conn:
            cur = conn.execute("DELETE FROM nonces WHERE expires_at <= ?", (int(now),))
            return int(cur.rowcount or 0)

    def count_nonces(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM nonces").fetchone()
        return int(row["n"])


class SqliteNonceStore:
    """Atomic single-use nonce acceptance scoped by ``(tenant_id, key_id)``.

    Acceptance is a primary-key ``INSERT`` inside ``BEGIN IMMEDIATE``, so under
    concurrency exactly one caller can claim a given nonce; everybody else sees
    the integrity violation and is rejected.  Rows whose TTL has passed are
    deleted first, which is what allows reuse only after the window.
    """

    def __init__(self, store: Store) -> None:
        self._store = store

    def consume(
        self, tenant_id: str, key_id: str, nonce: str, now: int, ttl: int = 600
    ) -> bool:
        now = int(now)
        expires_at = now + int(ttl)
        try:
            with self._store._tx() as conn:  # same connection, explicit IMMEDIATE tx
                conn.execute(
                    "DELETE FROM nonces WHERE tenant_id = ? AND key_id = ? AND nonce = ? "
                    "AND expires_at <= ?",
                    (str(tenant_id), str(key_id), str(nonce), now),
                )
                conn.execute(
                    "INSERT INTO nonces (tenant_id, key_id, nonce, expires_at) VALUES (?, ?, ?, ?)",
                    (str(tenant_id), str(key_id), str(nonce), expires_at),
                )
        except sqlite3.IntegrityError:
            return False
        return True
