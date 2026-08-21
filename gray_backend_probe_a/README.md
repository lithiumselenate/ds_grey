# RelayVault

A deterministic, security-conscious multi-tenant webhook intake and delivery
queue. Python 3.11+, **standard library only**, no network access at test time.

```
gray_backend_probe_a/
├── README.md          this document
├── app.py             Application.handle(...) + ThreadingHTTPServer adapter
├── security.py        authentication, canonical signing, replay defence, URL validation, redaction
├── store.py           SQLite schema, idempotency, worker leases
├── worker.py          delivery attempts, re-validation, retry classification
├── test_security.py   auth / nonce / SSRF / redaction tests
├── test_store.py      persistence, idempotency and lease tests
└── test_api.py        end-to-end API, HTTP adapter and worker tests
```

## Architecture

The application layer is transport independent:

```python
Application.handle(method, raw_target, headers, body) -> Response
```

`Response` is an immutable `(status, headers, body)` value object. `app.py` also
contains a minimal HTTP/1.1 adapter (`RelayVaultHTTPRequestHandler` /
`RelayVaultHTTPServer`) whose only responsibilities are to enforce the body-size
limit **before** the body is read, pass the raw request target through
untouched, and serialise the response.

Every non-deterministic dependency is injected, so tests never touch the clock,
the network or randomness:

| dependency | injection point | test double |
|---|---|---|
| wall clock (persisted times) | `clock()` -> int seconds | `FakeClock` |
| monotonic clock (durations only) | `monotonic()` -> float | `FakeMonotonic` |
| job id generation | `id_factory()` -> str | counter |
| hostname resolution | `resolver(hostname)` -> `[str, ...]` | `FakeResolver` |
| outbound transport | `transport(DeliveryRequest)` -> `DeliveryResponse` | `FakeTransport` |
| structured logging | `log(event, **fields)` | recording `JsonLogger` |
| tenant/key secrets | `security.Config` | in-test constants |

Secrets are never hard-coded. `load_config_from_env()` reads
`RELAYVAULT_SECRETS_FILE` (a JSON path) or `RELAYVAULT_SECRETS` (inline JSON) of
the shape `{"tenant_id": {"key_id": "<secret>"}}`; a missing configuration is a
startup error, and secrets shorter than 16 bytes are rejected.

## Request authentication

Required headers: `X-Tenant-ID`, `X-Key-ID`, `X-Timestamp`, `X-Nonce`,
`X-Signature`.

The signature is lowercase hex HMAC-SHA256 over exactly:

```text
tenant_id + "\n" + key_id + "\n" + timestamp + "\n" + nonce + "\n"
+ METHOD_UPPERCASE + "\n" + raw_target + "\n" + sha256(raw_body).hexdigest()
```

Invariants:

* **Constant-time comparison.** `hmac.compare_digest`, and only after the
  encoding has been validated as exactly 64 lowercase hex characters; malformed
  encodings are refused before any comparison.
* **Clock window.** `timestamp` must be integer Unix seconds (no `+`, no
  leading zeros, no floats) within ±300 s inclusive of the injected clock.
* **Single-use nonces**, scoped by `(tenant_id, key_id)`, valid for 600 s.
  Acceptance is a primary-key `INSERT` inside `BEGIN IMMEDIATE`, so exactly one
  concurrent caller can win, even across separate SQLite connections.
* **Order of checks:** header shape -> value formats -> clock window ->
  signature -> nonce. An invalid signature therefore *cannot* consume a nonce.
* **Ambiguity is fatal.** Any of the five security headers that is missing,
  repeated, empty, comma-folded or control-character bearing fails the request.
* **Raw target signing.** The signature always covers the wire target,
  including its original query string. Routing percent-decodes a *copy*; any
  encoding that could change routing (`%2F`, `%00`, `%25`, `//`, `.`/`..`
  segments) is rejected outright rather than normalised.
* **Uniform failures.** Every authentication problem returns
  `401 {"ok":false,"error":{"code":"unauthenticated","message":"authentication failed"}}`.
  Unknown tenant/key pairs still perform one HMAC against a random per-process
  dummy secret, so the unknown-principal path costs the same and leaks nothing
  about tenant existence.

## `POST /v1/events`

Requires `Content-Type: application/json` (optionally `charset=utf-8`),
`Idempotency-Key` matching `[A-Za-z0-9_-]{8,80}`, and a body of at most
**65 536 bytes**. Rejected: other content types, any non-`identity`
`Content-Encoding`, `Transfer-Encoding`, invalid UTF-8, duplicate JSON object
keys at any nesting depth, `NaN`/`Infinity`/`-Infinity` (including overflowing
literals such as `1e999`), integer literals over 40 digits, unknown top-level
fields, non-object bodies and non-object `payload` values.

```json
{"event_id":"evt_123","type":"build.completed",
 "callback_url":"https://hooks.example.test/delivery","payload":{}}
```

* `event_id`: 1–64 of `[A-Za-z0-9_-]`
* `type`: 1–80 of `[a-z0-9._-]`
* `callback_url`: see below (validated at creation *and* at every attempt)
* `payload`: JSON object

Idempotency is scoped to `(tenant_id, endpoint, idempotency_key)` and keyed on
the SHA-256 of the **raw request bytes**:

| situation | result |
|---|---|
| first valid request | `202` + job, `duplicate: false` |
| same key, byte-identical body | `200` + original job, `duplicate: true` |
| same key, any other body (even semantically equal) | `409 idempotency_conflict` |
| same key, different tenant | independent job (`202`) |
| new key, `event_id` already used by this tenant | `409 event_id_conflict` |

Repeat requests need a fresh timestamp, nonce and signature; nonce replay
protection applies independently of idempotency.

**Documented `event_id` decision.** `event_id` is unique per tenant
(`UNIQUE(tenant_id, event_id)`). When a *different* idempotency key submits an
existing `event_id`, the request deterministically fails with
`409 event_id_conflict`: no second job is created, the original job is not
modified, and no idempotency record is written. The check and both inserts run
inside one `BEGIN IMMEDIATE` transaction, so under concurrency exactly one
writer creates the job and every other writer sees the conflict.

## `GET /v1/jobs/{job_id}`

Same authentication scheme with an empty body (a body is a `400`). The lookup is
tenant-scoped, so a job owned by another tenant and a job that does not exist
produce a byte-identical `404 not_found`. `job_id` is treated as hostile input:
it is only ever a bound SQL parameter, never string-interpolated, and no SQL
identifier or predicate is ever built from request data. The response contains
job metadata only — never the payload.

## Callback URL security

HTTPS only; ports 443 and 8443 only. Rejected: user info, fragments, empty or
malformed hostnames, non-ASCII/control characters, hosts longer than 253 bytes
or with malformed labels, and URLs longer than 2048 bytes.

Hostnames are resolved through the injected resolver. **If any returned address
is non-global the whole URL is rejected** — a partially poisoned answer set is
never filtered down to its "good" entries. An address is refused when it is
loopback, private, link-local, multicast, reserved, unspecified, site-local,
CGNAT, broadcast, or not `is_global`. IPv4, IPv6, textual literals (never
resolved) and multi-answer hostnames are all handled; IPv4-mapped, 6to4 and
Teredo IPv6 addresses are unwrapped so that `::ffff:127.0.0.1` is judged as
loopback, and such wrapped forms are refused outright as an evasion signal.

`validate_callback_url` returns a `CallbackTarget` that pins one verified IP.
Validation at creation time is **not** trusted for delivery: the worker
re-resolves and re-validates immediately before every attempt (DNS-rebinding
defence) and hands the transport the validated `ip` *separately* from
`hostname`/`host_header`, so a conforming transport never resolves anything
while TLS/SNI and the `Host` header still carry the original hostname.
Redirects are never followed. Rejection reasons never contain a resolved
address, in responses or in logs.

## Store, leases and retries

SQLite with `PRAGMA foreign_keys=ON`, WAL, `busy_timeout`, and explicit
`BEGIN IMMEDIATE` transactions. One `Store` instance owns one connection;
concurrency tests simply build more stores against the same file. Tables:
`tenants`, `jobs` (FK to `tenants`), `idempotency` (FK to `tenants` and `jobs`),
`nonces`, `attempt_log` (FK to `jobs`).

```python
claim_due(worker_id, limit, lease_seconds, now) -> list[Job]
complete(job_id, worker_id, now, *, status_code, response_bytes, duration_ms) -> bool
fail(job_id, worker_id, retryable, now, error_code, ...) -> FailOutcome | None
```

* A job is claimable when its status is `pending`/`retrying`/`leased`,
  `next_attempt_at <= now`, and it holds no live lease. Claiming up to `limit`
  jobs is one atomic transaction, so two workers on separate connections can
  never hold the same active lease.
* Expired leases are reclaimable; terminal jobs (`delivered`, `failed`) never
  are.
* `complete`/`fail` require both the current status `leased` *and* a matching
  `lease_owner`; another worker's settle attempt returns `False`/`None` and
  changes nothing.
* **`attempts` is incremented exactly once per delivery attempt, at claim
  time.** A crashed worker therefore consumes its attempt instead of retrying
  for free, and `complete`/`fail` never touch the counter.
* Retry delay is `min(2 ** attempts, 300)` seconds using the post-increment
  counter: 2, 4, 8, 16 s, capped at 300 s. After 5 attempts the job is
  terminal (`failed`).

### Delivery outcome classification

| error code | retryable | trigger |
|---|---|---|
| `ok` | — | HTTP 200–299 (delivered) |
| `http_retryable` | yes | HTTP 408, 429, 500–599 |
| `http_terminal` | no | any other status |
| `redirect_not_followed` | no | HTTP 3xx (redirects are never followed) |
| `callback_url_rejected` | no | URL/resolver validation failed at delivery time |
| `timeout` | yes | transport connect/read timeout |
| `transport_error` | yes | connection reset, TLS failure, other transport error |
| `response_too_large` | no | response exceeded the 8192-byte cap |
| `internal_error` | yes | unexpected worker-side exception |

Persisted timestamps always come from the injected wall clock; the injected
monotonic clock is used only for `duration_ms` and is never written to a
timestamp column.

## Data retention, responses and logging

Responses are compact JSON (`application/json`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`) with a stable shape: `{"ok":true,"data":{…}}`
or `{"ok":false,"error":{"code":…,"message":…}}`. Errors never carry stack
traces, SQL text, secrets, resolved addresses or tenant-existence hints; an
unexpected exception becomes `500 internal_error` and is logged as a type name
only.

Stored: job metadata, the serialized payload (required to deliver it), status
codes, response **byte counts**, error codes. Never stored anywhere: secrets,
signatures, nonces beyond their replay window, and callback response bodies.
At most 8192 bytes of a callback response are read into memory, and they are
discarded after the byte count is taken.

Logging goes through an injectable `log(event, **fields)` callable.
`JsonLogger` emits one compact JSON line per event; `redact_fields` /
`redact_value` drop sensitive keys (`secret`, `signature`, `payload`, `body`,
`nonce`, `token`, `authorization`, …), mask 32+ character hex runs, summarise
bytes, truncate long strings and bound recursion, while keeping metric-style
keys such as `payload_bytes` and `key_id`.

## Running

```bash
cd gray_backend_probe_a
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v      # 128 tests
RELAYVAULT_SECRETS='{"tenant_a":{"key_1":"<32+ byte secret>"}}' \
  python3 app.py 127.0.0.1 8080 relayvault.sqlite3    # optional manual run
```

The test suite makes no network connections: the HTTP adapter is exercised with
in-memory buffers, and DNS/transport are fakes. `SocketTransport` and
`SystemResolver` exist for production use and are never invoked by tests.

## Decisions, interpretations and known limits

* **"Serialized payload" vs "never store complete payloads."** Jobs are
  required to carry a serialized payload in order to deliver it, so the payload
  lives in the `jobs` row and nowhere else. The prohibition is applied to logs,
  API responses and the attempt log, which never contain payload content.
* **Header whitespace.** Per RFC 9110 optional whitespace around a field value
  is not part of the value, so header values are stripped before verification.
  A leading space on a signature is therefore not a signature mutation; an
  *internal* space is, and is rejected as a malformed encoding.
* **Nonce window is half-open.** A nonce is unusable for the full 600 s TTL and
  becomes usable again once the TTL has elapsed (`t + 600`).
* **IPv4-mapped IPv6 is always refused**, even when the embedded address is
  global, because there is no legitimate reason for a callback URL to use that
  form and it is a classic filter-evasion trick.
* **`%25` in a path is refused**, which blocks double-encoding attacks at the
  cost of forbidding literal `%` in a job id.
* **Mixed DNS answers reject the URL** rather than selecting a safe address, so
  a DNS-poisoning attempt fails closed and is visible.
* Python's `ipaddress` classifies RFC 5737 documentation ranges (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`) as private, so tests use genuinely
  global literals such as `93.184.216.34` as their "safe" fixtures.
* **Limitations.** No delivery signing of outbound webhooks, no rate limiting or
  quota enforcement, no nonce/attempt-log garbage collector process (a
  `purge_expired_nonces(now)` helper exists but must be scheduled), single-node
  SQLite (leases assume a shared filesystem), no chunked request bodies, no
  HTTP keep-alive tuning, and `SocketTransport`/`SystemResolver` are
  intentionally untested because exercising them would require real sockets.
