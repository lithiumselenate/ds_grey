/**
 * main.js — renderer, coastal hangar scene, lighting rig, camera work,
 * hotspot picking, telemetry loop and the read-only diagnostic interface
 * for the Asterion HX-9 prototype viewer.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Assets, makeRNG, SEED_STRING, hashSeed } from './materials.js';
import { buildVehicle, REQUIRED_ASSEMBLIES, chamferedSlab } from './vehicle.js';
import { Animator, STATES, STATE_NAMES, CABLE_MAX } from './animation.js';
import { UI } from './ui.js';

const HALF_PI = Math.PI / 2;

const CAMERAS = {
  threequarter: { pos: [7.4, 3.8, 7.1], target: [0.1, 1.45, 0.2] },
  front: { pos: [12.4, 2.3, 0.7], target: [0.5, 1.55, 0] },
  port: { pos: [0.2, 2.1, -11.8], target: [0, 1.5, 0] },
  starboard: { pos: [1.7, 2.4, 8.0], target: [0.25, 1.3, 1.1] },
  top: { pos: [0.9, 13.8, 0.6], target: [0, 1.1, 0] },
  cockpit: { pos: [6.3, 3.05, 2.7], target: [2.6, 2.05, 0] },
  winch: { pos: [1.1, 3.4, 5.5], target: [-0.1, 1.5, 2.1] }
};

const LIGHT_MODES = ['dusk', 'night'];

function fail(title, detail) {
  if (typeof window.__HX9_FATAL__ === 'function') window.__HX9_FATAL__(title, detail);
  else console.error(title, detail);
}

/* ------------------------------------------------------------------ */
/* hangar                                                              */
/* ------------------------------------------------------------------ */

function buildHangar(A, rng) {
  const g = new THREE.Group();
  g.name = 'hangar';

  const floorGeo = new THREE.PlaneGeometry(46, 46);
  const floor = new THREE.Mesh(floorGeo, A.mats.deck);
  floor.name = 'hangar_floor';
  floor.rotation.x = -HALF_PI;
  floor.receiveShadow = true;
  g.add(floor);

  /* expansion joints: one instanced strip set reads as a segmented deck */
  const joint = new THREE.InstancedMesh(chamferedSlab(30, 0.09, 0.02, 0.01), A.mats.structureDark, 10);
  joint.name = 'deck_joints';
  joint.receiveShadow = true;
  joint.castShadow = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 10; i++) {
    const along = i < 5;
    const off = ((i % 5) - 2) * 7.4;
    e.set(-HALF_PI, along ? 0 : HALF_PI, 0);
    q.setFromEuler(e);
    p.set(along ? 0 : off, 0.012, along ? off : 0);
    m4.compose(p, q, s);
    joint.setMatrixAt(i, m4);
  }
  joint.instanceMatrix.needsUpdate = true;
  g.add(joint);

  /* rear service wall and side walls */
  const rear = new THREE.Mesh(chamferedSlab(30, 9.5, 0.5, 0.2), A.mats.wall);
  rear.name = 'service_wall';
  rear.position.set(-15, 4.75, 0);
  rear.rotation.y = HALF_PI;
  rear.receiveShadow = true;
  g.add(rear);
  [1, -1].forEach((sd, i) => {
    const w = new THREE.Mesh(chamferedSlab(30, 9.5, 0.5, 0.2), A.mats.wall);
    w.name = `side_wall_${i}`;
    w.position.set(-1, 4.75, sd * 14);
    w.receiveShadow = true;
    g.add(w);
  });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), A.mats.structureDark);
  ceil.name = 'hangar_ceiling';
  ceil.position.set(-1, 9.4, 0);
  ceil.rotation.x = HALF_PI;
  g.add(ceil);

  /* roof trusses: instanced I-beam bars */
  const beam = new THREE.InstancedMesh(chamferedSlab(28.5, 0.42, 0.3, 0.06), A.mats.structure, 12);
  beam.name = 'roof_beams';
  beam.castShadow = false;
  for (let i = 0; i < 12; i++) {
    if (i < 5) {
      e.set(0, HALF_PI, 0);
      q.setFromEuler(e);
      p.set(-1, 8.9, (i - 2) * 6.2);
    } else if (i < 9) {
      e.set(0, 0, 0);
      q.setFromEuler(e);
      p.set(-1, 8.4, (i - 7) * 8.0);
      s.set(1, 1, 1);
    } else {
      e.set(0, HALF_PI, 0.42 * (i % 2 ? 1 : -1));
      q.setFromEuler(e);
      p.set(-11 + (i - 9) * 9, 6.2, (i % 2 ? 1 : -1) * 9.2);
      s.set(0.42, 1, 1);
    }
    m4.compose(p, q, s);
    beam.setMatrixAt(i, m4);
    s.set(1, 1, 1);
  }
  beam.instanceMatrix.needsUpdate = true;
  g.add(beam);

  /* front opening: two pillars and a lintel frame the dusk exterior */
  const pillarGeo = chamferedSlab(3.2, 9.5, 0.6, 0.12);
  [1, -1].forEach((sd, i) => {
    const pl = new THREE.Mesh(pillarGeo, A.mats.wall);
    pl.name = `opening_pillar_${i}`;
    pl.position.set(13.4, 4.75, sd * 8.2);
    pl.rotation.y = HALF_PI;
    pl.receiveShadow = true;
    g.add(pl);
  });
  const lintel = new THREE.Mesh(chamferedSlab(17, 2.6, 0.6, 0.12), A.mats.wall);
  lintel.name = 'opening_lintel';
  lintel.position.set(13.4, 8.1, 0);
  lintel.rotation.y = HALF_PI;
  g.add(lintel);

  /* exterior: sky-over-water backdrop plus a dark water plane */
  const back = new THREE.Mesh(new THREE.PlaneGeometry(72, 30), A.mats.exterior);
  back.name = 'exterior_backdrop';
  back.position.set(34, 9, 0);
  back.rotation.y = -HALF_PI;
  g.add(back);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(44, 40), new THREE.MeshStandardMaterial({
    color: 0x1b2a33, metalness: 0.5, roughness: 0.22
  }));
  water.name = 'exterior_water';
  water.position.set(34, -0.12, 0);
  water.rotation.x = -HALF_PI;
  g.add(water);
  A.materials.push(water.material);

  /* practical hangar lamp housings (emissive, no extra shadow casters) */
  const lamp = new THREE.InstancedMesh(chamferedSlab(1.7, 0.5, 0.22, 0.06), A.mats.propWarn, 6);
  lamp.name = 'practical_lamps';
  for (let i = 0; i < 6; i++) {
    e.set(HALF_PI, 0, 0);
    q.setFromEuler(e);
    p.set(-9 + (i % 3) * 8, 8.5, i < 3 ? 5.4 : -5.4);
    m4.compose(p, q, s);
    lamp.setMatrixAt(i, m4);
  }
  lamp.instanceMatrix.needsUpdate = true;
  g.add(lamp);

  /* low-detail service props, deterministic placement */
  const props = new THREE.Group();
  props.name = 'service_props';
  const cart = new THREE.Mesh(chamferedSlab(1.5, 0.85, 0.8, 0.08), A.mats.propPaint);
  cart.name = 'tool_cart';
  cart.position.set(-6.4, 0.44, 5.6);
  cart.rotation.y = 0.4;
  cart.castShadow = true;
  props.add(cart);
  const crate = new THREE.Mesh(chamferedSlab(1.2, 0.7, 1.0, 0.06), A.mats.propPaint);
  crate.name = 'service_crate';
  crate.position.set(-8.2, 0.36, -4.4);
  crate.rotation.y = -0.25;
  crate.castShadow = true;
  props.add(crate);
  const drumGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 16);
  const drums = new THREE.InstancedMesh(drumGeo, A.mats.propWarn, 3);
  drums.name = 'fluid_drums';
  drums.castShadow = true;
  for (let i = 0; i < 3; i++) {
    p.set(-10.4 + i * 0.75, 0.46, 3.6 + (i % 2) * 0.7);
    q.identity();
    m4.compose(p, q, s);
    drums.setMatrixAt(i, m4);
  }
  drums.instanceMatrix.needsUpdate = true;
  props.add(drums);
  const stand = new THREE.Mesh(chamferedSlab(0.9, 1.6, 0.9, 0.06), A.mats.structure);
  stand.name = 'maintenance_stand';
  stand.position.set(-4.6, 0.8, -5.8);
  stand.castShadow = true;
  props.add(stand);
  const reel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.16, 8, 16), A.mats.propPaint);
  reel.name = 'cable_reel';
  reel.position.set(-11.6, 0.52, -1.4);
  reel.rotation.y = 0.5;
  reel.castShadow = true;
  props.add(reel);
  g.add(props);

  return g;
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  const canvas = document.getElementById('view');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    fail('WebGL could not be initialised', String((err && err.message) || err));
    return;
  }
  if (!renderer.getContext()) {
    fail('WebGL context unavailable', 'The browser returned no drawing context. Enable hardware acceleration and retry.');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const rng = makeRNG(SEED_STRING);
  const assets = new Assets(rng, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.name = 'HX9_scene';
  scene.background = new THREE.Color(0x0a1016);
  scene.fog = new THREE.Fog(0x101922, 30, 88);

  /* procedural PMREM environment from the seeded dusk gradient */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(assets.tex.envSource);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();
  assets.tex.envSource.dispose();

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 320);
  camera.position.fromArray(CAMERAS.threequarter.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.target.fromArray(CAMERAS.threequarter.target);
  controls.minDistance = 2.2;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minPolarAngle = 0.08;
  controls.panSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.update();

  scene.add(buildHangar(assets, rng));

  const built = buildVehicle(assets, rng);
  scene.add(built.root);
  const animator = new Animator(assets, built.refs, built.explodeGroups, built.hotspots);

  /* ---------------- lighting rig ---------------- */

  const hemi = new THREE.HemisphereLight(0x39536e, 0x2b2622, 0.55);
  hemi.name = 'fill_hemisphere';
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffe3c2, 2.1);
  key.name = 'key_light';
  key.position.set(8.5, 11.5, 9.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const exterior = new THREE.DirectionalLight(0x93bcdd, 1.15);
  exterior.name = 'exterior_light';
  exterior.position.set(20, 4.5, 2);
  scene.add(exterior);

  const practicals = [];
  [[2.5, 5.4], [-7.5, -5.4]].forEach((xz, i) => {
    const pl = new THREE.PointLight(0xffb877, 46, 30, 2);
    pl.name = `practical_${i}`;
    pl.position.set(xz[0], 8.2, xz[1]);
    scene.add(pl);
    practicals.push(pl);
  });

  const inspect = new THREE.SpotLight(0xdcefff, 0, 26, 0.55, 0.55, 1.6);
  inspect.name = 'inspection_light';
  inspect.position.set(6.5, 7.4, 6.0);
  inspect.target.position.set(0, 1.3, 0);
  inspect.castShadow = true;
  inspect.shadow.mapSize.set(1024, 1024);
  scene.add(inspect, inspect.target);

  let lightMode = 'dusk';
  function applyLighting(mode) {
    lightMode = LIGHT_MODES.includes(mode) ? mode : 'dusk';
    const night = lightMode === 'night';
    hemi.intensity = night ? 0.16 : 0.55;
    hemi.color.setHex(night ? 0x1c3550 : 0x39536e);
    key.intensity = night ? 0.34 : 2.1;
    key.color.setHex(night ? 0xbcd6ff : 0xffe3c2);
    exterior.intensity = night ? 0.42 : 1.15;
    practicals.forEach((pl) => { pl.intensity = night ? 12 : 46; });
    inspect.intensity = night ? 210 : 0;
    renderer.toneMappingExposure = night ? 0.95 : 1.05;
    scene.environmentIntensity = night ? 0.35 : 0.85;
    assets.mats.propWarn.emissive = assets.mats.propWarn.emissive || new THREE.Color();
    return lightMode;
  }
  applyLighting('dusk');

  /* ---------------- camera moves ---------------- */

  let activeCamera = 'threequarter';
  const tween = {
    active: false, t: 0, dur: 1.15,
    fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(),
    fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3()
  };
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  function moveCamera(pos, target, label) {
    tween.fromPos.copy(camera.position);
    tween.fromTgt.copy(controls.target);
    tween.toPos.copy(pos);
    tween.toTgt.copy(target);
    tween.t = 0;
    tween.dur = animator.reducedMotion ? 0.32 : 1.15;
    tween.active = true;
    if (label) { activeCamera = label; ui.setCamera(label); }
  }

  function setPreset(name) {
    const c = CAMERAS[name];
    if (!c) return false;
    ui.setHotspot(null);
    activeHotspot = null;
    moveCamera(tmpA.fromArray(c.pos), tmpB.fromArray(c.target), name);
    return true;
  }

  function updateTween(dt) {
    if (!tween.active) return;
    tween.t = Math.min(1, tween.t + dt / tween.dur);
    const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - Math.pow(-2 * tween.t + 2, 3) / 2;
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTgt, tween.toTgt, e);
    if (tween.t >= 1) tween.active = false;
  }

  /* ---------------- hotspots ---------------- */

  let activeHotspot = null;
  function focusHotspot(id) {
    const hs = built.hotspots.find((h) => h.id === id);
    if (!hs) return false;
    scene.updateMatrixWorld(true);
    hs.anchor.getWorldPosition(tmpA);
    tmpB.copy(tmpA).sub(built.root.position).setY(0);
    if (tmpB.lengthSq() < 0.04) tmpB.set(1, 0, 0.6);
    tmpB.normalize();
    tmpC.copy(tmpA).addScaledVector(tmpB, hs.dist).add(tmpA.clone().set(0, hs.dist * 0.34, 0));
    hs.anchor.getWorldPosition(tmpA);
    activeHotspot = hs.id;
    moveCamera(tmpC, tmpA, null);
    activeCamera = `hotspot:${hs.id}`;
    ui.setCamera(activeCamera);
    ui.setHotspot(hs);
    return true;
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    tween.active = false;
  });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 450;
    downAt = null;
    if (moved > 5 || !quick) return;
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(built.refs.markers, false);
    if (hit.length && hit[0].instanceId !== undefined) {
      const hs = built.hotspots[hit[0].instanceId];
      if (hs) focusHotspot(hs.id);
    }
  });

  /* ---------------- UI wiring ---------------- */

  let paused = false;
  const ui = new UI({
    onState: (name) => requestState(name),
    onCamera: (name) => setPreset(name),
    onLight: (mode) => { applyLighting(mode); ui.setLight(lightMode); },
    onLightCycle: () => {
      const next = LIGHT_MODES[(LIGHT_MODES.indexOf(lightMode) + 1) % LIGHT_MODES.length];
      applyLighting(next); ui.setLight(next);
    },
    onExplode: (v) => { ui.setExplodeValue(animator.setExplodeRequest(v)); },
    onExplodeToggle: () => {
      if (!animator.explodeAllowed()) return;
      const v = animator.explodeRequest > 0.02 ? 0 : 0.5;
      ui.setExplodeValue(animator.setExplodeRequest(v));
    },
    onHoist: (dir) => {
      const cur = animator.cableRequest;
      const next = dir === 0 ? 0 : Math.min(CABLE_MAX, Math.max(0, cur + dir * 0.35));
      animator.setCableRequest(next);
    },
    onSensor: (az, el) => {
      animator.autoScan = false;
      animator.sensorAz = az;
      animator.sensorEl = el;
      ui.setSensor(az, el, false);
    },
    onScan: (on) => { animator.autoScan = on; ui.setSensor(animator.sensorAz, animator.sensorEl, on); },
    onPause: () => { paused = !paused; ui.setPaused(paused); },
    onReset: () => resetAll(),
    onReducedMotion: (on) => {
      animator.reducedMotion = on;
      ui.setReducedMotion(on);
    },
    onHotspot: (id) => focusHotspot(id)
  });
  ui.buildHotspots(built.hotspots);
  ui.setCamera('threequarter');
  ui.setLight('dusk');
  ui.setSensor(animator.sensorAz, animator.sensorEl, animator.autoScan);
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animator.reducedMotion = true;
    ui.setReducedMotion(true);
  }

  function requestState(name) {
    if (!animator.setState(name)) return false;
    ui.setState(name);
    return true;
  }

  function resetAll() {
    animator.reducedMotion = animator.reducedMotion && false;
    animator.applyImmediate('ground');
    ui.setState('ground');
    ui.setExplodeValue(0);
    ui.setReducedMotion(false);
    ui.setHotspot(null);
    activeHotspot = null;
    applyLighting('dusk');
    ui.setLight('dusk');
    paused = false;
    ui.setPaused(false);
    ui.setSensor(animator.sensorAz, animator.sensorEl, animator.autoScan);
    camera.position.fromArray(CAMERAS.threequarter.pos);
    controls.target.fromArray(CAMERAS.threequarter.target);
    controls.update();
    tween.active = false;
    activeCamera = 'threequarter';
    ui.setCamera('threequarter');
  }

  /* ---------------- resize ---------------- */

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------------- loop ---------------- */

  const clock = new THREE.Clock();
  const perf = { fps: 0, calls: 0, triangles: 0 };
  const markerMatrix = new THREE.Matrix4();
  const markerScale = new THREE.Vector3(1, 1, 1);
  const markerQuat = new THREE.Quaternion();
  const worldPos = new THREE.Vector3();
  let lastGuiState = '';

  function updateMarkers() {
    const inst = built.refs.markers;
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    camera.getWorldDirection(tmpC);
    for (let i = 0; i < built.hotspots.length; i++) {
      const hs = built.hotspots[i];
      hs.anchor.getWorldPosition(worldPos);
      tmpA.copy(worldPos);
      inst.worldToLocal(tmpA);
      const active = activeHotspot === hs.id;
      markerScale.setScalar(active ? 1.5 : 1);
      markerMatrix.compose(tmpA, markerQuat, markerScale);
      inst.setMatrixAt(i, markerMatrix);

      tmpB.copy(worldPos).sub(camera.position);
      const front = tmpB.dot(tmpC) > 0.2;
      tmpA.copy(worldPos).project(camera);
      const vis = front && Math.abs(tmpA.x) < 1.05 && Math.abs(tmpA.y) < 1.05;
      ui.positionMarker(i, (tmpA.x * 0.5 + 0.5) * w, (-tmpA.y * 0.5 + 0.5) * h, vis, active);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  function frame() {
    const real = Math.min(0.1, clock.getDelta());
    const dt = paused ? 0 : real;
    animator.update(dt);
    updateTween(real);
    controls.update();
    scene.updateMatrixWorld(true);
    updateMarkers();
    renderer.render(scene, camera);

    perf.calls = renderer.info.render.calls;
    perf.triangles = renderer.info.render.triangles;
    if (real > 0) perf.fps = perf.fps * 0.9 + (1 / real) * 0.1;

    const snap = animator.snapshot();
    const now = performance.now();
    ui.setTelemetry(snap, perf, now);
    const label = snap.moving
      ? `Transitioning → ${snap.state}`
      : `Settled — ${snap.state}${snap.powered ? '' : ' (powered down)'}`;
    if (label !== lastGuiState) {
      ui.setTransition(label, snap.moving);
      lastGuiState = label;
    }
    ui.setExplodeEnabled(animator.explodeAllowed());
    ui.setHoistEnabled(animator.hoistAllowed());
    ui.setSensorEnabled(snap.powered);
    if (document.activeElement !== ui.el.explode) ui.setExplodeValue(animator.v.explode);
    if (animator.autoScan) ui.setSensor(animator.sensorAz, animator.sensorEl, true);

    requestAnimationFrame(frame);
  }

  ui.removeBoot();
  requestAnimationFrame(frame);

  /* ---------------- diagnostics ---------------- */

  function metrics() {
    return {
      drawCalls: perf.calls,
      triangles: perf.triangles,
      fps: +perf.fps.toFixed(1),
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      hotspots: built.hotspots.length,
      explodeGroups: built.explodeGroups.length,
      pixelRatio: renderer.getPixelRatio(),
      viewport: [renderer.domElement.clientWidth, renderer.domElement.clientHeight],
      seed: SEED_STRING,
      seedHash: hashSeed(SEED_STRING)
    };
  }

  function validate() {
    const errors = [];
    const warnings = [];

    for (const name of REQUIRED_ASSEMBLIES) {
      if (!built.root.getObjectByName(name)) errors.push(`missing required assembly: ${name}`);
    }

    let nonFinite = 0, meshes = 0, instanced = 0;
    built.root.traverse((o) => {
      const v = o.position.x + o.position.y + o.position.z +
        o.rotation.x + o.rotation.y + o.rotation.z +
        o.scale.x + o.scale.y + o.scale.z;
      if (!Number.isFinite(v)) { nonFinite++; if (nonFinite < 4) errors.push(`non-finite transform on ${o.name || o.type}`); }
      if (o.isInstancedMesh) instanced++;
      else if (o.isMesh) meshes++;
    });

    const ids = new Set();
    for (const hs of built.hotspots) {
      if (ids.has(hs.id)) errors.push(`duplicate hotspot id: ${hs.id}`);
      ids.add(hs.id);
      if (!hs.anchor.parent) errors.push(`detached hotspot anchor: ${hs.id}`);
      if (!hs.text || hs.text.length < 40) warnings.push(`thin hotspot description: ${hs.id}`);
    }
    if (built.hotspots.length < 10) errors.push(`only ${built.hotspots.length} hotspots (10 required)`);

    const legal = animator.legality();
    errors.push(...legal.errors);
    warnings.push(...legal.warnings);

    if (animator.v.explode <= 0) {
      for (const g of built.explodeGroups) {
        if (g.obj.position.distanceToSquared(g.base) > 1e-18) {
          errors.push(`explode base not restored: ${g.name}`);
        }
      }
    } else {
      warnings.push(`exploded view is at ${(animator.v.explode * 100).toFixed(0)}%; base restoration not asserted while separated`);
    }

    if (!renderer.getContext()) errors.push('renderer has no WebGL context');
    if (!camera.projectionMatrix || !Number.isFinite(camera.aspect)) errors.push('camera not ready');
    if (perf.calls === 0) warnings.push('no frame measured yet');
    if (perf.triangles > 350000) warnings.push(`triangle budget exceeded: ${perf.triangles}`);
    if (perf.calls > 180) warnings.push(`draw-call budget exceeded: ${perf.calls}`);
    if (meshes + instanced < 120) warnings.push('scene mesh count lower than expected for this model');

    const m = metrics();
    m.meshes = meshes;
    m.instancedMeshes = instanced;
    m.nonFiniteTransforms = nonFinite;

    return { ok: errors.length === 0, errors, warnings, metrics: m };
  }

  window.__HX9_PROBE__ = Object.freeze({
    version: '1.0.0',
    seed: SEED_STRING,
    states: STATE_NAMES.slice(),
    cameras: Object.keys(CAMERAS),
    lightModes: LIGHT_MODES.slice(),
    getState() {
      const snap = animator.snapshot();
      return {
        vehicle: snap,
        camera: {
          active: activeCamera,
          position: camera.position.toArray().map((n) => +n.toFixed(4)),
          target: controls.target.toArray().map((n) => +n.toFixed(4))
        },
        lighting: lightMode,
        paused,
        hotspot: activeHotspot,
        hotspotIds: built.hotspots.map((h) => h.id),
        metrics: metrics()
      };
    },
    setState(name) { return requestState(name); },
    setExplode(value) { const v = animator.setExplodeRequest(value); ui.setExplodeValue(v); return v; },
    focusHotspot(id) { return focusHotspot(id); },
    setCamera(name) { return setPreset(name); },
    setLighting(mode) { applyLighting(mode); ui.setLight(lightMode); return lightMode; },
    setPaused(v) { paused = !!v; ui.setPaused(paused); return paused; },
    setCable(metres) { return animator.setCableRequest(metres); },
    reset() { resetAll(); return true; },
    validate
  });

  window.addEventListener('beforeunload', () => {
    animator.dispose();
    scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) { if (o.geometry) o.geometry.dispose(); }
    });
    assets.dispose();
    envRT.dispose();
    renderer.dispose();
  });
}

try {
  boot();
} catch (err) {
  fail('Initialisation failed', String((err && err.stack) || err));
}
