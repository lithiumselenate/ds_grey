# Asterion HX-9 Amphibious Rescue Tiltrotor — prototype viewer

A deterministic, dependency-free Three.js product visualisation of the **Asterion HX-9**,
an entirely fictional compact twin-nacelle amphibious rescue tiltrotor. Every shape,
marking, word, colour and motion in this project is original and generated at runtime:
there are no downloaded models, images, fonts or encoded asset blobs. The only network
request is the pinned Three.js module bundle.

## Running it

The page uses ES modules and an import map, so it must be served over HTTP:

```bash
cd ds_threejs_probe_a
python3 -m http.server 8173
# then open http://127.0.0.1:8173/
```

Pinned dependency (loaded at runtime from the CDN, nothing is installed):

* `https://unpkg.com/three@0.169.0/build/three.module.js`
* `https://unpkg.com/three@0.169.0/examples/jsm/` (OrbitControls, BufferGeometryUtils)

A modern desktop browser with WebGL 2 is required. WebGL failures and module-load
failures both raise a visible, readable error panel instead of a blank canvas.

## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic shell, import map, UI markup, help dialog, fatal-error panel |
| `styles.css` | Restrained technical UI, focus treatment, responsive and reduced-motion rules |
| `src/materials.js` | Seeded PRNG, all procedural CanvasTextures, PBR material families |
| `src/vehicle.js` | Named hierarchical aircraft assembly, loft/lathe/extrude/tube geometry, hotspot and explode authoring |
| `src/animation.js` | State machine, interlocks, rate-limited mechanism animation, exploded view |
| `src/ui.js` | DOM wiring, ARIA state, keyboard shortcuts, telemetry throttling, marker overlay |
| `src/main.js` | Renderer, hangar, lighting rig, cameras, picking, loop, `window.__HX9_PROBE__` |

## The aircraft

* **Fuselage** — lofted from an authored 13-station table through a cross-section with
  duplicated crease points, giving a boat-like ventral hull, hard chines and a shoulder
  break. Separate swept-tube spray rails, keel strake and dorsal spine sit on the loft,
  and an inverted inner shell makes the cabin read as a closed volume through the door.
* **Cockpit** — curved tinted canopy lofted as an open arc, graphite frame built from
  swept tubes (sills, two arch ribs, spine), instrument shroud, three emissive displays,
  two seats with headrests and two control columns visible through the glass.
* **Cabin** — recessed floor, two bulkheads, two fold-down seats, tube-frame stretcher,
  ceiling grab rails, two light strips and a powered starboard rescue door on external
  rails, with sill hazard striping, boarding step and grab handle.
* **Wings** — lofted airfoil sections (cosine-spaced, cambered) with taper, sweep and
  dihedral, plus root carry-through fairings, layered upper access panels, flaperon
  seams, wingtip navigation lights and outboard pitot probes.
* **Nacelles** — lathed cowls with flared intake lips, dark internal plenums, exhaust
  rings with rotor-linked glow, instanced cooling slats, a wrapped caution band, and
  visible tilt hardware: spindle, arc bracket, yoke and a screwjack whose rod extends
  with tilt angle.
* **Proprotors** — five lofted, tapered, twisted blades per side on instanced hubs with
  root cuffs and pitch links, a lathed hub and spinner, and a motion disc that fades in
  as the blades fade out with rising speed.
* **Landing gear** — tricycle, paired wheels on every leg, lathed tyre and hub
  cross-sections, oleo struts, drag braces, and bay doors sequenced ahead of the legs.
* **Sponsons** — lofted shallow floats with their own chine strakes on retracting arms.
* **Rescue winch** — slewing boom, level-wind drum, sheave head, cable, hook and a
  folding basket with a buoyant collar, positioned outboard so it never fouls the hull.
* **Sensor turret** — two-axis gimbal, three lenses, emissive status indicators.
* **Details** — tail fin and stabilisers, antennas, nose pitots, landing light, beacons,
  three hinged service covers, and instanced fastener and recessed-seam fields.

## States

| State | Configuration |
| --- | --- |
| `ground` | Nacelles vertical, rotors stopped, gear down, sponsons extended |
| `hover` | Nacelles vertical, rotors at operating speed, gear down |
| `transition` | Nacelles half tilted, rotors turning, gear retracting |
| `cruise` | Nacelles forward, rotors turning, gear and sponsons retracted |
| `rescue` | Hover configuration, door open, hoist boom outboard and enabled |
| `maintenance` | Powered down, service covers open, exploded view enabled |

Every mechanism chases its target with an eased, rate-limited approach, so switching
state mid-transition is always valid. Interlocks are enforced centrally, not by
independent toggles: the gear only moves once its bay doors are past 92 %, the cable only
extends in `rescue` with the door open and the boom slewed out, and the exploded view is
refused unless the state is `maintenance` and the rotors have stopped. Hoist travel is
clamped to 1.4 m because the display keeps the aircraft on its gear, so the basket stays
above the hangar deck.

## Controls and keyboard shortcuts

| Key | Action |
| --- | --- |
| `1`–`6` | ground, hover, transition, cruise, rescue, maintenance |
| `Q` `F` `P` `S` `T` `C` `W` | three-quarter, front, port, starboard door, top, cockpit, winch views |
| `L` | cycle hangar dusk / night inspection lighting |
| `E` | toggle exploded view (maintenance only) |
| `]` `[` | lower / raise the hoist |
| `Space` | pause / resume |
| `R` | deterministic reset |
| `M` | reduced-motion toggle |
| `H`, `Esc` | open / close help |

Mouse: drag to orbit, wheel to zoom, right-drag to pan; click a cyan marker to inspect
that component. Every marker is duplicated as a real focusable button in the inspection
list, and all telemetry appears as text — nothing essential is canvas-only. The UI
respects `prefers-reduced-motion`, keeps visible focus rings, and degrades to bottom
sheets below 900 px so the model stays visible.

## Determinism

All variation comes from a mulberry32 PRNG seeded with the FNV-1a hash of the literal
string `HX9-FABLE-PROBE`. `Math.random()` is never used for visible content, so identical
reloads at the same viewport produce identical geometry, textures, markings and initial
state. The seed is shared by probe runs `a` and `b`; only the output directory differs.

## Diagnostics

`window.__HX9_PROBE__` exposes:

* `getState()` — JSON-serialisable snapshot of vehicle, camera, lighting and metrics
* `setState(name)`, `setCamera(name)`, `setLighting(mode)`, `setPaused(bool)`, `setCable(m)`
* `setExplode(0..1)` — enforces the maintenance constraint and returns the accepted value
* `focusHotspot(id)`, `reset()`
* `validate()` — `{ ok, errors, warnings, metrics }`, read-only

`validate()` checks the required named assemblies, finite transforms, unique and attached
hotspot IDs, legal mechanical combinations, exact restoration of exploded-view base
transforms at zero, renderer and camera readiness, and scene metrics. Budget overruns are
reported as warnings, never as silent failures.

## Performance notes

Geometry and materials are shared, repeated hardware (fasteners, seams, vents, blades,
beams, lamps, deck joints) uses `InstancedMesh`, and a post-build pass merges static
sibling meshes that share a material, which removes roughly sixty draw calls without
touching any animated or semantically named node. Hot paths reuse preallocated vectors
and matrices. Measured draw calls and triangles are published in the telemetry panel and
in `validate().metrics`; the design targets stay under 180 draw calls and 350 000
triangles on the initial camera.
