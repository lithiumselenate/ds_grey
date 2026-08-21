/**
 * Asterion HX-9 Amphibious Rescue Tiltrotor — scene, presentation, diagnostics.
 * Deterministic: every visible value derives from the seed "HX9-FABLE-PROBE".
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMaterials, makeRng, SEED_STRING } from './materials.js';
import { buildVehicle } from './vehicle.js';
import { createAnimator, STATE_NAMES } from './animation.js';
import { createUI } from './ui.js';

const CAMERAS = {
  hangar: { label: 'three-quarter', pos: [7.8, 4.1, 8.8], target: [0.3, 1.5, 0] },
  front: { label: 'front', pos: [12.4, 2.5, 0.9], target: [0.2, 1.6, 0] },
  port: { label: 'port beam', pos: [0.3, 2.3, -12.4], target: [0, 1.6, 0] },
  starboard: { label: 'starboard / rescue door', pos: [1.5, 2.3, 8.2], target: [-0.2, 1.4, 1.1] },
  top: { label: 'overhead', pos: [0.9, 13.8, 0.7], target: [0, 1.0, 0] },
  cockpit: { label: 'cockpit', pos: [5.4, 2.9, 2.7], target: [2.2, 1.95, 0] },
  winch: { label: 'winch', pos: [1.0, 3.1, 5.6], target: [0.6, 0.9, 2.0] }
};

const DIAG = (window.__HX9_DIAG__ = window.__HX9_DIAG__ || { stage: 'module', messages: [] });

/** Report the current start-up stage in the loading overlay and diagnostics. */
const stage = (text) => {
  DIAG.stage = text;
  const b = document.getElementById('bootText');
  if (b) b.textContent = text;
};

const showFatal = (title, msg, detail) => {
  if (typeof window.__HX9_FAIL__ === 'function') {
    window.__HX9_FAIL__(title, msg, detail || '');
    return;
  }
  const panel = document.getElementById('errorPanel');
  const text = document.getElementById('errorText');
  const head = document.getElementById('errorTitle');
  const det = document.getElementById('errorDetail');
  if (head) head.textContent = title;
  if (panel && text) {
    text.textContent = msg;
    panel.hidden = false;
  }
  if (det && detail) {
    det.textContent = detail;
    det.hidden = false;
  }
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
};

function buildHangar(mats, rng) {
  const g = new THREE.Object3D();
  g.name = 'hangar';

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(48, 40), mats.floor);
  floor.name = 'hangar.floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(-2, 0, 0);
  floor.receiveShadow = true;
  g.add(floor);

  const pad = new THREE.Mesh(new THREE.CircleGeometry(7.6, 56), mats.pad);
  pad.name = 'hangar.pad';
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-0.4, 0.004, 0);
  pad.receiveShadow = true;
  g.add(pad);

  const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 11), mats.wall);
  wall.name = 'hangar.rearWall';
  wall.rotation.y = Math.PI / 2;
  wall.position.set(-16, 5.5, 0);
  wall.receiveShadow = true;
  g.add(wall);

  for (const side of [1, -1]) {
    const sw = new THREE.Mesh(new THREE.PlaneGeometry(32, 11), mats.wall);
    sw.name = `hangar.sideWall.${side > 0 ? 'stbd' : 'port'}`;
    sw.position.set(0, 5.5, side * 14);
    sw.rotation.y = side > 0 ? Math.PI : 0;
    sw.receiveShadow = true;
    g.add(sw);
  }

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(32, 28), mats.beam);
  ceiling.name = 'hangar.ceiling';
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 10.4, 0);
  g.add(ceiling);

  // structural beams + columns (instanced)
  const beamGeo = new THREE.BoxGeometry(0.42, 0.62, 28);
  const beamMatrices = [];
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 8; i++) beamMatrices.push(m4.clone().makeTranslation(-14 + i * 3.6, 9.9, 0));
  const beams = new THREE.InstancedMesh(beamGeo, mats.beam, beamMatrices.length);
  beams.name = 'hangar.beams';
  beamMatrices.forEach((m, i) => beams.setMatrixAt(i, m));
  beams.instanceMatrix.needsUpdate = true;
  g.add(beams);

  const colGeo = new THREE.BoxGeometry(0.55, 10.2, 0.55);
  const colPos = [];
  for (let i = 0; i < 4; i++) {
    for (const side of [1, -1]) colPos.push([-13 + i * 8.6, 5.1, side * 13.4]);
  }
  const cols = new THREE.InstancedMesh(colGeo, mats.beam, colPos.length);
  cols.name = 'hangar.columns';
  colPos.forEach((p, i) => cols.setMatrixAt(i, m4.clone().makeTranslation(p[0], p[1], p[2])));
  cols.instanceMatrix.needsUpdate = true;
  g.add(cols);

  // opening frame toward the water
  const frameGeos = [
    new THREE.BoxGeometry(0.6, 11, 0.9).translate(15.6, 5.5, 13.6),
    new THREE.BoxGeometry(0.6, 11, 0.9).translate(15.6, 5.5, -13.6),
    new THREE.BoxGeometry(0.8, 0.9, 28).translate(15.6, 10.6, 0)
  ];
  const opening = new THREE.Mesh(mergeSimple(frameGeos), mats.beam);
  opening.name = 'hangar.opening';
  g.add(opening);

  // low-detail service props: crates, drums, a cable reel, a tool cart
  const propGeos = [];
  const orangeGeos = [];
  const spots = [
    [-13.4, 0.55, 7.2], [-12.4, 0.4, 8.6], [-13.8, 0.45, -6.4], [-11.6, 0.5, -8.2]
  ];
  spots.forEach((p, i) => {
    const h = 0.8 + rng() * 0.5;
    const w = 1.1 + rng() * 0.6;
    const box = new THREE.BoxGeometry(w, h, w * 0.8).translate(p[0], h / 2, p[2]);
    (i % 2 ? orangeGeos : propGeos).push(box);
    propGeos.push(new THREE.BoxGeometry(w * 0.96, 0.06, w * 0.78).translate(p[0], h * 0.6, p[2]));
  });
  propGeos.push(new THREE.CylinderGeometry(0.34, 0.34, 0.92, 14).translate(-14.2, 0.46, 2.4));
  propGeos.push(new THREE.CylinderGeometry(0.34, 0.34, 0.92, 14).translate(-14.2, 0.46, 3.3));
  orangeGeos.push(new THREE.CylinderGeometry(0.95, 0.95, 0.34, 20).rotateZ(Math.PI / 2).translate(-14.0, 0.98, -2.6));
  propGeos.push(new THREE.BoxGeometry(1.5, 0.1, 0.7).translate(-9.5, 0.85, 9.6));
  propGeos.push(new THREE.BoxGeometry(0.1, 0.8, 0.1).translate(-8.85, 0.45, 9.6));
  propGeos.push(new THREE.BoxGeometry(0.1, 0.8, 0.1).translate(-10.15, 0.45, 9.6));
  const props = new THREE.Mesh(mergeSimple(propGeos), mats.prop);
  props.name = 'hangar.props';
  props.castShadow = true;
  props.receiveShadow = true;
  g.add(props);
  const propsO = new THREE.Mesh(mergeSimple(orangeGeos), mats.propOrange);
  propsO.name = 'hangar.propsOrange';
  propsO.castShadow = true;
  g.add(propsO);

  // water outside the opening
  const water = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), mats.water);
  water.name = 'hangar.water';
  water.rotation.x = -Math.PI / 2;
  water.position.set(72, -0.15, 0);
  g.add(water);

  return g;
}

/** Minimal merge for same-attribute geometries (hangar only). */
function mergeSimple(geos) {
  let vCount = 0;
  const list = geos.map((geo) => (geo.index ? geo.toNonIndexed() : geo));
  list.forEach((geo) => (vCount += geo.attributes.position.count));
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  let o = 0;
  for (const geo of list) {
    pos.set(geo.attributes.position.array, o * 3);
    nor.set(geo.attributes.normal.array, o * 3);
    uv.set(geo.attributes.uv.array, o * 2);
    o += geo.attributes.position.count;
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

function boot() {
  stage('creating WebGL renderer');
  const canvas = document.getElementById('view');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no WebGL context');
  } catch (err) {
    showFatal(
      'WebGL could not be initialised',
      'This browser refused a WebGL context for the viewer, so the HX-9 cannot be rendered. ' +
        'three.js r' + THREE.REVISION + ' needs WebGL2; enable hardware acceleration (chrome://gpu) or use another desktop browser.',
      'webgl probe=' + DIAG.webgl + ' gpu=' + DIAG.gpu + '\n' + (err && err.stack ? err.stack : err)
    );
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  stage('generating procedural materials');
  const rng = makeRng(SEED_STRING + '/scene');
  const scene = new THREE.Scene();
  const matlib = createMaterials(renderer);
  const mats = matlib.mats;
  scene.environment = matlib.env;
  scene.background = matlib.textures.sky;
  scene.backgroundIntensity = 0.7;
  scene.fog = new THREE.Fog(0x1a2530, 42, 130);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(...CAMERAS.hangar.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 3.6;
  controls.maxDistance = 32;
  controls.minPolarAngle = 0.1;
  controls.maxPolarAngle = 1.5;
  controls.target.set(...CAMERAS.hangar.target);
  controls.update();

  stage('building hangar');
  scene.add(buildHangar(mats, rng));
  stage('building HX-9 assemblies');
  const vehicle = buildVehicle(mats);
  scene.add(vehicle.root);
  const animator = createAnimator(vehicle, mats);

  /* ---------------- lighting rig ---------------- */
  const ambient = new THREE.AmbientLight(0x9fb4c8, 0.16);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffd2a4, 2.7);
  key.position.set(14, 11, 7);
  key.target.position.set(0, 1.3, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -11;
  key.shadow.camera.right = 11;
  key.shadow.camera.top = 11;
  key.shadow.camera.bottom = -11;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 48;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.022;
  scene.add(key, key.target);
  const cool = new THREE.DirectionalLight(0x8cb9ff, 0.6);
  cool.position.set(18, 3.5, -9);
  scene.add(cool);
  const rim = new THREE.DirectionalLight(0xa8d8ff, 0.34);
  rim.position.set(-13, 6, -6);
  scene.add(rim);
  const practicals = [
    [-8, 9.2, 6.5], [-8, 9.2, -6.5], [2.5, 9.2, 0]
  ].map((p) => {
    const l = new THREE.PointLight(0xffb877, 70, 26, 2);
    l.position.set(p[0], p[1], p[2]);
    scene.add(l);
    return l;
  });
  const inspect = [
    [7.5, 5.5, 6.5], [-6.5, 5.5, -7.0]
  ].map((p) => {
    const sp = new THREE.SpotLight(0xd6ecff, 0, 34, 0.62, 0.55, 2);
    sp.position.set(p[0], p[1], p[2]);
    sp.target.position.set(0, 1.4, 0);
    scene.add(sp, sp.target);
    return sp;
  });

  let lightingMode = 'dusk';
  function setLighting(mode) {
    lightingMode = mode === 'night' ? 'night' : 'dusk';
    const night = lightingMode === 'night';
    key.intensity = night ? 0.34 : 2.7;
    cool.intensity = night ? 0.2 : 0.6;
    rim.intensity = night ? 0.14 : 0.34;
    ambient.intensity = night ? 0.05 : 0.16;
    practicals.forEach((l) => (l.intensity = night ? 26 : 70));
    inspect.forEach((l) => (l.intensity = night ? 320 : 0));
    scene.backgroundIntensity = night ? 0.28 : 0.7;
    renderer.toneMappingExposure = night ? 1.12 : 1.0;
    if (ui) ui.setLightingMode(lightingMode);
  }

  /* ---------------- camera transitions ---------------- */
  const camState = { id: 'hangar', anim: null };
  const tmpV = new THREE.Vector3();
  function goToCamera(pos, target, id, instant) {
    camState.id = id;
    if (ui) ui.setCamera(CAMERAS[id] ? id : '');
    const dur = instant || animator.ctl.reducedMotion ? 0 : 1.05;
    if (dur === 0) {
      camera.position.set(pos[0], pos[1], pos[2]);
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
      camState.anim = null;
      return;
    }
    camState.anim = {
      t: 0,
      dur,
      fromPos: camera.position.clone(),
      toPos: new THREE.Vector3(pos[0], pos[1], pos[2]),
      fromTgt: controls.target.clone(),
      toTgt: new THREE.Vector3(target[0], target[1], target[2])
    };
  }
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  function updateCameraAnim(dt) {
    const a = camState.anim;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / a.dur);
    const k = easeInOut(a.t);
    camera.position.lerpVectors(a.fromPos, a.toPos, k);
    controls.target.lerpVectors(a.fromTgt, a.toTgt, k);
    if (a.t >= 1) camState.anim = null;
  }
  function setCamera(id) {
    const preset = CAMERAS[id];
    if (!preset) return false;
    goToCamera(preset.pos, preset.target, id);
    return true;
  }

  function focusHotspot(id) {
    const h = vehicle.hotspots.find((x) => x.id === id);
    if (!h || !h.marker) return false;
    h.marker.getWorldPosition(tmpV);
    const target = tmpV.clone();
    const pos = [target.x + h.cam[0], Math.max(0.7, target.y + h.cam[1]), target.z + h.cam[2]];
    goToCamera(pos, [target.x, target.y, target.z], 'hotspot:' + id);
    camState.id = 'hotspot:' + h.id;
    ui.showHotspot(h);
    return true;
  }

  /* ---------------- UI wiring ---------------- */
  let paused = false;
  const api = {
    hotspots: vehicle.hotspots.map((h) => ({ id: h.id, title: h.title, body: h.body })),
    setState: (n) => animator.requestState(n),
    setCamera,
    setLighting,
    cycleLighting: () => setLighting(lightingMode === 'dusk' ? 'night' : 'dusk'),
    setExplode: (v) => animator.setExplode(v),
    nudgeExplode: (d) => animator.setExplode(animator.ctl.explodeTarget + d),
    toggleBoom: () => {
      if (animator.ctl.state !== 'rescue') return;
      animator.setBoom(!(animator.scalars.arm > 0.5));
    },
    setCableCommand: (d) => animator.setCableCommand(d),
    nudgeCable: (d) => {
      animator.setCableCommand(d);
      window.setTimeout(() => animator.setCableCommand(0), 220);
    },
    toggleScan: () => animator.setScanning(!animator.ctl.scanning),
    pointTurret: (dy, dp) => animator.pointTurret(dy, dp),
    togglePause: () => {
      paused = !paused;
      ui.setPaused(paused);
    },
    toggleReducedMotion: () => {
      animator.setReducedMotion(!animator.ctl.reducedMotion);
      ui.setReducedMotion(animator.ctl.reducedMotion);
    },
    reset: () => doReset(),
    focusHotspot
  };
  stage('wiring interface');
  const ui = createUI(api);
  ui.setLightingMode(lightingMode);
  ui.setCamera('hangar');
  ui.setPaused(false);

  const reducedPref = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedPref) {
    animator.setReducedMotion(true);
    ui.setReducedMotion(true);
  }

  function doReset() {
    animator.reset();
    setLighting('dusk');
    paused = false;
    ui.setPaused(false);
    ui.hideHotspot();
    goToCamera(CAMERAS.hangar.pos, CAMERAS.hangar.target, 'hangar', true);
  }

  /* ---------------- picking ---------------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    ndc.x = (ev.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(ev.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(vehicle.markers, false)[0];
    if (hit) focusHotspot(hit.object.userData.hotspotId);
  });

  /* ---------------- resize ---------------- */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  const metrics = { calls: 0, triangles: 0, fps: 60, camera: CAMERAS.hangar.label, frames: 0 };
  let fpsAccum = 0;
  let fpsFrames = 0;
  const markerScale = new THREE.Vector3();

  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    if (!paused) animator.update(dt);
    updateCameraAnim(dt);
    controls.update();

    // keep hotspot markers legible at any distance without per-frame allocation
    for (const m of vehicle.markers) {
      m.getWorldPosition(markerScale);
      const d = markerScale.distanceTo(camera.position);
      const sc = Math.min(0.5, Math.max(0.16, d * 0.021));
      m.scale.set(sc, sc, sc);
    }

    renderer.render(scene, camera);
    metrics.calls = renderer.info.render.calls;
    metrics.triangles = renderer.info.render.triangles;
    metrics.camera = CAMERAS[camState.id] ? CAMERAS[camState.id].label : camState.id;
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum > 0.5) {
      metrics.fps = fpsFrames / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
    }
    ui.update(animator.snapshot(), metrics, performance.now());
    requestAnimationFrame(frame);
  }

  /* ---------------- diagnostics ---------------- */
  const REQUIRED = [
    'HX9.root', 'HX9.frame', 'airframe.fuselage', 'hull.strakes', 'canopy.glass', 'canopy.frame',
    'cockpit.seats', 'cockpit.console', 'cabin.group', 'cabin.shell', 'cabin.door', 'cabin.door.panel',
    'wing.port', 'wing.stbd', 'nacelle.port', 'nacelle.stbd', 'rotor.port', 'rotor.stbd',
    'rotor.port.blades', 'rotor.stbd.blades', 'rotor.port.disc', 'rotor.stbd.disc',
    'gear.nose', 'gear.main.port', 'gear.main.stbd', 'gearDoor.nose', 'gearDoor.main.port',
    'gearDoor.main.stbd', 'sponson.port', 'sponson.stbd', 'winch.group', 'winch.arm', 'winch.cable',
    'winch.basket', 'turret.yaw', 'turret.pitch', 'tail.fin', 'details.fasteners', 'details.vents',
    'panel.avionics'
  ];

  function validate() {
    const errors = [];
    const warnings = [];
    for (const name of REQUIRED) if (!vehicle.root.getObjectByName(name)) errors.push(`missing assembly: ${name}`);
    let nonFinite = 0;
    let meshes = 0;
    vehicle.root.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) meshes++;
      const v = o.position.x + o.position.y + o.position.z + o.rotation.x + o.rotation.y + o.rotation.z + o.scale.x;
      if (!Number.isFinite(v)) {
        nonFinite++;
        if (nonFinite < 4) errors.push(`non-finite transform on ${o.name || o.type}`);
      }
    });
    const ids = new Set();
    for (const h of vehicle.hotspots) {
      if (ids.has(h.id)) errors.push(`duplicate hotspot id: ${h.id}`);
      ids.add(h.id);
      if (!h.marker || !h.marker.parent) errors.push(`hotspot ${h.id} is not attached to a component`);
    }
    if (ids.size < 10) errors.push(`only ${ids.size} hotspots defined (10 required)`);
    const legal = animator.legality();
    errors.push(...legal.errors);
    warnings.push(...legal.warnings);
    const drift = animator.explodeCheck();
    if (drift !== null && drift > 1e-6) errors.push(`explode=0 transform drift ${drift.toExponential(2)}`);
    if (!renderer.getContext()) errors.push('renderer context lost');
    if (!Number.isFinite(camera.aspect) || camera.aspect <= 0) errors.push('camera aspect invalid');
    if (!camera.projectionMatrix.elements.every(Number.isFinite)) errors.push('camera projection non-finite');
    if (metrics.triangles > 350000) warnings.push(`triangles ${metrics.triangles} above 350k budget`);
    if (metrics.calls > 180) warnings.push(`draw calls ${metrics.calls} above 180 budget`);
    if (metrics.triangles === 0) warnings.push('no triangles measured yet — render a frame first');
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      metrics: {
        drawCalls: metrics.calls,
        triangles: metrics.triangles,
        meshes,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : null,
        fps: +metrics.fps.toFixed(1),
        hotspots: ids.size,
        seed: SEED_STRING,
        explodeDrift: drift,
        camera: camState.id,
        lighting: lightingMode
      }
    };
  }

  window.__HX9_PROBE__ = Object.freeze({
    getState: () =>
      Object.assign(animator.snapshot(), {
        camera: camState.id,
        cameraLabel: metrics.camera,
        lighting: lightingMode,
        paused,
        seed: SEED_STRING,
        metrics: { drawCalls: metrics.calls, triangles: metrics.triangles, fps: +metrics.fps.toFixed(1) }
      }),
    setState: (n) => animator.requestState(n),
    setExplode: (v) => animator.setExplode(v),
    focusHotspot: (id) => focusHotspot(id),
    reset: () => {
      doReset();
      return true;
    },
    validate,
    diagnostics: () => JSON.parse(JSON.stringify(DIAG)),
    states: STATE_NAMES.slice(),
    cameras: Object.keys(CAMERAS),
    hotspots: vehicle.hotspots.map((h) => h.id),
    setLighting: (m) => {
      setLighting(m);
      return lightingMode;
    },
    setPaused: (p) => {
      paused = !!p;
      ui.setPaused(paused);
      return paused;
    }
  });

  window.addEventListener('beforeunload', () => {
    matlib.dispose();
    vehicle.dispose();
    renderer.dispose();
  });

  stage('rendering first frame');
  DIAG.revision = THREE.REVISION;
  const bootOverlay = document.getElementById('boot');
  if (bootOverlay) bootOverlay.hidden = true;
  window.__HX9_BOOTED__ = true;
  requestAnimationFrame(frame);
}

try {
  boot();
} catch (err) {
  showFatal(
    'Viewer failed to start',
    'An unexpected error occurred while building the scene (stage: ' + DIAG.stage + '): ' +
      (err && err.message ? err.message : err),
    err && err.stack ? err.stack : String(err)
  );
}
