/**
 * Asterion HX-9 Amphibious Rescue Tiltrotor — hierarchical model builder.
 *
 * Original fictional aircraft. Major surfaces are lofted custom BufferGeometry
 * (hull, wings, blades, sponsons, canopy), mechanisms use lathe/tube/extrude
 * geometry, and small hardware is instanced or merged to keep draw calls low.
 *
 * Local frame: +X nose, +Y up, +Z starboard. Wheels rest at y = -1.35 so the
 * root is lifted by that amount in the scene.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, SEED_STRING } from './materials.js';

export const GROUND_OFFSET = 1.35;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------------ *
 * generic geometry helpers
 * ------------------------------------------------------------------ */

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

/** 1D interpolation over control points [[t,v], ...] (sorted). */
export function curveFn(cps) {
  return (t) => {
    const tt = Math.min(cps[cps.length - 1][0], Math.max(cps[0][0], t));
    let i = 0;
    while (i < cps.length - 2 && tt > cps[i + 1][0]) i++;
    const p1 = cps[i];
    const p2 = cps[i + 1];
    const p0 = cps[Math.max(i - 1, 0)];
    const p3 = cps[Math.min(i + 2, cps.length - 1)];
    const u = (tt - p1[0]) / Math.max(1e-6, p2[0] - p1[0]);
    return catmull(p0[1], p1[1], p2[1], p3[1], u);
  };
}

/**
 * Loft a closed ring sequence into a solid. `hardIdx` duplicates ring
 * vertices so creases (chines, trailing edges, keel) stay crisp.
 */
function loft(rings, hardIdx = [], opts = {}) {
  const { capStart = true, capEnd = true } = opts;
  const N = rings[0].length;
  const M = rings.length;
  const hard = new Set(hardIdx);
  const order = [];
  for (let i = 0; i < N; i++) {
    order.push(i);
    if (hard.has(i)) order.push(i);
  }
  const L = order.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let m = 0; m < M; m++) {
    for (let k = 0; k < L; k++) {
      const v = rings[m][order[k]];
      pos.push(v.x, v.y, v.z);
      uv.push(k / L, m / (M - 1));
    }
  }
  const center = (ring) => {
    const c = V3(0, 0, 0);
    ring.forEach((v) => c.add(v));
    return c.multiplyScalar(1 / ring.length);
  };
  // orientation probe on the first strip
  const c0 = center(rings[0]);
  const a0 = rings[0][order[0]];
  const b0 = rings[0][order[1 % L]];
  const d0 = rings[1][order[0]];
  const nrm = new THREE.Vector3().subVectors(b0, a0).cross(new THREE.Vector3().subVectors(d0, a0));
  const flip = nrm.dot(new THREE.Vector3().subVectors(a0, c0)) < 0;
  for (let m = 0; m < M - 1; m++) {
    for (let k = 0; k < L; k++) {
      const k2 = (k + 1) % L;
      if (order[k] === order[k2]) continue;
      const a = m * L + k;
      const b = m * L + k2;
      const c = (m + 1) * L + k2;
      const d = (m + 1) * L + k;
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  let base = M * L;
  const addCap = (ring, outward) => {
    const ctr = center(ring);
    const ci = base;
    pos.push(ctr.x, ctr.y, ctr.z);
    uv.push(0.5, 0.5);
    base++;
    for (let i = 0; i < ring.length; i++) {
      pos.push(ring[i].x, ring[i].y, ring[i].z);
      uv.push(0.5 + 0.5 * Math.cos((i / ring.length) * Math.PI * 2), 0.5 + 0.5 * Math.sin((i / ring.length) * Math.PI * 2));
    }
    const t0 = new THREE.Vector3().subVectors(ring[0], ctr);
    const t1 = new THREE.Vector3().subVectors(ring[1], ctr);
    const capN = t0.clone().cross(t1);
    const rev = capN.dot(outward) < 0;
    for (let i = 0; i < ring.length; i++) {
      const p = base + i;
      const q = base + ((i + 1) % ring.length);
      if (rev) idx.push(ci, q, p);
      else idx.push(ci, p, q);
    }
    base += ring.length;
  };
  if (capStart) addCap(rings[0], new THREE.Vector3().subVectors(center(rings[0]), center(rings[1])));
  if (capEnd) {
    const last = rings[M - 1];
    addCap(last, new THREE.Vector3().subVectors(center(last), center(rings[M - 2])));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** clone + transform a geometry (build-time only). */
function xf(g, o = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r || [0, 0, 0])));
  m.compose(
    new THREE.Vector3(...(o.p || [0, 0, 0])),
    q,
    new THREE.Vector3(...(o.s || [1, 1, 1]))
  );
  return g.clone().applyMatrix4(m);
}

function merge(list, mat, name) {
  const g = mergeGeometries(list.map(flat), false);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = name;
  return mesh;
}

function chamferShape(w, h, c) {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  s.moveTo(-x + c, -y);
  s.lineTo(x - c, -y);
  s.lineTo(x, -y + c);
  s.lineTo(x, y - c);
  s.lineTo(x - c, y);
  s.lineTo(-x + c, y);
  s.lineTo(-x, y - c);
  s.lineTo(-x, -y + c);
  s.closePath();
  return s;
}

/** Chamfered, bevelled panel box — the core structural language. */
function panelBox(w, h, d, c = 0.04, bev = 0.012) {
  const b = Math.max(0.0008, Math.min(bev, w * 0.2, h * 0.2, d * 0.4));
  const ch = Math.max(0.002, Math.min(c, w * 0.45, h * 0.45));
  const depth = Math.max(0.001, d - 2 * b);
  const g = new THREE.ExtrudeGeometry(chamferShape(w, h, ch), {
    depth,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

function tubeGeo(pts, r, seg = 20, rad = 8, closed = false, tension = 0.45) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => V3(p[0], p[1], p[2])), closed, 'catmullrom', tension);
  return new THREE.TubeGeometry(curve, seg, r, rad, closed);
}

function latheGeo(profile, seg = 22, phi = Math.PI * 2) {
  return new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), seg, 0, phi);
}

const cyl = (rt, rb, h, s = 14, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);

/** NACA-style half-thickness. */
function foilThickness(x, thick) {
  return (
    thick *
    (1.4845 * Math.sqrt(x) - 0.63 * x - 1.758 * x * x + 1.4215 * x * x * x - 0.518 * x * x * x * x)
  );
}

/** Closed airfoil ring: [chordFraction, thicknessOffset] pairs. */
function foilRing(n, thick, camber) {
  const up = [];
  const lo = [];
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos((i / n) * Math.PI));
    const yt = foilThickness(x, thick);
    const yc = camber * 4 * x * (1 - x) * (1 - 0.25 * x);
    up.push([x, yc + yt]);
    if (i > 0 && i < n) lo.push([x, yc - yt]);
  }
  lo.reverse();
  return up.concat(lo);
}

/**
 * Build a solid foil: chord along local X, thickness along Y, span along Z.
 * sections: [{ z, chord, thick, camber, twist, xOff, yOff }]
 */
function foilSolid(sections, n = 11, pivot = 0.3) {
  const rings = sections.map((s) => {
    const ring = foilRing(n, s.thick, s.camber == null ? 0.02 : s.camber);
    const tw = s.twist || 0;
    const ct = Math.cos(tw);
    const st = Math.sin(tw);
    return ring.map(([c, y]) => {
      const cx = (c - pivot) * s.chord;
      const cy = y * s.chord;
      return V3((s.xOff || 0) + cx * ct - cy * st, (s.yOff || 0) + cx * st + cy * ct, s.z);
    });
  });
  return loft(rings, [n], { capStart: true, capEnd: true });
}

/* ------------------------------------------------------------------ *
 * hull definition (shared by geometry + decal placement)
 * ------------------------------------------------------------------ */

const HULL = {
  xTail: -3.55,
  xNose: 3.25,
  halfW: curveFn([[0, 0.16], [0.08, 0.5], [0.22, 0.84], [0.4, 0.97], [0.55, 0.98], [0.7, 0.9], [0.84, 0.7], [0.94, 0.4], [1, 0.08]]),
  deck: curveFn([[0, 0.5], [0.1, 0.76], [0.3, 0.98], [0.5, 1.05], [0.64, 1.02], [0.78, 0.88], [0.9, 0.66], [1, 0.36]]),
  chine: curveFn([[0, 0.06], [0.2, -0.06], [0.5, -0.13], [0.8, -0.09], [1, 0.04]]),
  keel: curveFn([[0, -0.24], [0.18, -0.5], [0.45, -0.62], [0.7, -0.56], [0.88, -0.34], [1, -0.06]])
};

export function hullX(t) {
  return HULL.xTail + (HULL.xNose - HULL.xTail) * t;
}
export function hullT(x) {
  return (x - HULL.xTail) / (HULL.xNose - HULL.xTail);
}
/** Outer half-width and deck height at a station — used to seat decals. */
export function hullSurface(x) {
  const t = hullT(x);
  return { halfW: HULL.halfW(t), deck: HULL.deck(t), chine: HULL.chine(t), keel: HULL.keel(t) };
}

const UP_SEG = 7;
const LO_SEG = 5;
const CHINE_IDX = UP_SEG;
const KEEL_IDX = UP_SEG + LO_SEG;
const RING_LEN = 2 * (UP_SEG + LO_SEG + 1) - 2;

function hullRing(t) {
  const x = hullX(t);
  const hw = HULL.halfW(t);
  const deck = HULL.deck(t);
  const chineY = HULL.chine(t);
  const keelY = HULL.keel(t);
  const half = [];
  for (let i = 0; i <= UP_SEG; i++) {
    const a = (i / UP_SEG) * (Math.PI / 2);
    half.push(V3(x, chineY + (deck - chineY) * Math.pow(Math.cos(a), 1.2), hw * Math.pow(Math.sin(a), 0.82)));
  }
  for (let i = 1; i <= LO_SEG; i++) {
    const u = i / LO_SEG;
    half.push(V3(x, chineY + (keelY - chineY) * Math.pow(u, 1.05), hw * (1 - u) * (1 - 0.22 * u)));
  }
  const ring = half.slice();
  for (let i = half.length - 2; i >= 1; i--) {
    const v = half[i];
    ring.push(V3(v.x, v.y, -v.z));
  }
  return ring;
}

/* ------------------------------------------------------------------ *
 * small builders
 * ------------------------------------------------------------------ */

/** Symmetry helper: run a builder for starboard (+1) and port (-1). */
function mirrored(builder) {
  return [builder(1, 'stbd'), builder(-1, 'port')];
}

function instanced(geo, mat, placements, name) {
  const im = new THREE.InstancedMesh(geo, mat, placements.length);
  im.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = V3(0, 1, 0);
  const sc = V3(1, 1, 1);
  placements.forEach((pl, i) => {
    const n = pl.n ? V3(pl.n[0], pl.n[1], pl.n[2]).normalize() : up;
    q.setFromUnitVectors(up, n);
    if (pl.s) sc.set(pl.s[0], pl.s[1], pl.s[2]);
    else sc.set(1, 1, 1);
    m.compose(V3(pl.p[0], pl.p[1], pl.p[2]), q, sc);
    im.setMatrixAt(i, m);
  });
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = true;
  return im;
}

function decalMesh(mat, w, h, p, r = [0, 0, 0], name = 'decal') {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(p[0], p[1], p[2]);
  m.rotation.set(r[0], r[1], r[2]);
  m.renderOrder = 3;
  m.name = name;
  return m;
}

function seatGeos(scale = 1) {
  const pan = xf(panelBox(0.5 * scale, 0.09, 0.52 * scale, 0.04), { p: [0, 0, 0] });
  const back = xf(panelBox(0.48 * scale, 0.62 * scale, 0.1, 0.04), { p: [-0.19 * scale, 0.3 * scale, 0], r: [0, 0, 0.14] });
  const head = xf(panelBox(0.3 * scale, 0.2 * scale, 0.12, 0.04), { p: [-0.24 * scale, 0.7 * scale, 0] });
  const bolsterL = xf(panelBox(0.46 * scale, 0.12, 0.07, 0.03), { p: [0, 0.07, 0.23 * scale] });
  const bolsterR = xf(panelBox(0.46 * scale, 0.12, 0.07, 0.03), { p: [0, 0.07, -0.23 * scale] });
  return { fabric: [pan, back, head, bolsterL, bolsterR] };
}

/* ------------------------------------------------------------------ *
 * main builder
 * ------------------------------------------------------------------ */

export function buildVehicle(mats) {
  const rng = makeRng(SEED_STRING + '/vehicle');
  const root = new THREE.Object3D();
  root.name = 'HX9.root';
  const frame = new THREE.Object3D();
  frame.name = 'HX9.frame';
  root.add(frame);

  const hotspots = [];
  const explodeSpec = [];
  const shadowCasters = [];
  const addHotspot = (h) => hotspots.push(h);

  /* ---------------- fuselage ---------------- */
  const stations = 32;
  const hullRings = [];
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    hullRings.push(hullRing(0.5 * (1 - Math.cos(Math.PI * t))));
  }
  const hullGeo = loft(hullRings, [CHINE_IDX, KEEL_IDX, RING_LEN - CHINE_IDX], { capStart: true, capEnd: true });
  const fuselage = new THREE.Mesh(hullGeo, mats.paintIvory);
  fuselage.name = 'airframe.fuselage';
  frame.add(fuselage);
  shadowCasters.push(fuselage);

  // chine strakes + keel strake: visible boat-hull lines
  const strakeGeos = [];
  for (const side of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const t = 0.03 + (i / 14) * 0.94;
      pts.push([hullX(t), HULL.chine(t), side * HULL.halfW(t) * 1.005]);
    }
    strakeGeos.push(tubeGeo(pts, 0.035, 30, 6));
  }
  const keelPts = [];
  for (let i = 0; i <= 14; i++) {
    const t = 0.05 + (i / 14) * 0.9;
    keelPts.push([hullX(t), HULL.keel(t) - 0.01, 0]);
  }
  strakeGeos.push(tubeGeo(keelPts, 0.045, 30, 6));
  const strakes = merge(strakeGeos, mats.paintGraphite, 'hull.strakes');
  frame.add(strakes);

  // orange rescue belly / waterline band along the chine
  const bandGeos = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < 13; i++) {
      const t = 0.06 + (i / 13) * 0.86;
      const s = hullSurface(hullX(t));
      bandGeos.push(
        xf(panelBox(0.44, 0.17, 0.02, 0.03), {
          p: [hullX(t) + 0.22, HULL.chine(t) - 0.11, side * (s.halfW * 0.96)],
          r: [0, 0, 0.02 * side]
        })
      );
    }
  }
  frame.add(merge(bandGeos, mats.paintOrange, 'hull.waterlineBand'));

  /* ---------------- structural deck detail, seams, hardware ---------------- */
  const graphiteDetail = [];
  const metalDetail = [];
  const ivoryDetail = [];

  // dorsal spine fairing
  const spineRings = [];
  for (let i = 0; i <= 10; i++) {
    const t = 0.12 + (i / 10) * 0.5;
    const d = HULL.deck(t);
    const w = 0.3 * Math.sin(Math.PI * (i / 10)) + 0.12;
    const ring = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      ring.push(V3(hullX(t), d + 0.06 + Math.sin(a) * 0.1, Math.cos(a) * w));
    }
    spineRings.push(ring);
  }
  graphiteDetail.push(loft(spineRings, [], { capStart: true, capEnd: true }));

  // panel seams as thin recessed strips across the hull top and sides
  for (let i = 0; i < 7; i++) {
    const t = 0.14 + i * 0.1;
    const s = hullSurface(hullX(t));
    graphiteDetail.push(xf(panelBox(0.02, 0.02, s.halfW * 1.9, 0.006), { p: [hullX(t), s.deck - 0.01, 0] }));
    for (const side of [1, -1]) {
      graphiteDetail.push(
        xf(panelBox(0.018, 0.5, 0.02, 0.006), { p: [hullX(t), s.chine + 0.34, side * (s.halfW * 0.99)] })
      );
    }
  }

  // service access covers (chamfered plates) + lift points
  const coverSpots = [[-1.6, 0.42], [-0.9, 0.55], [0.6, 0.4], [1.9, 0.3]];
  coverSpots.forEach(([x, yy], i) => {
    for (const side of [1, -1]) {
      const s = hullSurface(x);
      ivoryDetail.push(
        xf(panelBox(0.46, 0.3, 0.024, 0.05), { p: [x, yy, side * (s.halfW * 0.99)], r: [0, Math.PI / 2, 0] })
      );
      if (i % 2 === 0) {
        metalDetail.push(
          xf(cyl(0.03, 0.03, 0.05, 8), { p: [x + 0.16, yy - 0.1, side * (s.halfW * 1.01)], r: [Math.PI / 2, 0, 0] })
        );
      }
    }
  });

  // steps + grab handles by the rescue door (starboard) and crew door (port)
  for (const side of [1, -1]) {
    const s = hullSurface(0.15);
    metalDetail.push(xf(panelBox(0.3, 0.05, 0.13, 0.02), { p: [0.15, -0.14, side * (s.halfW * 1.02)] }));
    metalDetail.push(xf(panelBox(0.24, 0.05, 0.11, 0.02), { p: [0.5, 0.12, side * (s.halfW * 1.02)] }));
    metalDetail.push(
      xf(tubeGeo([[-0.2, 0, 0], [0, 0.05, 0.03], [0.2, 0, 0]], 0.022, 8, 6), {
        p: [1.0, 0.72, side * (s.halfW * 1.02)]
      })
    );
  }

  // antennas, pitot probes, blade aerials
  metalDetail.push(xf(latheGeo([[0.0, 0], [0.02, 0.02], [0.022, 0.34], [0.008, 0.42], [0, 0.44]], 10), { p: [2.62, 0.5, 0.34], r: [0, 0, -0.28] }));
  metalDetail.push(xf(latheGeo([[0.0, 0], [0.02, 0.02], [0.022, 0.34], [0.008, 0.42], [0, 0.44]], 10), { p: [2.62, 0.5, -0.34], r: [0, 0, -0.28] }));
  graphiteDetail.push(xf(panelBox(0.5, 0.26, 0.03, 0.06), { p: [-1.25, 1.12, 0] }));
  graphiteDetail.push(xf(panelBox(0.16, 0.34, 0.03, 0.04), { p: [-2.2, 1.02, 0] }));
  metalDetail.push(xf(latheGeo([[0, 0], [0.018, 0.03], [0.02, 0.5], [0.006, 0.56]], 8), { p: [3.02, 0.16, 0.2], r: [0, 0, Math.PI / 2 - 0.1] }));

  /* ---------------- cockpit ---------------- */
  const cockpit = new THREE.Object3D();
  cockpit.name = 'cockpit.group';
  frame.add(cockpit);

  const canopyRings = [];
  const canopyStations = [1.28, 1.55, 1.85, 2.15, 2.45, 2.72, 2.95, 3.1];
  canopyStations.forEach((x, i) => {
    const t = hullT(x);
    const u = i / (canopyStations.length - 1);
    const hw = HULL.halfW(t) * (0.9 - 0.28 * u * u);
    const base = HULL.deck(t) - 0.06;
    const top = base + 0.62 * (1 - 0.55 * u * u);
    const ring = [];
    const n = 9;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI;
      ring.push(V3(x, base + (top - base) * Math.sin(a), -hw * Math.cos(a)));
    }
    canopyRings.push(ring);
  });
  const canopyGeo = loft(canopyRings, [], { capStart: false, capEnd: false });
  const canopy = new THREE.Mesh(canopyGeo, mats.glass);
  canopy.name = 'canopy.glass';
  canopy.renderOrder = 6;
  cockpit.add(canopy);

  // canopy framing: sills, arches, centre spine
  const frameGeos = [];
  for (const side of [1, -1]) {
    const sill = canopyStations.map((x) => {
      const t = hullT(x);
      const i = canopyStations.indexOf(x);
      const u = i / (canopyStations.length - 1);
      return [x, HULL.deck(t) - 0.06, side * HULL.halfW(t) * (0.9 - 0.28 * u * u)];
    });
    frameGeos.push(tubeGeo(sill, 0.035, 22, 6));
  }
  [0, 3, 6].forEach((si) => {
    const ring = canopyRings[si];
    frameGeos.push(tubeGeo(ring.map((v) => [v.x, v.y, v.z]), si === 0 ? 0.04 : 0.028, 18, 6));
  });
  frameGeos.push(
    tubeGeo(canopyRings.map((r) => [r[Math.floor(r.length / 2)].x, r[Math.floor(r.length / 2)].y, 0]), 0.026, 22, 6)
  );
  const canopyFrame = merge(frameGeos, mats.paintGraphite, 'canopy.frame');
  cockpit.add(canopyFrame);
  shadowCasters.push(canopyFrame);

  // interior: dashboard silhouettes, seats, headrests, control columns
  const interiorDark = [];
  const interiorFabric = [];
  const interiorGlow = [];
  interiorDark.push(xf(panelBox(0.42, 0.34, 1.34, 0.05), { p: [2.62, 0.62, 0], r: [0, 0, -0.22] }));
  interiorDark.push(xf(panelBox(0.3, 0.12, 1.3, 0.03), { p: [2.36, 0.86, 0] }));
  interiorDark.push(xf(panelBox(0.22, 0.5, 0.3, 0.04), { p: [2.05, 0.52, 0] }));
  interiorGlow.push(xf(new THREE.PlaneGeometry(0.34, 0.22), { p: [2.5, 0.74, 0.32], r: [-1.15, 0, 0] }));
  interiorGlow.push(xf(new THREE.PlaneGeometry(0.34, 0.22), { p: [2.5, 0.74, -0.32], r: [-1.15, 0, 0] }));
  interiorGlow.push(xf(new THREE.PlaneGeometry(0.16, 0.3), { p: [2.06, 0.78, 0], r: [-0.5, 0, 0] }));

  const seatSet = seatGeos(1);
  for (const side of [1, -1]) {
    seatSet.fabric.forEach((g) => interiorFabric.push(xf(g, { p: [1.86, 0.36, side * 0.34] })));
    interiorDark.push(xf(panelBox(0.42, 0.06, 0.44, 0.03), { p: [1.86, 0.26, side * 0.34] }));
    // control column: tapered post + grip
    interiorDark.push(xf(latheGeo([[0.05, 0], [0.045, 0.28], [0.03, 0.4]], 8), { p: [2.24, 0.3, side * 0.3] }));
    interiorDark.push(xf(panelBox(0.1, 0.08, 0.2, 0.02), { p: [2.24, 0.72, side * 0.3], r: [0, 0, -0.2] }));
  }
  cockpit.add(merge(interiorDark, mats.mech, 'cockpit.console'));
  cockpit.add(merge(interiorFabric, mats.fabric, 'cockpit.seats'));
  const cockpitGlow = merge(interiorGlow, mats.emPanel, 'cockpit.displays');
  cockpit.add(cockpitGlow);

  const cockpitLight = new THREE.PointLight(0x9fe4ff, 0.0, 4.5, 2);
  cockpitLight.name = 'light.cockpit';
  cockpitLight.position.set(2.3, 0.8, 0);
  cockpit.add(cockpitLight);

  /* ---------------- cabin + rescue door ---------------- */
  const cabin = new THREE.Object3D();
  cabin.name = 'cabin.group';
  frame.add(cabin);

  const cabinDark = [];
  const cabinMetal = [];
  const cabinFabric = [];
  // recessed floor + inner walls (double-sided interior shell)
  cabinDark.push(xf(panelBox(1.9, 0.05, 1.5, 0.03), { p: [0.2, -0.16, 0] }));
  cabinDark.push(xf(panelBox(1.9, 1.0, 0.04, 0.03), { p: [0.2, 0.34, -0.78] }));
  cabinDark.push(xf(panelBox(0.05, 1.0, 1.5, 0.03), { p: [-0.78, 0.34, 0] }));
  cabinDark.push(xf(panelBox(1.9, 0.04, 1.5, 0.03), { p: [0.2, 0.86, 0] }));
  // floor tread strips
  for (let i = 0; i < 5; i++) {
    cabinMetal.push(xf(panelBox(0.05, 0.02, 1.4, 0.01), { p: [-0.5 + i * 0.36, -0.13, 0] }));
  }
  // fold-down seats (port wall) + stretcher
  const fold = seatGeos(0.8);
  [-0.32, 0.36].forEach((x) => {
    fold.fabric.forEach((g) => cabinFabric.push(xf(g, { p: [x, 0.18, -0.5] })));
    cabinMetal.push(xf(tubeGeo([[-0.2, -0.2, 0], [-0.2, 0.1, 0.05], [0.2, 0.1, 0.05]], 0.018, 10, 6), { p: [x, 0.18, -0.5] }));
  });
  const stretcherFrame = [
    tubeGeo([[-0.85, 0, 0.16], [0.85, 0, 0.16]], 0.026, 6, 6),
    tubeGeo([[-0.85, 0, -0.16], [0.85, 0, -0.16]], 0.026, 6, 6),
    tubeGeo([[-0.85, 0, -0.16], [-0.85, 0, 0.16]], 0.026, 4, 6),
    tubeGeo([[0.85, 0, -0.16], [0.85, 0, 0.16]], 0.026, 4, 6),
    xf(cyl(0.02, 0.02, 0.3, 8), { p: [-0.7, -0.15, 0.16] }),
    xf(cyl(0.02, 0.02, 0.3, 8), { p: [0.7, -0.15, 0.16] }),
    xf(cyl(0.02, 0.02, 0.3, 8), { p: [-0.7, -0.15, -0.16] }),
    xf(cyl(0.02, 0.02, 0.3, 8), { p: [0.7, -0.15, -0.16] })
  ].map((g) => xf(g, { p: [0.25, 0.16, 0.22] }));
  cabinMetal.push(...stretcherFrame);
  cabinFabric.push(xf(panelBox(1.66, 0.1, 0.42, 0.05), { p: [0.25, 0.2, 0.22] }));
  // grab rails along the ceiling
  cabinMetal.push(xf(tubeGeo([[-0.7, 0.78, 0.46], [0.2, 0.8, 0.5], [1.0, 0.78, 0.46]], 0.024, 14, 6), {}));
  cabinMetal.push(xf(tubeGeo([[-0.7, 0.78, -0.46], [0.2, 0.8, -0.5], [1.0, 0.78, -0.46]], 0.024, 14, 6), {}));
  cabin.add(merge(cabinDark, mats.interior, 'cabin.shell'));
  cabin.add(merge(cabinMetal, mats.metalBare, 'cabin.hardware'));
  cabin.add(merge(cabinFabric, mats.fabric, 'cabin.softGoods'));
  const ceilingLights = merge(
    [xf(new THREE.PlaneGeometry(1.5, 0.12), { p: [0.2, 0.83, 0.3], r: [Math.PI / 2, 0, 0] }),
     xf(new THREE.PlaneGeometry(1.5, 0.12), { p: [0.2, 0.83, -0.3], r: [Math.PI / 2, 0, 0] })],
    mats.emCabin,
    'cabin.ceilingLights'
  );
  cabin.add(ceilingLights);
  const cabinLight = new THREE.PointLight(0xffd0a0, 0.0, 5, 2);
  cabinLight.name = 'light.cabin';
  cabinLight.position.set(0.2, 0.6, 0.1);
  cabin.add(cabinLight);

  // sliding starboard rescue door (opens aft on an external rail)
  const doorS = hullSurface(0.35);
  const door = new THREE.Object3D();
  door.name = 'cabin.door';
  door.position.set(0.35, 0.34, 0);
  cabin.add(door);
  const doorGeos = [
    xf(panelBox(1.32, 0.98, 0.07, 0.07), { p: [0, 0, doorS.halfW * 0.99] }),
    xf(panelBox(1.2, 0.08, 0.04, 0.03), { p: [0, 0.48, doorS.halfW * 1.0] }),
    xf(panelBox(1.2, 0.08, 0.04, 0.03), { p: [0, -0.48, doorS.halfW * 1.0] })
  ];
  const doorPanel = merge(doorGeos, mats.paintIvory, 'cabin.door.panel');
  door.add(doorPanel);
  shadowCasters.push(doorPanel);
  const doorWindow = new THREE.Mesh(panelBox(0.62, 0.36, 0.03, 0.06), mats.glass);
  doorWindow.name = 'cabin.door.window';
  doorWindow.position.set(0.1, 0.2, doorS.halfW * 1.02);
  doorWindow.renderOrder = 6;
  door.add(doorWindow);
  door.add(
    merge(
      [
        xf(tubeGeo([[-0.2, 0, 0], [0.2, 0, 0]], 0.026, 6, 6), { p: [-0.3, -0.06, doorS.halfW * 1.06] }),
        xf(panelBox(0.1, 0.16, 0.05, 0.02), { p: [-0.52, -0.06, doorS.halfW * 1.05] })
      ],
      mats.metalBare,
      'cabin.door.handle'
    )
  );
  door.add(decalMesh(mats.decalDoor, 0.52, 0.26, [0.36, -0.26, doorS.halfW * 1.06], [0, 0, 0], 'decal.doorArrow'));
  // door rail + rollers on the fuselage side
  metalDetail.push(xf(panelBox(1.9, 0.05, 0.05, 0.02), { p: [0.1, 0.86, doorS.halfW * 1.02] }));
  metalDetail.push(xf(panelBox(1.9, 0.04, 0.04, 0.02), { p: [0.1, -0.18, doorS.halfW * 1.01] }));

  /* ---------------- wings ---------------- */
  const wingSections = (side) => {
    const out = [];
    const steps = [0.9, 1.5, 2.2, 2.85, 3.3];
    steps.forEach((z, i) => {
      const u = (z - 0.9) / (3.3 - 0.9);
      out.push({
        z: side * z,
        chord: 1.62 - 0.55 * u,
        thick: 0.17 - 0.035 * u,
        camber: 0.022,
        twist: -0.03 - 0.03 * u,
        xOff: -0.05 - 0.3 * u,
        yOff: 1.0 + 0.16 * u + 0.05 * Math.sin(u * 2.2)
      });
    });
    if (side < 0) out.reverse();
    return out;
  };

  const wings = mirrored((side, tag) => {
    const g = new THREE.Object3D();
    g.name = `wing.${tag}`;
    const skin = new THREE.Mesh(foilSolid(wingSections(side), 11), mats.paintIvory);
    skin.name = `wing.${tag}.skin`;
    g.add(skin);
    shadowCasters.push(skin);

    const detailG = [];
    const metalG = [];
    // structural root fairing blending into the shoulder
    const rootRings = [];
    for (let i = 0; i <= 7; i++) {
      const u = i / 7;
      const z = side * (0.55 + u * 0.62);
      const ring = [];
      const n = 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rx = (0.95 - 0.26 * u) * Math.cos(a);
        const ry = (0.3 - 0.09 * u) * Math.sin(a);
        ring.push(V3(-0.02 + rx, 1.0 + ry + 0.05 * u, z));
      }
      rootRings.push(ring);
    }
    detailG.push(loft(rootRings, [], { capStart: true, capEnd: true }));
    // layered panels + control-surface seams
    for (let i = 0; i < 4; i++) {
      const u = i / 3;
      const z = side * (1.15 + u * 1.95);
      const chord = 1.5 - 0.5 * u;
      metalG.push(xf(panelBox(0.03, 0.03, 0.5, 0.008), { p: [-0.05 - 0.3 * u + chord * 0.22, 1.06 + 0.16 * u, z] }));
    }
    metalG.push(
      xf(panelBox(0.24, 0.06, 2.0, 0.03), { p: [-0.62, 1.02, side * 2.05] })
    );
    // flaperon with a visible hinge line
    detailG.push(xf(panelBox(0.3, 0.07, 1.7, 0.05), { p: [-0.78, 1.02, side * 2.1] }));
    for (let i = 0; i < 4; i++) {
      metalG.push(xf(cyl(0.035, 0.035, 0.12, 8), { p: [-0.66, 1.02, side * (1.4 + i * 0.5)], r: [Math.PI / 2, 0, 0] }));
    }
    g.add(merge(detailG, mats.paintGraphite, `wing.${tag}.structure`));
    g.add(merge(metalG, mats.metalDark, `wing.${tag}.hardware`));
    // navigation light + wingtip strobe
    const navMat = side > 0 ? mats.emGreen : mats.emRed;
    const nav = new THREE.Mesh(latheGeo([[0, 0], [0.06, 0.02], [0.07, 0.07], [0.03, 0.11], [0, 0.12]], 10), navMat);
    nav.name = `wing.${tag}.navLight`;
    nav.position.set(-0.4, 1.2, side * 3.34);
    nav.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(nav);
    // chevron + wordmark markings on the upper skin
    g.add(decalMesh(mats.decalChevron, 1.1, 0.28, [-0.2, 1.2 + 0.06, side * 1.75], [-Math.PI / 2, 0, side > 0 ? 0 : Math.PI], `decal.wingChevron.${tag}`));
    g.add(decalMesh(mats.decalNoStep, 0.34, 0.17, [0.18, 1.2, side * 1.2], [-Math.PI / 2, 0, 0], `decal.noStep.${tag}`));
    frame.add(g);
    explodeSpec.push({ name: `wing.${tag}.structure`, vec: [0, 0.5, side * 0.7] });
    return g;
  });

  /* ---------------- nacelles + rotors ---------------- */
  const bladeSections = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    const z = 0.34 + u * 2.21;
    bladeSections.push({
      z,
      chord: 0.34 + 0.1 * Math.sin(Math.PI * u) - 0.12 * u * u,
      thick: 0.16 - 0.07 * u,
      camber: 0.03,
      twist: 0.26 * (1 - u) - 0.02,
      xOff: 0.0,
      yOff: 0.0
    });
  }
  const bladeGeo = foilSolid(bladeSections, 9, 0.32);

  const nacelles = mirrored((side, tag) => {
    const pivot = new THREE.Object3D();
    pivot.name = `nacelle.${tag}`;
    pivot.position.set(-0.15, 1.3, side * 3.3);
    frame.add(pivot);

    const housingProfile = [
      [0.02, -1.05], [0.16, -1.0], [0.3, -0.86], [0.39, -0.6], [0.43, -0.25],
      [0.44, 0.15], [0.43, 0.5], [0.41, 0.72], [0.38, 0.86], [0.35, 0.92]
    ];
    const housing = new THREE.Mesh(latheGeo(housingProfile, 26), mats.paintIvory);
    housing.name = `nacelle.${tag}.housing`;
    pivot.add(housing);
    shadowCasters.push(housing);

    const dark = [];
    const metal = [];
    // intake lip + inner cavity + exhaust ring
    metal.push(xf(new THREE.TorusGeometry(0.35, 0.045, 8, 26), { p: [0, 0.93, 0], r: [Math.PI / 2, 0, 0] }));
    metal.push(xf(latheGeo([[0.3, 0.9], [0.34, 0.94], [0.3, 0.98], [0.24, 0.95]], 22), {}));
    dark.push(xf(cyl(0.3, 0.24, 0.62, 22, true), { p: [0, 0.62, 0] }));
    metal.push(xf(latheGeo([[0.14, -1.02], [0.24, -1.04], [0.26, -0.94], [0.16, -0.9]], 20), {}));
    dark.push(xf(cyl(0.16, 0.2, 0.2, 18, true), { p: [0, -0.98, 0] }));
    // pivot trunnion, side plates, actuator
    metal.push(xf(cyl(0.14, 0.14, 0.62, 16), { p: [0, 0.0, 0], r: [Math.PI / 2, 0, 0] }));
    dark.push(xf(panelBox(0.44, 0.5, 0.05, 0.05), { p: [0, 0.02, 0.3] }));
    dark.push(xf(panelBox(0.44, 0.5, 0.05, 0.05), { p: [0, 0.02, -0.3] }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      metal.push(xf(cyl(0.022, 0.022, 0.66, 6), { p: [Math.cos(a) * 0.2, 0.02 + Math.sin(a) * 0.2, 0], r: [Math.PI / 2, 0, 0] }));
    }
    // cooling vents around the housing shoulder
    const ventPl = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ventPl.push({ p: [Math.cos(a) * 0.43, -0.42, Math.sin(a) * 0.43], n: [Math.cos(a), 0.12, Math.sin(a)] });
    }
    const vents = instanced(panelBox(0.1, 0.02, 0.22, 0.006), mats.mech, ventPl, `nacelle.${tag}.vents`);
    pivot.add(vents);

    pivot.add(merge(dark, mats.mech, `nacelle.${tag}.mech`));
    pivot.add(merge(metal, mats.metalBare, `nacelle.${tag}.hardware`));

    const warn = new THREE.Mesh(cyl(0.445, 0.445, 0.2, 26, true), mats.decalNacelle);
    warn.name = `nacelle.${tag}.warnBand`;
    warn.position.y = -0.05;
    pivot.add(warn);
    const exhaustGlow = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.24, 20), mats.emExhaust);
    exhaustGlow.name = `nacelle.${tag}.exhaustGlow`;
    exhaustGlow.position.y = -1.06;
    exhaustGlow.rotation.x = Math.PI / 2;
    pivot.add(exhaustGlow);

    // ---- rotor ----
    const rotor = new THREE.Object3D();
    rotor.name = `rotor.${tag}`;
    rotor.position.y = 1.02;
    pivot.add(rotor);

    const hubGeos = [
      latheGeo([[0, 0.24], [0.1, 0.24], [0.16, 0.18], [0.2, 0.06], [0.2, -0.06], [0.14, -0.14], [0, -0.15]], 18),
      xf(latheGeo([[0, 0.06], [0.3, 0.05], [0.32, 0.0], [0.3, -0.05], [0, -0.06]], 20), { p: [0, -0.02, 0] })
    ];
    const hubMetal = [];
    const cuffs = [];
    const blades = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const r = [0, a, 0];
      blades.push(xf(bladeGeo, { r }));
      cuffs.push(xf(latheGeo([[0.07, 0.3], [0.1, 0.32], [0.1, 0.14], [0.07, 0.12]], 12), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] }));
      // pitch link + cuff at the blade root
      hubMetal.push(xf(cyl(0.026, 0.026, 0.26, 8), { p: [Math.cos(a) * 0.26, -0.14, Math.sin(a) * 0.26], r: [0, 0, 0] }));
      hubMetal.push(xf(cyl(0.075, 0.09, 0.2, 10), { p: [Math.cos(a) * 0.3, 0.0, Math.sin(a) * 0.3], r: [Math.PI / 2, 0, -a] }));
    }
    rotor.add(merge(hubGeos, mats.metalDark, `rotor.${tag}.hub`));
    rotor.add(merge(hubMetal.concat(cuffs), mats.metalBare, `rotor.${tag}.pitchLinks`));
    const bladeMesh = merge(blades, mats.blade, `rotor.${tag}.blades`);
    bladeMesh.castShadow = true;
    rotor.add(bladeMesh);
    shadowCasters.push(bladeMesh);

    const disc = new THREE.Mesh(new THREE.RingGeometry(0.42, 2.58, 44, 1), mats.disc);
    disc.name = `rotor.${tag}.disc`;
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    disc.visible = false;
    disc.renderOrder = 5;
    rotor.add(disc);

    explodeSpec.push({ name: `nacelle.${tag}`, vec: [0.1, 0.9, side * 1.1] });
    explodeSpec.push({ name: `rotor.${tag}`, vec: [0, 1.5, 0] });

    addHotspot({
      id: `pivot-${tag}`,
      host: `nacelle.${tag}`,
      offset: [0.32, 0.05, side * 0.36],
      title: `Tilt Pivot Cluster (${tag === 'stbd' ? 'starboard' : 'port'})`,
      body: 'Twin-plate trunnion carries rotor thrust into the wing box. A pair of self-locking screwjacks drives the 0–90° nacelle arc and holds tilt without hydraulic pressure.',
      cam: [2.4, 1.4, side * 2.6]
    });
    return pivot;
  });

  addHotspot({
    id: 'rotor-hub',
    host: 'rotor.port',
    offset: [0, 0.34, 0],
    title: 'Five-Blade Articulated Hub',
    body: 'Elastomeric hub with individual blade cuffs and exposed pitch links. Blades are graphite-skinned with tapered tips to keep noise low over rescue sites.',
    cam: [2.2, 1.9, -2.2]
  });
  addHotspot({
    id: 'intake',
    host: 'nacelle.stbd',
    offset: [0, 0.98, 0.2],
    title: 'Debris-Tolerant Intake',
    body: 'Rolled intake lip and a deep plenum trap salt spray. The dark internal cavity houses the inertial particle separator ahead of the compressor face.',
    cam: [1.6, 2.2, 2.0]
  });
  addHotspot({
    id: 'exhaust',
    host: 'nacelle.port',
    offset: [0, -1.1, 0.0],
    title: 'Cooled Exhaust Ring',
    body: 'Annular mixer blends bypass air into the efflux to cut the thermal signature and keep the deck below the nacelle safe for ground crew.',
    cam: [1.8, -0.6, -2.0]
  });

  /* ---------------- landing gear ---------------- */
  const wheelGeo = latheGeo(
    [[0.1, 0.0], [0.16, 0.02], [0.2, 0.07], [0.205, 0.0], [0.2, -0.07], [0.16, -0.02], [0.1, 0.0]],
    18
  );
  const tireGeo = new THREE.TorusGeometry(0.19, 0.095, 12, 22);
  const hubCapGeo = latheGeo([[0, 0.05], [0.07, 0.05], [0.1, 0.02], [0.1, -0.02], [0, -0.03]], 14);

  function buildGearLeg(name, anchor, legLen, twin, retractAxis, retractAngle) {
    const leg = new THREE.Object3D();
    leg.name = name;
    leg.position.set(anchor[0], anchor[1], anchor[2]);
    leg.userData.retract = { axis: retractAxis, angle: retractAngle };
    frame.add(leg);
    const metal = [];
    const dark = [];
    metal.push(xf(latheGeo([[0.075, 0], [0.075, -legLen * 0.55], [0.055, -legLen * 0.58], [0.055, -legLen]], 12), {}));
    metal.push(xf(cyl(0.09, 0.09, 0.16, 12), { p: [0, -legLen * 0.52, 0] }));
    dark.push(xf(panelBox(0.16, 0.3, 0.1, 0.03), { p: [0.09, -0.12, 0], r: [0, 0, 0.3] }));
    dark.push(xf(cyl(0.03, 0.03, 0.42, 8), { p: [0.12, -legLen * 0.55, 0], r: [0, 0, 0.24] }));
    metal.push(xf(cyl(0.05, 0.05, twin ? 0.44 : 0.2, 10), { p: [0, -legLen, 0], r: [Math.PI / 2, 0, 0] }));
    leg.add(merge(metal, mats.metalBare, `${name}.strut`));
    leg.add(merge(dark, mats.mech, `${name}.mech`));
    const zs = twin ? [-0.18, 0.18] : [0];
    const rubberG = [];
    const rimG = [];
    zs.forEach((z) => {
      rubberG.push(xf(tireGeo, { p: [0, -legLen, z], r: [Math.PI / 2, 0, 0] }));
      rimG.push(xf(wheelGeo, { p: [0, -legLen, z], r: [Math.PI / 2, 0, 0] }));
      rimG.push(xf(hubCapGeo, { p: [0, -legLen, z + (z >= 0 ? 0.08 : -0.08)], r: [Math.PI / 2, 0, 0] }));
    });
    const tires = merge(rubberG, mats.rubber, `${name}.tires`);
    leg.add(tires);
    leg.add(merge(rimG, mats.metalDark, `${name}.wheels`));
    shadowCasters.push(tires);
    return leg;
  }

  const gearNose = buildGearLeg('gear.nose', [2.25, -0.5, 0], 0.57, true, 'z', -1.5);
  const gearMains = mirrored((side, tag) =>
    buildGearLeg(`gear.main.${tag}`, [-0.5, -0.45, side * 1.02], 0.62, true, 'x', side * 1.48)
  );

  function buildGearDoor(name, p, size, hingeSide) {
    const d = new THREE.Object3D();
    d.name = name;
    d.position.set(p[0], p[1], p[2]);
    d.userData.hinge = hingeSide;
    frame.add(d);
    const panel = merge(
      [
        xf(panelBox(size[0], 0.035, size[1], 0.05), { p: [0, 0, (size[1] / 2) * hingeSide] }),
        xf(panelBox(size[0] * 0.8, 0.02, 0.05, 0.01), { p: [0, 0.03, (size[1] / 2) * hingeSide] })
      ],
      mats.paintIvory,
      `${name}.panel`
    );
    d.add(panel);
    d.add(
      merge(
        [xf(cyl(0.02, 0.02, size[0] * 0.7, 6), { r: [0, 0, Math.PI / 2] })],
        mats.metalDark,
        `${name}.hinge`
      )
    );
    shadowCasters.push(panel);
    return d;
  }
  const doorNose = buildGearDoor('gearDoor.nose', [2.25, -0.52, 0.0], [0.86, 0.5], 1);
  const doorMains = mirrored((side, tag) =>
    buildGearDoor(`gearDoor.main.${tag}`, [-0.5, -0.5, side * 0.55], [1.0, 0.52], side)
  );

  addHotspot({
    id: 'main-gear',
    host: 'gear.main.stbd',
    offset: [0, -0.35, 0.3],
    title: 'Trailing-Arm Main Gear',
    body: 'Twin 480 mm wheels on a nitrogen oleo sized for unprepared strips. The leg folds inboard into a shallow bay behind the sponson shoulder.',
    cam: [1.6, 0.4, 2.4]
  });

  /* ---------------- water sponsons ---------------- */
  const sponsons = mirrored((side, tag) => {
    const g = new THREE.Object3D();
    g.name = `sponson.${tag}`;
    g.position.set(-0.55, -0.14, side * 0.94);
    frame.add(g);
    const rings = [];
    const stationsS = [-1.35, -0.85, -0.25, 0.35, 0.9, 1.3];
    stationsS.forEach((x, i) => {
      const u = i / (stationsS.length - 1);
      const bulge = Math.sin(Math.PI * Math.min(1, Math.max(0.001, u))) * 0.75 + 0.25;
      const halfW = 0.42 * bulge;
      const top = 0.17 * bulge;
      const bot = -0.3 * bulge;
      const ring = [];
      const n = 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const zz = Math.cos(a) * halfW;
        const yy = Math.sin(a) >= 0 ? Math.sin(a) * top : Math.sin(a) * Math.abs(bot) * (0.7 + 0.3 * Math.abs(Math.cos(a)));
        ring.push(V3(x, yy, side * (0.42 + zz)));
      }
      rings.push(ring);
    });
    if (side < 0) rings.reverse();
    const hullS = new THREE.Mesh(loft(rings, [], { capStart: true, capEnd: true }), mats.paintIvory);
    hullS.name = `sponson.${tag}.float`;
    g.add(hullS);
    shadowCasters.push(hullS);
    g.add(
      merge(
        [
          xf(panelBox(2.3, 0.05, 0.06, 0.02), { p: [0, -0.06, side * 0.78] }),
          xf(cyl(0.05, 0.05, 0.34, 10), { p: [-0.9, 0.06, side * 0.2], r: [Math.PI / 2, 0, 0] }),
          xf(cyl(0.05, 0.05, 0.34, 10), { p: [0.9, 0.06, side * 0.2], r: [Math.PI / 2, 0, 0] })
        ],
        mats.metalDark,
        `sponson.${tag}.hardware`
      )
    );
    g.add(decalMesh(mats.decalCaution, 0.7, 0.13, [0.3, 0.1, side * 0.86], [0, side > 0 ? 0 : Math.PI, 0], `decal.sponsonCaution.${tag}`));
    explodeSpec.push({ name: `sponson.${tag}`, vec: [-0.2, -0.6, side * 0.8] });
    return g;
  });

  addHotspot({
    id: 'sponson',
    host: 'sponson.port',
    offset: [0.2, 0.2, -0.5],
    title: 'Retractable Water Sponson',
    body: 'Foam-filled float gives 12° of static heel stability on the water and folds flat to the hull side for cruise, cutting drag by roughly a fifth.',
    cam: [1.2, 0.9, -2.6]
  });
  addHotspot({
    id: 'chine',
    host: 'airframe.fuselage',
    offset: [0.6, -0.16, 1.02],
    title: 'Hard Chine and Planing Hull',
    body: 'The double chine throws spray clear of the intakes during water taxi; the deep forward keel lets the HX-9 hold heading in a running sea.',
    cam: [2.2, 0.5, 2.4]
  });

  /* ---------------- rescue winch ---------------- */
  const winch = new THREE.Object3D();
  winch.name = 'winch.group';
  winch.position.set(0.62, 0.98, 0.72);
  frame.add(winch);
  winch.add(
    merge(
      [
        xf(panelBox(0.4, 0.3, 0.22, 0.05), {}),
        xf(latheGeo([[0, 0.14], [0.14, 0.14], [0.16, 0.1], [0.16, -0.1], [0.14, -0.14], [0, -0.14]], 16), { r: [Math.PI / 2, 0, 0], p: [0.02, 0.02, 0.2] })
      ],
      mats.mech,
      'winch.mount'
    )
  );
  const drum = new THREE.Mesh(
    latheGeo([[0, 0.11], [0.09, 0.11], [0.1, 0.08], [0.075, 0.06], [0.075, -0.06], [0.1, -0.08], [0.09, -0.11], [0, -0.11]], 16),
    mats.metalBare
  );
  drum.name = 'winch.drum';
  drum.rotation.x = Math.PI / 2;
  drum.position.set(0.02, 0.02, 0.2);
  winch.add(drum);

  const arm = new THREE.Object3D();
  arm.name = 'winch.arm';
  arm.position.set(0.0, 0.06, 0.16);
  winch.add(arm);
  arm.add(
    merge(
      [
        xf(latheGeo([[0.07, 0], [0.065, 0.6], [0.05, 1.0], [0.045, 1.12]], 12), { r: [Math.PI / 2, 0, 0], p: [0, 0, 0] }),
        xf(panelBox(0.1, 0.1, 0.3, 0.02), { p: [0, 0.04, 0.5] }),
        xf(new THREE.TorusGeometry(0.06, 0.018, 8, 14), { p: [0, -0.02, 1.14], r: [0, Math.PI / 2, 0] })
      ],
      mats.metalDark,
      'winch.arm.boom'
    )
  );
  arm.add(decalMesh(mats.decalLift, 0.22, 0.11, [0.075, 0.05, 0.62], [0, Math.PI / 2, 0], 'decal.winchLift'));

  const cableAnchor = new THREE.Object3D();
  cableAnchor.name = 'winch.cableAnchor';
  cableAnchor.position.set(0, -0.05, 1.16);
  arm.add(cableAnchor);
  const cableGeo = cyl(0.012, 0.012, 1, 6);
  cableGeo.translate(0, -0.5, 0);
  const cable = new THREE.Mesh(cableGeo, mats.metalBare);
  cable.name = 'winch.cable';
  cableAnchor.add(cable);

  const hookGroup = new THREE.Object3D();
  hookGroup.name = 'winch.hookGroup';
  cableAnchor.add(hookGroup);
  hookGroup.add(
    merge(
      [
        xf(latheGeo([[0, 0.06], [0.05, 0.05], [0.055, -0.06], [0.02, -0.1], [0, -0.1]], 12), {}),
        xf(new THREE.TorusGeometry(0.05, 0.014, 8, 12, Math.PI * 1.5), { p: [0, -0.16, 0], r: [Math.PI / 2, 0, 0] })
      ],
      mats.metalBare,
      'winch.hook'
    )
  );
  const basket = new THREE.Object3D();
  basket.name = 'winch.basket';
  basket.position.y = -0.34;
  hookGroup.add(basket);
  const basketMetal = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    basketMetal.push(xf(cyl(0.016, 0.016, 0.34, 6), { p: [Math.cos(a) * 0.3, 0.17, Math.sin(a) * 0.22] }));
    basketMetal.push(xf(cyl(0.014, 0.014, 0.4, 6), { p: [Math.cos(a) * 0.16, 0.5, Math.sin(a) * 0.12], r: [Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4] }));
  }
  basketMetal.push(xf(new THREE.TorusGeometry(0.3, 0.018, 8, 20), { p: [0, 0.34, 0], r: [Math.PI / 2, 0, 0], s: [1, 0.72, 1] }));
  basketMetal.push(xf(new THREE.TorusGeometry(0.3, 0.016, 8, 20), { p: [0, 0.02, 0], r: [Math.PI / 2, 0, 0], s: [1, 0.72, 1] }));
  basket.add(merge(basketMetal, mats.metalBare, 'winch.basket.frame'));
  basket.add(merge([xf(panelBox(0.56, 0.03, 0.4, 0.06), { p: [0, 0.01, 0] })], mats.propOrange, 'winch.basket.floor'));
  basket.add(merge([xf(panelBox(0.5, 0.04, 0.34, 0.05), { p: [0, 0.06, 0] })], mats.fabricWarm, 'winch.basket.pad'));

  explodeSpec.push({ name: 'winch.group', vec: [0.3, 0.9, 0.9] });
  addHotspot({
    id: 'winch',
    host: 'winch.arm',
    offset: [0, 0.14, 0.6],
    title: 'Rescue Hoist and Boom',
    body: '92 m of 6 mm cable on a level-wind drum. The boom swings 40° outboard so the basket clears the sponson and hull on every lift.',
    cam: [1.4, 1.2, 2.6]
  });

  /* ---------------- nose sensor turret ---------------- */
  const yaw = new THREE.Object3D();
  yaw.name = 'turret.yaw';
  yaw.position.set(2.62, -0.34, 0);
  frame.add(yaw);
  yaw.add(
    merge(
      [
        xf(latheGeo([[0.2, 0.1], [0.21, 0.02], [0.18, -0.02], [0, -0.03]], 18), {}),
        xf(new THREE.TorusGeometry(0.2, 0.022, 8, 20), { p: [0, -0.02, 0], r: [Math.PI / 2, 0, 0] })
      ],
      mats.metalDark,
      'turret.yoke'
    )
  );
  const pitch = new THREE.Object3D();
  pitch.name = 'turret.pitch';
  pitch.position.y = -0.14;
  yaw.add(pitch);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.19, 22, 16), mats.mech);
  ball.name = 'turret.ball';
  ball.scale.set(1, 0.94, 1);
  pitch.add(ball);
  pitch.add(
    merge(
      [
        xf(latheGeo([[0.09, 0.0], [0.09, 0.03], [0.06, 0.05], [0, 0.05]], 14), { p: [0.16, 0.03, 0], r: [0, 0, -Math.PI / 2] }),
        xf(latheGeo([[0.055, 0.0], [0.055, 0.03], [0.04, 0.04], [0, 0.04]], 12), { p: [0.15, -0.08, 0.08], r: [0, 0, -Math.PI / 2] }),
        xf(latheGeo([[0.04, 0.0], [0.04, 0.03], [0.03, 0.04], [0, 0.04]], 12), { p: [0.15, -0.08, -0.08], r: [0, 0, -Math.PI / 2] })
      ],
      mats.lens,
      'turret.lenses'
    )
  );
  const turretLed = merge(
    [xf(new THREE.SphereGeometry(0.022, 8, 6), { p: [0.06, 0.14, 0.1] }), xf(new THREE.SphereGeometry(0.022, 8, 6), { p: [0.06, 0.14, -0.1] })],
    mats.emCyan,
    'turret.status'
  );
  pitch.add(turretLed);
  explodeSpec.push({ name: 'turret.yaw', vec: [1.0, -0.5, 0] });
  addHotspot({
    id: 'turret',
    host: 'turret.pitch',
    offset: [0.24, 0.06, 0],
    title: 'Gimballed Search Turret',
    body: 'Four-axis stabilised ball with wide/narrow thermal channels, a low-light camera and a marker illuminator. It scans a 120° forward sector hands-off.',
    cam: [2.2, 0.4, 1.6]
  });

  /* ---------------- empennage ---------------- */
  const tail = new THREE.Object3D();
  tail.name = 'tail.group';
  frame.add(tail);
  const finSections = [];
  for (let i = 0; i <= 5; i++) {
    const u = i / 5;
    finSections.push({ z: 0.25 + u * 1.5, chord: 1.15 - 0.5 * u, thick: 0.13 - 0.03 * u, camber: 0, twist: 0, xOff: -0.3 * u, yOff: 0 });
  }
  const fin = new THREE.Mesh(foilSolid(finSections, 9), mats.paintIvory);
  fin.name = 'tail.fin';
  fin.rotation.x = -Math.PI / 2;
  fin.position.set(-3.0, 0.62, 0);
  tail.add(fin);
  shadowCasters.push(fin);
  const stabSections = (side) => {
    const arr = [];
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      arr.push({ z: side * (0.16 + u * 1.0), chord: 0.8 - 0.28 * u, thick: 0.12, camber: 0, twist: 0, xOff: -0.12 * u, yOff: 0.02 * u });
    }
    if (side < 0) arr.reverse();
    return arr;
  };
  const stabs = mirrored((side) => new THREE.Mesh(foilSolid(stabSections(side), 9), mats.paintIvory));
  stabs.forEach((m, i) => {
    m.name = `tail.stab.${i === 0 ? 'stbd' : 'port'}`;
    m.position.set(-3.15, 1.72, 0);
    tail.add(m);
    shadowCasters.push(m);
  });
  const tailLight = new THREE.Mesh(latheGeo([[0, 0], [0.05, 0.02], [0.055, 0.06], [0, 0.08]], 10), mats.emStrobe);
  tailLight.name = 'tail.strobe';
  tailLight.position.set(-3.42, 2.06, 0);
  tail.add(tailLight);
  tail.add(decalMesh(mats.decalWordmark, 1.5, 0.38, [-3.05, 1.35, 0.075], [0, 0, 0.06], 'decal.finWordmark'));
  tail.add(decalMesh(mats.decalWordmark, 1.5, 0.38, [-3.05, 1.35, -0.075], [0, Math.PI, -0.06], 'decal.finWordmarkPort'));

  /* ---------------- anti-collision beacons + hull decals ---------------- */
  const beacons = merge(
    [
      xf(latheGeo([[0, 0], [0.06, 0.02], [0.065, 0.06], [0, 0.08]], 10), { p: [-1.0, 1.14, 0] }),
      xf(latheGeo([[0, 0], [0.06, 0.02], [0.065, 0.06], [0, 0.08]], 10), { p: [-1.0, -0.52, 0], r: [Math.PI, 0, 0] })
    ],
    mats.emBeacon,
    'beacon.lights'
  );
  frame.add(beacons);

  const sMid = hullSurface(0.9);
  frame.add(decalMesh(mats.decalWordmark, 2.1, 0.52, [0.95, 0.6, -(sMid.halfW * 1.005)], [0, Math.PI, 0.02], 'decal.wordmarkPort'));
  frame.add(decalMesh(mats.decalChevron, 1.5, 0.34, [-1.7, 0.42, hullSurface(-1.7).halfW * 1.005], [0, 0, 0.08], 'decal.chevronStbd'));
  frame.add(decalMesh(mats.decalChevron, 1.5, 0.34, [-1.7, 0.42, -hullSurface(-1.7).halfW * 1.005], [0, Math.PI, -0.08], 'decal.chevronPort'));
  frame.add(decalMesh(mats.decalSvc, 0.42, 0.21, [-0.6, 0.72, hullSurface(-0.6).halfW * 1.01], [0, 0, 0], 'decal.svcStbd'));
  frame.add(decalMesh(mats.decalPanelId, 0.3, 0.15, [1.55, 0.28, hullSurface(1.55).halfW * 1.01], [0, 0, 0], 'decal.panelId'));
  frame.add(decalMesh(mats.decalPitot, 0.3, 0.15, [2.86, 0.3, hullSurface(2.86).halfW * 1.02], [0, 0, 0], 'decal.pitot'));
  frame.add(decalMesh(mats.decalCaution, 1.2, 0.2, [0.35, 0.9, hullSurface(0.35).halfW * 1.0], [-1.3, 0, 0], 'decal.doorSillCaution'));
  // asymmetric operational wear: only around the starboard working side
  const wearDecal = decalMesh(mats.decalWear, 2.2, 1.5, [0.2, 0.1, hullSurface(0.2).halfW * 1.008], [0, 0, 0], 'decal.wearStbd');
  frame.add(wearDecal);

  /* ---------------- fasteners (instanced) ---------------- */
  const fastPl = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < 16; i++) {
      const t = 0.08 + (i / 16) * 0.84;
      const s = hullSurface(hullX(t));
      fastPl.push({ p: [hullX(t), HULL.chine(t) + 0.02, side * s.halfW * 1.01], n: [0.05, 0.2, side] });
      if (i % 2 === 0) fastPl.push({ p: [hullX(t), s.deck - 0.02, side * s.halfW * 0.4], n: [0, 1, side * 0.15] });
    }
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    fastPl.push({ p: [-1.25 + Math.cos(a) * 0.22, 1.13, Math.sin(a) * 0.1], n: [0, 1, 0] });
  }
  const fasteners = instanced(cyl(0.017, 0.02, 0.012, 6), mats.metalDark, fastPl, 'details.fasteners');
  frame.add(fasteners);

  // hull vents (instanced louvres)
  const ventPl2 = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < 5; i++) {
      const x = -2.0 + i * 0.22;
      const s = hullSurface(x);
      ventPl2.push({ p: [x, 0.66, side * s.halfW * 1.0], n: [0, 0.25, side], s: [1, 1, 1] });
    }
  }
  frame.add(instanced(panelBox(0.14, 0.02, 0.3, 0.008), mats.mech, ventPl2, 'details.vents'));

  frame.add(merge(graphiteDetail, mats.paintGraphite, 'details.structure'));
  frame.add(merge(metalDetail, mats.metalBare, 'details.hardware'));
  frame.add(merge(ivoryDetail, mats.paintIvory, 'details.covers'));

  /* ---------------- maintenance service panels ---------------- */
  const panels = [];
  const mkPanel = (name, p, size, hinge) => {
    const g = new THREE.Object3D();
    g.name = name;
    g.position.set(p[0], p[1], p[2]);
    const panel = merge(
      [
        xf(panelBox(size[0], size[1], 0.03, 0.05), { p: [size[0] / 2, 0, 0] }),
        xf(cyl(0.014, 0.014, size[1] * 0.9, 6), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] })
      ],
      mats.paintIvory,
      `${name}.leaf`
    );
    g.add(panel);
    g.add(decalMesh(mats.decalNoStep, 0.26, 0.13, [size[0] * 0.5, 0, 0.02], [0, 0, 0], `${name}.label`));
    g.userData.hinge = hinge;
    frame.add(g);
    panels.push(g);
    shadowCasters.push(panel);
    return g;
  };
  mkPanel('panel.avionics', [1.15, 0.95, 0.0], [0.7, 0.5], 'x');
  mkPanel('panel.gearbox.stbd', [-0.3, 1.02, 1.3], [0.6, 0.42], 'x');
  mkPanel('panel.gearbox.port', [-0.3, 1.02, -1.3], [0.6, 0.42], 'x');
  explodeSpec.push({ name: 'panel.avionics', vec: [0.4, 0.7, 0] });
  explodeSpec.push({ name: 'panel.gearbox.stbd', vec: [0, 0.6, 0.5] });
  explodeSpec.push({ name: 'panel.gearbox.port', vec: [0, 0.6, -0.5] });

  /* ---------------- remaining explode + hotspot specs ---------------- */
  explodeSpec.push({ name: 'canopy.glass', vec: [0.7, 1.1, 0] });
  explodeSpec.push({ name: 'canopy.frame', vec: [0.7, 1.1, 0] });
  explodeSpec.push({ name: 'cabin.door', vec: [-0.3, 0.2, 1.5] });
  explodeSpec.push({ name: 'gear.nose', vec: [0.9, -0.9, 0] });
  explodeSpec.push({ name: 'gear.main.stbd', vec: [-0.3, -1.0, 0.6] });
  explodeSpec.push({ name: 'gear.main.port', vec: [-0.3, -1.0, -0.6] });
  explodeSpec.push({ name: 'gearDoor.nose', vec: [0.6, -1.3, 0] });
  explodeSpec.push({ name: 'gearDoor.main.stbd', vec: [-0.5, -1.4, 0.4] });
  explodeSpec.push({ name: 'gearDoor.main.port', vec: [-0.5, -1.4, -0.4] });
  explodeSpec.push({ name: 'tail.group', vec: [-1.3, 0.3, 0] });

  addHotspot({
    id: 'rescue-door',
    host: 'cabin.door',
    offset: [0, 0.1, 1.15],
    title: 'Starboard Rescue Door',
    body: 'A 1.3 m sliding aperture with an external rail. Open, it exposes the recessed cabin floor so a stretcher can be taken straight in from the hoist.',
    cam: [1.0, 0.7, 3.0]
  });
  addHotspot({
    id: 'cabin',
    host: 'cabin.group',
    offset: [0.2, 0.45, 0.0],
    title: 'Two-Litter Rescue Cabin',
    body: 'Recessed non-slip floor, two fold-down crew seats and a single litter station. Ceiling strips switch to red-free lighting for night casualty care.',
    cam: [1.2, 1.2, 3.0]
  });
  addHotspot({
    id: 'canopy',
    host: 'canopy.frame',
    offset: [2.1, 0.75, 0],
    title: 'Framed Crew Canopy',
    body: 'Three-arch frame carries a curved tinted shell. The lower sill glazing is cut back for a near-vertical view of the hoist and the water below.',
    cam: [2.4, 1.2, 2.0]
  });
  addHotspot({
    id: 'nav-light',
    host: 'wing.stbd',
    offset: [-0.45, 1.25, 3.5],
    title: 'Wingtip Navigation Light',
    body: 'Green starboard and red port units share the tip housing with a strobe. Timing is offset from the hull beacons so ground crew can read the aircraft state.',
    cam: [1.4, 0.8, 2.2]
  });
  addHotspot({
    id: 'service-panel',
    host: 'panel.avionics',
    offset: [0.35, 0.1, 0],
    title: 'Forward Avionics Bay',
    body: 'Single upward-hinged leaf over the flight-control computers. Gas struts hold it clear of the rotor arc so it can be opened with blades folded.',
    cam: [1.8, 1.4, 1.8]
  });

  /* ---------------- shadow flags ---------------- */
  frame.traverse((o) => {
    if (o.isMesh) o.receiveShadow = true;
  });
  for (const m of shadowCasters) m.castShadow = true;

  /* ---------------- hotspot markers ---------------- */
  const markerObjs = [];
  hotspots.forEach((h) => {
    const host = root.getObjectByName(h.host);
    if (!host) return;
    const sprite = new THREE.Sprite(mats.hotspot);
    sprite.name = `hotspot.${h.id}`;
    sprite.position.set(h.offset[0], h.offset[1], h.offset[2]);
    sprite.scale.set(0.26, 0.26, 0.26);
    sprite.userData.hotspotId = h.id;
    sprite.renderOrder = 8;
    host.add(sprite);
    h.marker = sprite;
    markerObjs.push(sprite);
  });

  root.position.y = GROUND_OFFSET;

  const parts = {};
  root.traverse((o) => {
    if (o.name) parts[o.name] = o;
  });

  const dispose = () => {
    root.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) o.geometry.dispose();
    });
  };

  return {
    root,
    frame,
    parts,
    hotspots,
    explodeSpec,
    markers: markerObjs,
    lights: { cabin: cabinLight, cockpit: cockpitLight },
    dispose,
    names: {
      nacelles: ['nacelle.port', 'nacelle.stbd'],
      rotors: ['rotor.port', 'rotor.stbd'],
      gear: ['gear.nose', 'gear.main.port', 'gear.main.stbd'],
      gearDoors: ['gearDoor.nose', 'gearDoor.main.port', 'gearDoor.main.stbd'],
      sponsons: ['sponson.port', 'sponson.stbd'],
      panels: panels.map((p) => p.name)
    }
  };
}
