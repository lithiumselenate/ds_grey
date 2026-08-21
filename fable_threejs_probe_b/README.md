# Asterion HX-9 — Amphibious Rescue Tiltrotor (procedural Three.js visualization)

An entirely original, fictional twin-nacelle amphibious rescue tiltrotor presented in a
procedural coastal hangar at dusk. All geometry, markings, text, UI and motion are
generated in code — no external models, images, fonts or textures. The only network
access is the pinned Three.js CDN module (`three@0.160.0` via jsDelivr import map).

## Run

Serve the directory over any static HTTP server and open it in a modern desktop browser:

```sh
cd fable_threejs_probe_b
python3 -m http.server 8093
# open http://127.0.0.1:8093/
```

ES modules require HTTP — opening `index.html` from `file://` will not work.

## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic layout, import map pin, boot/error handling |
| `styles.css` | Technical UI, focus treatment, responsive + reduced-motion rules |
| `src/main.js` | Renderer, hangar environment, lighting rig, cameras, picking, diagnostics, self-test |
| `src/vehicle.js` | Full HX-9 assembly: lofted hull, wings, nacelles, rotors, gear, winch, hotspots, explode vectors |
| `src/materials.js` | Seeded RNG, procedural CanvasTextures (wordmark, chevrons, placards…), PBR material families |
| `src/animation.js` | Deterministic state machine, gated channel integrator, pose application |
| `src/ui.js` | Control panel, telemetry, hotspot card, keyboard shortcuts |

## States

`ground · hover · transition · cruise · rescue · maintenance` — selected from the top
bar, keys 1–6, or `window.__HX9_PROBE__.setState(name)`. Transitions interpolate and
re-target safely mid-motion. Interlocks prevent impossible combinations: gear only
moves with bay doors open, the rescue door cannot close over a deployed winch cable,
the exploded view requires Maintenance with rotors stopped, and rotors will not spool
with panels open or the airframe exploded.

## Controls

- **Mouse** — drag orbit, wheel zoom, right-drag pan; click cyan markers for inspection.
- **1–6** states · **C** cycle cameras · **L** lighting mode · **[ / ]** explode − / +
- **W / Q** winch lower / raise (Rescue) · **P / Space** pause · **R** reset
- **M** reduced motion · **H / ?** help · **Esc / X** close dialogs

Camera presets: three-quarter (default), front, port, starboard rescue door, top,
cockpit, winch. Lighting modes: dusk hangar and night inspection.

## Determinism

All visible randomness derives from a fixed seed hashed from the literal string
`HX9-FABLE-PROBE` (`src/materials.js`). Reloads at the same viewport produce identical
geometry, markings and initial state. `Math.random()` is never used for visible content.

## Diagnostics

`window.__HX9_PROBE__` (read-only):

- `getState()` — JSON-serializable snapshot (state, channels, camera, lighting, metrics)
- `setState(name)` / `setExplode(0..1)` (maintenance-gated) / `focusHotspot(id)` / `reset()`
- `validate()` — `{ ok, errors, warnings, metrics }` without mutating the scene: checks
  required named assemblies, finite transforms, unique hotspot IDs, state interlocks,
  exact home-transform restoration at explode = 0, renderer/camera readiness, and
  draw-call/triangle budgets (warnings kept separate from failures).

Test hooks (also deterministic): URL parameters `?state=…&warp=seconds&explode=…`
`&camera=…&light=…` and `?selftest=1`, which runs a scripted pass over all states,
explode levels, hotspots, lighting, cameras, pause and reset, then prints
`HX9-SELFTEST {...}` to the console and to a `<pre id="selftest-out">` element.

## Performance notes

Assemblies merge geometry per material; fasteners, cones and beams use `InstancedMesh`;
rotor blades collapse into a translucent motion disc at speed. Budgets (≤ 350k rendered
triangles, ≤ 180 draw calls on the initial camera) are measured live and surfaced in the
telemetry panel and `validate().metrics`.

## Originality

The Asterion HX-9, its wordmark, registration `RSQ-091`, placards and hangar signage
are invented for this exercise and reference no real manufacturer, aircraft or livery.
