# RelayVault

A deterministic, security-conscious, multi-tenant webhook intake and delivery
queue built entirely on the Python 3.11+ standard library.

## Layout

| File | Responsibility |
| --- | --- |
| `app.py` | Transport-independent `Application.handle(method, raw_target, headers, body) -> Response`, plus a minimal `ThreadingHTTPServer` adapter (`make_server`) and a config-driven `main()`. |
| `security.py` | HMAC request authentication, nonce store, callback-URL/SSRF validation, log redaction. |
| `store.py` | SQLite persistence, tenant-scoped idempotency, worker leasing (`claim_due` / `complete` / `fail`). |
| `worker.py` | Delivery loop, pre-delivery re-validation, retry/terminal classification, injectable transport. |
| `test_security.py`, `test_store.py`, `test_api.py` | Deterministic `unittest` suites (fake clocks, resolvers, transports; no network). |

All collaborators are injected: wall clock, monotonic clock, job-ID generator,
credential lookup, hostname resolver, outbound transport, and log sink.
Secrets arrive only through injected configuration (see `main()`); nothing is
hard-coded.

## Request authentication

Headers: `X-Tenant-ID`, `X-Key-ID`, `X-Timestamp`, `X-Nonce`, `X-Signature`.
The signature is lowercase-hex HMAC-SHA256 over:

```
tenant_id "\n" key_id "\n" timestamp "\n" nonce "\n"
METHOD_UPPERCASE "\n" raw_target "\n" sha256(raw_body).hexdigest()
```

`raw_target` is the raw request target including its original query string;
routing percent-decodes a *copy* of the path but never alters the signed
value. Enforcement order: each security header exactly once and unambiguous →
signature must be exactly 64 lowercase hex chars (malformed encodings are
rejected *before* comparison) → timestamp must be integer Unix seconds within
±300 s of the injected clock → constant-time `hmac.compare_digest` → only then
is the nonce consumed atomically (scoped per tenant+key, single use per
600 s), so an invalid signature never burns a nonce. Every failure returns
the same generic `401 {"error":"unauthorized"}`.

## POST /v1/events

`application/json` body ≤ 65,536 bytes; the HTTP adapter rejects a larger
declared `Content-Length` before reading or parsing the body (the application
layer re-checks). Rejected: other content types/encodings, invalid UTF-8,
duplicate JSON keys at any depth, `NaN`/`Infinity`/`-Infinity`, unknown or
missing top-level fields, non-object payloads, malformed `event_id`
(`[A-Za-z0-9_-]{1,64}`) or `type` (`[a-z0-9._-]{1,80}`).

`Idempotency-Key` (`[A-Za-z0-9_-]{8,80}`) is required and scoped per tenant +
endpoint: first valid request → `202` and a job; same key + byte-identical
body → `200` with `"duplicate":true` and the original job; same key +
different body → `409 idempotency_conflict`. Check-and-insert runs in one
`BEGIN IMMEDIATE` transaction, so it is atomic across concurrent connections.
Different tenants may reuse keys. **Documented event-ID rule:** `event_id` is
unique per tenant; a request whose `(tenant, event_id)` already exists under a
*different* idempotency key is deterministically rejected with
`409 event_id_conflict` and nothing is created or modified.

## GET /v1/jobs/{job_id}

Same authentication with an empty body. A missing job and another tenant's
job return byte-identical `404 {"error":"not_found"}`. All SQL uses fixed
statement text with parameterized values only.

## Callback URL security

HTTPS only; userinfo, fragments, empty/malformed hostnames, and ports other
than 443/8443 are rejected. Hostnames resolve through the injected resolver;
if *any* answer (or an IP literal, with IPv4-mapped IPv6 unwrapped) is
loopback, private, link-local, multicast, reserved, unspecified, shared, or
otherwise non-global, the URL is rejected. The worker re-validates and
re-resolves immediately before every delivery attempt (DNS-rebinding
defense). The transport receives the chosen validated IP separately from the
hostname and must connect to that IP only; the hostname is preserved for
TLS/SNI and the `Host` header. Redirects are never followed (3xx is terminal).

## Store and worker

SQLite with `PRAGMA foreign_keys=ON`, explicit `BEGIN IMMEDIATE`
transactions, and a `job_attempts` audit table referencing `jobs`. Leases:
`claim_due` atomically claims up to `limit` due jobs (pending-and-due or
expired-lease; never terminal) and increments the attempt counter exactly
once per attempt; `complete`/`fail` verify the lease owner and raise
`LeaseError` otherwise. Retry delay is `min(2 ** attempt, 300)` seconds; the
job is terminal after five attempts. Persisted timestamps use the injected
wall clock; the monotonic clock is used only for in-process duration metrics.

Delivery classification: 200–299 success; 408/429/5xx retryable
(`http_<code>`); any other status terminal (`http_<code>`); resolver
rejection retryable (`resolver_rejected`); timeout retryable (`timeout`);
transport failure retryable (`transport_error`); oversized response terminal
(`oversized_response`). At most 8,192 bytes of a callback response are
retained; responses are never logged.

## Responses and logging

Compact, sorted-key JSON with `application/json`. Errors are generic — no
stack traces, SQL, secrets, resolved addresses, or tenant-existence hints.
Logging goes through an injectable `logger(event, fields)`; every field set
passes through `security.redact`, which masks secrets, signatures, tokens,
authorization material, payloads, bodies, and response contents.

## Running

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v      # 76 deterministic tests
RELAYVAULT_DB=relayvault.sqlite3 \
RELAYVAULT_CREDENTIALS_FILE=credentials.json \
RELAYVAULT_PORT=8443 python3 app.py                   # real server (optional)
```

## Limitations

Nonce replay state is in-memory per process (multi-process deployments would
need a shared store); `main()`'s default transport/resolver are provided for
completeness but are intentionally untested (tests use fakes only); chunked
transfer encoding is rejected rather than supported.
