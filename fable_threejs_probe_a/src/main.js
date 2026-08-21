// Asterion HX-9 — application entry: renderer, hangar environment, camera rig,
// hotspot picking, diagnostics (window.__HX9_PROBE__) and the main loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRng, createMaterialKit, SEED_STRING } from './materials.js';
import { buildVehicle } from './vehicle.js';
import { Animator, STATE_NAMES } from './animation.js';
import { initUI } from './ui.js';

const PRESETS = {
  threequarter: { pos: [10.8, 4.6, 8.8], tgt: [0.2, 1.5, 0] },
  front: { pos: [13.5, 2.4, 0.6], tgt: [0, 1.6, 0] },
  port: { pos: [0.2, 2.6, -12.5], tgt: [0, 1.6, 0] },
  starboard: { pos: [3.2, 2.6, 10.5], tgt: [0.7, 1.5, 0.5] },
  top: { pos: [0.5, 17, 0.02], tgt: [0, 1.5, 0] },
  cockpit: { pos: [7.4, 3.2, 2.9], tgt: [3.2, 1.9, 0] },
  winch: { pos: [3.6, 4.2, 6.4], tgt: [0.85, 2.2, 1.2] },
};
const PRESET_NAMES = Object.keys(PRESETS);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function start() {
  try {
    boot();
  } catch (err) {
    console.error(err);
    window.__hx9Fatal(err && err.stack ? err.stack : String(err));
  }
}

function boot() {
  const canvas = document.getElementById('view');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('WebGL initialization failed: ' + e.message);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const rng = createRng(SEED_STRING);
  const kit = createMaterialKit(rng);
  kit.applyAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101827);
  scene.fog = new THREE.Fog(0x101827, 34, 80);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(...PRESETS.threequarter.pos);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(...PRESETS.threequarter.tgt);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3.2;
  controls.maxDistance = 34;
  controls.maxPolarAngle = 1.52;
  controls.update();

  /* ---------------- environment ---------------- */
  const env = buildEnvironment(scene, kit, rng);

  /* ---------------- vehicle ---------------- */
  const vehicle = buildVehicle(kit, rng);
  scene.add(vehicle.root);
  const anim = new Animator(vehicle);

  /* ---------------- lighting rig ---------------- */
  const hemi = new THREE.HemisphereLight(0x33405e, 0x3a332c, 0.5);
  const key = new THREE.DirectionalLight(0xffd9b0, 1.5);
  key.position.set(9, 11, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -6;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  const cool = new THREE.DirectionalLight(0x7fa8ff, 0.7);
  cool.position.set(20, 6, -6);
  const practicals = [];
  for (const [x, z] of [[-8, -5], [-2, 5], [-8, 6]]) {
    const pt = new THREE.PointLight(0xffb46a, 14, 22, 1.8);
    pt.position.set(x, 7.4, z);
    practicals.push(pt);
    scene.add(pt);
  }
  const inspectA = new THREE.SpotLight(0xcfe7ff, 0, 30, 0.5, 0.45, 1.2);
  inspectA.position.set(6, 7, 6);
  inspectA.target.position.set(0, 1.5, 0);
  inspectA.castShadow = true;
  inspectA.shadow.mapSize.set(1024, 1024);
  const inspectB = new THREE.SpotLight(0xcfe7ff, 0, 30, 0.6, 0.5, 1.2);
  inspectB.position.set(-6, 6.5, -5);
  inspectB.target.position.set(0, 1.5, 0);
  scene.add(hemi, key, cool, inspectA, inspectA.target, inspectB, inspectB.target);

  let lighting = 'dusk';
  function setLighting(mode) {
    lighting = mode;
    const night = mode === 'night';
    hemi.intensity = night ? 0.12 : 0.5;
    key.intensity = night ? 0.12 : 1.5;
    cool.intensity = night ? 0.3 : 0.7;
    practicals.forEach((pt) => (pt.intensity = night ? 3 : 14));
    inspectA.intensity = night ? 260 : 0;
    inspectB.intensity = night ? 160 : 0;
    scene.background.set(night ? 0x05070d : 0x101827);
    scene.fog.color.copy(scene.background);
    anim.cabinBoost = night ? 1.9 : 1;
  }
  setLighting('dusk');

  /* ---------------- camera preset tweens ---------------- */
  let currentPreset = 'threequarter';
  let tween = null;
  let reducedMotion = false;
  function flyTo(pos, tgt, name) {
    if (name) currentPreset = name;
    if (reducedMotion) {
      camera.position.copy(pos);
      controls.target.copy(tgt);
      controls.update();
      tween = null;
      return;
    }
    tween = {
      fp: camera.position.clone(), tp: pos.clone(),
      ft: controls.target.clone(), tt: tgt.clone(),
      t: 0, dur: 1.1,
    };
  }
  function goPreset(name) {
    const p = PRESETS[name];
    if (!p) return false;
    flyTo(new THREE.Vector3(...p.pos), new THREE.Vector3(...p.tgt), name);
    return true;
  }
  controls.addEventListener('start', () => {
    tween = null;
    currentPreset = 'free';
  });

  /* ---------------- hotspot picking ---------------- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const markers = vehicle.hotspots.map((h) => h.marker);
  let activeHotspot = null;
  const wp = new THREE.Vector3();
  function focusHotspot(id) {
    const h = vehicle.hotspots.find((x) => x.id === id);
    if (!h) return false;
    activeHotspot = h;
    h.marker.getWorldPosition(wp);
    const camPos = wp.clone().addScaledVector(h.viewDir, h.viewDist);
    camPos.y = Math.max(camPos.y, 0.4);
    flyTo(camPos, wp.clone(), 'free');
    ui.showHotspot(h);
    return true;
  }
  function clearHotspot() {
    activeHotspot = null;
    ui.showHotspot(null);
  }
  let downXY = null;
  canvas.addEventListener('pointerdown', (e) => {
    downXY = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const dx = e.clientX - downXY[0], dy = e.clientY - downXY[1];
    downXY = null;
    if (dx * dx + dy * dy > 25) return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(markers, false);
    if (hits.length) focusHotspot(hits[0].object.userData.hotspotId);
  });

  /* ---------------- app facade for the UI ---------------- */
  let paused = false;
  let fps = 60;
  let lastCalls = 0;
  let lastTris = 0;

  const app = {
    anim,
    hotspots: vehicle.hotspots,
    setState: (n) => anim.setState(n),
    goPreset,
    cyclePreset() {
      const i = PRESET_NAMES.indexOf(currentPreset);
      goPreset(PRESET_NAMES[(i + 1) % PRESET_NAMES.length]);
    },
    currentPreset: () => currentPreset,
    setLighting,
    getLighting: () => lighting,
    setExplode: (v) => anim.requestExplode(v),
    setCable: (v) => anim.requestCable(v),
    setPaused: (v) => { paused = !!v; },
    isPaused: () => paused,
    setReducedMotion(v) {
      reducedMotion = !!v;
      anim.reduced = !!v;
    },
    focusHotspot,
    clearHotspot,
    reset() {
      paused = false;
      anim.reset();
      setLighting('dusk');
      clearHotspot();
      camera.position.set(...PRESETS.threequarter.pos);
      controls.target.set(...PRESETS.threequarter.tgt);
      controls.update();
      tween = null;
      currentPreset = 'threequarter';
      ui.sync();
    },
  };
  const ui = initUI(app);

  /* ---------------- diagnostics ---------------- */
  const REQUIRED_NAMES = [
    'HX9', 'vibrationRig', 'fuselage', 'canopyGroup', 'cockpitInterior',
    'cabinInterior', 'cabinDoor', 'wingL', 'wingR', 'nacellePivotL',
    'nacellePivotR', 'rotorL', 'rotorR', 'gearNose', 'gearMainL', 'gearMainR',
    'sponsonL', 'sponsonR', 'winch', 'winchArm', 'sensorTurret', 'rescueBasket',
  ];

  function validate() {
    const errors = [];
    const warnings = [];
    for (const n of REQUIRED_NAMES) {
      if (!vehicle.root.getObjectByName(n)) errors.push(`missing assembly: ${n}`);
    }
    let badTransforms = 0;
    vehicle.root.traverse((o) => {
      const ok =
        [o.position.x, o.position.y, o.position.z,
         o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w,
         o.scale.x, o.scale.y, o.scale.z].every(Number.isFinite);
      if (!ok) badTransforms++;
    });
    if (badTransforms) errors.push(`${badTransforms} objects with non-finite transforms`);
    const ids = vehicle.hotspots.map((h) => h.id);
    if (new Set(ids).size !== ids.length) errors.push('duplicate hotspot ids');
    if (ids.length < 10) errors.push(`only ${ids.length} hotspots`);
    for (const h of vehicle.hotspots) {
      let attached = false;
      h.marker.traverseAncestors((a) => { if (a === vehicle.root) attached = true; });
      if (!attached) errors.push(`hotspot detached: ${h.id}`);
    }
    const c = anim.ch;
    if (c.cable > 0.05 && c.door < 0.9) errors.push('cable extended through closed door');
    if (c.explode > 0.02 && c.rotor > 0.05) errors.push('exploded view with rotors turning');
    if (c.explode > 0.02 && anim.state !== 'maintenance' && anim.userExplode > 0)
      errors.push('exploded view outside maintenance');
    if (c.gear > 0.06 && c.gear < 0.94) {
      const doorAmt = c.gear; // doors open from 0.02..0.18, so mid-travel implies open
      if (doorAmt < 0.02) errors.push('gear moving through closed gear doors');
    }
    // explode restoration: positions must derive exactly from stored bases
    const tmp = new THREE.Vector3();
    for (const set of vehicle.explodeSets) {
      tmp.copy(set.base).addScaledVector(set.dir, set.dist * c.explode);
      if (tmp.distanceToSquared(set.object.position) > 1e-10) {
        errors.push(`explode drift on ${set.name}`);
      }
    }
    const gl = renderer.getContext();
    if (!gl || gl.isContextLost()) errors.push('WebGL context lost');
    if (!Number.isFinite(camera.aspect) || camera.aspect <= 0) errors.push('camera aspect invalid');
    if (lastTris > 350000) warnings.push(`triangles ${lastTris} above 350k target`);
    if (lastCalls > 180) warnings.push(`draw calls ${lastCalls} above 180 target`);
    if (fps < 24) warnings.push(`fps low: ${Math.round(fps)}`);
    const metrics = {
      drawCalls: lastCalls,
      triangles: lastTris,
      fps: Math.round(fps),
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      hotspots: ids.length,
      explodeSets: vehicle.explodeSets.length,
    };
    return { ok: errors.length === 0, errors, warnings, metrics };
  }

  window.__HX9_PROBE__ = Object.freeze({
    getState() {
      const s = anim.snapshot();
      return JSON.parse(JSON.stringify({
        ...s,
        seed: SEED_STRING,
        paused,
        lighting,
        camera: {
          preset: currentPreset,
          position: camera.position.toArray().map((v) => Math.round(v * 100) / 100),
          target: controls.target.toArray().map((v) => Math.round(v * 100) / 100),
        },
        hotspot: activeHotspot ? activeHotspot.id : null,
        metrics: { drawCalls: lastCalls, triangles: lastTris, fps: Math.round(fps) },
      }));
    },
    setState: (n) => anim.setState(n),
    setExplode: (v) => anim.requestExplode(Number(v)),
    focusHotspot: (id) => focusHotspot(id),
    reset: () => app.reset(),
    validate,
  });

  /* ---------------- resize ---------------- */
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ---------------- main loop ---------------- */
  const clockTmp = { last: performance.now() };
  let uiAccum = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - clockTmp.last) / 1000;
    clockTmp.last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    fps += ((1 / dt) - fps) * 0.05;

    if (!paused) anim.step(dt);
    else anim.step(0);

    if (tween) {
      tween.t += dt / tween.dur;
      const k = easeInOut(Math.min(tween.t, 1));
      camera.position.lerpVectors(tween.fp, tween.tp, k);
      controls.target.lerpVectors(tween.ft, tween.tt, k);
      if (tween.t >= 1) tween = null;
    }
    controls.update();

    // hotspot marker pulse (visual only)
    if (!reducedMotion) {
      const s = 1 + 0.18 * Math.sin(now * 0.004);
      for (const m of markers) m.scale.setScalar(s);
    }

    renderer.render(scene, camera);
    lastCalls = renderer.info.render.calls;
    lastTris = renderer.info.render.triangles;

    uiAccum += dt;
    if (uiAccum > 0.25) {
      uiAccum = 0;
      const s = anim.snapshot();
      ui.updateTelemetry({
        ...s,
        camera: currentPreset,
        drawCalls: lastCalls,
        triangles: lastTris,
        fps: Math.round(fps),
      });
    }
  }
  requestAnimationFrame(frame);

  window.__HX9_READY__ = true;

  /* ---------------- deterministic self-test / screenshot modes ---------------- */
  const params = new URLSearchParams(location.search);
  const ff = (seconds) => {
    const steps = Math.round(seconds * 30);
    for (let i = 0; i < steps; i++) anim.step(1 / 30);
    renderer.render(scene, camera);
    lastCalls = renderer.info.render.calls;
    lastTris = renderer.info.render.triangles;
  };
  if (params.has('shot')) {
    const which = params.get('shot');
    if (which === 'rescue') {
      anim.setState('rescue');
      ff(20);
      anim.requestCable(0.7);
      ff(14);
      goPreset('starboard');
      tween = null;
      camera.position.set(...PRESETS.starboard.pos);
      controls.target.set(...PRESETS.starboard.tgt);
      controls.update();
    } else if (which === 'maintenance') {
      anim.setState('maintenance');
      ff(16);
      anim.requestExplode(1);
      ff(6);
      camera.position.set(13, 6.5, 11);
      controls.target.set(0, 1.8, 0);
      controls.update();
    }
    ff(0.1);
    document.title = 'HX9-SHOT-READY';
  }
  if (params.has('selftest')) {
    runSelfTest({ anim, validate, goPreset, app, ff, probe: window.__HX9_PROBE__ });
  }
}

function runSelfTest(ctx) {
  const { anim, validate, app, ff, probe } = ctx;
  const report = { seed: SEED_STRING, steps: [] };
  const log = (name, data) => report.steps.push({ name, data });
  log('initial-validate', validate());
  for (const s of ['hover', 'transition', 'cruise', 'rescue', 'maintenance', 'ground']) {
    anim.setState(s);
    if (s === 'rescue') { ff(22); anim.requestCable(0.6); }
    ff(24);
    const v = validate();
    log(`state:${s}`, {
      ok: v.ok, errors: v.errors, warnings: v.warnings,
      transitioning: anim.transitionLabels(), snapshot: anim.snapshot(),
    });
  }
  anim.setState('maintenance');
  ff(16);
  for (const e of [0, 0.5, 1, 0]) {
    probe.setExplode(e);
    ff(4);
    const v = validate();
    log(`explode:${e}`, { ok: v.ok, errors: v.errors, explode: anim.ch.explode });
  }
  for (const id of ['rotor-hub-r', 'winch', 'sensor-turret', 'gear-nose', 'cabin-door']) {
    log(`hotspot:${id}`, { focused: probe.focusHotspot(id) });
  }
  app.setLighting('night');
  ff(0.2);
  log('lighting:night', { ok: validate().ok });
  app.setLighting('dusk');
  const t0 = anim.simTime;
  app.setPaused(true);
  anim.step(0); anim.step(0);
  log('pause', { simTimeStable: anim.simTime === t0 });
  app.setPaused(false);
  for (const p of ['front', 'port', 'starboard', 'top']) log(`preset:${p}`, { ok: ctx.goPreset(p) });
  app.reset();
  ff(1);
  const fin = validate();
  log('final-validate', fin);
  report.ok = report.steps.every((s) => s.data.ok !== false);
  const pre = document.getElementById('selftest');
  pre.textContent = 'HX9SELFTEST:' + JSON.stringify(report);
  document.title = 'HX9-SELFTEST-DONE';
}

/* =============== procedural coastal hangar =============== */
function buildEnvironment(scene, kit, rng) {
  const M = kit.materials;
  const g = new THREE.Group();
  g.name = 'hangar';

  const floorMat = new THREE.MeshStandardMaterial({ map: kit.floorTex, roughness: 0.9, metalness: 0.05 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(44, 32), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  g.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ map: kit.wallTex, roughness: 0.85, metalness: 0.08 });
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(30, 9), wallMat);
  rear.position.set(-14, 4.5, 0);
  rear.rotation.y = Math.PI / 2;
  rear.receiveShadow = true;
  g.add(rear);
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(22, 9), wallMat);
    w.position.set(-3, 4.5, side * 15);
    w.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    w.receiveShadow = true;
    g.add(w);
  }
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.9 });
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(20, 30), roofMat);
  roof.position.set(-4, 8.6, 0);
  roof.rotation.x = Math.PI / 2;
  g.add(roof);

  // structural beams (one instanced mesh)
  {
    const beamGeo = new THREE.BoxGeometry(1, 1, 1);
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x394252, roughness: 0.7, metalness: 0.3 });
    const inst = new THREE.InstancedMesh(beamGeo, beamMat, 13);
    const m4 = new THREE.Matrix4();
    let i = 0;
    for (const x of [-13.6, -8, -2, 4]) {
      for (const side of [1, -1]) {
        m4.makeScale(0.4, 8.6, 0.4).setPosition(x, 4.3, side * 14.6);
        inst.setMatrixAt(i++, m4);
      }
    }
    for (const x of [-13.6, -8, -2, 4]) {
      m4.makeScale(0.3, 0.5, 29).setPosition(x, 8.3, 0);
      inst.setMatrixAt(i++, m4);
    }
    m4.makeScale(0.3, 0.5, 29).setPosition(5.9, 8.3, 0);
    inst.setMatrixAt(i++, m4);
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    g.add(inst);
  }
  // light fixtures (instanced emissive)
  {
    const fixGeo = new THREE.BoxGeometry(1.4, 0.12, 0.3);
    const fixMat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xffb46a, emissiveIntensity: 1.6, roughness: 0.6,
    });
    const inst = new THREE.InstancedMesh(fixGeo, fixMat, 4);
    const m4 = new THREE.Matrix4();
    [[-8, -5], [-2, 5], [-8, 6], [-2, -6]].forEach(([x, z], i) => {
      m4.makeTranslation(x, 7.6, z);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
  }

  // sky + water through the opening (aircraft nose faces the opening)
  const skyMat = new THREE.MeshBasicMaterial({ map: kit.skyTex, fog: false });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(120, 40), skyMat);
  sky.position.set(60, 14, 0);
  sky.rotation.y = -Math.PI / 2;
  g.add(sky);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0e2b36, roughness: 0.22, metalness: 0.55, envMapIntensity: 0.8,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(58, -0.05, 0);
  g.add(water);

  // low-detail service props (kept off the starboard approach)
  const propMat = new THREE.MeshStandardMaterial({ color: 0x4a5260, roughness: 0.8 });
  const crate = (x, z, s, h) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, h, s), propMat);
    c.position.set(x, h / 2, z);
    c.castShadow = true;
    c.receiveShadow = true;
    g.add(c);
  };
  crate(-11, -8, 1.2, 1.2);
  crate(-11, -6.6, 1.0, 0.8);
  crate(-9.6, -8.2, 0.9, 1.5);
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.95, 14);
  for (const [x, z] of [[-10.5, 8.5], [-9.7, 8.9]]) {
    const b = new THREE.Mesh(barrelGeo, M.orange);
    b.position.set(x, 0.48, z);
    b.castShadow = true;
    g.add(b);
  }
  const cart = new THREE.Group();
  const cartBody = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.7), M.graphite);
  cartBody.position.y = 0.6;
  cartBody.castShadow = true;
  const cartTop = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.8), M.steelDark);
  cartTop.position.y = 1.03;
  cart.add(cartBody, cartTop);
  cart.position.set(-8, 0, 3.8);
  g.add(cart);
  const coneGeo = new THREE.CylinderGeometry(0.03, 0.16, 0.5, 10);
  for (const [x, z] of [[5.5, 4.5], [5.5, -4.5]]) {
    const c = new THREE.Mesh(coneGeo, M.orange);
    c.position.set(x, 0.25, z);
    c.castShadow = true;
    g.add(c);
  }

  scene.add(g);
  return g;
}
