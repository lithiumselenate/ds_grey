# Asterion HX-9 Amphibious Rescue Tiltrotor — Product Visualization

An entirely original, fictional coastal-rescue tiltrotor presented as an interactive
Three.js prototype viewer. All geometry, markings, text, UI and motion are procedural
and original; nothing is downloaded except the pinned Three.js modules.

## Run

Serve the folder over HTTP (ES modules do not load from `file://`):

```bash
cd fable_threejs_probe_a
python3 -m http.server 8000
# open http://127.0.0.1:8000/
```

Requires a modern desktop browser with WebGL2 and network access to the pinned CDN
(`three@0.160.0` via cdn.jsdelivr.net). WebGL or module-load failures show a visible
error panel instead of a blank page.

## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic UI shell, import map (pinned CDN), error panel |
| `styles.css` | Technical UI theme, focus states, responsive + reduced-motion rules |
| `src/main.js` | Renderer, hangar environment, lighting rigs, camera presets, picking, diagnostics, loop |
| `src/vehicle.js` | Lofted/lathed/extruded vehicle assembly, decals, hotspots, explode vectors |
| `src/materials.js` | Seeded RNG, procedural CanvasTextures, PBR material families |
| `src/animation.js` | Deterministic state machine, rate-limited channels, interlocks |
| `src/ui.js` | DOM bindings, keyboard shortcuts, ARIA sync, telemetry panel |

## States

`ground · hover · transition · cruise · rescue · maintenance` — selected from the top
bar or keys 1–6. Channels (nacelle tilt, rotor speed, gear, gear doors, sponsons,
cabin door, winch arm, cable, panels, power, explode) are rate-limited scalars, so
switching states mid-transition simply retargets them. Interlocks prevent impossible
combinations: cable requires door → arm; sponsons wait for gear; explode requires
maintenance with rotors stopped; the aircraft will not settle with gear up.

## Controls

| Key | Action |
| --- | --- |
| 1–6 | State select |
| C | Cycle camera presets (3/4, front, port, starboard door, top, cockpit, winch) |
| L | Dusk ↔ night-inspection lighting |
| Space | Pause / resume (no time jump) |
| R | Deterministic reset (state, camera, explode, lighting) |
| [ / ] | Exploded view − / + (maintenance only) |
| V | Winch cable down / up (rescue only) |
| M | Reduced motion |
| H / Esc | Help / close |

Click a cyan marker (or use the Hotspot list) to fly the camera to one of 12
components with an original description. Markers are parented to their assemblies,
so they track animation and the exploded view.

## Determinism & diagnostics

All visible randomness derives from a Mulberry32 stream seeded from the literal
`HX9-FABLE-PROBE`; reloads at the same viewport are identical. Read-only diagnostics:

```js
window.__HX9_PROBE__.getState()     // JSON snapshot
window.__HX9_PROBE__.setState('cruise')
window.__HX9_PROBE__.setExplode(0.5) // enforced: maintenance only
window.__HX9_PROBE__.focusHotspot('winch')
window.__HX9_PROBE__.reset()
window.__HX9_PROBE__.validate()     // { ok, errors, warnings, metrics }
```

`validate()` checks required named assemblies, finite transforms, unique hotspot ids,
legal state combinations, exact explode restoration, renderer/camera readiness, and
reports draw calls / triangles / fps as metrics (warnings are separate from errors).

Optional URL modes for automated checks: `?selftest` writes a JSON report into
`#selftest` and retitles the page; `?shot=rescue|maintenance` poses deterministic
views for screenshots.

## Performance

Shared geometries and materials; InstancedMesh for rotor blades, pitch links,
fasteners, hangar beams and light fixtures; no per-frame allocations in the hot
loop. Targets < 350k rendered triangles and < 180 draw calls on the initial camera;
live values appear in the telemetry panel and in `validate().metrics`.
