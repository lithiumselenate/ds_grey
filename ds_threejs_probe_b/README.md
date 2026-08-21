# Asterion HX-9 Amphibious Rescue Tiltrotor — Prototype Viewer

A deterministic, single-page Three.js product visualisation of the **Asterion HX-9**, an
entirely fictional compact twin-nacelle amphibious rescue tiltrotor. Everything visible —
geometry, materials, markings, environment, UI — is generated procedurally at runtime from
the fixed seed string `HX9-FABLE-PROBE`. There are no external models, images, fonts or
texture downloads, no bundler and no package installation; the only network access is the
pinned Three.js CDN module load.

## Run it

```bash
cd ds_threejs_probe_a
python3 -m http.server 8123 --bind 127.0.0.1
# then open http://127.0.0.1:8123/index.html in a modern desktop browser
```

A static HTTP server is required (ES modules + import map). Pinned dependencies, selected at
run time by the loader in `index.html`:

* **WebGL2 browsers** → `three@0.169.0`
* **WebGL1-only browsers** → `three@0.160.1` (the last line with WebGL1 support; r163 dropped it)

Each is loaded from the first reachable pinned CDN — `unpkg.com`, then `cdn.jsdelivr.net`,
then `fastly.jsdelivr.net` — and the import map is injected before the first module load.
Overrides for debugging: `?three=0.160.1` and `?cdn=https://unpkg.com/three@0.160.1/`.

## Troubleshooting “Viewer unavailable”

The error panel names the failing stage; `window.__HX9_DIAG__` (console) holds
`{ stage, webgl, gpu, version, cdn, tried, messages }` and
`window.__HX9_PROBE__.diagnostics()` returns the same snapshot after boot.

| Panel title | Meaning | Fix |
| --- | --- | --- |
| **WebGL unavailable** | The browser gave no WebGL context at all | Enable hardware acceleration (`chrome://gpu`, Firefox `webgl.disabled=false`); a GPU-less remote/VM browser may need `--enable-unsafe-swiftshader` |
| **WebGL could not be initialised** | A context existed but Three.js rejected it | Usually WebGL2 missing — the loader then pins `three@0.160.1` automatically; check `__HX9_DIAG__.webgl` |
| **Module load failed** / **Start-up timed out** | The pinned CDN is unreachable (offline machine, proxy, blocked domain) | Check the Network tab; `__HX9_DIAG__.tried` lists the probed URLs |
| **Start-up error** / **Viewer failed to start** | An exception in the viewer code; stage + stack are shown | Report the panel detail text |


## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic shell, import map, control/telemetry markup, boot watchdog |
| `styles.css` | Technical UI styling, focus treatment, responsive + reduced-motion rules |
| `src/main.js` | Renderer, hangar scene, lighting rig, camera presets, picking, diagnostics |
| `src/vehicle.js` | Hierarchical aircraft assembly (lofted hull/wings/blades, mechanisms, decals, hotspots) |
| `src/materials.js` | Seeded RNG, procedural CanvasTextures, PBR material families, PMREM environment |
| `src/animation.js` | State machine, constraint layer, frame-rate-independent motion, exploded view |
| `src/ui.js` | DOM wiring, keyboard shortcuts, telemetry, hotspot card, help dialog |

## Aircraft

Composite construction rather than modified primitives: the fuselage, wings, tail surfaces,
rotor blades and water sponsons are custom lofted `BufferGeometry` built from interpolated
station curves, with duplicated crease vertices so the chine, keel and trailing edges stay
crisp. Chamfered structural panels come from `ExtrudeGeometry` with a bevel; cowlings, hubs,
oleos, wheels, hooks and probes are `LatheGeometry`; strakes, rails, grab handles and canopy
framing are swept `TubeGeometry`. Repeated hardware (fasteners, louvres, hangar beams) is
instanced, and static parts are merged per material to hold draw calls down.

Assemblies: tapered hull with boat-like planing bottom and double chine · framed two-seat
cockpit with tinted canopy, dashboard, seats, headrests and control columns · short cabin
with sliding starboard rescue door, recessed floor, fold-down seats, litter, grab rails and
ceiling lights · shoulder wings with root fairings, layered panels, flaperon hinge line and
navigation lights · two tilting nacelles (housing, intake lip, dark internal cavity, exhaust
mixer, trunnion pivot hardware, louvres, warning band) · two five-blade rotors with hubs,
cuffs, pitch links and a motion disc at speed · retractable tricycle gear with paired wheels,
oleos, hubs, tyres and sequenced doors · retractable water sponsons · rescue hoist with boom,
drum, cable, hook and basket · gimballed nose sensor turret with three lenses and status LEDs ·
antennas, pitot probes, steps, handles, vents, access covers, seams and procedural decals
(HX-9 wordmark, chevrons, caution stripes, door arrow, maintenance labels, panel IDs, and
asymmetric wear on the working starboard side only).

Scene: original coastal rescue hangar at dusk — segmented floor, dashed landing-pad markings,
ribbed rear and side walls, instanced roof beams and columns, low-detail service props, and an
opening onto water and sky. Lighting is a warm key (single shadow caster), cool exterior fill,
rim light, warm practicals and emissive accents, with a clearly different **night inspection**
mode adding cool inspection spots and dimming the ambient/dusk contribution.

## Controls

| Key | Action |
| --- | --- |
| `1`–`6` | State: ground, hover, transition, cruise, rescue, maintenance |
| `F` / `L` / `R` | Camera: front, port beam, starboard rescue door |
| `O` / `K` / `N` | Camera: overhead, cockpit, winch |
| `G` | Cycle lighting mode (dusk ⇄ night inspection) |
| `[` / `]` | Exploded view −/+ (maintenance only) |
| `↑` / `↓` | Hoist cable raise / lower (rescue only) |
| `B` | Deploy or stow the hoist boom |
| `,` / `.` | Point sensor turret left / right |
| `S` | Toggle automatic turret scan |
| `Space` | Pause / resume |
| `X` | Deterministic reset |
| `M` | Toggle reduced motion |
| `H` or `?` | Help dialog |
| `Esc` | Dismiss hotspot card / help |

Mouse: drag to orbit, wheel to zoom, right-drag to pan (damped `OrbitControls` with distance
and polar limits). Click a cyan hotspot marker, or use the hotspot list, to focus a component.

## States and invariants

`ground` · `hover` · `transition` · `cruise` · `rescue` · `maintenance` are targets of one
scalar set; a new state may be selected at any point mid-transition. The constraint layer
enforces: gear doors open before the gear extends and close only after it is stowed; the hoist
cable extends only in `rescue` with the door open and boom out; the exploded view exists only
in `maintenance`, and any explode separation forces rotor speed to zero. Motion is integrated
from a delta time capped at 50 ms, so pause/resume introduces no time jump, and light timing
uses the animation clock rather than wall time. Exploded transforms are written absolutely
from stored authored bases, so returning the slider to 0 restores the original transforms
exactly (checked by `validate()`).

## Diagnostics

`window.__HX9_PROBE__` exposes `getState()`, `setState(name)`, `setExplode(0…1)`,
`focusHotspot(id)`, `reset()`, `validate()`, plus `states`, `cameras`, `hotspots`,
`setLighting(mode)` and `setPaused(bool)`. `validate()` returns
`{ ok, errors, warnings, metrics }` without mutating the scene and checks required named
assemblies, finite transforms, unique attached hotspot IDs, legal state combinations,
explode-zero restoration, renderer/camera readiness and scene metrics (draw calls, triangles,
geometries, textures, FPS). Budget warnings (>350 000 triangles, >180 draw calls) are reported
as warnings, never as failures.

## Accessibility

Semantic landmarks, fieldsets with legends, `aria-pressed` toggles, `role="status"` telemetry,
`aria-live` hotspot card, a native `<dialog>` for help, a skip link, visible `:focus-visible`
outlines, full keyboard operation, and `prefers-reduced-motion` support (honoured on load and
toggleable, disabling idle vibration and camera easing). No essential information is presented
only inside the canvas.

## Verification status

Verified by executing the modules against the real Three.js library in Node (with a stubbed
2D canvas, since `PMREMGenerator` needs a GPU): `createMaterials()`, `buildVehicle()`,
`createAnimator()`, all six states driven for 300 frames each, `setExplode(1)` → `setExplode(0)`
(drift **0**), `reset()`, and `buildHangar()`. Measured on **three r160 and r169**:
**126 drawable objects, 37 974 aircraft triangles, 620 hangar triangles**, no non-finite
vertices, `legality()` clean, 15 hotspots all attached, no missing named assemblies.

Also verified: ES-module parse of all five modules, HTTP 200 delivery of every file, DOM id
contract (44 referenced ids, none missing), material keys (42 referenced, all defined), and
that `Math.random` is never used.

**Still unverified:** anything requiring a real GPU — WebGL context creation, the PMREM
environment pass, shadow rendering, live `validate()` output, measured draw calls/FPS, and all
visual judgements (proportions, exposure, decal seating). No browser exists in the build
environment. Open the page and run `window.__HX9_PROBE__.validate()` to complete verification.

## Assumptions

* Pinned CDN is `unpkg.com/three@0.169.0`; `three` and `three/addons/` resolve via import map.
* “Run `a`” affects only this output directory name; the internal seed is `HX9-FABLE-PROBE`
  and is identical for runs `a` and `b`.
* One unit = one metre; the aircraft is ≈ 6.8 m long with a ≈ 6.6 m tip-to-tip wing span.
* Ground rotor state is a slow idle (≈ 24 rpm) rather than fully stopped, which the state
  legality checks treat as “stopped or idling”.
