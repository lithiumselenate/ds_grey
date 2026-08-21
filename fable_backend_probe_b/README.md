# RelayVault

A deterministic, security-conscious multi-tenant webhook intake and delivery
queue built entirely on the Python 3.11 standard library.

## Layout

| File | Responsibility |
| --- | --- |
| `app.py` | Transport-independent `Application.handle(method, raw_target, headers, body) -> Response` plus a minimal `ThreadingHTTPServer` adapter (`make_server`). |
| `security.py` | HMAC request authentication, atomic nonce cache, callback-URL / SSRF validation, redaction helper, injectable structured logger. |
| `store.py` | SQLite persistence: idempotent job creation, tenant-scoped reads, atomic lease claiming, completion/failure with deterministic retry policy. |
| `worker.py` | Delivery loop: pre-delivery re-resolution (DNS-rebinding defence), transport invocation, status classification. |
| `test_security.py`, `test_store.py`, `test_api.py` | `unittest` suites (71 tests) using fake clocks, fake resolvers, and fake transports — no real network. |

Clocks, ID generation, hostname resolution, the outbound transport, and the
log sink are all injected, so every test is deterministic.

## Authentication

Requests carry `X-Tenant-ID`, `X-Key-ID`, `X-Timestamp`, `X-Nonce`,
`X-Signature`. The signature is lowercase-hex HMAC-SHA256 over:

```text
tenant_id + "\n" + key_id + "\n" + timestamp + "\n" + nonce + "\n"
+ METHOD_UPPERCASE + "\n" + raw_target + "\n" + sha256(raw_body).hexdigest()
```

* The **raw request target** (original query string included) is signed;
  routing decodes the path separately and never alters the signed value.
* Signatures must match `[0-9a-f]{64}` before any comparison, which uses
  `hmac.compare_digest`.
* Timestamps are integer Unix seconds within ±300 s of the injected clock.
* Nonces are scoped by `(tenant_id, key_id)`, single-use for 600 s, consumed
  atomically under a lock, and **only after** the signature verified — an
  invalid signature never burns a nonce.
* Missing, repeated, or ambiguous security headers are rejected.
* Every failure returns the same generic 401; unknown tenants/keys are HMAC'd
  against a random decoy secret so behaviour stays uniform.
* Secrets arrive via injected configuration (`secret_lookup`); none are
  hard-coded.

## API

### `POST /v1/events`

`application/json`, ≤ 65,536 bytes (the HTTP adapter refuses from
`Content-Length` **before** reading the complete body). Rejected: unsupported
content types/encodings, invalid UTF-8, duplicate JSON keys at any depth,
`NaN`/`Infinity`/`-Infinity`, unknown top-level fields, non-object payloads,
malformed `event_id` / `type` / `callback_url`.

`Idempotency-Key` (`[A-Za-z0-9_-]{8,80}`) is required and scoped per tenant
and endpoint: first valid request → **202**; same key + byte-identical body →
**200** with `"duplicate": true` (original job); same key + different body →
**409 `idempotency_conflict`**. Different tenants may reuse keys.
Check-and-insert runs inside `BEGIN IMMEDIATE`, so it is atomic across
concurrent SQLite connections.

**Documented deterministic behaviour:** `event_id` is unique per tenant; a
*different* idempotency key submitting an existing `event_id` is rejected
with **409 `event_id_conflict`** and writes nothing.

### `GET /v1/jobs/{job_id}`

Same authentication with an empty body. A missing job and another tenant's
job return byte-identical 404s. All SQL uses parameterized values only.

## Callback URL security

HTTPS only; ports 443/8443; no userinfo, fragments, or malformed/empty hosts.
Hostnames resolve through the injected resolver; the URL is rejected if *any*
address is loopback, private, link-local, multicast, reserved, unspecified,
or non-global (IPv4-mapped IPv6 is unwrapped and judged as IPv4; IP literals
are validated directly). Validation runs at enqueue **and again immediately
before every delivery attempt**. The transport receives the pre-validated IP
separately from the hostname (kept only for TLS/SNI and `Host`), so it cannot
re-resolve behind the validator. Redirects are never followed.

## Store, leases, retries

SQLite with `PRAGMA foreign_keys=ON` and explicit `BEGIN IMMEDIATE`
transactions. `claim_due` atomically leases up to `limit` due jobs; separate
connections can never double-claim an active lease; expired leases are
reclaimable; only the lease owner may `complete`/`fail`; terminal jobs
(`delivered`/`failed`) are never reclaimed. `attempts` increments exactly
once per attempt (at claim). Retry delay is `min(2 ** attempt, 300)` s; the
job becomes terminal after five failed attempts.

Classification: HTTP 200–299 success; 408/429/500–599 retryable; all other
statuses (including 3xx) terminal. Resolution failure → retryable
`dns_error`; unsafe address → terminal `unsafe_address`; timeout → retryable
`timeout`; oversized response → terminal `oversized_response`; other
transport failure → retryable `transport_error`. At most 8,192 bytes of a
callback response are retained in memory; response bodies, payloads, secrets,
and signatures are never persisted or logged (structured logger + tested
redaction helper). Persisted timestamps use the injected wall clock;
monotonic time is used only for duration measurement.

## Running

```sh
cd fable_backend_probe_b
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v
```

A manual demo server (`python3 app.py`) exists but requires secrets via the
`RELAYVAULT_KEYS_JSON` environment variable; tests never start it.
