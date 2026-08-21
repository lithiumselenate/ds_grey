// main.js — renderer, hangar environment, cameras, interaction, diagnostics.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRng, createMaterials, SEED_STRING } from './materials.js';
import { buildVehicle } from './vehicle.js';
import { Animator, STATE_ORDER, STATE_DEFS } from './animation.js';
import { initUI } from './ui.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const CAMERA_PRESETS = {
  threeq: { pos: [8.8, 4.4, 9.2], tgt: [0, 1.7, 0.2] },
  front: { pos: [0.4, 2.4, 13.5], tgt: [0, 1.8, 0] },
  port: { pos: [-12.5, 2.8, 0.6], tgt: [0, 1.8, 0] },
  door: { pos: [8.2, 2.8, 2.6], tgt: [1.0, 1.6, 0.6] },
  top: { pos: [0.2, 18.5, 0.8], tgt: [0, 1.5, 0] },
  cockpit: { pos: [3.4, 3.2, 7.8], tgt: [0, 2.0, 3.0] },
  winch: { pos: [5.4, 4.2, 3.6], tgt: [1.6, 1.8, 0.8] },
};

export async function boot() {
  const container = document.getElementById('viewport');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no context');
  } catch (err) {
    throw new Error(`WebGL initialization failed: ${err.message || err}`);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const runtimeErrors = [];
  window.addEventListener('error', (e) => runtimeErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => runtimeErrors.push(String(e.reason)));
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    window.__HX9_BOOT_FAIL__ && window.__HX9_BOOT_FAIL__('WebGL context lost', 'The GPU context was lost. Reload the page.');
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);
  scene.fog = new THREE.Fog(0x151b23, 26, 70);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 140);

  // ---- deterministic content --------------------------------------------
  const rng = createRng(SEED_STRING);
  const M = createMaterials(rng, renderer.capabilities.getMaxAnisotropy
    ? renderer.capabilities.getMaxAnisotropy() : 4);
  const vehicle = buildVehicle(M, rng);
  vehicle.root.position.y = vehicle.baseY;
  scene.add(vehicle.root);
  const anim = new Animator(vehicle, M);

  // ---- hangar environment -------------------------------------------------
  const lightsRig = buildEnvironment(scene, M, rng);

  // ---- hotspot markers (single InstancedMesh, tracks components) ----------
  const markerGeo = new THREE.SphereGeometry(0.055, 10, 8);
  const markers = new THREE.InstancedMesh(markerGeo, M.marker, vehicle.hotspots.length);
  markers.name = 'hotspotMarkers';
  markers.renderOrder = 6;
  scene.add(markers);
  const _m4 = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  let activeHotspot = null;
  function updateMarkers() {
    for (let i = 0; i < vehicle.hotspots.length; i++) {
      const h = vehicle.hotspots[i];
      h.anchor.getWorldPosition(_p);
      const sc = (h.id === activeHotspot) ? 1.7 : 1.0;
      _s.set(sc, sc, sc);
      _q.identity();
      _m4.compose(_p, _q, _s);
      markers.setMatrixAt(i, _m4);
    }
    markers.instanceMatrix.needsUpdate = true;
  }

  // ---- controls + camera tween -------------------------------------------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 34;
  controls.maxPolarAngle = 1.53;
  let activeCamera = 'threeq';
  const tween = { active: false, t: 0, dur: 1.1, fromP: V3(), toP: V3(), fromT: V3(), toT: V3() };
  function flyTo(pos, tgt, instant) {
    if (instant || reducedMotion) {
      camera.position.copy(pos);
      controls.target.copy(tgt);
      tween.active = false;
      controls.update();
      return;
    }
    tween.active = true; tween.t = 0;
    tween.fromP.copy(camera.position); tween.toP.copy(pos);
    tween.fromT.copy(controls.target); tween.toT.copy(tgt);
  }
  function setCamera(name, instant = false) {
    const p = CAMERA_PRESETS[name];
    if (!p) return false;
    activeCamera = name;
    flyTo(V3(...p.pos), V3(...p.tgt), instant);
    return true;
  }

  // ---- state / app facade --------------------------------------------------
  let paused = false;
  let reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  anim.reducedMotion = reducedMotion;
  let lightingMode = 'day';
  function setLighting(mode) {
    if (mode !== 'day' && mode !== 'night') return false;
    lightingMode = mode;
    lightsRig.apply(mode, renderer);
    anim.emissiveBoost = mode === 'night' ? 1.7 : 1;
    return true;
  }

  const lastMetrics = { calls: 0, tris: 0, fps: 0 };
  const fpsBuf = [];

  function step(dt) {
    anim.update(dt);
    anim.apply();
    updateMarkers();
  }

  function focusHotspot(id) {
    const h = vehicle.hotspots.find((x) => x.id === id);
    if (!h) return false;
    activeHotspot = id;
    ui.showCard(h);
    h.anchor.getWorldPosition(_p);
    const dir = V3().copy(camera.position).sub(_p);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.3, 1);
    dir.normalize();
    dir.y = Math.max(dir.y, 0.12);
    dir.normalize();
    const pos = V3().copy(_p).addScaledVector(dir, h.dist);
    flyTo(pos, _p.clone(), false);
    return true;
  }
  function clearHotspot() {
    activeHotspot = null;
    ui.showCard(null);
  }

  function reset() {
    anim.reset();
    anim.apply();
    updateMarkers();
    clearHotspot();
    setLighting('day');
    paused = false;
    setCamera('threeq', true);
    ui.refresh();
  }

  const app = {
    stateNames: STATE_ORDER,
    cameraNames: Object.keys(CAMERA_PRESETS),
    hotspots: vehicle.hotspots.map((h) => ({ id: h.id, title: h.title, body: h.body })),
    anim,
    step,
    setState: (n) => { const ok = anim.setState(n); ui.refresh(); return ok; },
    getStateName: () => anim.state,
    isSettled: () => anim.isSettled(),
    setCamera: (n, instant = false) => { const ok = setCamera(n, instant); ui.refresh(); return ok; },
    activeCamera: () => activeCamera,
    setLighting: (m) => { const ok = setLighting(m); ui.refresh(); return ok; },
    lightingMode: () => lightingMode,
    canExplode: () => anim.canExplode(),
    setExplode: (v) => { const ok = anim.setExplode(v); ui.refresh(); return ok; },
    getExplode: () => anim.userExplode,
    winchAvailable: () => anim.state === 'rescue' && anim.ch.door.v > 0.95,
    winchNudge: (d) => anim.setCable(anim.userCable + d),
    winchSet: (v) => anim.setCable(v),
    cableMeters: () => THREE.MathUtils.lerp(0, 3.0, anim.ch.cable.v),
    turretAuto: () => anim.turret.auto,
    setTurret: (auto, yaw, pitch) => { anim.turret = { auto, yaw: yaw || 0, pitch: pitch || -0.2 }; },
    pause: (p) => { paused = !!p; ui.refresh(); },
    isPaused: () => paused,
    reset,
    reducedMotion: () => reducedMotion,
    setReducedMotion: (v) => { reducedMotion = !!v; anim.reducedMotion = reducedMotion; },
    focusHotspot,
    clearHotspot,
    getActiveHotspot: () => activeHotspot,
    validate,
    getState: () => ({
      ...anim.snapshot(),
      paused,
      lighting: lightingMode,
      camera: activeCamera,
      hotspot: activeHotspot,
      reducedMotion,
      metrics: { ...lastMetrics },
    }),
  };

  const ui = initUI(app);

  // ---- picking -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
    downXY = null;
    if (moved > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(markers, false);
    if (hits.length && hits[0].instanceId !== undefined) {
      focusHotspot(vehicle.hotspots[hits[0].instanceId].id);
    }
  });

  // ---- validation -----------------------------------------------------------
  const REQUIRED = ['fuselage', 'canopy', 'cockpit', 'cabin', 'cabinDoor', 'wingR', 'wingL',
    'nacelleR', 'nacelleL', 'rotorR', 'rotorL', 'gearNose', 'gearMainR', 'gearMainL',
    'gearDoorNoseR', 'gearDoorNoseL', 'gearDoorR', 'gearDoorL', 'sponsonR', 'sponsonL',
    'winch', 'winchArm', 'winchDrum', 'cable', 'hook', 'basket',
    'turretYaw', 'turretPitch', 'panelA', 'panelB', 'beacon'];
  const _vp = new THREE.Vector3();
  function validate() {
    const errors = [], warnings = [];
    for (const name of REQUIRED) {
      if (!vehicle.parts[name]) errors.push(`missing required assembly: ${name}`);
    }
    let badTransforms = 0;
    vehicle.root.traverse((o) => {
      const arr = [o.position.x, o.position.y, o.position.z,
        o.scale.x, o.scale.y, o.scale.z, o.rotation.x, o.rotation.y, o.rotation.z];
      if (!arr.every(Number.isFinite)) badTransforms++;
    });
    if (badTransforms) errors.push(`${badTransforms} object(s) with non-finite transforms`);
    const ids = new Set();
    for (const h of vehicle.hotspots) {
      if (ids.has(h.id)) errors.push(`duplicate hotspot id: ${h.id}`);
      ids.add(h.id);
    }
    if (ids.size < 10) errors.push(`only ${ids.size} hotspots (need >= 10)`);
    const c = anim.ch;
    if (c.cable.v > 0.05 && c.door.v < 0.9) errors.push('cable deployed through closed door');
    if (c.gear.v > 0.05 && c.gearDoors.v < 0.9) errors.push('gear extended inside closed gear doors');
    if (c.explode.v > 0.02 && c.rpm.v > 0.02) errors.push('exploded view with rotors operating');
    if (c.explode.v > 0.02 && anim.state !== 'maintenance') errors.push('exploded view outside maintenance');
    // exact restoration check (non-mutating): recompute expected positions
    let drift = 0;
    for (const e of anim.posList) {
      anim.computePos(e, _vp);
      if (_vp.distanceToSquared(e.node.position) > 1e-10) drift++;
    }
    if (drift) errors.push(`${drift} node(s) deviate from authored pose model`);
    if (c.explode.v === 0) {
      let hd = 0;
      for (const e of anim.posList) {
        if (!e.binds.length && e.ex && e.node.position.distanceToSquared(e.home) > 1e-10) hd++;
      }
      if (hd) errors.push(`${hd} explodable(s) not restored at explode=0`);
    }
    if (!renderer.getContext() || renderer.getContext().isContextLost()) {
      errors.push('renderer context lost or missing');
    }
    if (!Number.isFinite(camera.position.x)) errors.push('camera position not finite');
    if (lastMetrics.calls > 180) warnings.push(`draw calls ${lastMetrics.calls} > 180 budget`);
    if (lastMetrics.tris > 350000) warnings.push(`triangles ${lastMetrics.tris} > 350k budget`);
    if (runtimeErrors.length) warnings.push(`runtime errors captured: ${runtimeErrors.slice(0, 3).join(' | ')}`);
    if (lastMetrics.fps && lastMetrics.fps < 30) warnings.push(`fps ${lastMetrics.fps} < 30`);
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      metrics: {
        drawCalls: lastMetrics.calls,
        triangles: lastMetrics.tris,
        fps: lastMetrics.fps,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        hotspots: ids.size,
        seed: SEED_STRING,
      },
    };
  }

  // ---- diagnostics ----------------------------------------------------------
  const probe = Object.freeze({
    getState: () => app.getState(),
    setState: (name) => app.setState(name),
    setExplode: (v) => app.setExplode(v),
    focusHotspot: (id) => focusHotspot(id),
    reset: () => reset(),
    validate: () => validate(),
  });
  Object.defineProperty(window, '__HX9_PROBE__', { value: probe, writable: false });

  // ---- resize ---------------------------------------------------------------
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- initial pose ---------------------------------------------------------
  setCamera('threeq', true);
  setLighting('day');
  step(1 / 60);

  // ---- URL parameters (deterministic testing hooks) --------------------------
  const q = new URLSearchParams(location.search);
  if (q.get('light')) setLighting(q.get('light'));
  if (q.get('state')) app.setState(q.get('state'));
  const warp = parseFloat(q.get('warp') || '0');
  if (warp > 0) {
    const n = Math.min(Math.round(warp * 60), 60 * 120);
    for (let i = 0; i < n; i++) step(1 / 60);
  }
  if (q.get('explode')) { app.setExplode(parseFloat(q.get('explode'))); for (let i = 0; i < 300; i++) step(1 / 60); }
  if (q.get('camera')) setCamera(q.get('camera'), true);

  // ---- render loop ------------------------------------------------------------
  let last = performance.now();
  let uiClock = 0;
  const easeInOut = (x) => x * x * (3 - 2 * x);
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(Math.max(dt, 0), 0.05); // clamp: pause/tab-switch cause no jumps
    if (!paused) step(dt);
    if (tween.active) {
      tween.t += dt / tween.dur;
      if (tween.t >= 1) {
        tween.t = 1; tween.active = false;
      }
      const k = easeInOut(tween.t);
      camera.position.lerpVectors(tween.fromP, tween.toP, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
    }
    controls.update();
    renderer.render(scene, camera);
    lastMetrics.calls = renderer.info.render.calls;
    lastMetrics.tris = renderer.info.render.triangles;
    if (dt > 0) {
      fpsBuf.push(1 / dt);
      if (fpsBuf.length > 40) fpsBuf.shift();
      lastMetrics.fps = Math.round(fpsBuf.reduce((a, b) => a + b, 0) / fpsBuf.length);
    }
    uiClock += dt;
    if (uiClock > 0.25) {
      uiClock = 0;
      const s = anim.snapshot();
      const fmt = (v, up, dn) => (v > 0.98 ? up : v < 0.02 ? dn : 'CYCLING');
      ui.updateTelemetry({
        nacelleDeg: s.nacelleDeg,
        rotorRpm: s.rotorRpm,
        gear: fmt(anim.ch.gear.v, 'DOWN', 'UP'),
        sponson: fmt(anim.ch.sponson.v, 'DEPLOYED', 'STOWED'),
        door: fmt(anim.ch.door.v, 'OPEN', 'CLOSED'),
        cable: app.cableMeters(),
        camera: activeCamera,
        calls: lastMetrics.calls,
        tris: lastMetrics.tris,
        fps: lastMetrics.fps,
      });
      ui.refresh();
    }
  }
  requestAnimationFrame(frame);
  ui.refresh();

  if (q.has('selftest')) runSelfTest(app);
  return app;
}

// ---- procedural coastal hangar ------------------------------------------------
function buildEnvironment(scene, M, rng) {
  const env = new THREE.Group();
  env.name = 'hangar';
  scene.add(env);
  const add = (mesh, cast = false, recv = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    env.add(mesh);
    return mesh;
  };

  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(36, 36, 1, 1), M.concrete));
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';

  const mkWall = (w, h, x, y, z, ry = 0) => {
    const m = add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.wall), false, true);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    return m;
  };
  mkWall(13, 8, -11.5, 4, -13);      // rear wall, left of opening
  mkWall(13, 8, 11.5, 4, -13);       // rear wall, right of opening
  mkWall(10, 2.4, 0, 6.8, -13);      // header above the sea opening
  mkWall(26, 8, -18, 4, -0, Math.PI / 2); // port side wall

  const roof = add(new THREE.Mesh(new THREE.BoxGeometry(36, 0.3, 16), M.steel), false, false);
  roof.position.set(0, 8.1, -5);
  roof.name = 'roof';

  { // columns + trusses
    const cols = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 8, 0.4), M.steel, 8);
    const m4 = new THREE.Matrix4();
    const spots = [[-17.6, -10], [-17.6, -2], [-17.6, 6], [-12.8, -12.8],
      [12.8, -12.8], [17.6, -10], [17.6, -2], [17.6, 6]];
    spots.forEach(([x, z], i) => {
      m4.makeTranslation(x, 4, z);
      cols.setMatrixAt(i, m4);
    });
    cols.castShadow = false;
    env.add(cols);
    const truss = new THREE.InstancedMesh(new THREE.BoxGeometry(35, 0.5, 0.3), M.steel, 4);
    for (let i = 0; i < 4; i++) {
      m4.makeTranslation(0, 7.7, -12 + i * 4.5);
      truss.setMatrixAt(i, m4);
    }
    truss.castShadow = false;
    env.add(truss);
  }

  // sea opening: dusk sky + water
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(60, 22), M.sky);
  sky.position.set(0, 9, -34);
  sky.name = 'duskSky';
  env.add(sky);
  const water = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 24), M.water), false, false);
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.02, -25.5);
  water.name = 'water';

  { // service props
    const crates = new THREE.Group();
    crates.name = 'crates';
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.0), M.crate);
    c1.position.set(-7.6, 0.45, -8.6);
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.8), M.crate);
    c2.position.set(-7.3, 1.25, -8.5);
    c2.rotation.y = 0.4;
    for (const c of [c1, c2]) { c.castShadow = true; c.receiveShadow = true; crates.add(c); }
    env.add(crates);
    const cart = new THREE.Group();
    cart.name = 'serviceCart';
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.8), M.steel);
    body.position.y = 0.55;
    body.castShadow = true;
    cart.add(body);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.1, 12), M.paintOrange);
    tank.rotation.z = Math.PI / 2;
    tank.position.set(0, 1.05, 0);
    tank.castShadow = true;
    cart.add(tank);
    for (const [sx, sz] of [[0.55, 0.3], [0.55, -0.3], [-0.55, 0.3], [-0.55, -0.3]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 10), M.rubber);
      w.rotation.x = Math.PI / 2;
      w.position.set(sx, 0.12, sz);
      cart.add(w);
    }
    cart.position.set(7.2, 0, -9.4);
    cart.rotation.y = -0.5;
    env.add(cart);
    const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.16, 0.42, 10), M.paintOrange, 6);
    const m4 = new THREE.Matrix4();
    const conePos = [[-5.5, 5.5], [5.5, 5.5], [-6.5, -5], [6.5, -5], [-3, 8], [3, 8]];
    conePos.forEach(([x, z], i) => {
      m4.makeTranslation(x + (rng() - 0.5) * 0.4, 0.21, z + (rng() - 0.5) * 0.4);
      cones.setMatrixAt(i, m4);
    });
    cones.castShadow = true;
    env.add(cones);
    for (const sx of [-6.4, 6.4]) { // inspection tripods
      const tri = new THREE.Group();
      tri.name = 'tripod';
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), M.steel);
        leg.position.set(Math.cos(a) * 0.42, 1.1, Math.sin(a) * 0.42);
        leg.rotation.z = Math.cos(a) * 0.32;
        leg.rotation.x = -Math.sin(a) * 0.32;
        tri.add(leg);
      }
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.22), M.graphite);
      head.position.y = 2.35;
      tri.add(head);
      const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.14), M.cabinLight);
      lens.position.set(sx > 0 ? -0.18 : 0.18, 2.35, 0);
      lens.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      tri.add(lens);
      tri.position.set(sx, 0, 5.6);
      env.add(tri);
    }
  }

  // ---- lighting rig ----
  const hemi = new THREE.HemisphereLight(0x8fa3b8, 0x2a2622, 0.4);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe8cf, 2.2);
  key.position.set(9, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -10; key.shadow.camera.right = 10;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
  key.shadow.camera.near = 2; key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const dusk = new THREE.DirectionalLight(0x7fa0d8, 0.9);
  dusk.position.set(-4, 5, -14);
  scene.add(dusk);
  const pracs = [];
  for (const [x, z] of [[-8, -6], [0, -8], [8, -6]]) {
    const p = new THREE.PointLight(0xffb066, 30, 26, 2);
    p.position.set(x, 7.2, z);
    scene.add(p);
    pracs.push(p);
    const fix = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.18, 10), M.graphite);
    fix.position.set(x, 7.45, z);
    env.add(fix);
  }
  const spots = [];
  for (const sx of [-6.4, 6.4]) {
    const sp = new THREE.SpotLight(0xbfe9ff, 0, 30, 0.5, 0.45, 2);
    sp.position.set(sx, 2.4, 5.6);
    sp.target.position.set(0, 1.6, 0);
    scene.add(sp);
    scene.add(sp.target);
    spots.push(sp);
  }

  return {
    apply(mode, renderer) {
      const night = mode === 'night';
      hemi.intensity = night ? 0.08 : 0.4;
      key.intensity = night ? 0.12 : 2.2;
      dusk.intensity = night ? 0.3 : 0.9;
      for (const p of pracs) p.intensity = night ? 7 : 30;
      for (const s of spots) s.intensity = night ? 260 : 0;
      M.sky.color.setHex(night ? 0x55607a : 0xffffff);
      scene.background.setHex(night ? 0x080b10 : 0x10151c);
      scene.fog.color.setHex(night ? 0x0a0e14 : 0x151b23);
      renderer.toneMappingExposure = night ? 1.0 : 1.12;
    },
  };
}

// ---- deterministic scripted self-test (?selftest=1) ---------------------------
function runSelfTest(app) {
  const out = [];
  const okv = (name, cond) => out.push({ check: name, ok: !!cond });
  const step = (sec) => {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) app.step(1 / 60);
  };
  try {
    for (const s of app.stateNames) {
      app.setState(s);
      step(16);
      const val = app.validate();
      okv(`state:${s}:valid`, val.ok);
      okv(`state:${s}:settled`, app.isSettled());
    }
    app.setState('maintenance'); step(16);
    for (const e of [0.5, 1, 0]) {
      app.setExplode(e); step(4);
      okv(`explode:${e}`, Math.abs(app.getExplode() - e) < 0.02 && app.validate().ok);
    }
    app.setState('hover'); step(16);
    okv('explode-denied-in-hover', app.setExplode(0.5) === false && app.anim.ch.explode.v < 0.02);
    app.setExplode(0);
    app.setState('rescue'); step(18);
    app.winchSet(1); step(12);
    okv('winch-lowered-in-rescue', app.anim.ch.cable.v > 0.9);
    app.winchSet(0); step(12);
    okv('winch-recovered', app.anim.ch.cable.v < 0.05);
    for (const h of app.hotspots.slice(0, 4)) {
      app.focusHotspot(h.id); step(2);
      okv(`hotspot:${h.id}`, app.getActiveHotspot() === h.id);
    }
    app.clearHotspot();
    app.setLighting('night'); okv('lighting-night', app.lightingMode() === 'night');
    app.setLighting('day'); okv('lighting-day', app.lightingMode() === 'day');
    for (const c of ['front', 'port', 'top', 'door']) {
      app.setCamera(c, true);
      okv(`camera:${c}`, app.activeCamera() === c);
    }
    app.pause(true); okv('paused', app.isPaused());
    app.pause(false); okv('resumed', !app.isPaused());
    app.reset();
    const snap = app.getState();
    okv('reset', snap.state === 'ground' && snap.channels.explode < 0.001
      && app.activeCamera() === 'threeq' && snap.lighting === 'day');
  } catch (err) {
    out.push({ check: `exception:${err.message}`, ok: false });
  }
  const fails = out.filter((o) => !o.ok);
  const summary = { ok: fails.length === 0, total: out.length, fails, validate: app.validate() };
  const el = document.getElementById('selftest-out');
  el.hidden = false;
  el.textContent = 'HX9-SELFTEST ' + JSON.stringify(summary, null, 1);
  console.log('HX9-SELFTEST', JSON.stringify(summary));
}
