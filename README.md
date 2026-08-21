# ds_grey
一些模型生成的代码收集

# 提示词

# 前端任务
Complete the following local engineering and visual-design task.

Work only inside a new directory named `fable_threejs_probe_a` in the current workspace. Assume everything outside that directory is unrelated. Do not read, modify, or delete anything outside the target directory. If it already exists and is not empty, stop and report that condition without overwriting it.

Build a polished, deterministic Three.js product-visualization experience for an entirely original fictional vehicle called the “Asterion HX-9 Amphibious Rescue Tiltrotor.” It must look like a plausible high-end physical prototype, not a collection of lightly modified primitive shapes. All geometry, materials, decals, UI, text, and motion must be original. Do not copy any real manufacturer, franchise, game, aircraft, logo, or trade dress.

The result must run directly in a modern desktop browser from a local static HTTP server. Use JavaScript ES modules and Three.js from a pinned CDN URL. Do not use a bundler, package installation, external models, external images, external fonts, downloaded textures, or base64 asset blobs. Procedural CanvasTexture data is allowed. Apart from loading the pinned Three.js modules at runtime, do not use the network and do not perform web research.

## Deliverables

Create exactly these eight files and no others:

1. `fable_threejs_probe_a/index.html`
2. `fable_threejs_probe_a/styles.css`
3. `fable_threejs_probe_a/src/main.js`
4. `fable_threejs_probe_a/src/vehicle.js`
5. `fable_threejs_probe_a/src/materials.js`
6. `fable_threejs_probe_a/src/animation.js`
7. `fable_threejs_probe_a/src/ui.js`
8. `fable_threejs_probe_a/README.md`

Do not intentionally create screenshots, caches, package metadata, generated bundles, test artifacts, or temporary files inside the deliverable directory.

## Vehicle design

Model the HX-9 as a compact twin-nacelle rescue aircraft that can operate from water, damaged runways, and confined landing pads. Establish one coherent visual language: chamfered structural panels, exposed mechanical pivots, orange-and-ivory rescue markings, dark graphite mechanisms, and restrained cyan status lighting.

Construct the vehicle as a named hierarchical Object3D assembly. Include at least:

- a tapered central fuselage with a ventral boat-like hull and visible chine lines;
- a framed two-seat cockpit with a curved tinted canopy, dashboard silhouettes, seats, headrests, and control columns visible through the glass;
- a short cabin with an opening starboard rescue door, recessed floor, two fold-down seats, a stretcher, grab rails, and ceiling lights;
- left and right shoulder wings with structural roots, panel layering, navigation lights, and control-surface seams;
- two detailed rotating tilt nacelles with housings, intake lips, internal dark cavities, exhaust rings, pivot hardware, vents, and warning markings;
- two five-blade rotors with hubs, pitch-link suggestions, blade-root cuffs, tapered blades, and motion-disc treatment at high speed;
- retractable tricycle landing gear with struts, paired wheels where appropriate, hubs, tires, gear doors, and animated deployment;
- two shallow retractable water sponsons or floats integrated with the lower fuselage;
- a rescue winch with arm, drum, cable, hook, and a small rescue basket that can lower without intersecting the hull;
- a gimballed nose sensor turret with multiple lenses and emissive status indicators;
- antennas, pitot probes, steps, handles, hinges, fasteners, panel seams, vents, access covers, and original procedural decals;
- a readable silhouette from front, side, three-quarter, and top views.

Major visible components must be composite constructions. Use custom BufferGeometry, ExtrudeGeometry, LatheGeometry, Shape geometry, curves/tubes, layered meshes, or transformed geometry where those techniques materially improve the form. Ordinary primitives are acceptable for small mechanical parts, but a box-and-cylinder-only result is not acceptable.

Implement symmetry through reusable helpers rather than manually duplicating unrelated coordinates. Give important objects stable semantic names so that animation and inspection code do not depend on child-array indices.

## Materials and procedural surface detail

Use physically based materials with a coherent scale and finish. Include distinct material families for painted composite, exposed metal, rubber, glass, interior fabric, lenses, emissive indicators, and dark mechanical parts.

Generate all markings procedurally with CanvasTexture or geometry. Include an original HX-9 wordmark, rescue chevrons, caution stripes, door arrows, small maintenance labels, panel identifiers, and asymmetric operational wear. Do not reproduce any real logo.

Add subtle roughness/color variation, edge accents, recessed seams, and limited wear without making the aircraft dirty or noisy. Configure renderer color space, tone mapping, lighting, shadows, transparency, polygon offsets, anisotropy where available, and texture disposal correctly.

## Scene and presentation

Present the vehicle in an original coastal rescue hangar at dusk. Build a restrained procedural environment containing a segmented floor, landing-pad markings, a rear service wall, structural beams, a few low-detail service props, and an exterior opening suggesting water and sky. The aircraft must remain the visual focus.

Use a balanced lighting rig with soft environmental fill, a key light, cool exterior light, warm practical hangar lights, shadows, and emissive accents. Include a clearly different night-inspection lighting mode. Avoid excessive bloom or unreadably dark materials.

Use OrbitControls with sensible damping, limits, reset behavior, and a carefully selected initial three-quarter camera. Provide named camera presets for front, port, starboard/rescue-door, top, cockpit, and winch views. Camera transitions should ease rather than teleport.

The layout must remain usable at 1280×720 and 1920×1080. It should degrade reasonably on a narrow viewport without covering the entire model.

## Interactive states and animation

Implement a deterministic state machine rather than independent conflicting toggles. Required states:

- `ground`: nacelles vertical, rotors stopped or idling, gear and sponsons deployed;
- `hover`: nacelles vertical, rotors at operating speed, gear deployed;
- `transition`: nacelles partially tilted, rotors operating, gear retracting;
- `cruise`: nacelles forward, rotors operating, gear and sponsons retracted;
- `rescue`: stable hover configuration, rescue door open, winch available;
- `maintenance`: powered down, selected panels open, exploded-view control enabled.

Transitions must interpolate smoothly and remain valid if the user selects a new state mid-transition. Do not allow impossible combinations such as a lowered basket through a closed door, deployed landing gear inside closed gear doors, or maintenance exploded view while rotors are operating.

Animate at least:

- rotor acceleration, blur/disc appearance, rotation, and deceleration;
- nacelle tilt with visible mechanical pivots;
- landing gear and gear-door sequencing;
- water-sponson deployment;
- rescue-door motion;
- winch arm, cable length, hook, and basket;
- sensor-turret scanning and manual pointing;
- cockpit/cabin light intensity;
- navigation and anti-collision light timing;
- subtle idle vibration only when mechanically appropriate.

Animation must be frame-rate independent. Pause/resume must not create time jumps. Provide a deterministic reset that restores the initial state, camera, exploded view, and lighting.

## Exploded view and inspection

Add a continuous exploded-view slider available in maintenance mode. It must separate meaningful assemblies—nacelles, rotor groups, wing panels, canopy/cockpit shell, cabin door, gear, sponsons, sensor turret, and selected service panels—along authored vectors while preserving recognizable relationships. Returning the slider to zero must exactly restore the original transforms without cumulative drift.

Add at least ten clickable or selectable inspection hotspots. Each hotspot must focus the camera on a component and display a concise original description of its mechanical purpose. Hotspots must remain attached to their components during animation and exploded view.

## User interface and accessibility

Create a restrained technical UI rather than a generic dashboard template. Include:

- state selector and current-transition indicator;
- camera preset controls;
- lighting-mode control;
- exploded-view slider with correct disabled state;
- winch and sensor controls that enforce state constraints;
- pause, reset, help, and reduced-motion controls;
- a compact telemetry panel showing nacelle angle, rotor RPM, gear/sponson/door states, cable length, active camera, draw calls, triangles, and FPS;
- a hotspot information card;
- keyboard shortcuts documented in the UI and README.

Use semantic HTML, visible focus treatment, keyboard operation, appropriate ARIA attributes, adequate contrast, and `prefers-reduced-motion`. Do not place essential information only in canvas-rendered text.

## Determinism and diagnostics

Use a fixed internal seed derived from the literal string `HX9-FABLE-PROBE`; do not use uncontrolled `Math.random()` for visible content. Identical reloads at the same viewport must produce the same model, materials, markings, and initial state. The seed must remain identical for runs `a` and `b`; `a` changes only the isolated output directory.

Expose a read-only diagnostic interface as `window.__HX9_PROBE__` with:

- `getState()` returning a JSON-serializable snapshot;
- `setState(name)` requesting a valid named state;
- `setExplode(value)` accepting a number from 0 to 1 while enforcing maintenance constraints;
- `focusHotspot(id)`;
- `reset()`;
- `validate()` returning `{ ok, errors, warnings, metrics }` without mutating the scene.

Validation must check required named assemblies, finite transforms, unique hotspot IDs, legal state combinations, original-transform restoration at explode=0, renderer/camera readiness, and basic scene metrics. Keep warnings separate from failures.

Handle WebGL initialization failure and CDN/module-load failure with a useful visible error panel instead of a blank page.

## Performance

Target a smooth desktop experience. Reuse geometry/materials where practical, use InstancedMesh for repeated fasteners or lights when appropriate, avoid per-frame allocations in hot paths, and dispose of replaceable resources. Keep the default scene below 350,000 rendered triangles and below 180 draw calls on the initial camera unless the browser reports a materially different accounting method; expose the measured values in diagnostics.

Visual quality is more important than minimizing source-code length, but do not generate repetitive geometry by copy-pasting hundreds of nearly identical statements.

## Validation procedure

Follow this bounded procedure:

1. Inspect only the target directory and stop if it is already non-empty.
2. Plan the component hierarchy, state invariants, and file responsibilities.
3. Create the eight deliverables.
4. Start one local static server using a managed/background mechanism if available.
5. Open the page in an available browser tool at 1280×720.
6. Check load completion, console errors, `window.__HX9_PROBE__.validate()`, and the initial visual composition.
7. Exercise every named vehicle state, reset, exploded view at 0/0.5/1, at least four hotspots, two lighting modes, pause/resume, and at least four camera presets.
8. Inspect at most three representative rendered views: initial three-quarter, rescue state at the starboard door, and maintenance exploded view.
9. Perform at most two focused correction passes. After each pass, repeat only the checks affected by that correction.
10. Run one final validation, stop the local server, review the exact deliverable list, and stop.

If no browser or screenshot capability is available, do not install one. Perform static/runtime checks that are possible, clearly identify unverified visual requirements, and stop within the same limits.

## Hard execution bounds

- Use no more than 32 tool invocations total.
- Use no more than 16 model-response steps total.
- Use no more than two visual correction passes.
- Do not delegate to subagents.
- Do not use MCP, web search, external research, or image-generation services.
- Do not install packages or modify global/user configuration.
- Do not inspect unrelated workspace, system, or user files.
- Do not expand the project beyond the eight listed files.
- Do not ask clarification questions; make the narrowest reasonable assumption and report it.
- If a tool, environment, response, or time limit prevents completion, stop safely and report what remains.
- Do not expose private internal reasoning. Provide only normal progress updates, tool actions, the requested artifacts, and the final report.

## Final response

Keep the final response below 450 English words. Include:

- completion status;
- exact files created;
- model/scene highlights;
- browser/runtime checks performed and their results;
- `validate()` result and scene metrics;
- states and interactions exercised;
- corrections made, if any;
- assumptions;
- unresolved or visually unverified items;
- confirmation that the server was stopped and no extra files were intentionally created.

# 后端任务
Complete the following bounded local backend-engineering task autonomously.

  Work only inside a new directory named `gray_backend_probe_b` in the current workspace. Treat everything outside that
  directory as unrelated. Do not read, modify, move, or delete anything outside the target directory. If the directory
  already exists and is not empty, stop without overwriting it.

  Build a deterministic, security-conscious Python 3.11 service named “RelayVault”: a multi-tenant webhook intake and
  delivery queue.

  Use only the Python standard library. Do not install packages, access the network, use external services, or launch
  containers. Tests must not make real network connections.

  ## Exact deliverables

  Create exactly these eight files:

  1. `gray_backend_probe_b/README.md`
  2. `gray_backend_probe_b/app.py`
  3. `gray_backend_probe_b/security.py`
  4. `gray_backend_probe_b/store.py`
  5. `gray_backend_probe_b/worker.py`
  6. `gray_backend_probe_b/test_security.py`
  7. `gray_backend_probe_b/test_store.py`
  8. `gray_backend_probe_b/test_api.py`

  Do not create generated databases, logs, caches, coverage files, or additional fixtures in the project directory.
  Tests may use temporary directories.

  ## Architecture

  Separate the implementation into:

  - a transport-independent application layer:
    `Application.handle(method, raw_target, headers, body) -> Response`;
  - a minimal `ThreadingHTTPServer` adapter in `app.py`;
  - authentication and URL validation in `security.py`;
  - SQLite persistence and leasing in `store.py`;
  - delivery and retry logic in `worker.py`.

  Make clocks, ID generation, hostname resolution, and outbound transport injectable so tests remain deterministic.

  ## Request authentication

  All API requests use these headers:

  - `X-Tenant-ID`
  - `X-Key-ID`
  - `X-Timestamp`
  - `X-Nonce`
  - `X-Signature`

  The server receives tenant/key secrets through injected configuration. Never hard-code production secrets.

  The signature is lowercase hexadecimal HMAC-SHA256 over this exact byte sequence:

  ```text
  tenant_id + "\n"
  + key_id + "\n"
  + timestamp + "\n"
  + nonce + "\n"
  + METHOD_UPPERCASE + "\n"
  + raw_target + "\n"
  + sha256(raw_body).hexdigest()

  Requirements:

  - compare signatures with a constant-time operation;
  - reject malformed signature encodings before comparison;
  - timestamps are integer Unix seconds within ±300 seconds of the injected wall clock;
  - nonces are scoped by tenant and key ID and may be used only once within 600 seconds;
  - nonce acceptance must be atomic under concurrent requests;
  - an invalid signature must not consume its nonce;
  - reject missing, repeated, or ambiguous security headers;
  - use the raw request target, including its original query string, for signing;
  - routing may decode the path separately, but must not silently change the signed value.

  Return generic authentication errors without revealing whether a tenant, key, timestamp, nonce, or signature was
  wrong.

  ## POST 
/v1
/events

  Accept an application/json body of at most 65,536 bytes. Enforce the limit before parsing the complete body in the
  HTTP adapter.

  Reject:

  - unsupported content types or content encodings;
  - invalid UTF-8;
  - duplicate JSON object keys at any nesting level;
  - NaN, Infinity, and -Infinity;
  - unknown top-level fields;
  - non-object payload values.

  The exact body schema is:

  {
    "event_id": "evt_123",
    "type": "build.completed",
    "callback_url": "https://hooks.example.test/delivery",
    "payload": {}
  }

  Validation:

  - event_id: 1–64 ASCII letters, digits, _ or -;
  - type: 1–80 lowercase ASCII letters, digits, ., _ or -;
  - callback_url: validated as described below;
  - payload: JSON object.

  Require Idempotency-Key, matching [A-Za-z0-9_-]{8,80}.

  Idempotency is scoped by tenant and endpoint:

  - first valid request creates a job and returns HTTP 202;
  - a new authenticated request with the same key and byte-identical body returns the original job with HTTP 200 and
    duplicate: true;

  - the same key with a different body returns HTTP 409;
  - different tenants may reuse the same key;
  - checking and inserting must be atomic across concurrent SQLite connections.

  A repeated idempotent request uses a fresh timestamp, nonce, and signature. Nonce replay protection still applies
  independently.

  event_id is unique per tenant. Define and document deterministic behavior when a different idempotency key submits an
  existing event ID.

  ## GET 
/v1
/jobs/{job_id}

  Use the same request authentication scheme with an empty body.

  Return the job only when it belongs to the authenticated tenant. A missing job and a job owned by another tenant must
  produce the same HTTP 404 response.

  Do not build SQL identifiers or predicates from untrusted strings. All data values must be parameterized.

  ## Callback URL security

  Only allow HTTPS callback URLs.

  Reject URLs containing:

  - user information;
  - fragments;
  - empty or malformed hostnames;
  - non-HTTPS schemes;
  - ports other than 443 or 8443.

  Resolve hostnames through an injected resolver. Reject the URL if any returned address is loopback, private, link-
  local, multicast, reserved, unspecified, or otherwise non-global.

  Correctly handle:

  - IPv4;
  - IPv6;
  - IPv4-mapped IPv6;
  - textual IP literals;
  - hostnames that resolve to multiple addresses.

  Validation at event creation is not sufficient. Resolve and validate again immediately before every delivery attempt
  to defend against DNS rebinding.

  The outbound transport must receive the chosen validated IP separately from the original hostname, so it cannot
  resolve the hostname again behind the validator. Preserve the original hostname for TLS/SNI and the HTTP Host header.

  Do not follow redirects. Tests must use fake resolvers and fake transports only.

  ## SQLite store and worker leases

  Use SQLite with foreign keys enabled and explicit transactions.

  Jobs have at least:

  - tenant ID;
  - event ID;
  - callback URL;
  - serialized payload;
  - status;
  - attempt count;
  - next-attempt time;
  - lease owner;
  - lease expiry;
  - created and updated times.

  Implement:

  claim_due(worker_id, limit, lease_seconds, now)
  complete(job_id, worker_id, now)
  fail(job_id, worker_id, retryable, now, error_code)

  Requirements:

  - two workers using separate SQLite connections must never claim the same active lease;
  - claiming up to limit jobs is atomic;
  - expired leases may be reclaimed;
  - a worker must not complete or fail another worker’s lease;
  - terminal jobs are never reclaimed;
  - attempt count changes exactly once per delivery attempt;
  - retry delays are deterministic: min(2 ** attempt, 300) seconds;
  - after five failed attempts, the job becomes terminal;
  - HTTP 200–299 means success;
  - 408, 429, and 500–599 are retryable;
  - other HTTP status codes are terminal;
  - resolver rejection, timeout, oversized response, and transport failure have documented classifications;
  - retain at most 8,192 bytes of a callback response;
  - never store or log authentication secrets, signatures, complete payloads, or callback response bodies.

  Use wall-clock time for persisted timestamps and an injected monotonic clock for in-process duration measurement. Do
  not use a monotonic value as a persisted timestamp.

  ## Responses and logging

  Return compact JSON with a stable shape and application/json.

  Security-sensitive failures must not include stack traces, SQL text, secrets, resolved private addresses, or tenant
  existence information.

  Provide structured logging through an injectable callable. Log only event names and safe metadata. Include a redaction
  helper and test it.

  ## Required tests

  Use unittest. Include deterministic tests for at least:

  1. valid authentication;
  2. body or raw-target mutation invalidating a signature;
  3. malformed signatures;
  4. timestamp boundaries;
  5. invalid signatures not burning a nonce;
  6. concurrent reuse of one nonce;
  7. duplicate JSON keys and non-finite numbers;
  8. body-size enforcement;
  9. same-body and conflicting-body idempotency;
  10. concurrent idempotency requests through separate SQLite connections;
  11. cross-tenant job lookup returning 404;
  12. parameterized handling of hostile job IDs;
  13. private, loopback, link-local and IPv4-mapped callback addresses;
  14. mixed safe/unsafe DNS answers;
  15. DNS rebinding between enqueue and delivery;
  16. redirects not being followed;
  17. two workers racing to claim one job;
  18. expired lease recovery;
  19. wrong-worker completion rejection;
  20. retry/terminal transition boundaries;
  21. logs not containing secrets or payload contents.

  Tests should verify observable behavior rather than merely checking that functions exist.

  ## Validation procedure

  1. Check the target directory before writing.
  2. Implement all eight files.
  3. Run:

     PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v

  4. Run syntax compilation without leaving __pycache__ in the project.
  5. Inspect the final directory and confirm there are exactly eight files.
  6. Do not weaken or delete a security test merely to make it pass.
  7. If a requirement cannot be completed, leave the implementation in a safe state and report the exact gap.

  ## Final response

  Keep the final response below 400 English words. Include:

  - completion status;
  - exact files created;
  - test count and results;
  - security invariants implemented;
  - important design decisions;
  - corrections made during implementation;
  - remaining limitations;
  - confirmation that no real network request was made and no extra project files remain.