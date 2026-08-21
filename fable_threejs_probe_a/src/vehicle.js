// Asterion HX-9 — procedural vehicle assembly.
// Named hierarchical Object3D construction; lofted hull, lathed nacelles,
// instanced blades/fasteners, authored explode vectors and hotspots.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PI = Math.PI;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/* ---------- generic loft: sections are equal-length arrays of Vector3 ---------- */
function loft(sections, { closed = true, filter = null } = {}) {
  const S = sections.length;
  const N = sections[0].length;
  const pos = new Float32Array(S * N * 3);
  const uv = new Float32Array(S * N * 2);
  for (let s = 0; s < S; s++) {
    for (let i = 0; i < N; i++) {
      const p = sections[s][i];
      const o = s * N + i;
      pos[o * 3] = p.x; pos[o * 3 + 1] = p.y; pos[o * 3 + 2] = p.z;
      uv[o * 2] = i / (N - 1); uv[o * 2 + 1] = s / (S - 1);
    }
  }
  const idx = [];
  const cols = closed ? N : N - 1;
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % N;
      const a = s * N + i, b = s * N + i2, c = (s + 1) * N + i, d = (s + 1) * N + i2;
      if (filter) {
        const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3] + pos[d * 3]) / 4;
        const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4;
        const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2] + pos[d * 3 + 2]) / 4;
        if (!filter(cx, cy, cz)) continue;
      }
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* Flip winding if the normal nearest `probe` opposes `expected`. */
function orientOutward(g, probe, expected) {
  const p = g.attributes.position, n = g.attributes.normal;
  let best = 0, bd = Infinity;
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i) - probe.x, dy = p.getY(i) - probe.y, dz = p.getZ(i) - probe.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  const dot = n.getX(best) * expected.x + n.getY(best) * expected.y + n.getZ(best) * expected.z;
  if (dot < 0) {
    const idx = g.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
    g.getIndex().needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/* ---------- hull cross-section: rounded top, tumblehome, chine, V keel ---------- */
function hullSectionPts(st) {
  const pts = [];
  const K = 6;
  for (let k = 0; k <= K; k++) {
    const a = (k / K) * PI * 0.5;
    pts.push([st.w * Math.sin(a), st.yWide + (st.top - st.yWide) * Math.cos(a)]);
  }
  pts.push([st.chW, st.chY]);
  pts.push([st.chW * 0.45, st.chY - (st.chY - st.keel) * 0.55]);
  pts.push([0, st.keel]);
  const m = [];
  for (let i = pts.length - 2; i >= 1; i--) m.push([-pts[i][0], pts[i][1]]);
  return pts.concat(m);
}

const HULL_STATIONS = [
  { x: 4.75, w: 0.07, top: 1.62, yWide: 1.42, chW: 0.05, chY: 1.32, keel: 1.22 },
  { x: 4.45, w: 0.30, top: 1.80, yWide: 1.35, chW: 0.20, chY: 1.18, keel: 1.02 },
  { x: 4.00, w: 0.52, top: 1.95, yWide: 1.32, chW: 0.36, chY: 1.08, keel: 0.90 },
  { x: 3.40, w: 0.66, top: 2.02, yWide: 1.30, chW: 0.50, chY: 1.02, keel: 0.82 },
  { x: 2.70, w: 0.76, top: 2.02, yWide: 1.30, chW: 0.58, chY: 1.00, keel: 0.78 },
  { x: 2.10, w: 0.84, top: 2.30, yWide: 1.30, chW: 0.62, chY: 0.98, keel: 0.75 },
  { x: 1.20, w: 0.86, top: 2.42, yWide: 1.32, chW: 0.64, chY: 0.98, keel: 0.74 },
  { x: 0.20, w: 0.86, top: 2.44, yWide: 1.34, chW: 0.64, chY: 0.99, keel: 0.75 },
  { x: -0.90, w: 0.82, top: 2.40, yWide: 1.36, chW: 0.60, chY: 1.02, keel: 0.80 },
  { x: -1.90, w: 0.68, top: 2.32, yWide: 1.42, chW: 0.50, chY: 1.12, keel: 0.95 },
  { x: -3.00, w: 0.50, top: 2.26, yWide: 1.55, chW: 0.34, chY: 1.42, keel: 1.28 },
  { x: -3.90, w: 0.32, top: 2.24, yWide: 1.75, chW: 0.18, chY: 1.70, keel: 1.62 },
  { x: -4.55, w: 0.10, top: 2.30, yWide: 2.00, chW: 0.05, chY: 1.98, keel: 1.95 },
];

function refineStations(raw, per = 2) {
  const out = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    for (let j = 1; j <= per; j++) {
      const t = j / per;
      const o = {};
      for (const k of Object.keys(raw[i])) o[k] = raw[i - 1][k] + (raw[i][k] - raw[i - 1][k]) * t;
      out.push(o);
    }
  }
  return out;
}

function chineYAt(x) {
  const st = HULL_STATIONS;
  for (let i = 1; i < st.length; i++) {
    if (x >= st[i].x) {
      const t = (x - st[i].x) / (st[i - 1].x - st[i].x);
      return st[i].chY + (st[i - 1].chY - st[i].chY) * t;
    }
  }
  return st[st.length - 1].chY;
}

const inCanopyHole = (x, y, z) => x > 2.55 && x < 4.02 && y > 1.78 && Math.abs(z) < 0.62;
const inDoorHole = (x, y, z) => x > 0.18 && x < 1.52 && y > 0.99 && y < 2.04 && z > 0.45;

/* ---------- airfoil loop (closed): chordwise c 0..chord, thickness t ---------- */
function airfoilLoop(chord, thick, samples = 7) {
  const up = [], lo = [];
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const yc = 0.03 * chord * Math.sin(PI * t);
    const yt = thick * (1.25 * Math.sqrt(t) * (1 - t) + 0.05 * Math.sin(PI * t));
    up.push([t * chord, yc + yt]);
    lo.push([t * chord, yc - yt * 0.65]);
  }
  const loop = up.slice();
  for (let k = samples - 1; k >= 1; k--) loop.push(lo[k]);
  return loop;
}

function tubeFromPoints(points, radius, segs = 24, radial = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  return new THREE.TubeGeometry(curve, segs, radius, radial, closed);
}

/* merged thin-bar frame box (12 edges, 1 geometry) */
function frameBoxGeo(w, h, d, t) {
  const parts = [];
  const bar = (sx, sy, sz, x, y, z) => {
    const b = new THREE.BoxGeometry(sx, sy, sz);
    b.translate(x, y, z);
    parts.push(b);
  };
  const hw = w / 2, hh = h / 2, hd = d / 2;
  for (const sy of [-hh, hh]) {
    bar(w, t, t, 0, sy, -hd); bar(w, t, t, 0, sy, hd);
    bar(t, t, d, -hw, sy, 0); bar(t, t, d, hw, sy, 0);
  }
  for (const sx of [-hw, hw]) for (const sz of [-hd, hd]) bar(t, h, t, sx, 0, sz);
  return mergeGeometries(parts);
}

/* =================================================================== */
export function buildVehicle(kit, rng) {
  const M = kit.materials;
  const D = kit.decals;
  const parts = {};
  const explodeSets = [];
  const hotspots = [];
  const dyn = {};

  const mesh = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    if (name) m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const group = (name, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parts[name] = g;
    return g;
  };
  const explode = (obj, dir, dist) => {
    explodeSets.push({
      name: obj.name, object: obj, base: obj.position.clone(),
      dir: V3(...dir).normalize(), dist,
    });
  };
  const hotspot = (id, title, body, parent, local, viewDir, viewDist) => {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 10, 8),
      M.cyanGlow
    );
    marker.name = `hotspot:${id}`;
    marker.position.set(...local);
    marker.castShadow = false;
    marker.receiveShadow = false;
    marker.userData.hotspotId = id;
    parent.add(marker);
    hotspots.push({ id, title, body, marker, viewDir: V3(...viewDir).normalize(), viewDist });
  };
  const decalPlane = (mat, w, h, pos, rotY = 0, rotX = 0) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    p.position.set(...pos);
    p.rotation.set(rotX, rotY, 0);
    p.castShadow = false;
    p.receiveShadow = false;
    return p;
  };

  const root = group('HX9');
  const rig = group('vibrationRig');
  root.add(rig);

  /* ================= fuselage ================= */
  const fus = group('fuselage');
  rig.add(fus);
  const stations = refineStations(HULL_STATIONS, 2);
  const sections = stations.map((st) =>
    hullSectionPts(st).map(([z, y]) => V3(st.x, y, z))
  );
  const isLower = (x, y) => y < chineYAt(x) + 0.02;
  const upperGeo = orientOutward(
    loft(sections, { filter: (x, y, z) => !isLower(x, y) && !inCanopyHole(x, y, z) && !inDoorHole(x, y, z) }),
    V3(0.2, 2.44, 0), V3(0, 1, 0)
  );
  const lowerGeo = orientOutward(
    loft(sections, { filter: (x, y) => isLower(x, y) }),
    V3(0, 0.74, 0), V3(0, -1, 0)
  );
  fus.add(mesh(upperGeo, M.ivory, 'hullUpper'));
  fus.add(mesh(lowerGeo, M.orange, 'hullLower'));

  // chine strakes + keel + spine (visible chine lines)
  for (const side of [1, -1]) {
    const pts = HULL_STATIONS.map((st) => V3(st.x, st.chY + 0.005, side * st.chW));
    fus.add(mesh(tubeFromPoints(pts, 0.022, 30, 6), M.graphite));
  }
  fus.add(mesh(tubeFromPoints(HULL_STATIONS.map((st) => V3(st.x, st.keel, 0)), 0.028, 30, 6), M.graphite, 'keelStrake'));
  fus.add(mesh(tubeFromPoints([V3(2.3, 2.31, 0), V3(1.0, 2.44, 0), V3(-1.5, 2.4, 0), V3(-3.4, 2.26, 0)], 0.018, 20, 6), M.graphite));

  // recessed panel seam rings
  for (const sx of [1.85, -0.35, -2.4]) {
    const st = stations.reduce((a, b) => (Math.abs(b.x - sx) < Math.abs(a.x - sx) ? b : a));
    const pts = hullSectionPts(st).map(([z, y]) => V3(sx, y * 0.998 + 0.002, z * 0.995));
    fus.add(mesh(tubeFromPoints(pts, 0.012, 34, 5, true), M.darkMech));
  }

  /* ---- tail fin + tailplane ---- */
  const finSt = [
    { y: 2.26, ch: 1.15, lead: -3.42, th: 0.12 },
    { y: 2.80, ch: 0.95, lead: -3.62, th: 0.10 },
    { y: 3.30, ch: 0.75, lead: -3.82, th: 0.08 },
    { y: 3.72, ch: 0.55, lead: -3.98, th: 0.06 },
  ];
  const finGeo = orientOutward(
    loft(finSt.map((s) => airfoilLoop(s.ch, s.th).map(([c, t]) => V3(s.lead - c, s.y, t)))),
    V3(-3.9, 3.0, 0.08), V3(0, 0, 1)
  );
  fus.add(mesh(finGeo, M.ivory, 'fin'));
  fus.add(mesh(tubeFromPoints([V3(-4.28, 2.3, 0), V3(-4.42, 3.68, 0)], 0.012, 8, 5), M.darkMech)); // rudder seam
  const tpSt = [-1.55, -0.6, 0.6, 1.55].map((z) => {
    const t = Math.abs(z) / 1.55;
    return { z, ch: 0.75 - 0.25 * t, lead: -3.66 - 0.06 * t, th: 0.09 - 0.03 * t };
  });
  const tpGeo = orientOutward(
    loft(tpSt.map((s) => airfoilLoop(s.ch, s.th).map(([c, t]) => V3(s.lead - c, 3.55 + t, s.z)))),
    V3(-3.9, 3.65, 0), V3(0, 1, 0)
  );
  fus.add(mesh(tpGeo, M.ivory, 'tailplane'));
  const strobeTail = mesh(new THREE.SphereGeometry(0.05, 8, 6), M.strobe, 'strobeTail');
  strobeTail.position.set(-4.0, 3.78, 0);
  fus.add(strobeTail);
  const beacon = mesh(new THREE.SphereGeometry(0.05, 8, 6), M.beacon, 'beacon');
  beacon.position.set(-1.5, 2.47, 0);
  fus.add(beacon);
  dyn.strobe = M.strobe; dyn.beacon = M.beacon;

  /* ---- decals on hull ---- */
  fus.add(decalPlane(D.wordmarkStbd, 2.0, 0.5, [2.15, 1.62, 0.845], 0));
  fus.add(decalPlane(D.wordmarkPort, 2.0, 0.5, [2.15, 1.62, -0.845], PI));
  fus.add(decalPlane(D.registry, 0.55, 0.22, [-3.2, 1.95, 0.47], 0));
  fus.add(decalPlane(D.registry, 0.55, 0.22, [-3.2, 1.95, -0.47], PI));
  fus.add(decalPlane(D.chevron, 0.5, 0.95, [-3.95, 3.0, 0.075], 0));
  fus.add(decalPlane(D.chevron, 0.5, 0.95, [-3.95, 3.0, -0.075], PI));
  fus.add(decalPlane(D.winchZone, 0.5, 0.2, [0.85, 2.2, 0.72], 0, -0.25));

  /* ---- antennas, pitots, steps (merged graphite set) ---- */
  {
    const gset = [];
    const addBox = (sx, sy, sz, x, y, z) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z); gset.push(b); };
    const addCyl = (r1, r2, h, x, y, z, rz = 0) => {
      const c = new THREE.CylinderGeometry(r1, r2, h, 8);
      if (rz) c.rotateZ(rz);
      c.translate(x, y, z); gset.push(c);
    };
    // blade antennas
    addBox(0.28, 0.22, 0.02, 1.9, 2.55, 0);
    addBox(0.2, 0.18, 0.02, -2.6, 2.42, 0);
    // whip
    addCyl(0.008, 0.004, 0.55, -3.3, 2.55, 0.15);
    // pitot probes
    addCyl(0.012, 0.008, 0.45, 4.62, 1.55, 0.2, PI / 2);
    addCyl(0.012, 0.008, 0.45, 4.62, 1.55, -0.2, PI / 2);
    // boarding step + handles
    addBox(0.3, 0.03, 0.1, 1.0, 1.02, 0.72);
    addBox(0.02, 0.25, 0.03, 1.7, 1.7, 0.83);
    addBox(0.02, 0.25, 0.03, 0.1, 1.7, 0.83);
    const antennaSet = mesh(mergeGeometries(gset), M.graphite, 'antennaSet');
    fus.add(antennaSet);
    const gps = mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.03, 12), M.ivory, 'gpsPuck');
    gps.position.set(0.6, 2.46, 0);
    fus.add(gps);
    hotspot('antenna-array', 'Comms & Air-Data Array',
      'Dual blade antennas, a trailing HF whip and paired heated pitot probes feed the HX-9 nav/comm stack; the dorsal puck houses the satellite fix receiver.',
      fus, [1.9, 2.72, 0], [0.5, 0.5, 1], 2.6);
  }

  /* ---- instanced fasteners on static hull ---- */
  {
    const fast = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * PI * 2;
      fast.push([0.85 + Math.cos(a) * 0.78, 1.52 + Math.sin(a) * 0.62, 0.84]);
    }
    for (let i = 0; i < 10; i++) fast.push([2.6 + i * 0.15, 1.985, 0.6 * (i % 2 ? 1 : -1)]);
    for (const side of [1, -1]) for (let i = 0; i < 8; i++) fast.push([1.45 - i * 0.28, 2.34, side * 0.62]);
    for (let i = 0; i < 8; i++) fast.push([4.15 - i * 0.12, 1.35, (i % 2 ? 0.4 : -0.4)]);
    const fg = new THREE.CylinderGeometry(0.016, 0.016, 0.012, 6);
    fg.rotateX(PI / 2);
    const inst = new THREE.InstancedMesh(fg, M.steelDark, fast.length);
    const m4 = new THREE.Matrix4();
    fast.forEach((p, i) => {
      m4.makeTranslation(p[0], p[1], p[2]);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'hullFasteners';
    fus.add(inst);
  }

  /* ---- nose avionics service panel (opens in maintenance) ---- */
  const nosePanel = group('nosePanel', 4.05, 1.75, 0);
  {
    const pg = new THREE.BoxGeometry(0.5, 0.02, 0.5);
    pg.translate(-0.25, 0, 0);
    nosePanel.add(mesh(pg, M.ivory));
    nosePanel.add(decalPlane(D.panelId, 0.3, 0.12, [-0.25, 0.015, 0], 0, -PI / 2));
    nosePanel.userData.openAxis = 'z';
    nosePanel.userData.openRot = 0.9;
    nosePanel.rotation.x = 0;
    fus.add(nosePanel);
    const bay = mesh(new THREE.BoxGeometry(0.44, 0.16, 0.44), M.cavity, 'noseBay');
    bay.position.set(3.8, 1.68, 0);
    fus.add(bay);
  }

  /* ================= cockpit ================= */
  const cockpit = group('cockpitInterior');
  rig.add(cockpit);
  {
    const tub = mesh(new THREE.BoxGeometry(1.5, 0.55, 1.05), M.interior, 'cockpitTub');
    tub.material = M.interior;
    tub.position.set(3.25, 1.72, 0);
    tub.castShadow = false;
    cockpit.add(tub);
    const dash = mesh(new THREE.BoxGeometry(0.16, 0.3, 0.95), M.graphite, 'dashboard');
    dash.position.set(3.85, 1.92, 0);
    dash.rotation.z = -0.25;
    cockpit.add(dash);
    const screen = mesh(new THREE.PlaneGeometry(0.86, 0.24), M.dash, 'dashScreens');
    screen.position.set(3.76, 1.95, 0);
    screen.rotation.y = -PI / 2;
    screen.rotation.x = 0;
    screen.rotation.z = -PI / 2;
    // orient facing aft toward pilots:
    screen.rotation.set(0, -PI / 2, 0);
    screen.rotation.y = -PI / 2;
    cockpit.add(screen);
    dyn.dash = M.dash;

    const seat = (z) => {
      const s = new THREE.Group();
      s.name = z > 0 ? 'seatRight' : 'seatLeft';
      const base = mesh(new THREE.BoxGeometry(0.36, 0.1, 0.34), M.fabric);
      base.position.y = 0;
      const back = mesh(new THREE.BoxGeometry(0.1, 0.5, 0.34), M.fabric);
      back.position.set(-0.2, 0.25, 0);
      back.rotation.z = 0.16;
      const head = mesh(new THREE.BoxGeometry(0.09, 0.14, 0.2), M.graphite);
      head.position.set(-0.26, 0.56, 0);
      const col = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.32, 6), M.darkMech);
      col.position.set(0.3, 0.12, 0);
      col.rotation.z = 0.35;
      const grip = mesh(new THREE.SphereGeometry(0.032, 8, 6), M.rubber);
      grip.position.set(0.35, 0.27, 0);
      s.add(base, back, head, col, grip);
      s.position.set(3.05, 2.02, z);
      return s;
    };
    cockpit.add(seat(0.32), seat(-0.32));
    hotspot('cockpit', 'Two-Seat Flight Deck',
      'Side-by-side crew stations under a framed bubble canopy. Three glass panels carry hover-hold, sea-state and winch-load pages; dual columns drive a triplex fly-by-wire loop.',
      cockpit, [3.3, 2.3, 0], [1, 0.55, 0.7], 3.2);
  }

  /* ---- canopy (lofted glass + frames) ---- */
  const canopyG = group('canopyGroup');
  rig.add(canopyG);
  {
    const capSt = [
      { x: 4.08, h: 0.04, w: 0.34 },
      { x: 3.9, h: 0.3, w: 0.5 },
      { x: 3.55, h: 0.52, w: 0.6 },
      { x: 3.15, h: 0.58, w: 0.62 },
      { x: 2.85, h: 0.5, w: 0.6 },
      { x: 2.6, h: 0.3, w: 0.56 },
      { x: 2.44, h: 0.07, w: 0.5 },
    ];
    const sill = 1.98;
    const arcs = capSt.map((s) => {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        pts.push(V3(s.x, sill + Math.sin(PI * t) * s.h, s.w * Math.cos(PI * t)));
      }
      return pts;
    });
    const glassGeo = orientOutward(loft(arcs, { closed: false }), V3(3.2, 2.6, 0), V3(0, 1, 0));
    const glass = mesh(glassGeo, M.glass, 'canopyGlass');
    glass.castShadow = false;
    canopyG.add(glass);
    // frame hoops + spine + sills
    for (const s of [capSt[1], capSt[4]]) {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        pts.push(V3(s.x, sill + Math.sin(PI * t) * (s.h + 0.01), (s.w + 0.008) * Math.cos(PI * t)));
      }
      canopyG.add(mesh(tubeFromPoints(pts, 0.026, 16, 6), M.graphite));
    }
    canopyG.add(mesh(tubeFromPoints(capSt.map((s) => V3(s.x, sill + s.h + 0.012, 0)), 0.022, 16, 6), M.graphite, 'canopySpine'));
    for (const side of [1, -1]) {
      const sillBar = mesh(new THREE.BoxGeometry(1.75, 0.14, 0.07), M.graphite);
      sillBar.position.set(3.26, 1.94, side * 0.56);
      canopyG.add(sillBar);
    }
    explode(canopyG, [0.25, 1, 0], 1.15);
  }

  /* ================= cabin ================= */
  const cabin = group('cabinInterior');
  rig.add(cabin);
  {
    const plane = (w, h, pos, rot) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.interior);
      p.position.set(...pos);
      p.rotation.set(...rot);
      p.receiveShadow = true;
      p.castShadow = false;
      return p;
    };
    cabin.add(plane(1.6, 1.15, [0.85, 1.51, -0.32], [0, 0, 0]));           // back wall (faces +z)
    cabin.add(plane(1.6, 1.1, [0.85, 0.95, 0.18], [-PI / 2, 0, 0]));       // recessed floor
    cabin.add(plane(1.6, 1.1, [0.85, 2.07, 0.18], [PI / 2, 0, 0]));        // ceiling
    cabin.add(plane(1.1, 1.15, [0.08, 1.51, 0.18], [0, PI / 2, 0]));       // aft bulkhead
    cabin.add(plane(1.1, 1.15, [1.62, 1.51, 0.18], [0, -PI / 2, 0]));      // fwd bulkhead

    // fold-down seats on back wall
    for (const x of [0.45, 1.25]) {
      const pan = mesh(new THREE.BoxGeometry(0.34, 0.05, 0.3), M.fabric);
      pan.position.set(x, 1.32, -0.14);
      pan.rotation.x = -0.12;
      const back = mesh(new THREE.BoxGeometry(0.34, 0.4, 0.05), M.fabric);
      back.position.set(x, 1.58, -0.28);
      cabin.add(pan, back);
    }
    // stretcher
    const stretcher = group('stretcher', 0.85, 1.06, 0.28);
    const rail1 = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.35, 8), M.steel);
    rail1.rotation.z = PI / 2;
    rail1.position.z = -0.16;
    const rail2 = rail1.clone();
    rail2.position.z = 0.16;
    const pad = mesh(new THREE.BoxGeometry(1.3, 0.06, 0.4), M.fabricOrange);
    pad.position.y = 0.045;
    const strap1 = mesh(new THREE.BoxGeometry(0.05, 0.075, 0.42), M.graphite);
    strap1.position.set(-0.35, 0.045, 0);
    const strap2 = strap1.clone();
    strap2.position.x = 0.35;
    stretcher.add(rail1, rail2, pad, strap1, strap2);
    cabin.add(stretcher);
    explode(stretcher, [0, 0.2, 1], 0.9);
    hotspot('stretcher', 'Casualty Stretcher',
      'A quick-release litter locked to floor rails; the orange pad is a flotation mattress and both straps carry hoist-rated rings so the litter can ride the winch.',
      stretcher, [0, 0.15, 0], [0.6, 0.5, 1], 2.2);

    // grab rails + ceiling light strips
    cabin.add(mesh(tubeFromPoints([V3(0.25, 2.0, 0.5), V3(0.85, 2.03, 0.55), V3(1.45, 2.0, 0.5)], 0.018, 12, 6), M.steel));
    for (const x of [0.5, 1.2]) {
      const strip = mesh(new THREE.BoxGeometry(0.4, 0.02, 0.08), M.cabinLight);
      strip.position.set(x, 2.055, 0.05);
      strip.castShadow = false;
      cabin.add(strip);
    }
    dyn.cabinLight = M.cabinLight;
  }

  /* ---- cabin door (skin lofted from the same hull stations) ---- */
  const door = group('cabinDoor', 0.85, 2.04, 0.62);
  {
    const doorGeo = orientOutward(
      loft(sections, { filter: (x, y, z) => inDoorHole(x, y, z) }),
      V3(0.85, 1.5, 0.9), V3(0, 0, 1)
    );
    doorGeo.translate(-0.85, -2.04, -0.62);
    const skin = mesh(doorGeo, M.ivory, 'doorSkin');
    door.add(skin);
    // inner face
    const inner = mesh(new THREE.PlaneGeometry(1.24, 0.96), M.interior);
    inner.position.set(0, -0.52, 0.1);
    inner.rotation.y = PI;
    inner.castShadow = false;
    door.add(inner);
    const win = mesh(new THREE.CircleGeometry(0.16, 20), M.glass);
    win.position.set(0.1, -0.4, 0.235);
    win.castShadow = false;
    door.add(win);
    door.add(decalPlane(D.door, 0.7, 0.55, [-0.15, -0.62, 0.23], 0));
    const handle = mesh(new THREE.BoxGeometry(0.16, 0.03, 0.04), M.graphite);
    handle.position.set(0.4, -0.85, 0.23);
    door.add(handle);
    rig.add(door);
    explode(door, [0, 0.3, 1], 1.35);
    hotspot('cabin-door', 'Starboard Rescue Door',
      'Top-hinged gullwing door sized for a litter pass-through. Gas struts hold it clear of the winch wire; the sill doubles as a swimmer step at water line.',
      door, [0, -0.55, 0.28], [0.6, 0.15, 1], 3.0);

    // door frame
    const fr = new THREE.Shape();
    fr.absarc(0, 0, 0.001, 0, 0, false);
    const outer = new THREE.Shape();
    const rr = (s, w, h, r) => {
      s.moveTo(-w / 2 + r, -h / 2);
      s.lineTo(w / 2 - r, -h / 2); s.absarc(w / 2 - r, -h / 2 + r, r, -PI / 2, 0, false);
      s.lineTo(w / 2, h / 2 - r); s.absarc(w / 2 - r, h / 2 - r, r, 0, PI / 2, false);
      s.lineTo(-w / 2 + r, h / 2); s.absarc(-w / 2 + r, h / 2 - r, r, PI / 2, PI, false);
      s.lineTo(-w / 2, -h / 2 + r); s.absarc(-w / 2 + r, -h / 2 + r, r, PI, PI * 1.5, false);
    };
    rr(outer, 1.52, 1.24, 0.12);
    const hole = new THREE.Path();
    rr(hole, 1.36, 1.08, 0.1);
    outer.holes.push(hole);
    const frGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.04, bevelEnabled: false });
    const frame = mesh(frGeo, M.graphite, 'doorFrame');
    frame.position.set(0.85, 1.52, 0.77);
    frame.rotation.x = -0.09;
    fus.add(frame);
  }

  /* ================= wings + nacelles + rotors ================= */
  // shared blade geometry
  const bladeGeo = (() => {
    const st = [
      { r: 0.3, ch: 0.34, th: 0.075, tw: 0.38 },
      { r: 1.0, ch: 0.30, th: 0.050, tw: 0.25 },
      { r: 1.7, ch: 0.24, th: 0.038, tw: 0.14 },
      { r: 2.24, ch: 0.15, th: 0.028, tw: 0.05 },
      { r: 2.3, ch: 0.03, th: 0.008, tw: 0.03 },
    ];
    const secs = st.map((s) =>
      airfoilLoop(s.ch, s.th).map(([c, t]) => {
        const z0 = c - s.ch * 0.35, y0 = t;
        const ct = Math.cos(s.tw), sn = Math.sin(s.tw);
        return V3(s.r, y0 * ct - z0 * sn, y0 * sn + z0 * ct);
      })
    );
    const blade = orientOutward(loft(secs), V3(1.4, 0.08, 0), V3(0, 1, 0));
    const cuff = new THREE.CylinderGeometry(0.05, 0.06, 0.26, 10);
    cuff.rotateZ(PI / 2);
    cuff.translate(0.2, 0, 0);
    return mergeGeometries([blade, cuff.toNonIndexed ? cuff : cuff], false) || blade;
  })();

  const linkGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.2, 6);
  const wheelTire = {};
  const wheelHub = {};
  const wheelGeoFor = (r) => {
    const key = r.toFixed(2);
    if (!wheelTire[key]) {
      wheelTire[key] = new THREE.TorusGeometry(r * 0.7, r * 0.32, 10, 18);
      wheelHub[key] = new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 0.5, 12);
      wheelHub[key].rotateX(PI / 2);
    }
    return { tire: wheelTire[key], hub: wheelHub[key] };
  };
  const makeWheel = (r) => {
    const g = new THREE.Group();
    const { tire, hub } = wheelGeoFor(r);
    g.add(mesh(tire, M.rubber), mesh(hub, M.steelDark));
    return g;
  };

  const buildWingSide = (side) => {
    const sideName = side > 0 ? 'R' : 'L';
    const wing = group(`wing${sideName}`, 0, 0, 0);
    rig.add(wing);
    explode(wing, [0, 0.25, side], 1.35);

    const wSt = [0, 0.18, 0.45, 0.75, 1].map((t) => ({
      z: side * (0.68 + t * 3.67),
      ch: 1.3 - t * 0.45,
      lead: 0.95 - t * 0.12,
      y0: 2.3 + t * 0.1,
      th: 0.2 - t * 0.07,
    }));
    const wingGeo = orientOutward(
      loft(wSt.map((s) => airfoilLoop(s.ch, s.th).map(([c, t]) => V3(s.lead - c, s.y0 + t, s.z)))),
      V3(0.35, 2.55, side * 2.5), V3(0, 1, 0)
    );
    wing.add(mesh(wingGeo, M.ivory, `wingSkin${sideName}`));

    // root fairing
    const rf = new THREE.Shape();
    rf.moveTo(1.15, 0); rf.quadraticCurveTo(1.3, 0.3, 0.6, 0.42);
    rf.lineTo(-0.9, 0.42); rf.quadraticCurveTo(-1.25, 0.3, -1.1, 0);
    rf.lineTo(1.15, 0);
    const rfGeo = new THREE.ExtrudeGeometry(rf, { depth: 0.5, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 });
    rfGeo.translate(0.15, 2.08, side > 0 ? 0.45 : -0.95);
    wing.add(mesh(rfGeo, M.ivory, `wingRoot${sideName}`));

    // flaperon (trailing wedge with seam gap)
    const fSt = [0.22, 0.62].map((t) => ({
      z: side * (0.68 + t * 3.67),
      lead: (0.95 - t * 0.12) - (1.3 - t * 0.45) - 0.015,
      y0: 2.3 + t * 0.1 + 0.02,
    }));
    const flapGeo = orientOutward(
      loft(fSt.map((s) => airfoilLoop(0.4, 0.05).map(([c, t]) => V3(s.lead - c, s.y0 + t, s.z)))),
      V3(fSt[0].lead - 0.2, 2.42, side * 1.9), V3(0, 1, 0)
    );
    const flap = mesh(flapGeo, M.graphite, `flaperon${sideName}`);
    wing.add(flap);
    explode(flap, [-0.8, -0.2, 0], 0.55);

    // raised access panel + label
    const panGeo = new THREE.BoxGeometry(0.5, 0.02, 0.32);
    const pan = mesh(panGeo, M.ivory, `wingPanel${sideName}`);
    pan.position.set(0.45, 2.46, side * 2.1);
    wing.add(pan);
    explode(pan, [0, 1, 0], 0.8);
    wing.add(decalPlane(D.panelId, 0.3, 0.12, [0.45, 2.475, side * 2.1], side > 0 ? 0 : PI, -PI / 2));
    wing.add(decalPlane(D.noStep, 0.4, 0.14, [0.35, 2.44, side * 3.2], side > 0 ? 0 : PI, -PI / 2));
    if (side > 0) {
      hotspot('wing-panel-r', 'Wing Service Panel',
        'Chamfered composite hatch over the cross-wing driveshaft and hydraulic run. The stencil records access code and system pressure for deck crews.',
        pan, [0, 0.06, 0], [0.3, 1, 0.5], 2.4);
    }

    // nav light
    const navMat = side > 0 ? M.navGreen : M.navRed;
    const navHouse = mesh(new THREE.BoxGeometry(0.1, 0.06, 0.12), M.graphite);
    navHouse.position.set(0.95, 2.4, side * 4.05);
    const navLamp = mesh(new THREE.SphereGeometry(0.04, 8, 6), navMat, `nav${sideName}`);
    navLamp.position.set(1.0, 2.4, side * 4.05);
    wing.add(navHouse, navLamp);

    /* ---- nacelle ---- */
    const mount = group(`nacelleMount${sideName}`, 0.35, 2.38, side * 4.35);
    wing.add(mount);
    explode(mount, [0, 0.55, side], 1.0);
    // tip rib
    const rib = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 18), M.graphite);
    rib.rotation.x = PI / 2;
    rib.position.z = -side * 0.32;
    mount.add(rib);
    const bracket = mesh(new THREE.BoxGeometry(0.14, 0.5, 0.16), M.darkMech);
    bracket.position.set(0, -0.28, -side * 0.28);
    mount.add(bracket);

    const pivot = group(`nacellePivot${sideName}`);
    mount.add(pivot);
    if (side > 0) {
      hotspot('nacelle-pivot-r', 'Tilt Pivot & Sector Drive',
        'The whole nacelle swings on this graphite trunnion. A toothed sector and dual screw actuators rotate 0–90° in about nine seconds with mechanical down-locks at both ends.',
        pivot, [0, 0, -0.34], [1, 0.3, -0.6], 2.2);
    } else {
      hotspot('exhaust-l', 'IR-Screened Exhaust',
        'Annular exhaust with a cooling ejector ring; bypass air is mixed in to blur the thermal wake during low hovers over survivors.',
        pivot, [0, -1.1, 0], [-0.4, -0.7, -1], 2.4);
    }

    const lathePts = [
      [0.30, -1.06], [0.44, -0.92], [0.50, -0.55], [0.53, 0], [0.52, 0.45],
      [0.47, 0.70], [0.50, 0.86], [0.44, 0.98], [0.34, 1.02],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const body = mesh(new THREE.LatheGeometry(lathePts, 20), M.ivory, `nacelleBody${sideName}`);
    pivot.add(body);
    // intake lip + interior cavity
    const lip = mesh(new THREE.TorusGeometry(0.38, 0.07, 10, 20), M.graphite);
    lip.rotation.x = PI / 2;
    lip.position.y = 1.0;
    const inCav = mesh(new THREE.CylinderGeometry(0.3, 0.33, 0.3, 16), M.cavity);
    inCav.position.y = 0.9;
    const exCav = mesh(new THREE.CylinderGeometry(0.27, 0.25, 0.24, 16), M.cavity);
    exCav.position.y = -0.98;
    const exRing = mesh(new THREE.TorusGeometry(0.29, 0.045, 8, 20), M.steelDark);
    exRing.rotation.x = PI / 2;
    exRing.position.y = -1.05;
    pivot.add(lip, inCav, exCav, exRing);
    // warning + caution bands
    const warn = mesh(new THREE.CylinderGeometry(0.535, 0.535, 0.12, 20, 1, true), D.rotorWarn);
    warn.position.y = 0.58;
    warn.castShadow = false;
    const caut = mesh(new THREE.CylinderGeometry(0.512, 0.522, 0.09, 20, 1, true), D.caution);
    caut.position.y = -0.75;
    caut.castShadow = false;
    pivot.add(warn, caut);
    pivot.add(decalPlane(D.intake, 0.3, 0.14, [0, 0.78, side * 0.505], side > 0 ? 0 : PI, -0.15));
    // trunnion + sector
    const trun = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 12), M.steel);
    trun.rotation.x = PI / 2;
    trun.position.z = -side * 0.3;
    const sector = mesh(new THREE.TorusGeometry(0.3, 0.05, 8, 16, 2.2), M.darkMech);
    sector.position.z = -side * 0.3;
    sector.rotation.z = -0.4;
    pivot.add(trun, sector);
    // vents
    for (let i = 0; i < 3; i++) {
      const v = mesh(new THREE.BoxGeometry(0.14, 0.05, 0.02), M.cavity);
      v.position.set(0.2 - i * 0.2, -0.35, side * 0.52);
      v.castShadow = false;
      pivot.add(v);
    }
    // per-nacelle fastener ring
    {
      const n = 14;
      const fg = new THREE.CylinderGeometry(0.014, 0.014, 0.012, 6);
      const inst = new THREE.InstancedMesh(fg, M.steelDark, n);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        m4.makeTranslation(Math.cos(a) * 0.53, 0.28, Math.sin(a) * 0.53);
        inst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      pivot.add(inst);
    }
    // service panel (opens in maintenance)
    const panelG = group(`nacellePanel${sideName}`, 0, 0.05, 0);
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.545, 0.545, 0.5, 14, 1, true, side > 0 ? 0.3 : PI + 0.3, 1.1),
      M.orange
    );
    shell.castShadow = false;
    panelG.add(shell);
    panelG.userData.openAxis = 'y';
    panelG.userData.openRot = side * 1.0;
    pivot.add(panelG);

    /* ---- rotor ---- */
    const rotor = group(`rotor${sideName}`, 0, 1.12, 0);
    pivot.add(rotor);
    explode(rotor, [0, 1, 0], 1.5);
    const hub = mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.14, 14), M.darkMech, `hub${sideName}`);
    hub.position.y = -0.02;
    const spinPts = [[0.01, 0.34], [0.1, 0.28], [0.16, 0.18], [0.18, 0.05], [0.18, 0]].map(([r, y]) => new THREE.Vector2(r, y));
    const spinner = mesh(new THREE.LatheGeometry(spinPts, 14), M.orange, `spinner${sideName}`);
    spinner.position.y = 0.05;
    rotor.add(hub, spinner);
    const blades = new THREE.InstancedMesh(bladeGeo, M.blade, 5);
    blades.name = `blades${sideName}`;
    blades.castShadow = true;
    const links = new THREE.InstancedMesh(linkGeo, M.steel, 5);
    const m4 = new THREE.Matrix4();
    const mrot = new THREE.Matrix4();
    const mtl = new THREE.Matrix4();
    for (let i = 0; i < 5; i++) {
      const az = (i / 5) * PI * 2;
      mrot.makeRotationY(az);
      mtl.makeRotationZ(0.06);
      m4.multiplyMatrices(mrot, mtl);
      blades.setMatrixAt(i, m4);
      const lp = new THREE.Matrix4().makeTranslation(0.21, -0.1, 0.05).premultiply(mrot);
      links.setMatrixAt(i, lp);
    }
    blades.instanceMatrix.needsUpdate = true;
    links.instanceMatrix.needsUpdate = true;
    rotor.add(blades, links);
    const disc = mesh(new THREE.CircleGeometry(2.32, 36), M.disc, `rotorDisc${sideName}`);
    disc.rotation.x = -PI / 2;
    disc.position.y = 0.06;
    disc.castShadow = false;
    disc.receiveShadow = false;
    rotor.add(disc);
    if (side > 0) {
      hotspot('rotor-hub-r', 'Five-Blade Prop-Rotor',
        'Elastomeric-bearing hub with five twisted composite blades. Pitch links to the swash ring set collective for hover and near-propeller pitch for cruise.',
        rotor, [0, 0.3, 0], [0.7, 1, 0.6], 3.4);
    }
    return wing;
  };
  buildWingSide(1);
  buildWingSide(-1);

  /* ================= landing gear ================= */
  const gearDoors = {};
  {
    // nose gear
    const mountN = group('gearNoseMount', 3.55, 1.0, 0);
    rig.add(mountN);
    explode(mountN, [0.5, -1, 0], 0.9);
    const gN = group('gearNose');
    gN.userData.retractAxis = 'z';
    gN.userData.retractRot = 1.5;
    mountN.add(gN);
    const strut = mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.55, 10), M.steel);
    strut.position.y = -0.28;
    const oleo = mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 8), M.steelDark);
    oleo.position.y = -0.62;
    const fork = mesh(new THREE.BoxGeometry(0.06, 0.16, 0.3), M.darkMech);
    fork.position.y = -0.74;
    const torque = mesh(new THREE.BoxGeometry(0.03, 0.28, 0.06), M.darkMech);
    torque.position.set(0.07, -0.5, 0);
    torque.rotation.z = 0.25;
    const light = mesh(new THREE.CircleGeometry(0.045, 10), M.landingLight, 'landingLight');
    light.position.set(0.06, -0.45, 0);
    light.rotation.y = PI / 2;
    light.castShadow = false;
    gN.add(strut, oleo, fork, torque, light);
    for (const zz of [0.12, -0.12]) {
      const w = makeWheel(0.2);
      w.position.set(0, -0.8, zz);
      gN.add(w);
    }
    dyn.landingLight = M.landingLight;
    hotspot('gear-nose', 'Nose Gear & Approach Light',
      'Twin-wheel steerable leg with a long-stroke oleo for rough pads. It retracts forward so airflow helps free-fall extension if hydraulics are lost.',
      gN, [0, -0.55, 0.2], [1, -0.1, 0.8], 2.2);
    const dN = mesh(new THREE.BoxGeometry(0.55, 0.02, 0.3), M.orange, 'gearDoorNose');
    const dNg = group('gearDoorNoseG', 3.55, 0.87, 0.18);
    dNg.userData.openAxis = 'x';
    dNg.userData.openRot = 1.5;
    dNg.add(dN);
    dN.position.set(0, 0, -0.15);
    rig.add(dNg);
    gearDoors.nose = dNg;

    // main gear (mirrored)
    for (const side of [1, -1]) {
      const nm = side > 0 ? 'R' : 'L';
      const mount = group(`gearMain${nm}Mount`, -1.35, 0.95, side * 1.02);
      rig.add(mount);
      explode(mount, [0, -1, side * 0.3], 0.8);
      const g = group(`gearMain${nm}`);
      g.userData.retractAxis = 'x';
      g.userData.retractRot = side * 1.45;
      mount.add(g);
      const strutM = mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.6, 10), M.steel);
      strutM.position.y = -0.3;
      const arm = mesh(new THREE.BoxGeometry(0.34, 0.07, 0.08), M.darkMech);
      arm.position.set(-0.12, -0.58, 0);
      arm.rotation.z = 0.3;
      const brake = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 12), M.steelDark);
      brake.rotation.x = PI / 2;
      brake.position.set(-0.22, -0.66, 0);
      g.add(strutM, arm, brake);
      for (const zz of [0.15, -0.15]) {
        const w = makeWheel(0.27);
        w.position.set(-0.22, -0.68, zz);
        g.add(w);
      }
      const dGgrp = group(`gearDoor${nm}G`, -1.35, 0.62, side * 0.78);
      const dM = mesh(new THREE.BoxGeometry(0.7, 0.02, 0.4), M.orange, `gearDoor${nm}`);
      dM.position.set(0, 0, side * 0.2);
      dGgrp.add(dM);
      dGgrp.userData.openAxis = 'x';
      dGgrp.userData.openRot = -side * 1.3;
      rig.add(dGgrp);
      gearDoors[nm] = dGgrp;
    }
  }

  /* ================= sponsons ================= */
  for (const side of [1, -1]) {
    const nm = side > 0 ? 'R' : 'L';
    const mount = group(`sponsonMount${nm}`, -1.0, 1.08, side * 0.82);
    rig.add(mount);
    explode(mount, [0, -0.35, side], 1.0);
    const sp = group(`sponson${nm}`);
    mount.add(sp);
    sp.userData.posA = V3(0, -0.28, side * 0.35); // deployed
    sp.userData.posB = V3(0, 0.04, side * 0.06);  // retracted (flush)
    sp.userData.foldRot = side * 0.5;
    const bodyGeo = new THREE.SphereGeometry(0.5, 18, 12);
    bodyGeo.scale(2.3, 0.62, 0.72);
    const body = mesh(bodyGeo.clone(), M.orange, `sponsonBody${nm}`);
    sp.add(body);
    const padTop = mesh(new THREE.BoxGeometry(1.4, 0.02, 0.26), M.rubber);
    padTop.position.y = 0.3;
    sp.add(padTop);
    const strake = mesh(new THREE.BoxGeometry(1.9, 0.03, 0.03), M.graphite);
    strake.position.set(0, -0.1, side * 0.34);
    sp.add(strake);
    sp.add(decalPlane(D.caution, 0.8, 0.1, [0.1, 0.12, side * 0.345], side > 0 ? 0 : PI));
    sp.position.copy(sp.userData.posA);
    if (side < 0) {
      hotspot('sponson-l', 'Retractable Water Sponson',
        'Shallow planing float that gives roll stability afloat and tucks flush for cruise. The rubber spine is a swimmer step; hard chine sheds spray from the door.',
        sp, [0, 0.1, side * 0.3], [0.2, 0.2, -1], 2.6);
    }
  }

  /* ================= winch ================= */
  const winch = group('winch', 0.85, 2.42, 0.28);
  rig.add(winch);
  explode(winch, [0, 1, 0.4], 0.85);
  {
    const base = mesh(new THREE.BoxGeometry(0.4, 0.1, 0.3), M.graphite);
    const mast = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.26, 10), M.steelDark);
    mast.position.y = 0.16;
    winch.add(base, mast);
    const arm = group('winchArm', 0, 0.3, 0);
    winch.add(arm);
    const boom = mesh(new THREE.BoxGeometry(1.9, 0.09, 0.09), M.graphite, 'winchBoom');
    boom.position.x = -0.95;
    const gusset = mesh(new THREE.BoxGeometry(0.5, 0.16, 0.04), M.darkMech);
    gusset.position.set(-0.3, -0.08, 0);
    gusset.rotation.z = -0.25;
    const drum = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.18, 12), M.darkMech, 'winchDrum');
    drum.rotation.x = PI / 2;
    drum.position.set(-0.5, 0.08, 0);
    arm.add(boom, gusset, drum);
    const tip = group('winchTip', -1.86, -0.05, 0);
    arm.add(tip);
    const pulley = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10), M.steel);
    pulley.rotation.x = PI / 2;
    tip.add(pulley);
    const cableGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
    cableGeo.translate(0, -0.5, 0);
    const cable = mesh(cableGeo, M.darkMech, 'winchCable');
    cable.castShadow = false;
    tip.add(cable);
    const hookG = group('winchHook', 0, 0, 0);
    tip.add(hookG);
    const hook = mesh(new THREE.TorusGeometry(0.05, 0.016, 6, 12, PI * 1.5), M.steel);
    hook.position.y = -0.08;
    const weight = mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.09, 8), M.orange);
    weight.position.y = -0.02;
    hookG.add(weight, hook);
    const basket = group('rescueBasket', 0, -0.42, 0);
    hookG.add(basket);
    const frame = mesh(frameBoxGeo(0.9, 0.32, 0.45, 0.025), M.steelDark, 'basketFrame');
    const floorP = mesh(new THREE.BoxGeometry(0.86, 0.02, 0.41), M.graphite);
    floorP.position.y = -0.15;
    const floatA = mesh(new THREE.BoxGeometry(0.3, 0.1, 0.12), M.orange);
    floatA.position.set(-0.25, 0.12, 0.2);
    const floatB = floatA.clone();
    floatB.position.set(0.25, 0.12, -0.2);
    basket.add(frame, floorP, floatA, floatB);
    // bridle lines from hook to basket corners
    basket.add(mesh(tubeFromPoints([V3(0, 0.42, 0), V3(-0.42, 0.18, 0.2)], 0.006, 4, 4), M.darkMech));
    basket.add(mesh(tubeFromPoints([V3(0, 0.42, 0), V3(0.42, 0.18, -0.2)], 0.006, 4, 4), M.darkMech));
    hotspot('winch', 'Rescue Winch & Basket',
      'Roof-mounted boom swings the drum line 1.9 m outboard of the sill, keeping the wire off the hull. Rated 270 kg with a self-righting flotation basket.',
      arm, [-1.0, 0.12, 0], [0.5, 0.5, 1], 2.8);
  }

  /* ================= sensor turret ================= */
  const turret = group('sensorTurret', 4.1, 0.98, 0);
  rig.add(turret);
  explode(turret, [0.5, -1, 0], 0.8);
  {
    const collar = mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.1, 14), M.graphite);
    turret.add(collar);
    const yaw = group('turretYaw', 0, -0.08, 0);
    turret.add(yaw);
    const cap = mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.08, 14), M.darkMech);
    yaw.add(cap);
    const ball = group('turretBall', 0, -0.2, 0);
    yaw.add(ball);
    const sphereGeo = new THREE.SphereGeometry(0.21, 18, 14);
    sphereGeo.scale(1, 0.92, 1);
    ball.add(mesh(sphereGeo, M.graphite, 'turretShell'));
    const lensMain = mesh(new THREE.CylinderGeometry(0.09, 0.095, 0.1, 14), M.darkMech);
    lensMain.rotation.z = PI / 2;
    lensMain.position.set(0.16, 0.02, 0);
    const glassMain = mesh(new THREE.CircleGeometry(0.075, 14), M.lens);
    glassMain.position.set(0.215, 0.02, 0);
    glassMain.rotation.y = PI / 2;
    const lensIR = mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 12), M.darkMech);
    lensIR.rotation.z = PI / 2;
    lensIR.position.set(0.15, -0.02, 0.12);
    const glassIR = mesh(new THREE.CircleGeometry(0.04, 12), M.lens);
    glassIR.position.set(0.195, -0.02, 0.12);
    glassIR.rotation.y = PI / 2;
    const rangefinder = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 8), M.steelDark);
    rangefinder.rotation.z = PI / 2;
    rangefinder.position.set(0.16, 0.05, -0.12);
    const status = mesh(new THREE.SphereGeometry(0.022, 8, 6), M.cyanGlow, 'turretStatus');
    status.position.set(0, -0.16, -0.14);
    ball.add(lensMain, glassMain, lensIR, glassIR, rangefinder, status);
    hotspot('sensor-turret', 'Search Sensor Turret',
      'Gimballed ball with day camera, thermal imager and an eye-safe rangefinder. In SEARCH it scans a raster ahead; crews can slew it manually from either seat.',
      ball, [0.1, -0.2, 0], [1, -0.4, 0.6], 1.8);
  }

  root.userData.isHX9 = true;
  return { root, parts, hotspots, explodeSets, dyn, gearDoors };
}
