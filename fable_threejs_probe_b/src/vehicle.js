// vehicle.js — procedural construction of the fictional Asterion HX-9 tiltrotor.
// Builds a named hierarchical assembly plus rig bindings, explode vectors and hotspots.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PI = Math.PI, HPI = PI / 2;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const lerp = THREE.MathUtils.lerp;

// ---------- geometry helpers ------------------------------------------------
function tg(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}
const box = (w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  tg(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, seg, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  tg(new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);
const tube = (rt, rb, h, seg, open, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  tg(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), x, y, z, rx, ry, rz);
const sph = (r, sx = 1, sy = 1, sz = 1, x = 0, y = 0, z = 0) => {
  const g = new THREE.SphereGeometry(r, 16, 12);
  g.scale(sx, sy, sz);
  return tg(g, x, y, z);
};
const tor = (R, t, arc, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  tg(new THREE.TorusGeometry(R, t, 8, 22, arc), x, y, z, rx, ry, rz);
const circ = (r, seg, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  tg(new THREE.CircleGeometry(r, seg), x, y, z, rx, ry, rz);

function flipWinding(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    g.index.needsUpdate = true;
  } else {
    for (const key of ['position', 'normal', 'uv']) {
      const at = g.attributes[key];
      if (!at) continue;
      const arr = at.array, is = at.itemSize;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < is; k++) {
          const i1 = (i + 1) * is + k, i2 = (i + 2) * is + k;
          const t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
        }
      }
      at.needsUpdate = true;
    }
  }
  g.computeVertexNormals();
  return g;
}
function mirrorGeometry(src) {
  const g = src.clone();
  g.scale(-1, 1, 1);
  return flipWinding(g);
}
function fixOutward(g) {
  g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal;
  let bi = 0, bx = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    if (Math.abs(x) > Math.abs(bx)) { bx = x; bi = i; }
  }
  if (n.getX(bi) * bx < 0) flipWinding(g);
  return g;
}

// Loft closed cross-sections into a skinned surface. Rings must be ordered
// with DECREASING z so that cap winding stays consistent with side winding.
function loft(rings, opts = {}) {
  const { caps = true, hole = null } = opts;
  const N = rings[0].pts.length, R = rings.length;
  const pos = [], uv = [], idx = [];
  for (let ri = 0; ri < R; ri++) {
    const r = rings[ri];
    for (let j = 0; j < N; j++) {
      pos.push(r.pts[j][0], r.pts[j][1], r.z);
      uv.push(j / N, ri / (R - 1));
    }
  }
  const skip = (ri, j) => hole && ri >= hole.r0 && ri < hole.r1 && j >= hole.j0 && j < hole.j1;
  for (let ri = 0; ri < R - 1; ri++) {
    for (let j = 0; j < N; j++) {
      if (skip(ri, j)) continue;
      const j1 = (j + 1) % N;
      const a = ri * N + j, b = ri * N + j1, c = (ri + 1) * N + j, d = (ri + 1) * N + j1;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (caps) {
    const centro = (ri) => {
      let x = 0, y = 0;
      for (const p of rings[ri].pts) { x += p[0]; y += p[1]; }
      return [x / N, y / N, rings[ri].z];
    };
    let ci = pos.length / 3;
    pos.push(...centro(0)); uv.push(0.5, 0);
    for (let j = 0; j < N; j++) idx.push(ci, (j + 1) % N, j);
    ci = pos.length / 3;
    pos.push(...centro(R - 1)); uv.push(0.5, 1);
    const base = (R - 1) * N;
    for (let j = 0; j < N; j++) idx.push(ci, base + j, base + (j + 1) % N);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return fixOutward(g);
}

// Assembly builder: collects geometry per material, merges to one mesh each.
class Asm {
  constructor(name, parent) {
    this.g = new THREE.Group();
    this.g.name = name;
    if (parent) parent.add(this.g);
    this.bins = new Map();
  }
  put(mat, geo) {
    if (geo.index) geo = geo.toNonIndexed();
    if (!this.bins.has(mat)) this.bins.set(mat, []);
    this.bins.get(mat).push(geo);
    return this;
  }
  done(shadows = true) {
    for (const [mat, geos] of this.bins) {
      const merged = mergeGeometries(geos, false);
      const m = new THREE.Mesh(merged, mat);
      m.name = `${this.g.name}:${mat.name || 'mat'}`;
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      this.g.add(m);
    }
    this.bins.clear();
    return this.g;
  }
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function decalMesh(mat, w, h, pos, normal, roll = 0, name = 'decal') {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.quaternion.setFromUnitVectors(V3(0, 0, 1), normal.clone().normalize());
  if (roll) m.rotateZ(roll);
  m.position.copy(pos);
  m.name = name;
  m.renderOrder = 2;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// Hull cross-section: keel, deadrise, chine, knuckle, upper side, crown. 16 pts.
function fuseSec(w, d, h, yc) {
  const side = [
    [0.55 * w, -0.85 * d], [0.95 * w, -0.30 * d], [1.00 * w, 0.12 * h],
    [0.97 * w, 0.45 * h], [0.86 * w, 0.70 * h], [0.62 * w, 0.90 * h], [0.30 * w, 1.00 * h],
  ];
  const pts = [[0, -d]];
  for (const p of side) pts.push(p.slice());
  pts.push([0, 1.03 * h]);
  for (let i = side.length - 1; i >= 0; i--) pts.push([-side[i][0], side[i][1]]);
  return pts.map((p) => [p[0], p[1] + yc]);
}

const STA = [ // [z, halfWidth, keelDepth, height, yOffset]
  [4.70, 0.07, 0.06, 0.10, 0.55],
  [4.25, 0.34, 0.26, 0.50, 0.32],
  [3.50, 0.60, 0.48, 0.95, 0.12],
  [2.50, 0.80, 0.62, 1.50, 0.00],
  [1.50, 0.92, 0.70, 1.72, 0.00],
  [-0.30, 0.95, 0.72, 1.75, 0.00],
  [-1.60, 0.90, 0.68, 1.68, 0.02],
  [-2.80, 0.68, 0.42, 1.28, 0.30],
  [-3.80, 0.44, 0.16, 0.80, 0.62],
  [-4.50, 0.18, 0.04, 0.34, 0.98],
];

function airfoilShape(chord, th) {
  const s = new THREE.Shape();
  s.moveTo(chord, 0.006);
  s.quadraticCurveTo(chord * 0.35, th, 0.03, th * 0.4);
  s.quadraticCurveTo(-th * 0.35, 0, 0.03, -th * 0.28);
  s.quadraticCurveTo(chord * 0.35, -th * 0.4, chord, -0.006);
  s.closePath();
  return s;
}

// ---------- main build -------------------------------------------------------
export function buildVehicle(M, rng) {
  const root = new THREE.Group();
  root.name = 'HX9';
  const parts = {};
  const reg = (o) => { parts[o.name] = o; return o; };
  const rig = [];
  const explodables = [];
  const hotspots = [];
  const hs = (id, parent, off, title, body, dist = 2.6) => {
    const a = new THREE.Object3D();
    a.name = `hs:${id}`;
    a.position.copy(off);
    parent.add(a);
    hotspots.push({ id, title, body, anchor: a, dist });
  };

  // ==== fuselage ====
  const fus = reg(new THREE.Group());
  fus.name = 'fuselage';
  root.add(fus);

  const hullRings = STA.map(([z, w, d, h, yc]) => ({ z, pts: fuseSec(w, d, h, yc) }));
  const hullGeo = loft(hullRings, { hole: { r0: 4, r1: 5, j0: 4, j1: 6 } });
  const hull = new THREE.Mesh(hullGeo, M.paintHull);
  hull.name = 'hullSkin';
  hull.castShadow = hull.receiveShadow = true;
  fus.add(hull);

  const fusD = new Asm('fusDetail', fus);
  // nose / tail closing caps and keel strake
  fusD.put(M.paintIvory, sph(0.1, 1, 1, 0.8, 0, 0.55, 4.7));
  fusD.put(M.paintIvory, sph(0.2, 0.9, 1, 0.6, 0, 1.13, -4.5));
  fusD.put(M.graphite, box(0.08, 0.1, 6.2, 0, -0.62, 0.9));
  // chine emphasis lines via curves
  for (const s of [1, -1]) {
    const pts = STA.slice(1, 9).map(([z, w, d, , yc]) => V3(s * 0.95 * w, -0.3 * d + yc, z));
    const curve = new THREE.CatmullRomCurve3(pts);
    fusD.put(M.graphiteLight, new THREE.TubeGeometry(curve, 32, 0.016, 5));
  }
  // tail fins + stabilizer
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(0.9, 0);
  finShape.lineTo(0.62, 1.25); finShape.lineTo(0.28, 1.3); finShape.closePath();
  for (const s of [1, -1]) {
    let fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: false });
    fin.rotateY(-HPI); // shape x -> -z (sweep aft), depth -> thickness in x
    fin = tg(fin, s * 0.52, 1.05, -3.35);
    fusD.put(M.paintIvory, fin);
    fusD.put(M.paintOrange, box(0.07, 0.16, 0.5, s * 0.49, 2.24, -3.85));
  }
  let stab = new THREE.ExtrudeGeometry(airfoilShape(0.7, 0.09), { depth: 1.3, bevelEnabled: false });
  stab.rotateY(HPI);
  stab = tg(stab, -0.65, 2.3, -3.55);
  fusD.put(M.paintIvory, stab);
  // antennas, probes, steps, handles, vents
  fusD.put(M.graphite, box(0.03, 0.2, 0.32, 0, 1.85, 0.9, 0.15));
  fusD.put(M.graphite, box(0.03, 0.16, 0.26, 0, 1.83, -1.9, -0.12));
  fusD.put(M.graphite, cyl(0.006, 0.006, 0.55, 6, 0, 1.75, -3.2, 0.4));
  fusD.put(M.graphiteLight, cyl(0.07, 0.07, 0.035, 12, 0, 1.79, 0.15));
  for (const s of [1, -1]) {
    fusD.put(M.metal, cyl(0.013, 0.013, 0.45, 8, s * 0.28, 0.62, 4.42, HPI));
    fusD.put(M.metal, cyl(0.002, 0.024, 0.1, 8, s * 0.28, 0.62, 4.69, HPI));
  }
  fusD.put(M.graphiteLight, tor(0.1, 0.016, PI, 0.9, 0.62, 2.7, 0, HPI, 0));
  fusD.put(M.graphiteLight, tor(0.1, 0.016, PI, 0.92, 1.02, 2.5, 0, HPI, 0));
  fusD.put(M.graphiteLight, tor(0.12, 0.018, PI, 0.9, 1.68, 1.55, 0, HPI, 0));
  for (let i = 0; i < 4; i++) {
    fusD.put(M.cavity, box(0.02, 0.06, 0.28, -0.9, 1.3 - i * 0.14, -2.2 + i * 0.05));
  }
  fusD.put(M.metal, box(0.06, 0.04, 1.85, 0.91, 0.74, 0.6));
  fusD.done();

  // lower anti-collision + tail strobe + top beacon
  const beacon = reg(new THREE.Mesh(sph(0.045), M.beacon));
  beacon.name = 'beacon';
  beacon.position.set(0, 2.42, -3.55);
  fus.add(beacon);
  const beaconBot = new THREE.Mesh(sph(0.04), M.beacon);
  beaconBot.name = 'beaconBot';
  beaconBot.position.set(0, -0.7, -0.2);
  fus.add(beaconBot);
  const strobe = reg(new THREE.Mesh(sph(0.035), M.strobe));
  strobe.name = 'strobe';
  strobe.position.set(0, 1.14, -4.62);
  fus.add(strobe);

  // ==== cockpit interior ====
  const cockpit = reg(new THREE.Group());
  cockpit.name = 'cockpit';
  cockpit.position.set(0, 0, 0);
  fus.add(cockpit);
  const ck = new Asm('cockpitParts', cockpit);
  ck.put(M.cavity, box(1.3, 0.04, 1.9, 0, 0.74, 2.85));
  ck.put(M.graphite, box(0.95, 0.32, 0.75, 0, 1.1, 3.62, -0.35)); // glareshield
  ck.put(M.graphite, box(1.05, 0.26, 0.4, 0, 1.28, 3.3, -0.5)); // dash
  ck.put(M.graphite, box(0.3, 0.4, 0.85, 0, 0.95, 2.85)); // center console
  for (const s of [1, -1]) {
    ck.put(M.fabric, box(0.4, 0.09, 0.45, s * 0.34, 0.95, 2.6));
    ck.put(M.fabric, box(0.4, 0.55, 0.09, s * 0.34, 1.24, 2.36, -0.12));
    ck.put(M.fabric, box(0.24, 0.17, 0.08, s * 0.34, 1.6, 2.32, -0.12));
    ck.put(M.graphiteLight, cyl(0.024, 0.024, 0.36, 8, s * 0.34, 1.0, 3.03, -0.3));
    ck.put(M.graphiteLight, sph(0.04, 1, 1, 1, s * 0.34, 1.18, 3.08));
  }
  ck.done();
  const screens = new Asm('dashScreens', cockpit);
  for (const sx of [-0.3, 0, 0.3]) {
    screens.put(M.screen, tg(new THREE.PlaneGeometry(0.22, 0.13), sx, 1.32, 3.1, -0.5));
  }
  screens.done(false);

  // ==== canopy ====
  const canopy = reg(new THREE.Group());
  canopy.name = 'canopy';
  canopy.position.set(0, 1.45, 3.8);
  canopy.rotation.x = 0.12;
  fus.add(canopy);
  const glassG = new THREE.SphereGeometry(1, 26, 14, 0, PI * 2, 0, HPI);
  glassG.scale(0.72, 0.72, 1.25);
  glassG.translate(0, 0, -0.95);
  const glass = new THREE.Mesh(glassG, M.glassCanopy);
  glass.name = 'canopyGlass';
  glass.renderOrder = 3;
  glass.castShadow = false;
  canopy.add(glass);
  const frames = new Asm('canopyFrames', canopy);
  for (const zf of [-0.25, -0.95, -1.6]) {
    const hoop = tor(0.71, 0.028, PI, 0, 0, zf);
    hoop.scale(1.0, 1.02, 1);
    frames.put(M.graphite, hoop);
  }
  frames.put(M.graphite, cyl(0.024, 0.024, 1.5, 8, 0, 0.7, -0.95, HPI));
  for (const s of [1, -1]) frames.put(M.graphite, cyl(0.028, 0.028, 1.7, 8, s * 0.7, 0.02, -0.95, HPI));
  frames.done();

  // ==== cabin + rescue door ====
  const cabin = reg(new THREE.Group());
  cabin.name = 'cabin';
  fus.add(cabin);
  const cb = new Asm('cabinParts', cabin);
  cb.put(M.cavity, box(1.35, 0.05, 2.2, 0, 0.72, 0.6));
  cb.put(M.cavity, box(1.3, 1.05, 0.05, 0, 1.25, 1.72));
  cb.put(M.cavity, box(1.3, 1.05, 0.05, 0, 1.25, -0.52));
  cb.put(M.cavity, box(0.05, 1.0, 2.2, -0.64, 1.24, 0.6));
  cb.put(M.cavity, box(1.3, 0.04, 2.2, 0, 1.72, 0.6));
  for (const zf of [0.15, 0.95]) { // fold-down seats, port side
    cb.put(M.fabric, box(0.38, 0.06, 0.4, -0.42, 0.98, zf));
    cb.put(M.fabric, box(0.07, 0.5, 0.4, -0.58, 1.24, zf));
    cb.put(M.graphiteLight, cyl(0.015, 0.015, 0.24, 6, -0.34, 0.86, zf, 0, 0, 0.25));
  }
  // stretcher
  for (const sx of [-0.06, 0.38]) cb.put(M.graphiteLight, cyl(0.02, 0.02, 1.75, 8, sx, 0.88, 0.55, HPI));
  for (const zf of [-0.2, 1.3]) for (const sx of [-0.06, 0.38]) {
    cb.put(M.graphiteLight, cyl(0.016, 0.016, 0.14, 6, sx, 0.8, zf));
  }
  cb.put(M.paintOrange, box(0.5, 0.07, 1.68, 0.16, 0.93, 0.55));
  for (const zf of [0.1, 1.0]) cb.put(M.graphite, box(0.52, 0.02, 0.08, 0.16, 0.98, zf));
  // grab rails + ceiling
  cb.put(M.graphiteLight, cyl(0.019, 0.019, 1.9, 8, 0.5, 1.66, 0.6, HPI));
  cb.put(M.graphiteLight, cyl(0.019, 0.019, 1.9, 8, -0.5, 1.66, 0.6, HPI));
  cb.done();
  const cabinLights = reg(new THREE.Mesh(
    mergeGeometries([box(0.1, 0.02, 1.6, 0.25, 1.7, 0.6).toNonIndexed(),
      box(0.1, 0.02, 1.6, -0.25, 1.7, 0.6).toNonIndexed()], false),
    M.cabinLight));
  cabinLights.name = 'cabinLightStrips';
  cabin.add(cabinLights);

  const cabinDoor = reg(new THREE.Group());
  cabinDoor.name = 'cabinDoor';
  cabinDoor.position.set(0.74, 1.17, 0.6);
  cabinDoor.rotation.z = 0.36;
  fus.add(cabinDoor);
  {
    let panel = new THREE.ExtrudeGeometry(roundedRectShape(1.72, 0.82, 0.1),
      { depth: 0.045, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1 });
    panel.rotateY(HPI);
    const dA = new Asm('doorParts', cabinDoor);
    dA.put(M.paintHull, panel);
    dA.put(M.glassLens, box(0.03, 0.3, 0.5, 0.045, 0.14, 0.25));
    dA.put(M.graphiteLight, tor(0.07, 0.014, PI, 0.075, -0.1, -0.55, 0, HPI, 0));
    dA.put(M.graphite, box(0.02, 0.04, 1.66, -0.02, 0.44, 0));
    dA.put(M.graphite, box(0.02, 0.04, 1.66, -0.02, -0.44, 0));
    dA.done();
    cabinDoor.add(decalMesh(M.decal(M.tex.doorSign), 0.78, 0.3, V3(0.085, -0.02, 0.35), V3(1, 0, 0)));
  }

  // maintenance service panels
  const panelA = reg(new THREE.Group());
  panelA.name = 'panelA';
  panelA.position.set(0, 1.77, -1.15);
  fus.add(panelA);
  const pA = new Asm('panelAParts', panelA);
  pA.put(M.paintIvory, box(0.62, 0.03, 0.86, 0, 0, -0.45));
  pA.put(M.graphiteLight, box(0.08, 0.02, 0.1, 0, -0.025, -0.8));
  pA.done();
  fus.add(new THREE.Mesh(box(0.56, 0.3, 0.8, 0, 1.58, -1.6), M.cavity));
  const panelB = reg(new THREE.Group());
  panelB.name = 'panelB';
  panelB.position.set(0.42, 0.85, 4.05);
  fus.add(panelB);
  const pB = new Asm('panelBParts', panelB);
  pB.put(M.paintIvory, box(0.04, 0.42, 0.5, 0.05, 0, -0.28));
  pB.put(M.graphiteLight, box(0.02, 0.08, 0.08, 0.08, 0, -0.5));
  pB.done();
  const avionics = new Asm('avionicsBay', fus);
  avionics.put(M.cavity, box(0.5, 0.44, 0.5, 0.15, 0.85, 3.78));
  avionics.put(M.graphiteLight, box(0.16, 0.1, 0.3, 0.28, 0.78, 3.78));
  avionics.put(M.paintOrange, box(0.1, 0.08, 0.2, 0.28, 0.95, 3.7));
  avionics.done();

  // ==== sensor turret ====
  const turretYaw = reg(new THREE.Group());
  turretYaw.name = 'turretYaw';
  turretYaw.position.set(0, -0.06, 4.0);
  fus.add(turretYaw);
  const tMount = new Asm('turretMount', turretYaw);
  tMount.put(M.graphiteLight, cyl(0.1, 0.09, 0.12, 14, 0, -0.04, 0));
  tMount.done();
  const turretPitch = reg(new THREE.Group());
  turretPitch.name = 'turretPitch';
  turretPitch.position.set(0, -0.22, 0);
  turretYaw.add(turretPitch);
  const tHead = new Asm('turretHead', turretPitch);
  tHead.put(M.graphite, sph(0.2, 1, 0.86, 1));
  tHead.put(M.graphiteLight, tor(0.2, 0.02, PI * 2, 0, 0.02, 0, HPI, 0, 0));
  tHead.done();
  const lenses = new Asm('turretLenses', turretPitch);
  lenses.put(M.glassLens, cyl(0.07, 0.075, 0.05, 14, 0, -0.02, 0.17, HPI));
  lenses.put(M.glassLens, cyl(0.032, 0.035, 0.04, 10, 0.1, 0.03, 0.15, HPI));
  lenses.put(M.glassLens, cyl(0.032, 0.035, 0.04, 10, -0.1, 0.03, 0.15, HPI));
  lenses.put(M.statusCyan, tor(0.075, 0.008, PI * 2, 0, -0.02, 0.185));
  lenses.put(M.statusCyan, sph(0.014, 1, 1, 1, 0, -0.16, 0.1));
  lenses.done(false);

  // ==== winch ====
  const winch = reg(new THREE.Group());
  winch.name = 'winch';
  winch.position.set(0.6, 1.88, 0.85);
  fus.add(winch);
  const wBase = new Asm('winchBase', winch);
  wBase.put(M.graphite, box(0.3, 0.16, 0.42, 0, 0.0, 0));
  wBase.put(M.metal, cyl(0.05, 0.06, 0.22, 10, 0, 0.18, 0));
  wBase.done();
  const winchDrum = reg(new THREE.Mesh(
    mergeGeometries([cyl(0.11, 0.11, 0.2, 14).toNonIndexed(),
      cyl(0.14, 0.14, 0.03, 14, 0, 0.1, 0).toNonIndexed(),
      cyl(0.14, 0.14, 0.03, 14, 0, -0.1, 0).toNonIndexed()], false),
    M.cable));
  winchDrum.name = 'winchDrum';
  winchDrum.rotation.z = HPI;
  winchDrum.position.set(0, 0.12, -0.28);
  winch.add(winchDrum);
  const winchArm = reg(new THREE.Group());
  winchArm.name = 'winchArm';
  winchArm.position.set(0, 0.3, 0);
  winch.add(winchArm);
  const wArm = new Asm('winchArmParts', winchArm);
  wArm.put(M.paintOrange, cyl(0.045, 0.055, 1.24, 10, 0, 0, 0.62, HPI));
  wArm.put(M.paintOrange, box(0.09, 0.2, 0.24, 0, -0.08, 0.05));
  wArm.put(M.graphiteLight, tor(0.075, 0.018, PI * 2, 0, -0.02, 1.22, 0, 0, HPI));
  wArm.done();
  const cableRig = new THREE.Group();
  cableRig.name = 'cableRig';
  cableRig.position.set(0, -0.06, 1.22);
  winchArm.add(cableRig);
  const cableGeo = tg(new THREE.CylinderGeometry(0.011, 0.011, 1, 6), 0, -0.5, 0);
  const cableMesh = reg(new THREE.Mesh(cableGeo, M.cable));
  cableMesh.name = 'cable';
  cableMesh.castShadow = false;
  cableRig.add(cableMesh);
  const hook = reg(new THREE.Group());
  hook.name = 'hook';
  cableRig.add(hook);
  const hookA = new Asm('hookParts', hook);
  hookA.put(M.metal, cyl(0.02, 0.03, 0.07, 8, 0, -0.02, 0));
  hookA.put(M.metal, tor(0.05, 0.013, PI * 1.6, 0, -0.11, 0, 0, 0, -0.5));
  hookA.done();
  const basket = reg(new THREE.Group());
  basket.name = 'basket';
  basket.position.set(0, -0.2, 0);
  hook.add(basket);
  const bk = new Asm('basketParts', basket);
  for (const yb of [0, -0.36]) {
    for (const sx of [0.22, -0.22]) bk.put(M.paintOrange, cyl(0.018, 0.018, 0.96, 8, sx, yb, 0, HPI));
    for (const zf of [0.48, -0.48]) bk.put(M.paintOrange, cyl(0.018, 0.018, 0.44, 8, 0, yb, zf, 0, 0, HPI));
  }
  for (const sx of [0.22, -0.22]) for (const zf of [0.48, -0.48]) {
    bk.put(M.paintOrange, cyl(0.014, 0.014, 0.36, 6, sx, -0.18, zf));
  }
  for (const sx of [-0.12, 0, 0.12]) bk.put(M.graphite, box(0.06, 0.015, 0.92, sx, -0.37, 0));
  bk.done();

  // ==== landing gear ====
  function wheelPair(A, y, spread, rTire, rTube) {
    for (const sx of [spread, -spread]) {
      A.put(M.rubber, tor(rTire, rTube, PI * 2, sx, y, 0, 0, HPI, 0));
      A.put(M.graphiteLight, cyl(rTire * 0.45, rTire * 0.45, 0.05, 10, sx, y, 0, 0, 0, HPI));
    }
    A.put(M.metal, cyl(0.022, 0.022, spread * 2 + 0.14, 8, 0, y, 0, 0, 0, HPI));
  }
  const gearNose = reg(new THREE.Group());
  gearNose.name = 'gearNose';
  gearNose.position.set(0, -0.42, 3.1);
  fus.add(gearNose);
  const gn = new Asm('gearNoseParts', gearNose);
  gn.put(M.metal, cyl(0.05, 0.045, 0.62, 10, 0, -0.31, 0));
  gn.put(M.metal, cyl(0.028, 0.028, 0.24, 8, 0, -0.62, 0));
  gn.put(M.graphiteLight, box(0.05, 0.16, 0.1, 0, -0.5, 0.07, 0.5));
  wheelPair(gn, -0.73, 0.11, 0.13, 0.06);
  gn.done();
  const gearBays = new Asm('gearBays', fus);
  gearBays.put(M.cavity, box(0.34, 0.2, 0.92, 0, -0.42, 3.1));
  gearBays.put(M.cavity, box(0.28, 0.4, 0.95, 0.8, -0.4, -1.0));
  gearBays.put(M.cavity, box(0.28, 0.4, 0.95, -0.8, -0.4, -1.0));
  gearBays.done(false);
  const mains = {};
  for (const s of [1, -1]) {
    const g = reg(new THREE.Group());
    g.name = s > 0 ? 'gearMainR' : 'gearMainL';
    g.position.set(s * 0.88, -0.35, -1.0);
    fus.add(g);
    const ga = new Asm('gearMainParts', g);
    ga.put(M.metal, cyl(0.06, 0.05, 0.78, 10, 0, -0.39, 0));
    ga.put(M.metal, cyl(0.03, 0.03, 0.52, 8, 0, -0.32, 0.18, 0.6));
    ga.put(M.graphiteLight, box(0.07, 0.2, 0.12, 0, -0.6, 0.03));
    wheelPair(ga, -0.78, 0.12, 0.145, 0.065);
    ga.done();
    mains[s] = g;
  }
  const gearDoorNoseR = reg(new THREE.Group());
  gearDoorNoseR.name = 'gearDoorNoseR';
  gearDoorNoseR.position.set(0.17, -0.44, 3.1);
  fus.add(gearDoorNoseR);
  gearDoorNoseR.add(new THREE.Mesh(box(0.16, 0.02, 0.85, 0.08, 0, 0), M.paintIvory));
  const gearDoorNoseL = reg(new THREE.Group());
  gearDoorNoseL.name = 'gearDoorNoseL';
  gearDoorNoseL.position.set(-0.17, -0.44, 3.1);
  fus.add(gearDoorNoseL);
  gearDoorNoseL.add(new THREE.Mesh(box(0.16, 0.02, 0.85, -0.08, 0, 0), M.paintIvory));
  const mainDoors = {};
  for (const s of [1, -1]) {
    const d = reg(new THREE.Group());
    d.name = s > 0 ? 'gearDoorR' : 'gearDoorL';
    d.position.set(s * 0.93, -0.28, -1.0);
    fus.add(d);
    d.add(new THREE.Mesh(box(0.025, 0.44, 0.92, 0, -0.24, 0), M.paintIvory));
    mainDoors[s] = d;
  }

  // ==== sponsons ====
  const spons = {};
  for (const s of [1, -1]) {
    const g = reg(new THREE.Group());
    g.name = s > 0 ? 'sponsonR' : 'sponsonL';
    g.position.set(s * 1.12, 0.08, -0.5);
    fus.add(g);
    const rings = [
      [1.2, 0.05, 0.04, 0.05], [0.8, 0.22, 0.18, 0.16], [0.0, 0.3, 0.26, 0.22],
      [-0.8, 0.26, 0.2, 0.2], [-1.3, 0.08, 0.05, 0.1],
    ].map(([z, w, d, h]) => ({ z, pts: fuseSec(w, d, h, 0) }));
    const mesh = new THREE.Mesh(loft(rings), M.paintIvory);
    mesh.name = 'sponsonHull';
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    const trim = new Asm('sponsonTrim', g);
    trim.put(M.graphite, box(0.5, 0.03, 2.1, 0, 0.23, -0.05));
    trim.put(M.paintOrange, box(0.56, 0.05, 0.2, 0, -0.05, 1.0));
    trim.done();
    spons[s] = g;
  }

  // ==== wings + nacelles + rotors ====
  function bladeGeometry() {
    const rings = [];
    const NS = 7;
    for (let i = 0; i < NS; i++) {
      const t = 1 - i / (NS - 1); // decreasing z ordering (tip first)
      const rr = 0.24 + 1.66 * t;
      const c = lerp(0.3, 0.13, t);
      const tw = lerp(0.38, 0.06, t);
      const pts = [];
      const K = 8;
      for (let k = 0; k < K; k++) {
        const a = (k / K) * PI * 2;
        const x = Math.cos(a) * 0.5 * c - 0.12 * c;
        const y = Math.sin(a) * 0.5 * c * 0.18;
        pts.push([x * Math.cos(tw) - y * Math.sin(tw), x * Math.sin(tw) + y * Math.cos(tw)]);
      }
      rings.push({ pts, z: rr });
    }
    const g = loft(rings);
    g.rotateY(HPI); // span along +x
    return g;
  }

  function buildRotor(s) {
    const rotor = new THREE.Group();
    rotor.name = s > 0 ? 'rotorR' : 'rotorL';
    const unitParts = [
      bladeGeometry().toNonIndexed(),
      cyl(0.055, 0.045, 0.22, 10, 0.24, 0, 0, 0, 0, HPI).toNonIndexed(),
      cyl(0.012, 0.012, 0.2, 6, 0.16, -0.07, 0.05, 0.4, 0, 0.5).toNonIndexed(),
    ];
    let unit = mergeGeometries(unitParts, false);
    if (s < 0) unit = mirrorGeometry(unit);
    const all = [];
    for (let i = 0; i < 5; i++) {
      const gi = unit.clone();
      gi.rotateY((i * PI * 2) / 5);
      all.push(gi);
    }
    const blades = new THREE.Mesh(mergeGeometries(all, false), M.blade);
    blades.name = 'blades';
    blades.castShadow = true;
    rotor.add(blades);
    const hub = new Asm('rotorHub', rotor);
    hub.put(M.graphite, cyl(0.16, 0.18, 0.16, 14, 0, 0.0, 0));
    hub.put(M.graphiteLight, cyl(0.05, 0.05, 0.28, 8, 0, -0.14, 0));
    hub.put(M.paintIvory, new THREE.LatheGeometry([
      new THREE.Vector2(0.02, 0.4), new THREE.Vector2(0.12, 0.3),
      new THREE.Vector2(0.18, 0.16), new THREE.Vector2(0.19, 0.06), new THREE.Vector2(0.16, 0.02),
    ], 16));
    hub.done();
    return rotor;
  }

  function buildNacelle(s) {
    const pivot = new THREE.Group();
    pivot.name = s > 0 ? 'nacelleR' : 'nacelleL';
    const hard = new Asm('nacHardware', pivot);
    hard.put(M.graphiteLight, cyl(0.1, 0.1, 0.74, 12, 0, 0, 0, 0, 0, HPI));
    for (const fx of [0.37, -0.37]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * PI * 2;
        hard.put(M.graphite, cyl(0.018, 0.018, 0.05, 6,
          fx, Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0, 0, HPI));
      }
    }
    hard.done();
    const body = new THREE.Group();
    body.name = s > 0 ? 'nacBodyR' : 'nacBodyL';
    pivot.add(body);
    const B = new Asm('nacBody', body);
    B.put(M.paintIvory, new THREE.LatheGeometry([
      new THREE.Vector2(0.04, -0.95), new THREE.Vector2(0.3, -0.88), new THREE.Vector2(0.46, -0.6),
      new THREE.Vector2(0.55, -0.2), new THREE.Vector2(0.55, 0.3), new THREE.Vector2(0.5, 0.6),
      new THREE.Vector2(0.42, 0.8), new THREE.Vector2(0.45, 0.9),
    ], 24));
    B.put(M.metal, tor(0.42, 0.06, PI * 2, 0, 0.9, 0, HPI, 0, 0));
    B.put(M.cavity, tube(0.37, 0.34, 0.42, 18, true, 0, 0.72, 0));
    B.put(M.cavity, circ(0.345, 18, 0, 0.52, 0, -HPI));
    B.put(M.graphite, tor(0.17, 0.05, PI * 2, 0, -0.9, -0.1, HPI, 0, 0));
    B.put(M.cavity, circ(0.16, 12, 0, -0.91, -0.1, HPI));
    for (let i = 0; i < 3; i++) B.put(M.cavity, box(0.02, 0.05, 0.24, 0.54, -0.15 - i * 0.12, -0.05));
    B.put(M.graphiteLight, box(0.2, 0.3, 0.24, s * -0.45, -0.05, 0));
    B.done();
    const band = new THREE.Mesh(tube(0.556, 0.556, 0.14, 24, true, 0, 0.38, 0), M.caution);
    band.name = 'cautionBand';
    band.castShadow = false;
    body.add(band);
    body.add(decalMesh(M.decal(M.tex.labelIntake), 0.5, 0.13, V3(0, 0.06, 0.555), V3(0, 0.12, 1)));
    const rotor = buildRotor(s);
    rotor.position.y = 1.02;
    body.add(rotor);
    reg(rotor);
    const disc = new THREE.Mesh(circ(1.94, 48, 0, 1.12, 0, -HPI), M.disc);
    disc.name = s > 0 ? 'discR' : 'discL';
    disc.renderOrder = 4;
    body.add(disc);
    reg(disc);
    const anchor = new THREE.Object3D();
    anchor.name = s > 0 ? 'actAnchorR' : 'actAnchorL';
    anchor.position.set(0, -0.55, 0.3);
    body.add(anchor);
    reg(anchor);
    return pivot;
  }

  function buildWing(s) {
    const wing = new THREE.Group();
    wing.name = s > 0 ? 'wingR' : 'wingL';
    wing.position.set(s * 0.9, 1.58, 0.35);
    root.add(wing);
    reg(wing);
    const span = 3.6;
    let skin = new THREE.ExtrudeGeometry(airfoilShape(1.5, 0.19), { depth: span, bevelEnabled: false, curveSegments: 8 });
    skin.rotateY(HPI);
    {
      const p = skin.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const t = THREE.MathUtils.clamp(p.getX(i) / span, 0, 1);
        const k = 1 - 0.38 * t;
        p.setY(i, p.getY(i) * k + t * 0.1);
        p.setZ(i, p.getZ(i) * k - 0.28 * t);
      }
      skin.computeVertexNormals();
    }
    let fair = new THREE.ExtrudeGeometry(airfoilShape(1.95, 0.34), { depth: 0.55, bevelEnabled: false, curveSegments: 6 });
    fair.rotateY(HPI);
    fair = tg(fair, -0.15, -0.04, 0.18);
    let plates = mergeGeometries([
      box(1.15, 0.014, 0.55, 1.05, 0.1, -0.5).toNonIndexed(),
      box(0.8, 0.014, 0.4, 2.2, 0.09, -0.45).toNonIndexed(),
      box(0.08, 0.5, 0.9, 3.52, 0.06, -0.52).toNonIndexed(),
    ], false);
    let skinAll = mergeGeometries([skin.toNonIndexed(), fair.toNonIndexed(), plates], false);
    if (s < 0) skinAll = mirrorGeometry(skinAll);
    const skinMesh = new THREE.Mesh(skinAll, M.paintIvory);
    skinMesh.name = 'wingSkin';
    skinMesh.castShadow = skinMesh.receiveShadow = true;
    wing.add(skinMesh);
    // flaperon
    const flap = new THREE.Group();
    flap.name = s > 0 ? 'wingFlapR' : 'wingFlapL';
    flap.position.set(s * 1.65, 0.0, -1.28);
    wing.add(flap);
    reg(flap);
    flap.add(new THREE.Mesh(box(1.9, 0.05, 0.3, 0, 0, -0.16, 0, 0, s * 0.02), M.paintIvory));
    flap.add(new THREE.Mesh(box(1.9, 0.02, 0.05, 0, 0, 0.02), M.graphite));
    // wing bolts
    {
      const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 6), M.graphiteLight, 36);
      const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
      let k = 0;
      for (let i = 0; i < 18; i++) {
        p.set(s * (0.45 + i * 0.17), 0.105 - i * 0.004, -0.18 + (rng() - 0.5) * 0.01);
        m4.compose(p, q, sc); im.setMatrixAt(k++, m4);
        p.set(s * (0.45 + i * 0.17), 0.1 - i * 0.004, -0.88 - i * 0.012);
        m4.compose(p, q, sc); im.setMatrixAt(k++, m4);
      }
      im.name = 'wingBolts';
      im.castShadow = false;
      wing.add(im);
    }
    wing.add(decalMesh(M.decal(M.tex.labelNoStep), 0.6, 0.16, V3(s * 1.3, 0.12, -0.55), V3(0, 1, 0), s > 0 ? 0 : PI));
    // nav light
    const nav = new THREE.Mesh(sph(0.035), s > 0 ? M.navGreen : M.navRed);
    nav.name = s > 0 ? 'navR' : 'navL';
    nav.position.set(s * 3.55, 0.1, 0.02);
    wing.add(nav);
    reg(nav);
    // tilt actuator
    const actBase = new THREE.Object3D();
    actBase.name = s > 0 ? 'actBaseR' : 'actBaseL';
    actBase.position.set(s * 2.95, -0.12, 0.0);
    wing.add(actBase);
    reg(actBase);
    const rodGeo = tg(new THREE.CylinderGeometry(0.032, 0.032, 1, 8), 0, 0.5, 0);
    const rod = new THREE.Mesh(rodGeo, M.metal);
    rod.name = s > 0 ? 'actRodR' : 'actRodL';
    rod.position.copy(actBase.position);
    wing.add(rod);
    reg(rod);
    const rodBracket = new THREE.Mesh(box(0.12, 0.1, 0.14, s * 2.95, -0.16, 0), M.graphite);
    rodBracket.name = 'actBracket';
    wing.add(rodBracket);
    // nacelle
    const nacelle = buildNacelle(s);
    nacelle.position.set(s * 3.5, 0.12, -0.55);
    wing.add(nacelle);
    reg(nacelle);
    return wing;
  }
  const wingR = buildWing(1);
  const wingL = buildWing(-1);

  // ==== hull fasteners (instanced) ====
  {
    const linesDef = [];
    for (const s of [1, -1]) {
      linesDef.push([[s * 0.96, 0.55, 2.6], [s * 0.92, 0.6, -2.0], 24, [s, 0, 0]]);
      linesDef.push([[s * 0.86, -0.2, 2.8], [s * 0.84, -0.15, -2.2], 20, [s, -0.4, 0]]);
      linesDef.push([[s * 0.7, 1.55, 1.7], [s * 0.66, 1.5, -0.7], 12, [s, 0.8, 0]]);
    }
    linesDef.push([[0, 1.78, 2.0], [0, 1.8, -2.6], 20, [0, 1, 0]]);
    linesDef.push([[0.35, 1.72, -3.0], [0.2, 2.2, -3.6], 8, [0.6, 0.8, 0]]);
    let total = 0;
    for (const l of linesDef) total += l[2];
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.013, 0.013, 0.013, 6), M.graphiteLight, total);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
      up = V3(0, 1, 0), a = V3(), b = V3(), n = V3(), p = V3(), sc = V3(1, 1, 1);
    let k = 0;
    for (const [A, B2, cnt, nor] of linesDef) {
      a.fromArray(A); b.fromArray(B2); n.fromArray(nor).normalize();
      q.setFromUnitVectors(up, n);
      for (let i = 0; i < cnt; i++) {
        p.lerpVectors(a, b, cnt === 1 ? 0 : i / (cnt - 1));
        p.x += (rng() - 0.5) * 0.006;
        p.y += (rng() - 0.5) * 0.006;
        m4.compose(p, q, sc);
        im.setMatrixAt(k++, m4);
      }
    }
    im.name = 'hullFasteners';
    im.castShadow = false;
    fus.add(im);
  }

  // ==== fuselage decals ====
  for (const s of [1, -1]) {
    fus.add(decalMesh(M.decal(M.tex.wordmark), 1.9, 0.48, V3(s * 0.92, 1.18, -1.5), V3(s, 0.33, 0)));
    fus.add(decalMesh(M.decal(M.tex.chevron), 0.9, 0.45, V3(s * 0.7, 0.8, 3.0), V3(s, 0.12, 0.18)));
    fus.add(decalMesh(M.decal(M.tex.finCode), 0.5, 0.5, V3(s * 0.585, 1.72, -3.85), V3(s, 0, 0)));
  }
  fus.add(decalMesh(M.decal(M.tex.labelHoist), 0.62, 0.16, V3(0.78, 1.72, 1.5), V3(0.55, 0.83, 0)));
  fus.add(decalMesh(M.decal(M.tex.labelSvc), 0.34, 0.1, V3(0.47, 0.62, 4.0), V3(1, 0.1, 0.2)));
  fus.add(decalMesh(M.decal(M.tex.labelStatic), 0.32, 0.09, V3(-0.9, 1.05, 2.2), V3(-1, 0.25, 0)));
  fus.add(decalMesh(M.decal(M.tex.labelTie), 0.3, 0.09, V3(0.62, 1.62, -2.75), V3(0.75, 0.66, 0)));
  fus.add(decalMesh(M.decal(M.tex.wear), 0.5, 0.7, V3(0.93, 0.9, -2.35), V3(1, 0.3, 0), 0, 'wearStreak'));

  // ==== rig bindings (channel-driven articulation) ====
  rig.push(
    { c: 'nacelle', n: 'nacelleR', p: 'rx', a: 0, b: HPI },
    { c: 'nacelle', n: 'nacelleL', p: 'rx', a: 0, b: HPI },
    { c: 'gear', n: 'gearNose', p: 'rx', a: -1.9, b: 0 },
    { c: 'gear', n: 'gearMainR', p: 'rz', a: -1.75, b: 0 },
    { c: 'gear', n: 'gearMainL', p: 'rz', a: 1.75, b: 0 },
    { c: 'gearDoors', n: 'gearDoorNoseR', p: 'rz', a: 0, b: -1.4 },
    { c: 'gearDoors', n: 'gearDoorNoseL', p: 'rz', a: 0, b: 1.4 },
    { c: 'gearDoors', n: 'gearDoorR', p: 'rz', a: 0, b: 1.3 },
    { c: 'gearDoors', n: 'gearDoorL', p: 'rz', a: 0, b: -1.3 },
    { c: 'sponson', n: 'sponsonR', p: 'px', a: -0.42, b: 0 },
    { c: 'sponson', n: 'sponsonR', p: 'py', a: 0.34, b: 0 },
    { c: 'sponson', n: 'sponsonL', p: 'px', a: 0.42, b: 0 },
    { c: 'sponson', n: 'sponsonL', p: 'py', a: 0.34, b: 0 },
    { c: 'door', n: 'cabinDoor', p: 'pz', a: 0, b: -1.55 },
    { c: 'door', n: 'cabinDoor', p: 'px', a: 0, b: 0.14 },
    { c: 'arm', n: 'winchArm', p: 'ry', a: 0, b: 1.42 },
    { c: 'panels', n: 'panelA', p: 'rx', a: 0, b: 1.15 },
    { c: 'panels', n: 'panelB', p: 'ry', a: 0, b: -1.25 },
    { c: 'panels', n: 'canopy', p: 'rx', a: 0.12, b: 0.55 },
    { c: 'cable', n: 'cable', p: 'sy', a: 0.02, b: 3.0 },
  );

  // ==== explode vectors (local-space, restored exactly at 0) ====
  const ex = (n, x, y, z, dist) => explodables.push({ n, dir: V3(x, y, z).normalize(), dist });
  ex('canopy', 0, 0.85, 0.45, 1.15);
  ex('cabinDoor', 1, 0.12, 0, 1.35);
  ex('wingR', 0.5, 0.5, 0, 1.35);
  ex('wingL', -0.5, 0.5, 0, 1.35);
  ex('nacelleR', 1, 0.25, 0, 1.3);
  ex('nacelleL', -1, 0.25, 0, 1.3);
  ex('rotorR', 0, 1, 0, 1.05);
  ex('rotorL', 0, 1, 0, 1.05);
  ex('gearNose', 0, -0.85, 0.5, 0.95);
  ex('gearMainR', 0.7, -0.75, 0, 0.95);
  ex('gearMainL', -0.7, -0.75, 0, 0.95);
  ex('gearDoorNoseR', 0.6, -0.55, 0, 0.55);
  ex('gearDoorNoseL', -0.6, -0.55, 0, 0.55);
  ex('gearDoorR', 0.9, -0.4, 0, 0.65);
  ex('gearDoorL', -0.9, -0.4, 0, 0.65);
  ex('sponsonR', 1, -0.3, 0, 1.15);
  ex('sponsonL', -1, -0.3, 0, 1.15);
  ex('turretYaw', 0, -1, 0.5, 0.95);
  ex('winch', 0.85, 0.6, 0, 0.95);
  ex('panelA', 0, 1, -0.35, 0.85);
  ex('panelB', 1, 0.3, 0.4, 0.75);
  ex('wingFlapR', 0, 0.35, -1, 0.6);
  ex('wingFlapL', 0, 0.35, -1, 0.6);

  // ==== hotspots ====
  hs('rotor-head-r', parts.nacelleR, V3(0, 1.35, 0),
    'Rotor head — starboard',
    'Five-blade articulated head with elastomeric bearings. The cuffs and pitch links trim blade incidence collectively; at operating speed the disc is rendered as a translucent sweep.', 3.2);
  hs('nacelle-pivot-r', parts.nacelleR, V3(0.3, 0, 0),
    'Nacelle tilt pivot',
    'Cross-shaft trunnion carrying the full nacelle. The bolted collar transfers rotor thrust into the wing torque box while the nacelle sweeps from lift to cruise.', 2.6);
  hs('tilt-actuator-r', parts.actBaseR, V3(0, 0, 0),
    'Tilt conversion actuator',
    'Ball-screw actuator that drives nacelle conversion. It is sized to hold the nacelle against full rotor thrust with the second (redundant) motor lane failed.', 2.2);
  hs('sensor-turret', parts.turretPitch, V3(0, -0.12, 0.22),
    'Nose sensor turret',
    'Gimballed ball with thermal imager, low-light camera and a laser range channel. Auto-scan sweeps the search sector; manual pointing overrides for a hoist survey.', 1.8);
  hs('winch-drum', parts.winch, V3(0, 0.15, -0.25),
    'Rescue winch drum',
    'Level-wound drum with 30 m of synthetic cable, load cell and cutter cartridge. Rated 270 kg — see the hoist placard beside the door track.', 2.0);
  hs('rescue-basket', parts.basket, V3(0, -0.2, 0),
    'Rescue basket',
    'Buoyant single-litter basket. The arm swings the load line clear of the sponson step so the basket descends outboard of the hull chine.', 2.2);
  hs('cabin-door', parts.cabinDoor, V3(0.1, 0, 0),
    'Starboard rescue door',
    'Single-panel door that translates aft on twin tracks, leaving the full cabin cutout clear for hoist work. Interlocked: it cannot close over a deployed cable.', 2.8);
  hs('nose-gear', parts.gearNose, V3(0, -0.6, 0.1),
    'Nose gear',
    'Trailing-link twin-wheel nose leg. Retracts forward so ram air assists emergency extension; doors sequence open before the leg moves.', 2.0);
  hs('main-gear-l', parts.gearMainL, V3(0, -0.55, 0),
    'Main gear — port',
    'Main leg folds inboard into a keel bay behind the hull step. The oleo is tuned for deck landings; the paired tires spread load on soft ground.', 2.2);
  hs('sponson-l', parts.sponsonL, V3(-0.2, 0, 0),
    'Water sponson — port',
    'Shallow planing sponson that extends for water work, adding roll stability at rest. It houses flotation cells and retracts flush for cruise.', 2.6);
  hs('pitot-probes', parts.fuselage, V3(0.28, 0.62, 4.5),
    'Air-data probes',
    'Dual heated pitot-static probes feeding independent air-data computers; the static plate sits aft on the port side away from spray.', 1.6);
  hs('beacon-mast', parts.fuselage, V3(0, 2.42, -3.55),
    'Anti-collision beacon',
    'Tail beacon and VHF whip on the stabilizer bridge. The red flasher runs whenever the drive system is powered.', 2.6);

  return { root, parts, rig, explodables, hotspots, baseY: 1.34 };
}
