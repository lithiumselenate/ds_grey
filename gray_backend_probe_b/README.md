# RelayVault

Deterministic, security-conscious multi-tenant **webhook intake and delivery
queue**. Python 3.11+ standard library only — no third-party packages, no
network access at test time, no containers.

```
gray_backend_probe_b/
├── README.md          this document
├── app.py             transport-independent Application + ThreadingHTTPServer adapter
├── security.py        request authentication, callback-URL policy, redaction
├── store.py           SQLite persistence, idempotency, worker leases, nonces
├── worker.py          delivery attempts, re-validation, retry classification
├── test_security.py   authentication / URL / redaction tests
├── test_store.py      persistence, idempotency, leasing tests
└── test_api.py        end-to-end API + delivery tests (fake resolver/transport)
```

## Architecture

```
HTTP bytes ── RelayVaultHandler (app.py) ── Application.handle(method, raw_target,
                    │                              headers, body) -> Response
                    │                                   │
      size guard before body read              RequestVerifier (security.py)
                                                        │
                                          Store (store.py, SQLite + leases)
                                                        │
                                  DeliveryWorker (worker.py) ── injected transport
                                                        │
                                       validate_callback_url (security.py)
```

Everything non-deterministic is injected: wall clock, monotonic clock, job-ID
factory, hostname resolver, outbound transport, secret table and the structured
log sink. The tests therefore never sleep, never resolve a name and never open
a socket.

Run the service (secrets arrive from the environment; nothing is hard-coded):

```bash
RELAYVAULT_DB=/var/lib/relayvault.sqlite3 \
RELAYVAULT_SECRETS='[{"tenant_id":"acme","key_id":"key_1","secret":"..."}]' \
python3 app.py
```

## Request authentication

Every API request carries exactly one of each header:

| header | meaning |
| --- | --- |
| `X-Tenant-ID` | tenant identifier, `[A-Za-z0-9_.-]{1,64}` |
| `X-Key-ID` | key identifier, `[A-Za-z0-9_.-]{1,64}` |
| `X-Timestamp` | canonical integer Unix seconds |
| `X-Nonce` | `[A-Za-z0-9_-]{8,128}`, single use |
| `X-Signature` | lowercase hex HMAC-SHA256, 64 characters |

Signed byte sequence (no trailing newline):

```text
tenant_id + "\n" + key_id + "\n" + timestamp + "\n" + nonce + "\n"
+ METHOD_UPPERCASE + "\n" + raw_target + "\n" + sha256(raw_body).hexdigest()
```

Rules enforced by `RequestVerifier`:

* the **raw request target** is signed, query string included and undecoded;
* signature encodings are validated (`^[0-9a-f]{64}$`) **before** any
  comparison, and comparison uses `hmac.compare_digest`;
* unknown tenant/key still performs an HMAC against a decoy key so responses
  and work are indistinguishable from a wrong signature;
* timestamps must be within ±300 s of the injected clock (±300 inclusive);
* nonces are scoped by `(tenant_id, key_id)` and single-use for 600 s;
* nonce acceptance is a single `INSERT` under `BEGIN IMMEDIATE` against a
  primary key, so it is atomic across processes and connections;
* the nonce is claimed **after** signature verification, so an invalid
  signature never burns a nonce; a stale timestamp does not either;
* missing, repeated (even identical) or ambiguous (empty/non-ASCII/control)
  security headers are rejected;
* RFC 9110 optional whitespace around a field value is trimmed before
  verification, because it is not part of the field value.

Every authentication failure returns the same body:

```json
{"ok":false,"error":{"code":"unauthorized","message":"authentication failed"}}
```

The specific reason (`bad_signature`, `nonce_replayed`, `timestamp_out_of_window`,
…) only ever reaches the internal structured log. Unknown routes are
authenticated **before** routing, so route existence cannot be probed
anonymously.

## `POST /v1/events`

`Content-Type: application/json` (optionally `; charset=utf-8`), no
`Content-Encoding` other than `identity`, `Content-Length` required and at most
65 536 bytes. The adapter refuses an oversized `Content-Length` **before**
reading any body bytes (`plan_body_read`); `Application.handle` re-checks the
materialised body.

Body schema (all fields required, no unknown fields):

```json
{
  "event_id": "evt_123",
  "type": "build.completed",
  "callback_url": "https://hooks.example.test/delivery",
  "payload": {}
}
```

* `event_id` — `[A-Za-z0-9_-]{1,64}`
* `type` — `[a-z0-9._-]{1,80}`
* `callback_url` — see *Callback URL security*
* `payload` — JSON object

Rejected: invalid UTF-8, malformed JSON, non-object documents, duplicate object
keys at **any** nesting depth, `NaN`/`Infinity`/`-Infinity` (including overflow
literals such as `1e400`), unknown top-level fields, non-object `payload`.

`Idempotency-Key` is required and must match `[A-Za-z0-9_-]{8,80}`.

### Idempotency semantics

Scope is `(tenant_id, endpoint, idempotency_key)`:

| situation | result |
| --- | --- |
| new key | `202` + job, `duplicate: false` |
| same key, byte-identical body | `200` + original job, `duplicate: true` |
| same key, different body | `409 idempotency_key_reuse` |
| same key, different tenant | independent — `202` |

The check-and-insert pair runs inside one `BEGIN IMMEDIATE` transaction, so
concurrent requests over separate SQLite connections produce exactly one job.
A repeated idempotent request must still use a fresh timestamp, nonce and
signature: replay protection is independent of idempotency.

**Documented decision — `event_id` reuse.** `event_id` is unique per tenant
(`UNIQUE(tenant_id, event_id)`). When a *different* idempotency key submits an
`event_id` that already exists for that tenant, the request is rejected with
`409 event_id_conflict` and no second job is created. Rationale: silently
returning the first job would make a distinct idempotency key behave like a
duplicate of an unrelated request, and creating a second job would break
per-tenant event uniqueness. The only way to observe the original job for that
event is the original idempotency key (`200 duplicate: true`) or
`GET /v1/jobs/{job_id}`.

## `GET /v1/jobs/{job_id}`

Same signed scheme with an empty body. The job is returned only to its owning
tenant; a job owned by another tenant and a job that does not exist produce
byte-identical `404` responses (same status, headers and body).

Job IDs are always bound SQL parameters, never concatenated. Syntactically
impossible IDs (quotes, `%`, `_`, SQL fragments, NUL) can only ever be "not
found"; the `%`/`_` cases also prove no `LIKE` predicate is involved.
Percent-decoding that would introduce a path separator (`%2F`) is rejected as
an ambiguous target rather than silently changing the signed value.

## Callback URL security

`validate_callback_url(url, resolver)` enforces:

* `https` only; no userinfo; no fragment (not even an empty one);
* ports restricted to **443** or **8443**;
* printable ASCII URL, ≤ 2048 bytes, LDH hostname labels, no trailing dot;
* IP literals are used directly (never resolved); hostnames go through the
  **injected** resolver, and an empty answer is a rejection;
* every returned address is normalised (IPv4, IPv6, IPv4-mapped IPv6 →
  unmapped IPv4, 6to4/Teredo → embedded IPv4) and must be global: loopback,
  private, link-local, multicast, reserved, unspecified, scoped and otherwise
  non-global addresses are refused;
* if **any** address in a multi-answer response is unsafe, the whole URL is
  rejected (no "pick the safe one" behaviour);
* the first validated address is chosen deterministically.

### DNS-rebinding defence

Validation at enqueue time is not trusted. `DeliveryWorker.deliver` re-resolves
and re-validates immediately before **every** attempt. The transport receives
`ip` + `family` separately from `hostname`, so it cannot resolve the name
behind the validator, while `hostname` is preserved for TLS/SNI and the HTTP
`Host` header (`host:port` when the port is 8443). Redirects are never
followed. `HttpsTransport` connects straight to the validated IP; the test
suite uses fake resolvers and fake transports exclusively.

## Store, leases and retries

SQLite with `PRAGMA foreign_keys = ON`, WAL journalling, a busy timeout and
explicit `BEGIN IMMEDIATE` transactions. Tables: `jobs`, `idempotency`
(FK → `jobs.id`), `nonces`. Every SQL statement is a fixed literal; all
untrusted input is bound.

`jobs` holds tenant ID, event ID, event type, callback URL, serialized payload,
status (`pending`/`leased`/`delivered`/`failed`), attempt count, next-attempt
time, lease owner, lease expiry, last error code, last status code, created and
updated times.

```python
claim_due(worker_id, limit, lease_seconds, now) -> list[Job]
complete(job_id, worker_id, now) -> bool
fail(job_id, worker_id, retryable, now, error_code, *, status_code=None) -> Job | None
```

* a job is claimable when it is non-terminal, due, and holds no live lease;
* select-then-update happens in one transaction, so two workers on separate
  connections never share an active lease, and claiming up to `limit` jobs is
  atomic;
* a lease is reclaimable from its expiry instant onwards (`lease_expires_at <= now`);
* terminal jobs (`delivered`, `failed`) are never reclaimed;
* `complete`/`fail` only apply to a `leased` job whose `lease_owner` matches, so
  a worker cannot finish another worker's lease;
* the attempt count changes exactly once per delivery attempt — claiming and
  re-claiming never change it;
* retry delay is `min(2 ** attempts, 300)` seconds after the increment, i.e.
  2, 4, 8, 16 s; the **fifth** failed attempt is terminal;
* stored error codes are constrained to `[a-z0-9_]{1,40}`.

### Failure classification

| condition | classification | error code |
| --- | --- | --- |
| HTTP 200–299 | success | — |
| HTTP 408, 429, 500–599 | retryable | `http_retryable` |
| any other status (incl. 3xx redirects) | terminal | `http_terminal` |
| callback URL rejected by policy (incl. rebinding) | terminal | `callback_rejected` |
| resolver raised (transient DNS failure) | retryable | `resolver_error` |
| transport timeout | retryable | `timeout` |
| transport/TLS/I-O failure | retryable | `transport_error` |
| response exceeds 8192 bytes | terminal | `response_too_large` |
| unexpected internal error | retryable | `internal_error` |

Policy rejection is terminal because a job pointing at a non-global address is
a configuration/attack condition, not a transient one; a resolver *exception*
is retryable because it is transient. At most 8192 bytes of a callback response
are ever read, purely to classify it; the body is never persisted or logged —
only the status code, an error code and a byte count exist, and the byte count
stays in memory.

Persisted timestamps always come from the injected **wall clock**; attempt
durations come from the injected **monotonic** clock and are never persisted as
timestamps.

## Responses and logging

All responses are compact JSON with `Content-Type: application/json`,
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`:

```json
{"ok":true,"data":{"job_id":"job_1","event_id":"evt_123","type":"build.completed",
"status":"pending","attempts":0,"next_attempt_at":1700000000,
"created_at":1700000000,"updated_at":1700000000,"duplicate":false}}
{"ok":false,"error":{"code":"not_found","message":"resource not found"}}
```

Statuses used: `200`, `202`, `400`, `401`, `404`, `405`, `409`, `411`, `413`,
`415`, `500`, `501`. Error bodies carry only a stable code and a short static
message — never a stack trace, SQL text, secret, resolved address, payload
content or tenant-existence hint.

Logging goes through an injected `log(event_name, fields)` callable and every
field set passes through `security.redact`, which replaces sensitive keys
(`secret`, `signature`, `payload`, `body`, `token`, `authorization`, `cookie`,
`api_key`, …), scrubs known literal secrets from free text, truncates long
strings and summarises bytes as `<N bytes>`. Delivery logs record the callback
*hostname* only — never the resolved IP.

## Security invariants

1. Constant-time signature comparison after strict encoding validation.
2. Signature covers method, raw target (query string included) and body digest.
3. Timestamp window ±300 s; nonce single-use per tenant+key for 600 s, claimed
   atomically and only after the signature verifies.
4. Uniform generic `401` for every authentication failure.
5. Body-size limit enforced before the body is read, and again on the payload.
6. Hostile JSON (duplicate keys, non-finite numbers, unknown fields) rejected.
7. Idempotency and event-ID uniqueness are per tenant and transactionally atomic.
8. Cross-tenant job reads are byte-identical to "not found".
9. No SQL identifier or predicate is built from input; all values are bound.
10. HTTPS-only, port-restricted, global-address-only callbacks, re-validated
    before every attempt, with the IP passed to the transport separately.
11. Leases are single-owner; completion/failure requires ownership; attempts
    increment exactly once; five attempts is terminal.
12. Logs and error bodies contain no secrets, signatures, payloads, response
    bodies, SQL or resolved addresses.

## Tests

```bash
cd gray_backend_probe_b
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v
```

151 tests, all passing. Requirement coverage:

| requirement | where |
| --- | --- |
| valid authentication | `test_security.TestValidAuthentication` |
| body / raw-target mutation | `test_security.TestSignatureMutations`, `test_api.TestRawTargetHandling` |
| malformed signatures | `test_security.TestMalformedSignatures` |
| timestamp boundaries | `test_security.TestTimestampBoundaries` |
| invalid signature keeps nonce | `TestNonceLifecycle.test_invalid_signature_does_not_burn_nonce` |
| concurrent nonce reuse | `TestNonceLifecycle.test_concurrent_reuse_of_one_nonce_admits_exactly_one` |
| duplicate keys / non-finite numbers | `test_api.TestBodyValidation` |
| body-size enforcement | `TestBodyValidation.test_body_size_limit_enforced`, `TestAdapterEnvelopePlanning` |
| idempotency same / conflicting body | `test_api.TestIdempotency`, `test_store.TestIdempotency` |
| concurrent idempotency, separate connections | `TestIdempotency.test_concurrent_requests_over_separate_connections` (API and store) |
| cross-tenant 404 | `test_api.TestTenantIsolation`, `test_store.TestTenantScopedLookup` |
| hostile job IDs | `TestTenantIsolation.test_hostile_job_ids_*`, `TestTenantScopedLookup.test_hostile_job_ids_*` |
| private/loopback/link-local/IPv4-mapped | `test_security.TestCallbackUrlValidation`, `test_api.TestCallbackUrlAtCreation` |
| mixed safe/unsafe DNS answers | `test_mixed_answer_rejected_entirely`, `test_rebinding_to_mixed_answer_also_blocked` |
| DNS rebinding | `TestDelivery.test_dns_rebinding_between_enqueue_and_delivery` |
| redirects not followed | `TestDelivery.test_redirects_are_not_followed` |
| two workers racing one job | `test_store.TestLeasing.test_two_workers_racing_one_job`, `TestDelivery.test_two_workers_do_not_deliver_the_same_job_twice` |
| expired lease recovery | `TestLeasing.test_expired_lease_is_reclaimable` |
| wrong-worker completion | `test_store.TestCompletionOwnership` |
| retry/terminal boundaries | `test_store.TestRetryAndTerminalTransitions`, `TestDelivery.test_retry_until_terminal_after_five_attempts` |
| logs free of secrets/payloads | `test_api.TestLoggingHygiene`, `test_security.TestRedaction` |

The suite was additionally checked by mutation: weakening the nonce check,
moving the nonce claim before signature verification, accepting non-global
addresses, removing the skew check, accepting malformed hex, ignoring leases,
ignoring lease ownership, dropping the retry cap, skipping duplicate-key or
non-finite detection, removing the body limit, reading jobs untenanted,
ignoring the idempotency body hash and skipping delivery-time re-validation
each made the suite fail.

## Limitations

* Single-node SQLite: safe under concurrency via `BEGIN IMMEDIATE`, but write
  throughput is bounded by one writer at a time.
* `HttpsTransport` and `SystemResolver` are the only components with no test
  coverage, by design — exercising them would require real network I/O.
* There is no scheduler loop or HTTP-server smoke test in the suite: the worker
  is driven by explicit `run_once()` calls and the adapter's pre-read guards are
  tested directly (`plan_body_read`), because binding a socket is out of scope.
* Nonce and job rows are pruned lazily (expired nonces on each claim); no
  background compaction or job retention policy is implemented.
* The interpreter available here is CPython 3.13; the code targets 3.11+ syntax
  and standard-library APIs only.
