"""End-to-end tests for the application layer, HTTP adapter helpers, and
worker delivery — all with fake resolvers, fake transports, and fixed clocks.
No real network connections are made anywhere in this suite.
"""
import itertools
import json
import os
import tempfile
import unittest

import app
import security
import store
import worker

NOW = 1_700_000_000
SECRET_T1 = b"api-secret-tenant-one"
SECRET_T2 = b"api-secret-tenant-two"
_CREDENTIALS = {("t1", "k1"): SECRET_T1, ("t2", "k2"): SECRET_T2}
SAFE_IP = "93.184.216.34"
CALLBACK = "https://hooks.example.test/delivery"

VALID_EVENT = {
    "event_id": "evt_123",
    "type": "build.completed",
    "callback_url": CALLBACK,
    "payload": {"ok": True},
}


class FakeResolver:
    def __init__(self, table):
        self.table = dict(table)

    def __call__(self, hostname):
        if hostname not in self.table:
            raise LookupError("unresolvable")
        return list(self.table[hostname])


class FakeTransport:
    """Scripted transport; records every DeliveryRequest it receives."""

    def __init__(self):
        self.calls = []
        self.script = []

    def __call__(self, request):
        self.calls.append(request)
        if self.script:
            action = self.script.pop(0)
        else:
            action = worker.TransportResponse(200, b"ok")
        if isinstance(action, Exception):
            raise action
        return action


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = os.path.join(self._tmp.name, "relayvault.sqlite3")
        self.store = store.Store(self.db_path)
        self.addCleanup(self.store.close)
        self.clock = [NOW]
        self.logs = []
        self.resolver = FakeResolver({"hooks.example.test": [SAFE_IP]})
        self.transport = FakeTransport()
        self._nonces = itertools.count()
        self._job_ids = itertools.count(1)
        self.authenticator = security.Authenticator(
            lambda tenant, key: _CREDENTIALS.get((tenant, key)),
            clock=lambda: self.clock[0],
            nonce_store=security.InMemoryNonceStore(),
        )
        self.app = app.Application(
            self.store,
            self.authenticator,
            self.resolver,
            clock=lambda: self.clock[0],
            id_generator=lambda: "job-%d" % next(self._job_ids),
            logger=lambda event, fields: self.logs.append((event, fields)),
        )
        self.monotonic = itertools.count()
        self.worker = worker.Worker(
            self.store,
            self.resolver,
            self.transport,
            worker_id="w1",
            wall_clock=lambda: self.clock[0],
            monotonic_clock=lambda: float(next(self.monotonic)),
            logger=lambda event, fields: self.logs.append((event, fields)),
        )

    # -- request helpers ---------------------------------------------------

    def auth_headers(self, method, target, body, tenant="t1", key="k1", secret=None):
        nonce = "api-nonce-%d" % next(self._nonces)
        timestamp = str(int(self.clock[0]))
        signature = security.sign_request(
            secret or _CREDENTIALS[(tenant, key)],
            tenant,
            key,
            timestamp,
            nonce,
            method,
            target,
            body,
        )
        return [
            ("X-Tenant-ID", tenant),
            ("X-Key-ID", key),
            ("X-Timestamp", timestamp),
            ("X-Nonce", nonce),
            ("X-Signature", signature),
        ]

    def post_event(self, document=None, raw_body=None, idem="idem-key-0001",
                   tenant="t1", key="k1", extra_headers=(), signed_body=None):
        body = raw_body if raw_body is not None else json.dumps(
            document if document is not None else VALID_EVENT
        ).encode("utf-8")
        headers = self.auth_headers(
            "POST", "/v1/events", signed_body if signed_body is not None else body,
            tenant=tenant, key=key,
        )
        headers.append(("Content-Type", "application/json"))
        if idem is not None:
            headers.append(("Idempotency-Key", idem))
        headers.extend(extra_headers)
        return self.app.handle("POST", "/v1/events", headers, body)

    def get_job(self, job_id, tenant="t1", key="k1", raw_target=None):
        target = raw_target or ("/v1/jobs/" + job_id)
        headers = self.auth_headers("GET", target, b"", tenant=tenant, key=key)
        return self.app.handle("GET", target, headers, b"")

    # -- authentication through the API -------------------------------------

    def test_valid_post_creates_job(self):
        response = self.post_event()
        self.assertEqual(response.status, 202)
        self.assertEqual(
            response.body,
            {"duplicate": False, "event_id": "evt_123", "job_id": "job-1",
             "status": "pending"},
        )

    def test_tampered_body_is_rejected(self):
        signed = json.dumps(VALID_EVENT).encode("utf-8")
        tampered = json.dumps({**VALID_EVENT, "type": "build.failed"}).encode("utf-8")
        response = self.post_event(raw_body=tampered, signed_body=signed)
        self.assertEqual(response.status, 401)
        self.assertEqual(response.body, {"error": "unauthorized"})

    def test_tampered_raw_target_query_is_rejected(self):
        headers = self.auth_headers("GET", "/v1/jobs/job-1?a=1", b"")
        response = self.app.handle("GET", "/v1/jobs/job-1?a=2", headers, b"")
        self.assertEqual(response.status, 401)

    def test_routing_decodes_path_without_changing_signed_value(self):
        self.post_event()
        # Sign the raw percent-encoded target; routing decodes it to job-1.
        raw_target = "/v1/jobs/job%2D1"
        response = self.get_job("job-1", raw_target=raw_target)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["job_id"], "job-1")

    # -- strict body handling -------------------------------------------------

    def test_duplicate_json_keys_rejected_at_any_depth(self):
        top = b'{"event_id":"e1","event_id":"e1","type":"t","callback_url":"%s","payload":{}}' % CALLBACK.encode()
        nested = (
            b'{"event_id":"e1","type":"build.completed","callback_url":"'
            + CALLBACK.encode()
            + b'","payload":{"a":1,"a":2}}'
        )
        for raw in (top, nested):
            response = self.post_event(raw_body=raw)
            self.assertEqual(response.status, 400)
            self.assertEqual(response.body, {"error": "invalid_body"})

    def test_non_finite_numbers_rejected(self):
        for literal in (b"NaN", b"Infinity", b"-Infinity"):
            raw = (
                b'{"event_id":"e1","type":"build.completed","callback_url":"'
                + CALLBACK.encode()
                + b'","payload":{"n":' + literal + b"}}"
            )
            response = self.post_event(raw_body=raw)
            self.assertEqual(response.status, 400)

    def test_invalid_utf8_rejected(self):
        response = self.post_event(raw_body=b'{"event_id":"\xff\xfe"}')
        self.assertEqual(response.status, 400)

    def test_schema_violations_rejected(self):
        cases = [
            {**VALID_EVENT, "extra": 1},                      # unknown field
            {k: v for k, v in VALID_EVENT.items() if k != "type"},  # missing field
            {**VALID_EVENT, "payload": [1, 2]},               # non-object payload
            {**VALID_EVENT, "payload": "text"},
            {**VALID_EVENT, "event_id": ""},
            {**VALID_EVENT, "event_id": "bad id!"},
            {**VALID_EVENT, "event_id": "x" * 65},
            {**VALID_EVENT, "type": "Build.Completed"},       # uppercase
            {**VALID_EVENT, "type": ""},
            {**VALID_EVENT, "callback_url": 7},
        ]
        for document in cases:
            response = self.post_event(document=document)
            self.assertEqual(response.status, 400, document)
        response = self.post_event(raw_body=b'["not", "an", "object"]')
        self.assertEqual(response.status, 400)

    def test_unsupported_media_types_and_encodings_rejected(self):
        body = json.dumps(VALID_EVENT).encode("utf-8")
        headers = self.auth_headers("POST", "/v1/events", body)
        headers += [("Content-Type", "text/plain"), ("Idempotency-Key", "idem-key-0001")]
        self.assertEqual(self.app.handle("POST", "/v1/events", headers, body).status, 415)

        headers = self.auth_headers("POST", "/v1/events", body)
        headers += [
            ("Content-Type", "application/json"),
            ("Content-Encoding", "gzip"),
            ("Idempotency-Key", "idem-key-0001"),
        ]
        self.assertEqual(self.app.handle("POST", "/v1/events", headers, body).status, 415)

        headers = self.auth_headers("POST", "/v1/events", body)
        headers += [
            ("Content-Type", "application/json; charset=utf-16"),
            ("Idempotency-Key", "idem-key-0001"),
        ]
        self.assertEqual(self.app.handle("POST", "/v1/events", headers, body).status, 415)

    def test_idempotency_key_header_required_and_validated(self):
        self.assertEqual(self.post_event(idem=None).status, 400)
        self.assertEqual(self.post_event(idem="short").status, 400)
        self.assertEqual(self.post_event(idem="bad key with spaces").status, 400)
        self.assertEqual(self.post_event(idem="x" * 81).status, 400)
        repeated = self.post_event(
            idem="idem-key-0001", extra_headers=[("Idempotency-Key", "idem-key-0002")]
        )
        self.assertEqual(repeated.status, 400)

    # -- body size ---------------------------------------------------------------

    def test_body_size_enforced_by_application(self):
        big = b"x" * (app.MAX_BODY_BYTES + 1)
        headers = self.auth_headers("POST", "/v1/events", big)
        headers += [("Content-Type", "application/json"), ("Idempotency-Key", "idem-key-0001")]
        response = self.app.handle("POST", "/v1/events", headers, big)
        self.assertEqual(response.status, 413)
        self.assertEqual(response.body, {"error": "body_too_large"})

    def test_adapter_rejects_declared_oversize_before_reading_body(self):
        length, error = app.parse_content_length([str(app.MAX_BODY_BYTES + 1)])
        self.assertIsNone(length)
        self.assertEqual(error, (413, "body_too_large"))
        length, error = app.parse_content_length([str(app.MAX_BODY_BYTES)])
        self.assertEqual((length, error), (app.MAX_BODY_BYTES, None))
        self.assertEqual(app.parse_content_length([]), (0, None))
        for bad in (["12", "12"], ["-5"], ["abc"], ["1.5"]):
            length, error = app.parse_content_length(bad)
            self.assertIsNone(length)
            self.assertEqual(error, (400, "invalid_content_length"))

    # -- idempotency through the API -----------------------------------------

    def test_replay_same_body_returns_original_with_duplicate_true(self):
        first = self.post_event()
        self.assertEqual(first.status, 202)
        # Fresh timestamp/nonce/signature are generated automatically.
        replay = self.post_event()
        self.assertEqual(replay.status, 200)
        self.assertEqual(
            replay.body,
            {"duplicate": True, "event_id": "evt_123", "job_id": "job-1",
             "status": "pending"},
        )

    def test_same_key_different_body_conflicts(self):
        self.post_event()
        response = self.post_event(
            document={**VALID_EVENT, "event_id": "evt_456"}
        )
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body, {"error": "idempotency_conflict"})

    def test_existing_event_id_under_new_key_conflicts_deterministically(self):
        self.post_event()
        response = self.post_event(idem="idem-key-0002")
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body, {"error": "event_id_conflict"})

    def test_different_tenants_may_reuse_idempotency_key(self):
        self.post_event()
        response = self.post_event(tenant="t2", key="k2")
        self.assertEqual(response.status, 202)
        self.assertEqual(response.body["duplicate"], False)

    # -- job lookup ---------------------------------------------------------------

    def test_cross_tenant_lookup_identical_to_missing_job(self):
        self.post_event()
        own = self.get_job("job-1")
        self.assertEqual(own.status, 200)
        cross = self.get_job("job-1", tenant="t2", key="k2")
        missing = self.get_job("job-does-not-exist", tenant="t2", key="k2")
        self.assertEqual(cross.status, 404)
        self.assertEqual(missing.status, 404)
        self.assertEqual(cross.encode(), missing.encode())

    def test_hostile_job_ids_via_api(self):
        self.post_event()
        for raw in (
            "/v1/jobs/job-1%27%20OR%20%271%27%3D%271",
            "/v1/jobs/job-1%27%3B%20DROP%20TABLE%20jobs%3B--",
        ):
            response = self.get_job("", raw_target=raw)
            self.assertEqual(response.status, 404)
        # Store remains intact and queryable.
        self.assertEqual(self.get_job("job-1").status, 200)

    # -- callback URL security through the API ---------------------------------

    def test_unsafe_callback_urls_rejected_at_enqueue(self):
        self.resolver.table["internal.example.test"] = ["10.0.0.9"]
        cases = [
            "http://hooks.example.test/x",
            "https://user@hooks.example.test/x",
            "https://hooks.example.test/x#frag",
            "https://hooks.example.test:8080/x",
            "https://10.0.0.9/x",
            "https://[::1]/x",
            "https://internal.example.test/x",
        ]
        for url in cases:
            response = self.post_event(document={**VALID_EVENT, "callback_url": url})
            self.assertEqual(response.status, 422, url)
            self.assertEqual(response.body, {"error": "invalid_callback_url"})
            self.assertNotIn("10.0.0.9", response.encode().decode())

    # -- delivery through the worker ---------------------------------------------

    def test_worker_delivers_with_validated_ip_and_preserved_host(self):
        self.post_event()
        processed = self.worker.run_once()
        self.assertEqual(processed, 1)
        self.assertEqual(len(self.transport.calls), 1)
        request = self.transport.calls[0]
        self.assertEqual(request.ip, SAFE_IP)
        self.assertEqual(request.host, "hooks.example.test")
        self.assertEqual(request.headers["Host"], "hooks.example.test")
        self.assertEqual(request.port, 443)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.target, "/delivery")
        delivered = json.loads(request.body.decode("utf-8"))
        self.assertEqual(delivered["event_id"], "evt_123")
        self.assertEqual(delivered["payload"], {"ok": True})
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "delivered")
        self.assertEqual(job["attempts"], 1)

    def test_dns_rebinding_between_enqueue_and_delivery_blocked(self):
        self.post_event()  # validated against SAFE_IP at enqueue
        self.resolver.table["hooks.example.test"] = ["10.0.0.5"]  # rebinding
        self.worker.run_once()
        self.assertEqual(self.transport.calls, [])
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "pending")  # retryable
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(job["last_error_code"], "resolver_rejected")

    def test_redirects_are_not_followed(self):
        self.post_event()
        self.transport.script = [worker.TransportResponse(302, b"see /elsewhere")]
        self.worker.run_once()
        self.assertEqual(len(self.transport.calls), 1)  # no second request
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "failed")  # terminal, never retried
        self.assertEqual(job["last_error_code"], "http_302")
        self.clock[0] += 3600
        self.worker.run_once()
        self.assertEqual(len(self.transport.calls), 1)

    def test_retryable_http_status_schedules_backoff(self):
        self.post_event()
        for status in (500, 429, 408, 503):
            self.transport.script = [worker.TransportResponse(status, b"busy")]
            before = self.store.get_job("t1", "job-1")
            self.clock[0] = max(self.clock[0], before["next_attempt_at"])
            self.worker.run_once()
            job = self.store.get_job("t1", "job-1")
            self.assertEqual(job["status"], "pending", status)
            self.assertEqual(
                job["next_attempt_at"],
                self.clock[0] + min(2 ** job["attempts"], 300),
            )

    def test_non_retryable_http_status_is_terminal(self):
        self.post_event()
        self.transport.script = [worker.TransportResponse(410, b"gone")]
        self.worker.run_once()
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["last_error_code"], "http_410")

    def test_timeout_and_transport_failure_retryable_oversize_terminal(self):
        self.post_event()
        self.transport.script = [worker.TransportTimeout()]
        self.worker.run_once()
        job = self.store.get_job("t1", "job-1")
        self.assertEqual((job["status"], job["last_error_code"]), ("pending", "timeout"))

        self.clock[0] = job["next_attempt_at"]
        self.transport.script = [worker.TransportFailure()]
        self.worker.run_once()
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(
            (job["status"], job["last_error_code"]), ("pending", "transport_error")
        )

        self.clock[0] = job["next_attempt_at"]
        self.transport.script = [worker.OversizedResponse()]
        self.worker.run_once()
        job = self.store.get_job("t1", "job-1")
        self.assertEqual(
            (job["status"], job["last_error_code"]), ("failed", "oversized_response")
        )

    def test_stored_response_snippet_is_capped(self):
        self.post_event()
        self.transport.script = [
            worker.TransportResponse(500, b"e" * (store.MAX_RESPONSE_SNIPPET_BYTES * 3))
        ]
        self.worker.run_once()
        job = self.store.get_job("t1", "job-1")
        self.assertLessEqual(
            len(job["response_snippet"].encode("utf-8")),
            store.MAX_RESPONSE_SNIPPET_BYTES,
        )

    # -- logging -------------------------------------------------------------------

    def test_logs_contain_no_secrets_signatures_or_payload_contents(self):
        sentinel_payload = {"card_number": "4111-1111-1111-1111", "note": "sup3rsecretnote"}
        document = {**VALID_EVENT, "payload": sentinel_payload}
        body = json.dumps(document).encode("utf-8")
        headers = self.auth_headers("POST", "/v1/events", body)
        signature_value = dict(headers)["X-Signature"]
        headers += [("Content-Type", "application/json"), ("Idempotency-Key", "idem-key-0001")]
        self.app.handle("POST", "/v1/events", headers, body)
        # A failed request also logs, and a delivery attempt logs.
        bad = self.auth_headers("POST", "/v1/events", body)
        bad = [(k, "0" * 64) if k == "X-Signature" else (k, v) for k, v in bad]
        self.app.handle("POST", "/v1/events", bad + [("Content-Type", "application/json")], body)
        self.transport.script = [worker.TransportResponse(500, b"server-blew-up-details")]
        self.worker.run_once()

        self.assertTrue(any(event == "event_accepted" for event, _ in self.logs))
        self.assertTrue(any(event == "auth_failed" for event, _ in self.logs))
        self.assertTrue(any(event == "delivery_attempt" for event, _ in self.logs))
        dump = repr(self.logs)
        for leaked in (
            SECRET_T1.decode(),
            SECRET_T2.decode(),
            signature_value,
            "4111-1111-1111-1111",
            "sup3rsecretnote",
            "server-blew-up-details",
        ):
            self.assertNotIn(leaked, dump)

    def test_redaction_applied_to_log_fields(self):
        log = []
        application = app.Application(
            self.store,
            self.authenticator,
            self.resolver,
            clock=lambda: self.clock[0],
            logger=lambda event, fields: log.append(fields),
        )
        application._log("probe", tenant_id="t1", signature="abc", payload={"x": 1})
        self.assertEqual(
            log[0],
            {"tenant_id": "t1", "signature": security.REDACTED,
             "payload": security.REDACTED},
        )

    # -- misc routing ---------------------------------------------------------------

    def test_unknown_routes_and_methods(self):
        headers = self.auth_headers("GET", "/v1/unknown", b"")
        self.assertEqual(self.app.handle("GET", "/v1/unknown", headers, b"").status, 404)
        headers = self.auth_headers("GET", "/v1/events", b"")
        self.assertEqual(self.app.handle("GET", "/v1/events", headers, b"").status, 405)
        body = json.dumps(VALID_EVENT).encode("utf-8")
        headers = self.auth_headers("POST", "/v1/jobs/job-1", body)
        self.assertEqual(
            self.app.handle("POST", "/v1/jobs/job-1", headers, body).status, 405
        )

    def test_get_job_with_body_rejected(self):
        self.post_event()
        headers = self.auth_headers("GET", "/v1/jobs/job-1", b"x")
        response = self.app.handle("GET", "/v1/jobs/job-1", headers, b"x")
        self.assertEqual(response.status, 400)

    def test_responses_are_compact_stable_json(self):
        response = self.post_event()
        encoded = response.encode()
        self.assertEqual(
            encoded,
            b'{"duplicate":false,"event_id":"evt_123","job_id":"job-1","status":"pending"}',
        )


if __name__ == "__main__":
    unittest.main()
