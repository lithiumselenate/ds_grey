/**
 * vehicle.js — hierarchical, named Object3D assembly for the
 * Asterion HX-9 Amphibious Rescue Tiltrotor.
 *
 * Axis convention used throughout:
 *   +X = forward (nose)   +Y = up   +Z = starboard (aircraft right)
 * The rescue door, winch and "door" camera preset all live on +Z.
 *
 * Major forms are lofted from authored cross-section tables (custom
 * BufferGeometry), lathed profiles, extruded chamfered shapes and swept
 * tubes. Small mechanical parts use primitives, and repeated hardware
 * (fasteners, seams, vents) uses InstancedMesh.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HALF_PI = Math.PI / 2;

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Rectangle with straight chamfered corners — the core of the visual language. */
export function chamferRectShape(w, h, c) {
  const x = w / 2, y = h / 2, k = Math.min(c, Math.min(x, y) * 0.7);
  const s = new THREE.Shape();
  s.moveTo(-x + k, -y);
  s.lineTo(x - k, -y);
  s.lineTo(x, -y + k);
  s.lineTo(x, y - k);
  s.lineTo(x - k, y);
  s.lineTo(-x + k, y);
  s.lineTo(-x, y - k);
  s.lineTo(-x, -y + k);
  s.closePath();
  return s;
}

/** Chamfered slab: w x h in XY, thickness d in Z, centred on the origin. */
export function chamferedSlab(w, h, d, c = 0.04, bevel = 0.012) {
  const b = Math.min(bevel, d * 0.4, Math.min(w, h) * 0.2);
  const g = new THREE.ExtrudeGeometry(chamferRectShape(w, h, c), {
    depth: Math.max(d - b * 2, 0.001),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1
  });
  g.translate(0, 0, -(d - b * 2) / 2);
  g.computeVertexNormals();
  return g;
}

/** Flip winding when the sampled normals point inward (loft safety net). */
function orientOutward(geo) {
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center;
  const p = geo.attributes.position, n = geo.attributes.normal;
  const step = Math.max(1, Math.floor(p.count / 96));
  let dot = 0;
  for (let i = 0; i < p.count; i += step) {
    dot += (p.getX(i) - c.x) * n.getX(i) + (p.getY(i) - c.y) * n.getY(i) + (p.getZ(i) - c.z) * n.getZ(i);
  }
  if (dot < 0 && geo.index) {
    const a = geo.index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
    }
    geo.index.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Loft a surface through rings of equal length.
 * @param {THREE.Vector3[][]} rings
 */
export function loftFromRings(rings, { closed = true, cap = true } = {}) {
  const m = rings.length, n = rings[0].length;
  const capped = cap && closed;
  const vCount = m * n + (capped ? 2 : 0);
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  for (let r = 0; r < m; r++) {
    for (let i = 0; i < n; i++) {
      const v = rings[r][i], k = r * n + i;
      pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
      uv[k * 2] = i / (closed ? n : n - 1);
      uv[k * 2 + 1] = r / (m - 1);
    }
  }
  const idx = [];
  const segs = closed ? n : n - 1;
  for (let r = 0; r < m - 1; r++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const a = r * n + i, b = r * n + j, c = (r + 1) * n + j, d = (r + 1) * n + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (capped) {
    const cs = m * n, ce = cs + 1;
    for (let e = 0; e < 2; e++) {
      const ring = e === 0 ? rings[0] : rings[m - 1];
      let x = 0, y = 0, z = 0;
      for (const v of ring) { x += v.x; y += v.y; z += v.z; }
      const k = (e === 0 ? cs : ce);
      pos[k * 3] = x / n; pos[k * 3 + 1] = y / n; pos[k * 3 + 2] = z / n;
      uv[k * 2] = 0.5; uv[k * 2 + 1] = e;
    }
    for (let i = 0; i < n; i++) idx.push(cs, (i + 1) % n, i);
    const base = (m - 1) * n;
    for (let i = 0; i < n; i++) idx.push(ce, base + i, base + (i + 1) % n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return orientOutward(g);
}

/** Catmull-Rom resample of an authored numeric station table. */
function resampleTable(rows, count) {
  const out = [];
  const cols = rows[0].length;
  const last = rows.length - 1;
  for (let s = 0; s < count; s++) {
    const t = (s / (count - 1)) * last;
    const i = Math.min(last - 1, Math.floor(t));
    const f = t - i;
    const p0 = rows[Math.max(0, i - 1)], p1 = rows[i], p2 = rows[i + 1], p3 = rows[Math.min(last, i + 2)];
    const r = [];
    for (let c = 0; c < cols; c++) {
      const a = p1[c], b = p2[c];
      const m0 = (b - p0[c]) * 0.5, m1 = (p3[c] - a) * 0.5;
      const f2 = f * f, f3 = f2 * f;
      r.push((2 * f3 - 3 * f2 + 1) * a + (f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) * b + (f3 - f2) * m1);
    }
    out.push(r);
  }
  return out;
}

/** Closed airfoil loop in normalised chord units, cosine spaced. */
function airfoilLoop(n, thickRatio, camber) {
  const yt = (x) => 5 * thickRatio * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
  const yc = (x) => camber * 4 * x * (1 - x);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos(Math.PI * (i / n)));
    pts.push([x, yc(x) + yt(x)]);
  }
  for (let i = n - 1; i > 0; i--) {
    const x = 0.5 * (1 - Math.cos(Math.PI * (i / n)));
    pts.push([x, yc(x) - yt(x)]);
  }
  return pts;
}

function latheGeo(points, segments = 24) {
  return orientOutward(new THREE.LatheGeometry(points, segments));
}
const V2 = (x, y) => new THREE.Vector2(x, y);

function tubeAlong(points, radius, tubular = 32, radial = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.4);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, closed);
}

function mesh(geo, mat, name, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function group(name, parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  if (parent) parent.add(g);
  return g;
}

/** Build one object per side through a factory; side = +1 starboard, -1 port. */
function mirrorPair(name, parent, factory) {
  const holder = group(name, parent);
  const made = {};
  [['starboard', 1], ['port', -1]].forEach(([label, side]) => {
    const g = group(`${name}_${label}`, holder);
    made[label] = factory(g, side, label);
  });
  return { holder, ...made };
}

function radialRepeat(count, fn) {
  for (let i = 0; i < count; i++) fn(i, (i / count) * Math.PI * 2);
}

/* ------------------------------------------------------------------ */
/* authored form tables                                                */
/* ------------------------------------------------------------------ */

/* Half cross-section of the fuselage: [z, y] normalised.
   Duplicated points create the hard chine and shoulder creases. */
const HULL_HALF = [
  [0.00, -1.00], [0.30, -0.90], [0.46, -0.68],
  [0.62, -0.44], [0.62, -0.44],
  [0.71, -0.14], [0.75, 0.16], [0.75, 0.16],
  [0.68, 0.52], [0.50, 0.80], [0.26, 0.96], [0.00, 1.00]
];

/* [x, halfWidth, halfHeight, yCentre] from tail to nose. */
const HULL_STATIONS = [
  [-4.30, 0.15, 0.19, 0.32],
  [-3.70, 0.34, 0.40, 0.25],
  [-3.00, 0.53, 0.57, 0.16],
  [-2.30, 0.73, 0.66, 0.08],
  [-1.50, 0.88, 0.72, 0.02],
  [-0.60, 0.95, 0.75, 0.00],
  [0.60, 0.95, 0.75, 0.00],
  [1.50, 0.92, 0.74, 0.00],
  [2.40, 0.85, 0.70, -0.02],
  [3.20, 0.71, 0.62, -0.07],
  [3.90, 0.53, 0.50, -0.13],
  [4.35, 0.32, 0.34, -0.19],
  [4.56, 0.11, 0.15, -0.23]
];

/* Canopy arc: [x, halfWidth, height, yCentre]. */
const CANOPY_STATIONS = [
  [1.24, 0.84, 0.94, 0.10],
  [1.90, 0.90, 1.02, 0.10],
  [2.55, 0.87, 0.99, 0.06],
  [3.15, 0.75, 0.87, 0.00],
  [3.70, 0.57, 0.67, -0.07],
  [3.98, 0.38, 0.46, -0.12]
];

/* Sponson float half section [z, y] normalised. */
const SPONSON_HALF = [
  [0.00, -1.00], [0.42, -0.86], [0.72, -0.52],
  [0.86, -0.14], [0.86, -0.14],
  [0.80, 0.34], [0.52, 0.80], [0.00, 1.00]
];

function ringFromHalf(half) {
  const r = half.map((p) => [p[0], p[1]]);
  for (let i = half.length - 2; i > 0; i--) r.push([-half[i][0], half[i][1]]);
  return r;
}

function loftBody(stations, half, sampleCount) {
  const ring2d = ringFromHalf(half);
  const rows = resampleTable(stations, sampleCount);
  const rings = rows.map((r) => ring2d.map(([pz, py]) =>
    new THREE.Vector3(r[0], r[3] + r[2] * py, r[1] * pz)));
  return loftFromRings(rings, { closed: true, cap: true });
}

/* ------------------------------------------------------------------ */
/* component builders                                                  */
/* ------------------------------------------------------------------ */

function buildFuselage(A, rng, refs) {
  const g = group('fuselage', null);

  const skin = mesh(loftBody(HULL_STATIONS, HULL_HALF, 32), A.mats.paintIvory, 'fuselage_skin', g);
  refs.fuselageSkin = skin;

  /* inner shell so the cabin reads as an enclosed volume through the door */
  const inner = loftBody(HULL_STATIONS, HULL_HALF, 20);
  inner.scale(0.985, 0.97, 0.97);
  const innerMesh = mesh(inner, A.mats.cavity, 'fuselage_inner_shell', g);
  innerMesh.material = new THREE.MeshStandardMaterial({
    color: 0x3a4046, metalness: 0.2, roughness: 0.85, side: THREE.BackSide
  });
  A.materials.push(innerMesh.material);
  innerMesh.castShadow = false;

  /* ventral hull belly paint band (lower half re-skinned in shadow ivory) */
  const rows = resampleTable(HULL_STATIONS, 26);
  const bellyRings = rows.map((r) => {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = -1 + t * 2;
      const py = -Math.cos(a * 0.9) * 0.62 - 0.34;
      const pz = Math.sin(a * 0.9) * 0.66;
      pts.push(new THREE.Vector3(r[0], r[3] + r[2] * py * 1.02, r[1] * pz * 1.02));
    }
    return pts;
  });
  const belly = mesh(loftFromRings(bellyRings, { closed: false, cap: false }),
    A.mats.paintIvoryLower, 'hull_belly_band', g);
  belly.material = A.mats.paintIvoryLower.clone();
  belly.material.name = 'paintIvoryLowerBelly';
  belly.material.side = THREE.DoubleSide;
  belly.material.polygonOffset = true;
  belly.material.polygonOffsetFactor = -1;
  belly.material.polygonOffsetUnits = -1;
  A.materials.push(belly.material);

  /* chine / spray rails + keel strake */
  const chineRows = resampleTable(HULL_STATIONS, 22).filter((r) => r[0] > -3.6 && r[0] < 4.3);
  [1, -1].forEach((side) => {
    const pts = chineRows.map((r) => new THREE.Vector3(r[0], r[3] + r[2] * -0.44, side * r[1] * 0.635));
    const rail = mesh(tubeAlong(pts, 0.028, 44, 5), A.mats.metalWarm,
      `chine_rail_${side > 0 ? 'starboard' : 'port'}`, g);
    rail.receiveShadow = false;
  });
  const keelPts = resampleTable(HULL_STATIONS, 20)
    .filter((r) => r[0] > -3.9 && r[0] < 4.4)
    .map((r) => new THREE.Vector3(r[0], r[3] + r[2] * -1.01, 0));
  mesh(tubeAlong(keelPts, 0.036, 40, 5), A.mats.graphite, 'keel_strake', g);

  /* dorsal spine fairing */
  const spinePts = resampleTable(HULL_STATIONS, 18)
    .filter((r) => r[0] > -3.8 && r[0] < 1.2)
    .map((r) => new THREE.Vector3(r[0], r[3] + r[2] * 1.01, 0));
  mesh(tubeAlong(spinePts, 0.055, 26, 6), A.mats.paintIvory, 'dorsal_spine', g);

  /* side placards (mirrored decal planes) */
  const decalPlane = new THREE.PlaneGeometry(1.9, 0.475);
  mirrorPair('hull_placards', g, (holder, side) => {
    const d = mesh(decalPlane, A.mats.decalWordmark, 'placard', holder);
    d.position.set(-1.15, 0.16, side * 0.958);
    d.rotation.y = side > 0 ? 0 : Math.PI;
    d.castShadow = false;
    return d;
  });

  /* asymmetric wear, starboard lower hull only */
  const wear = mesh(new THREE.PlaneGeometry(2.6, 0.9), A.mats.decalWear, 'hull_wear_starboard', g);
  wear.position.set(0.9, -0.35, 0.905);
  wear.rotation.set(0, 0, 0.06);
  wear.castShadow = false;

  /* maintenance labels, port aft */
  const labels = mesh(new THREE.PlaneGeometry(0.62, 0.62), A.mats.decalLabels, 'hull_labels_port', g);
  labels.position.set(-2.05, 0.1, -0.86);
  labels.rotation.y = Math.PI;
  labels.castShadow = false;

  /* tail chevrons both sides */
  const chevGeo = new THREE.PlaneGeometry(1.0, 0.42);
  mirrorPair('tail_chevrons', g, (holder, side) => {
    const d = mesh(chevGeo, A.mats.decalChevrons, 'chevrons', holder);
    d.position.set(-3.15, 0.24, side * 0.53);
    d.rotation.y = side > 0 ? 0 : Math.PI;
    d.castShadow = false;
    return d;
  });

  return g;
}

function buildCockpit(A, refs, parent) {
  const g = group('cockpit_assembly', parent);
  const shell = group('canopy_shell', g);
  refs.canopyShell = shell;

  /* glass: open arc loft, double sided */
  const rows = resampleTable(CANOPY_STATIONS, 18);
  const rings = rows.map((r) => {
    const pts = [];
    for (let j = 0; j <= 14; j++) {
      const a = (-1 + (2 * j) / 14) * 1.30;
      pts.push(new THREE.Vector3(r[0], r[3] + r[2] * Math.cos(a), r[1] * Math.sin(a)));
    }
    return pts;
  });
  const glass = mesh(loftFromRings(rings, { closed: false, cap: false }), A.mats.canopy, 'canopy_glass', shell);
  glass.castShadow = false;
  glass.receiveShadow = false;
  glass.renderOrder = 4;

  /* frame: sill rails, two arch ribs, centre spine, windshield post */
  const sill = (side) => rows.map((r) =>
    new THREE.Vector3(r[0], r[3] + r[2] * Math.cos(1.3) + 0.01, side * r[1] * Math.sin(1.3)));
  [1, -1].forEach((side) => {
    mesh(tubeAlong(sill(side), 0.036, 26, 5), A.mats.graphite,
      `canopy_sill_${side > 0 ? 'starboard' : 'port'}`, shell);
  });
  const archAt = (row, name) => {
    const pts = [];
    for (let j = 0; j <= 12; j++) {
      const a = (-1 + (2 * j) / 12) * 1.3;
      pts.push(new THREE.Vector3(row[0], row[3] + row[2] * Math.cos(a), row[1] * Math.sin(a)));
    }
    mesh(tubeAlong(pts, 0.032, 18, 5), A.mats.graphite, name, shell);
  };
  archAt(rows[5], 'canopy_arch_fwd');
  archAt(rows[11], 'canopy_arch_aft');
  const spine = rows.map((r) => new THREE.Vector3(r[0], r[3] + r[2] + 0.012, 0));
  mesh(tubeAlong(spine, 0.03, 24, 5), A.mats.graphite, 'canopy_spine', shell);

  /* interior: instrument shroud, seats, columns */
  const interior = group('cockpit_interior', g);
  const shroud = mesh(chamferedSlab(0.72, 0.3, 1.45, 0.06), A.mats.graphite, 'dash_shroud', interior);
  shroud.position.set(3.18, 0.06, 0);
  shroud.rotation.set(0, HALF_PI, -0.32);
  const scr = new THREE.PlaneGeometry(0.34, 0.2);
  [-0.42, 0, 0.42].forEach((z, i) => {
    const s = mesh(scr, A.mats.emPanel, `dash_display_${i}`, interior);
    s.position.set(3.0, 0.12, z);
    s.rotation.set(-1.05, 0, 0);
    s.castShadow = false;
    refs.panelDisplays.push(s);
  });
  const console3 = mesh(chamferedSlab(0.6, 0.16, 0.3, 0.04), A.mats.graphiteLight, 'centre_console', interior);
  console3.position.set(2.62, -0.14, 0);
  console3.rotation.y = HALF_PI;

  const seatPan = chamferedSlab(0.46, 0.09, 0.44, 0.05);
  const seatBack = chamferedSlab(0.5, 0.09, 0.42, 0.05);
  const headrest = chamferedSlab(0.2, 0.08, 0.24, 0.04);
  const column = new THREE.CylinderGeometry(0.022, 0.03, 0.34, 8);
  const grip = chamferedSlab(0.11, 0.05, 0.14, 0.02);
  mirrorPair('cockpit_seats', interior, (holder, side) => {
    const z = side * 0.42;
    const pan = mesh(seatPan, A.mats.fabric, 'seat_pan', holder);
    pan.position.set(2.06, -0.2, z);
    pan.rotation.x = HALF_PI;
    const back = mesh(seatBack, A.mats.fabric, 'seat_back', holder);
    back.position.set(1.82, 0.06, z);
    back.rotation.set(0, HALF_PI, 0.16);
    const hr = mesh(headrest, A.mats.fabric, 'headrest', holder);
    hr.position.set(1.76, 0.34, z);
    hr.rotation.y = HALF_PI;
    const col = mesh(column, A.mats.graphite, 'control_column', holder);
    col.position.set(2.5, -0.14, z * 0.72);
    col.rotation.z = -0.18;
    const gr = mesh(grip, A.mats.graphiteLight, 'column_grip', holder);
    gr.position.set(2.54, 0.05, z * 0.72);
    return { pan, back, hr, col };
  });

  const dome = mesh(new THREE.SphereGeometry(0.05, 10, 8), A.mats.emCabin, 'cockpit_dome_light', interior);
  dome.position.set(1.7, 0.62, 0);
  dome.castShadow = false;
  refs.interiorLights.push(dome);

  return g;
}

function buildCabin(A, refs, parent) {
  const g = group('cabin_assembly', parent);

  const floor = mesh(chamferedSlab(3.0, 0.07, 1.5, 0.05), A.mats.graphiteLight, 'cabin_floor', g);
  floor.position.set(-0.35, -0.38, 0);
  floor.rotation.x = HALF_PI;

  const bulk = chamferedSlab(1.4, 1.1, 0.06, 0.08);
  const fwdB = mesh(bulk, A.mats.graphite, 'cabin_bulkhead_fwd', g);
  fwdB.position.set(1.2, 0.06, 0);
  fwdB.rotation.y = HALF_PI;
  const aftB = mesh(bulk, A.mats.graphite, 'cabin_bulkhead_aft', g);
  aftB.position.set(-1.95, 0.06, 0);
  aftB.rotation.y = HALF_PI;

  /* fold-down seats on the port wall */
  const seat = chamferedSlab(0.42, 0.06, 0.4, 0.04);
  [[-0.35], [-1.1]].forEach(([x], i) => {
    const hinge = group(`cabin_seat_hinge_${i}`, g, x, -0.16, -0.62);
    const s = mesh(seat, A.mats.fabric, `cabin_seat_${i}`, hinge);
    s.position.set(0, 0, 0.2);
    s.rotation.x = HALF_PI;
    const back = mesh(chamferedSlab(0.42, 0.05, 0.44, 0.04), A.mats.fabric, `cabin_seat_back_${i}`, hinge);
    back.position.set(0, 0.24, -0.02);
    back.rotation.y = HALF_PI;
  });

  /* stretcher: tube frame + pad */
  const st = group('stretcher', g, -0.3, -0.05, 0.24);
  const railPts = (z) => [
    new THREE.Vector3(-0.95, 0, z), new THREE.Vector3(0.95, 0, z)
  ];
  [0.24, -0.24].forEach((z, i) => {
    mesh(tubeAlong(railPts(z), 0.022, 6, 5), A.mats.metal, `stretcher_rail_${i}`, st);
  });
  const pad = mesh(chamferedSlab(1.84, 0.07, 0.5, 0.05), A.mats.fabric, 'stretcher_pad', st);
  pad.position.y = 0.05;
  pad.rotation.x = HALF_PI;
  const leg = new THREE.CylinderGeometry(0.018, 0.018, 0.28, 8);
  radialRepeat(4, (i) => {
    const l = mesh(leg, A.mats.metal, `stretcher_leg_${i}`, st);
    l.position.set(i < 2 ? -0.82 : 0.82, -0.16, i % 2 ? 0.22 : -0.22);
  });

  /* grab rails along the ceiling */
  [0.5, -0.5].forEach((z, i) => {
    const pts = [
      new THREE.Vector3(-1.7, 0.5, z), new THREE.Vector3(-0.6, 0.56, z),
      new THREE.Vector3(0.5, 0.56, z), new THREE.Vector3(1.05, 0.5, z)
    ];
    mesh(tubeAlong(pts, 0.024, 16, 5), A.mats.metal, `cabin_grab_rail_${i}`, g);
  });

  /* ceiling light strips */
  const strip = chamferedSlab(1.5, 0.04, 0.12, 0.02);
  [0.3, -0.3].forEach((z, i) => {
    const l = mesh(strip, A.mats.emCabin, `cabin_light_${i}`, g);
    l.position.set(-0.4, 0.58, z);
    l.rotation.x = HALF_PI;
    l.castShadow = false;
    refs.interiorLights.push(l);
  });

  /* sliding rescue door on the starboard side */
  const carrier = group('door_explode', g);
  const slider = group('rescue_door', carrier, 0, 0, 0);
  refs.doorSlider = slider;
  const panel = mesh(chamferedSlab(1.42, 1.16, 0.075, 0.09), A.mats.paintIvory, 'door_panel', slider);
  panel.position.set(0.35, 0.1, 0.955);
  panel.rotation.y = HALF_PI;
  const win = mesh(chamferedSlab(0.72, 0.46, 0.03, 0.06), A.mats.windowGlass, 'door_window', slider);
  win.position.set(0.45, 0.32, 0.995);
  win.rotation.y = HALF_PI;
  win.castShadow = false;
  win.renderOrder = 3;
  const dec = mesh(new THREE.PlaneGeometry(0.62, 0.62), A.mats.decalDoor, 'door_decal', slider);
  dec.position.set(0.2, -0.12, 1.0);
  dec.rotation.y = 0;
  dec.castShadow = false;
  const handle = mesh(new THREE.TorusGeometry(0.075, 0.016, 6, 12, Math.PI * 1.1), A.mats.metal, 'door_handle', slider);
  handle.position.set(-0.18, 0.06, 1.005);
  handle.rotation.set(0, HALF_PI, 0.4);

  /* door rails on the fuselage */
  [0.62, -0.5].forEach((y, i) => {
    const rail = mesh(chamferedSlab(2.4, 0.05, 0.05, 0.015), A.mats.graphite, `door_rail_${i}`, g);
    rail.position.set(-0.2, y, 0.93);
    rail.rotation.y = HALF_PI;
  });

  /* sill hazard strip, boarding step and grab handle */
  const sill = mesh(new THREE.PlaneGeometry(1.4, 0.12), A.mats.decalChevrons, 'door_sill_stripe', g);
  sill.position.set(0.35, -0.52, 0.945);
  sill.castShadow = false;
  const step = mesh(chamferedSlab(0.46, 0.05, 0.2, 0.02), A.mats.metal, 'boarding_step', g);
  step.position.set(0.35, -0.78, 0.86);
  step.rotation.x = HALF_PI;
  const hand = mesh(new THREE.TorusGeometry(0.1, 0.018, 6, 12, Math.PI), A.mats.metal, 'boarding_handle', g);
  hand.position.set(1.1, 0.3, 0.95);
  hand.rotation.set(HALF_PI, 0, 0);

  return g;
}

function buildWings(A, refs, parent) {
  const pair = mirrorPair('wings', parent, (holder, side, label) => {
    /* lofted airfoil from root to tip with taper, sweep and dihedral */
    const loop = airfoilLoop(9, 0.15, 0.035);
    const rings = [];
    const spans = 9;
    for (let i = 0; i <= spans; i++) {
      const t = i / spans;
      const z = side * (0.88 + t * 2.07);
      const chord = 1.62 - t * 0.5;
      const xLE = 0.42 - t * 0.26;
      const y = 0.42 + t * 0.12;
      rings.push(loop.map(([cx, cy]) =>
        new THREE.Vector3(xLE - cx * chord, y + cy * chord, z)));
    }
    if (side < 0) rings.reverse();
    const wing = mesh(loftFromRings(rings, { closed: true, cap: true }), A.mats.paintIvory, `wing_skin_${label}`, holder);

    /* structural root fairing */
    const root = mesh(chamferedSlab(1.9, 0.5, 0.42, 0.12), A.mats.paintIvory, `wing_root_${label}`, holder);
    root.position.set(-0.12, 0.4, side * 0.86);
    root.rotation.y = HALF_PI;

    /* layered upper access panel + seam */
    const panel = mesh(chamferedSlab(0.78, 1.1, 0.022, 0.06), A.mats.paintIvoryLower, `wing_panel_${label}`, holder);
    panel.position.set(-0.05, 0.552, side * 1.7);
    panel.rotation.x = -HALF_PI;
    panel.material = A.mats.paintIvoryLower.clone();
    panel.material.name = 'paintIvoryLowerPanel';
    panel.material.polygonOffset = true;
    panel.material.polygonOffsetFactor = -2;
    panel.material.polygonOffsetUnits = -2;
    A.materials.push(panel.material);

    /* control-surface seams (flaperon) */
    const seam = mesh(chamferedSlab(1.75, 0.035, 0.03, 0.01), A.mats.graphite, `flaperon_seam_${label}`, holder);
    seam.position.set(-0.92, 0.5, side * 1.9);
    seam.rotation.set(0, HALF_PI, 0.06);
    const flap = mesh(chamferedSlab(1.7, 0.26, 0.07, 0.03), A.mats.paintIvoryLower, `flaperon_${label}`, holder);
    flap.position.set(-1.02, 0.5, side * 1.9);
    flap.rotation.set(0, HALF_PI, 0.05);

    /* navigation light at the leading edge tip */
    const navMat = side > 0 ? A.mats.emGreen : A.mats.emRed;
    const nav = mesh(new THREE.SphereGeometry(0.055, 10, 8), navMat, `nav_light_${label}`, holder);
    nav.position.set(0.2, 0.53, side * 2.9);
    nav.castShadow = false;
    refs.navLights.push(nav);

    /* pitot probe outboard */
    const probe = mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.36, 8), A.mats.metal, `pitot_${label}`, holder);
    probe.position.set(0.5, 0.44, side * 2.55);
    probe.rotation.z = HALF_PI;

    return { wing, panel, root, nav };
  });
  refs.wingPanels = { starboard: pair.starboard.panel, port: pair.port.panel };
  return pair;
}

function buildNacelle(A, refs, holder, side, label) {
  /* explode carrier -> tilt pivot -> nacelle body (built pointing up) */
  const carrier = group(`nacelle_explode_${label}`, holder, 0, 0, 0);
  const pivotAnchor = group(`nacelle_pivot_${label}`, carrier, 0.16, 0.54, side * 2.95);
  const body = group(`nacelle_body_${label}`, pivotAnchor);

  /* cowl: lathed profile revolved about Y */
  const cowl = latheGeo([
    V2(0.001, -0.86), V2(0.20, -0.86), V2(0.27, -0.80), V2(0.31, -0.66),
    V2(0.36, -0.4), V2(0.42, -0.06), V2(0.445, 0.3), V2(0.44, 0.52),
    V2(0.47, 0.6), V2(0.455, 0.64), V2(0.40, 0.62), V2(0.39, 0.5), V2(0.001, 0.5)
  ], 28);
  mesh(cowl, A.mats.paintIvory, `nacelle_cowl_${label}`, body);

  /* intake lip + dark internal cavity + inlet screen ring */
  const lip = latheGeo([
    V2(0.39, 0.5), V2(0.40, 0.6), V2(0.44, 0.65), V2(0.47, 0.6), V2(0.455, 0.52)
  ], 28);
  mesh(lip, A.mats.metal, `intake_lip_${label}`, body);
  const cavity = mesh(new THREE.CylinderGeometry(0.38, 0.3, 0.6, 22, 1, true), A.mats.cavity, `intake_cavity_${label}`, body);
  cavity.position.y = 0.24;
  cavity.material = A.mats.cavity.clone();
  cavity.material.name = 'cavityInner';
  cavity.material.side = THREE.BackSide;
  A.materials.push(cavity.material);
  const cavityFloor = mesh(new THREE.CircleGeometry(0.3, 22), A.mats.cavity, `intake_floor_${label}`, body);
  cavityFloor.position.y = -0.06;
  cavityFloor.rotation.x = -HALF_PI;

  /* exhaust ring at the bottom + faint glow disc */
  mesh(latheGeo([
    V2(0.18, -0.9), V2(0.235, -0.88), V2(0.27, -0.82), V2(0.24, -0.78), V2(0.2, -0.8)
  ], 24), A.mats.graphite, `exhaust_ring_${label}`, body);
  const glow = mesh(new THREE.CircleGeometry(0.19, 20), A.mats.emExhaust, `exhaust_glow_${label}`, body);
  glow.position.y = -0.885;
  glow.rotation.x = HALF_PI;
  glow.castShadow = false;
  refs.exhaustGlows.push(glow);

  /* cooling vents: instanced slats around the mid cowl */
  const ventGeo = chamferedSlab(0.05, 0.16, 0.02, 0.008);
  const vents = new THREE.InstancedMesh(ventGeo, A.mats.graphite, 9);
  vents.name = `nacelle_vents_${label}`;
  vents.castShadow = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pos = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 9; i++) {
    const a = -0.9 + i * 0.2;
    pos.set(Math.sin(a) * 0.44 * side, -0.16, Math.cos(a) * 0.44);
    e.set(0, Math.atan2(pos.x, pos.z), 0);
    q.setFromEuler(e);
    m4.compose(pos, q, sc);
    vents.setMatrixAt(i, m4);
  }
  vents.instanceMatrix.needsUpdate = true;
  body.add(vents);

  /* caution wrap around the cowl waist */
  const wrap = mesh(new THREE.CylinderGeometry(0.452, 0.452, 0.26, 26, 1, true),
    A.mats.decalNacelle, `nacelle_warn_${label}`, body);
  wrap.position.y = 0.12;
  wrap.castShadow = false;

  /* visible pivot hardware: spindle, arc bracket, actuator */
  const spindle = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 14), A.mats.metal, `tilt_spindle_${label}`, pivotAnchor);
  spindle.rotation.x = HALF_PI;
  const arc = mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 18, Math.PI * 0.85), A.mats.graphite, `tilt_arc_${label}`, pivotAnchor);
  arc.rotation.y = HALF_PI;
  arc.rotation.z = -0.4;
  const yoke = mesh(chamferedSlab(0.5, 0.44, 0.08, 0.06), A.mats.graphiteLight, `tilt_yoke_${label}`, pivotAnchor);
  yoke.position.set(-0.02, 0, side * -0.34);
  yoke.rotation.y = HALF_PI;

  const actuator = group(`tilt_actuator_${label}`, carrier, -0.42, 0.3, side * 2.72);
  const barrel = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.34, 12), A.mats.graphite, `actuator_barrel_${label}`, actuator);
  barrel.rotation.z = -HALF_PI;
  const rod = mesh(new THREE.CylinderGeometry(0.032, 0.032, 1.0, 10), A.mats.metal, `actuator_rod_${label}`, actuator);
  rod.rotation.z = -HALF_PI;
  rod.position.x = 0.3;

  /* rotor: hub, cuffs, blades, links, spinner, motion disc */
  const spin = group(`rotor_spin_${label}`, body, 0, 0.72, 0);
  const hub = latheGeo([
    V2(0.001, -0.06), V2(0.14, -0.06), V2(0.2, 0.0), V2(0.22, 0.1),
    V2(0.17, 0.2), V2(0.1, 0.26), V2(0.001, 0.27)
  ], 20);
  mesh(hub, A.mats.graphite, `rotor_hub_${label}`, spin);
  mesh(latheGeo([V2(0.001, 0.26), V2(0.09, 0.3), V2(0.12, 0.38), V2(0.06, 0.44), V2(0.001, 0.45)], 18),
    A.mats.metal, `rotor_spinner_${label}`, spin);
  const swash = mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.035, 20), A.mats.metal, `swashplate_${label}`, spin);
  swash.position.y = -0.11;

  /* blade: lofted airfoil along +X with taper and twist */
  const bloop = airfoilLoop(7, 0.12, 0.05);
  const bRings = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const r = 0.22 + t * 1.83;
    const chord = 0.3 - t * 0.115 - Math.pow(t, 6) * 0.08;
    const tw = (0.34 - t * 0.3) * (side > 0 ? 1 : -1);
    const ct = Math.cos(tw), st = Math.sin(tw);
    bRings.push(bloop.map(([cx, cy]) => {
      const zc = -(cx - 0.28) * chord, yc = cy * chord;
      return new THREE.Vector3(r + Math.pow(t, 3) * 0.06, zc * st + yc * ct, zc * ct - yc * st);
    }));
  }
  const bladeGeo = loftFromRings(bRings, { closed: true, cap: true });
  const blades = new THREE.InstancedMesh(bladeGeo, A.mats.paintIvoryLower, 5);
  blades.name = `rotor_blades_${label}`;
  blades.castShadow = true;
  const cuffGeo = latheGeo([V2(0.05, 0.0), V2(0.09, 0.02), V2(0.1, 0.16), V2(0.07, 0.22), V2(0.05, 0.22)], 12);
  const cuffs = new THREE.InstancedMesh(cuffGeo, A.mats.graphite, 5);
  cuffs.name = `rotor_cuffs_${label}`;
  const linkGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.2, 6);
  const links = new THREE.InstancedMesh(linkGeo, A.mats.metal, 5);
  links.name = `pitch_links_${label}`;
  radialRepeat(5, (i, ang) => {
    e.set(0, ang, 0);
    q.setFromEuler(e);
    m4.compose(pos.set(0, 0, 0), q, sc);
    blades.setMatrixAt(i, m4);
    e.set(0, ang, HALF_PI);
    q.setFromEuler(e);
    m4.compose(pos.set(Math.cos(ang) * 0.2, 0.04, -Math.sin(ang) * 0.2), q, sc);
    cuffs.setMatrixAt(i, m4);
    e.set(0.22, ang, 0);
    q.setFromEuler(e);
    m4.compose(pos.set(Math.cos(ang) * 0.24, -0.06, -Math.sin(ang) * 0.24), q, sc);
    links.setMatrixAt(i, m4);
  });
  blades.instanceMatrix.needsUpdate = true;
  cuffs.instanceMatrix.needsUpdate = true;
  links.instanceMatrix.needsUpdate = true;
  spin.add(blades, cuffs, links);

  const disc = mesh(new THREE.RingGeometry(0.34, 2.14, 40, 1), A.mats.motionDisc.clone(), `rotor_disc_${label}`, spin);
  disc.rotation.x = -HALF_PI;
  disc.position.y = 0.02;
  disc.castShadow = false;
  disc.receiveShadow = false;
  disc.visible = false;
  A.materials.push(disc.material);

  refs.nacelles.push({ label, side, carrier, pivot: pivotAnchor, body, spin, blades, cuffs, disc, rod, actuator });
  return { carrier, pivotAnchor, body, spin };
}

function buildGearLeg(A, refs, parent, spec) {
  const carrier = group(`gear_explode_${spec.id}`, parent);
  const pivot = group(`gear_pivot_${spec.id}`, carrier, spec.x, spec.y, spec.z);
  const leg = group(`gear_leg_${spec.id}`, pivot);

  const trunnion = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 12), A.mats.metal, `trunnion_${spec.id}`, leg);
  trunnion.rotation.x = HALF_PI;
  const upper = mesh(new THREE.CylinderGeometry(0.058, 0.066, spec.len * 0.6, 12), A.mats.graphiteLight, `oleo_upper_${spec.id}`, leg);
  upper.position.y = -spec.len * 0.3;
  const lower = mesh(new THREE.CylinderGeometry(0.044, 0.044, spec.len * 0.55, 12), A.mats.metal, `oleo_lower_${spec.id}`, leg);
  lower.position.y = -spec.len * 0.72;
  const brace = mesh(new THREE.CylinderGeometry(0.026, 0.026, spec.len * 0.7, 8), A.mats.metal, `drag_brace_${spec.id}`, leg);
  brace.position.set(spec.braceX, -spec.len * 0.42, 0);
  brace.rotation.z = spec.braceX > 0 ? -0.5 : 0.5;
  const axle = mesh(new THREE.CylinderGeometry(0.03, 0.03, spec.track + 0.1, 10), A.mats.metal, `axle_${spec.id}`, leg);
  axle.position.y = -spec.len;
  axle.rotation.x = HALF_PI;

  /* tyre: lathed cross-section revolved about Y, then laid on the Z axis */
  const r = spec.tyreR, tw = spec.tyreW;
  const tyreGeo = latheGeo([
    V2(r * 0.5, -tw / 2), V2(r * 0.82, -tw / 2), V2(r * 0.97, -tw * 0.36),
    V2(r, -tw * 0.18), V2(r, tw * 0.18), V2(r * 0.97, tw * 0.36),
    V2(r * 0.82, tw / 2), V2(r * 0.5, tw / 2)
  ], 20);
  tyreGeo.rotateX(HALF_PI);
  const hubGeo = latheGeo([
    V2(0.001, -tw * 0.3), V2(r * 0.3, -tw * 0.32), V2(r * 0.5, -tw * 0.22),
    V2(r * 0.52, tw * 0.22), V2(r * 0.3, tw * 0.32), V2(0.001, tw * 0.3)
  ], 16);
  hubGeo.rotateX(HALF_PI);
  const offsets = spec.wheels === 2 ? [spec.track / 2, -spec.track / 2] : [0];
  offsets.forEach((z, i) => {
    const w = group(`wheel_${spec.id}_${i}`, leg, 0, -spec.len, z);
    mesh(tyreGeo, A.mats.rubber, `tyre_${spec.id}_${i}`, w);
    mesh(hubGeo, A.mats.metalWarm, `hub_${spec.id}_${i}`, w);
  });

  /* gear bay door on its own hinge */
  const doorHinge = group(`gear_door_hinge_${spec.id}`, parent, spec.x, spec.y - 0.02, spec.doorZ);
  const door = mesh(chamferedSlab(spec.doorLen, spec.doorW, 0.05, 0.05), A.mats.paintIvoryLower, `gear_door_${spec.id}`, doorHinge);
  door.position.set(0, 0, spec.doorSide * spec.doorW * 0.5);
  door.rotation.x = HALF_PI;
  const stripe = mesh(new THREE.PlaneGeometry(spec.doorLen * 0.8, 0.09), A.mats.decalChevrons, `gear_door_stripe_${spec.id}`, doorHinge);
  stripe.position.set(0, -0.031, spec.doorSide * spec.doorW * 0.5);
  stripe.rotation.x = HALF_PI;
  stripe.castShadow = false;

  refs.gear.push({
    id: spec.id, carrier, pivot, leg, doorHinge,
    axis: spec.axis, retractAngle: spec.retractAngle, doorAngle: spec.doorAngle
  });
  return { carrier, pivot, doorHinge };
}

function buildSponsons(A, refs, parent) {
  return mirrorPair('sponsons', parent, (holder, side, label) => {
    const carrier = group(`sponson_explode_${label}`, holder);
    const pivot = group(`sponson_pivot_${label}`, carrier, -0.1, -0.28, side * 0.72);
    const stations = [
      [-1.5, 0.12, 0.1, 0.0],
      [-1.05, 0.26, 0.18, 0.0],
      [-0.3, 0.34, 0.22, 0.0],
      [0.5, 0.34, 0.22, 0.0],
      [1.15, 0.26, 0.18, 0.0],
      [1.55, 0.1, 0.08, 0.0]
    ];
    const ring2d = ringFromHalf(SPONSON_HALF);
    const rows = resampleTable(stations, 16);
    const rings = rows.map((r) => ring2d.map(([pz, py]) =>
      new THREE.Vector3(r[0], r[3] + r[2] * py, r[1] * pz)));
    if (side < 0) rings.forEach((ring) => ring.reverse());
    const float = mesh(loftFromRings(rings, { closed: true, cap: true }), A.mats.paintIvoryLower, `sponson_float_${label}`, pivot);
    float.position.z = side * 0.5;

    /* strut arms + a hard chine strake along the float */
    [0.55, -0.5].forEach((x, i) => {
      const arm = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.42, 10), A.mats.graphite, `sponson_arm_${label}_${i}`, pivot);
      arm.position.set(x, 0.06, side * 0.22);
      arm.rotation.x = side * -0.5;
    });
    const strakePts = rows.filter((r) => r[0] > -1.4 && r[0] < 1.5)
      .map((r) => new THREE.Vector3(r[0], r[3] + r[2] * -0.14, side * (0.5 + r[1] * 0.88)));
    mesh(tubeAlong(strakePts, 0.02, 20, 5), A.mats.metalWarm, `sponson_strake_${label}`, pivot);

    const stripe = mesh(new THREE.PlaneGeometry(0.7, 0.16), A.mats.decalChevrons, `sponson_stripe_${label}`, pivot);
    stripe.position.set(1.05, 0.12, side * 0.52);
    stripe.rotation.set(-HALF_PI, 0, 0);
    stripe.castShadow = false;

    refs.sponsons.push({ label, side, carrier, pivot });
    return { carrier, pivot, float };
  });
}

function buildWinch(A, refs, parent) {
  const carrier = group('winch_explode', parent);
  const mount = group('winch_mount', carrier, 0.45, 0.6, 0.82);
  const base = mesh(chamferedSlab(0.34, 0.26, 0.3, 0.05), A.mats.graphite, 'winch_base', mount);
  base.rotation.y = HALF_PI;

  const arm = group('winch_arm', mount);
  refs.winchArm = arm;
  const boom = mesh(chamferedSlab(1.5, 0.14, 0.16, 0.04), A.mats.metal, 'winch_boom', arm);
  boom.position.set(0, 0.02, 0.78);
  boom.rotation.y = HALF_PI;
  const brace = mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.8, 8), A.mats.metal, 'winch_brace', arm);
  brace.position.set(0, -0.16, 0.42);
  brace.rotation.x = -0.9;
  const drum = mesh(latheGeo([
    V2(0.05, -0.13), V2(0.16, -0.13), V2(0.16, -0.1), V2(0.13, -0.09),
    V2(0.13, 0.09), V2(0.16, 0.1), V2(0.16, 0.13), V2(0.05, 0.13)
  ], 18), A.mats.graphiteLight, 'winch_drum', arm);
  drum.rotation.z = HALF_PI;
  drum.position.set(0, 0.05, 0.24);
  refs.winchDrum = drum;
  const sheave = mesh(new THREE.TorusGeometry(0.075, 0.022, 6, 14), A.mats.metal, 'winch_sheave', arm);
  sheave.position.set(0, -0.05, 1.5);
  sheave.rotation.y = HALF_PI;

  const head = group('winch_head', arm, 0, -0.1, 1.5);
  const cable = mesh(new THREE.CylinderGeometry(0.011, 0.011, 1, 6), A.mats.metal, 'winch_cable', head);
  cable.castShadow = false;
  refs.winchCable = cable;

  const load = group('winch_load', head);
  refs.winchLoad = load;
  const hook = group('winch_hook', load);
  mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8), A.mats.metal, 'hook_swivel', hook);
  const hookBody = mesh(new THREE.TorusGeometry(0.06, 0.017, 6, 14, Math.PI * 1.55), A.mats.metalWarm, 'hook_body', hook);
  hookBody.position.y = -0.11;
  hookBody.rotation.x = HALF_PI;

  /* rescue basket: tube frame + mesh floor + float collar */
  const basket = group('rescue_basket', load, 0, -0.34, 0);
  const w = 0.34, d = 0.22, h = 0.2;
  const rim = [
    new THREE.Vector3(-w, h, -d), new THREE.Vector3(w, h, -d),
    new THREE.Vector3(w, h, d), new THREE.Vector3(-w, h, d)
  ];
  mesh(tubeAlong([...rim, rim[0].clone()], 0.016, 26, 5, true), A.mats.metalWarm, 'basket_rim', basket);
  const floor = mesh(chamferedSlab(w * 2 - 0.04, d * 2 - 0.04, 0.02, 0.03), A.mats.graphiteLight, 'basket_floor', basket);
  floor.rotation.x = HALF_PI;
  const strut = new THREE.CylinderGeometry(0.012, 0.012, h, 6);
  [[-w, -d], [w, -d], [w, d], [-w, d]].forEach(([x, z], i) => {
    const s = mesh(strut, A.mats.metal, `basket_strut_${i}`, basket);
    s.position.set(x, h / 2, z);
  });
  const collar = mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 18), A.mats.paintOrange, 'basket_collar', basket);
  collar.rotation.x = HALF_PI;
  collar.position.y = 0.04;
  const bridle = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.26, 6), A.mats.metal, 'basket_bridle', basket);
  bridle.position.y = 0.32;

  return { carrier, arm, load };
}

function buildTurret(A, refs, parent) {
  const carrier = group('turret_explode', parent);
  const mount = group('turret_mount', carrier, 3.62, -0.42, 0);
  mesh(latheGeo([V2(0.001, 0.12), V2(0.15, 0.1), V2(0.17, 0.0), V2(0.16, -0.04), V2(0.001, -0.04)], 18),
    A.mats.graphite, 'turret_collar', mount);
  const yaw = group('turret_yaw', mount, 0, -0.06, 0);
  refs.turretYaw = yaw;
  const ring = mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 20), A.mats.metal, 'turret_yaw_ring', yaw);
  ring.rotation.x = HALF_PI;
  [1, -1].forEach((s, i) => {
    const cheek = mesh(chamferedSlab(0.2, 0.24, 0.05, 0.04), A.mats.graphiteLight, `turret_yoke_${i}`, yaw);
    cheek.position.set(0, -0.14, s * 0.17);
    cheek.rotation.y = HALF_PI;
  });
  const pitch = group('turret_pitch', yaw, 0, -0.2, 0);
  refs.turretPitch = pitch;
  const ball = mesh(new THREE.SphereGeometry(0.16, 20, 14), A.mats.graphite, 'turret_ball', pitch);
  ball.scale.set(1, 0.94, 1);
  const face = mesh(chamferedSlab(0.2, 0.2, 0.03, 0.05), A.mats.graphiteLight, 'turret_face', pitch);
  face.position.set(0.15, 0.01, 0);
  face.rotation.y = HALF_PI;
  const lensGeo = new THREE.CircleGeometry(0.045, 18);
  [[0.06, 0.05], [0.06, -0.05], [-0.055, 0.0]].forEach(([y, z], i) => {
    const l = mesh(lensGeo, A.mats.lens, `turret_lens_${i}`, pitch);
    l.position.set(0.168, y, z);
    l.rotation.y = HALF_PI;
    l.castShadow = false;
  });
  const led = new THREE.SphereGeometry(0.016, 8, 6);
  [[0.1, 0.11, A.mats.emCyan], [0.1, -0.11, A.mats.emGreen]].forEach(([y, z, m], i) => {
    const l = mesh(led, m, `turret_led_${i}`, pitch);
    l.position.set(0.13, y, z);
    l.castShadow = false;
    refs.statusLeds.push(l);
  });
  return { carrier, yaw, pitch };
}

function buildTail(A, refs, parent) {
  const g = group('tail_assembly', parent);
  const loop = airfoilLoop(7, 0.13, 0.0);
  const finRings = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const chord = 1.25 - t * 0.5;
    const xLE = -3.15 - t * 0.3;
    finRings.push(loop.map(([cx, cy]) =>
      new THREE.Vector3(xLE - cx * chord, 0.42 + t * 1.35, cy * chord)));
  }
  mesh(loftFromRings(finRings, { closed: true, cap: true }), A.mats.paintIvory, 'vertical_fin', g);
  const beacon = mesh(new THREE.SphereGeometry(0.05, 10, 8), A.mats.emWhite, 'anticollision_beacon', g);
  beacon.position.set(-3.72, 1.82, 0);
  beacon.castShadow = false;
  refs.beacons.push(beacon);
  const whip = mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.5, 6), A.mats.metal, 'hf_antenna', g);
  whip.position.set(-3.0, 1.7, 0);
  whip.rotation.z = -0.3;

  mirrorPair('stabilisers', g, (holder, side, label) => {
    const rings = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const chord = 0.95 - t * 0.32;
      const xLE = -3.5 - t * 0.1;
      rings.push(loop.map(([cx, cy]) =>
        new THREE.Vector3(xLE - cx * chord, 1.7 + t * 0.06, side * (0.1 + t * 1.2) + cy * chord * 0.0)));
    }
    /* thickness along Y for a horizontal surface */
    rings.forEach((ring, i) => {
      const t = i / 6;
      const chord = 0.95 - t * 0.32;
      ring.forEach((v, k) => { v.y = 1.7 + t * 0.06 + loop[k][1] * chord; });
    });
    if (side < 0) rings.forEach((r) => r.reverse());
    const stab = mesh(loftFromRings(rings, { closed: true, cap: true }), A.mats.paintIvory, `stabiliser_${label}`, holder);
    const seam = mesh(chamferedSlab(0.9, 0.02, 0.03, 0.008), A.mats.graphite, `elevator_seam_${label}`, holder);
    seam.position.set(-4.06, 1.72, side * 0.7);
    seam.rotation.y = HALF_PI;
    return stab;
  });
  return g;
}

function buildDetails(A, rng, refs, body) {
  const g = group('details', body);

  /* nose probes and antennas */
  [0.24, -0.24].forEach((z, i) => {
    const p = mesh(new THREE.CylinderGeometry(0.009, 0.016, 0.34, 8), A.mats.metal, `nose_pitot_${i}`, g);
    p.position.set(4.52, -0.12, z);
    p.rotation.z = HALF_PI;
  });
  [[-1.3, 0.8], [-2.4, 0.62]].forEach(([x, y], i) => {
    const a = mesh(chamferedSlab(0.3, 0.14, 0.02, 0.03), A.mats.graphite, `blade_antenna_${i}`, g);
    a.position.set(x, y + 0.06, 0);
    refs.antennas.push(a);
  });
  const gps = mesh(chamferedSlab(0.18, 0.05, 0.14, 0.02), A.mats.paintIvoryLower, 'satcom_pad', g);
  gps.position.set(-0.5, 0.79, 0);

  /* underside anti-collision + landing light */
  const bell = mesh(new THREE.SphereGeometry(0.045, 10, 8), A.mats.emRed, 'beacon_ventral', g);
  bell.position.set(-1.2, -0.74, 0);
  bell.castShadow = false;
  refs.beacons.push(bell);
  const land = mesh(new THREE.CircleGeometry(0.09, 16), A.mats.emWhite, 'landing_light', g);
  land.position.set(3.5, -0.56, 0.3);
  land.rotation.x = HALF_PI;
  land.castShadow = false;
  refs.landingLight = land;

  /* service access covers on hinges (open in maintenance) */
  const coverSpecs = [
    { id: 'avionics', x: 2.5, y: 0.42, z: 0.62, w: 0.66, h: 0.44, axis: 'z', sign: 1 },
    { id: 'hydraulics', x: -1.7, y: 0.3, z: -0.7, w: 0.6, h: 0.5, axis: 'z', sign: -1 },
    { id: 'gearbox', x: 0.1, y: 0.62, z: -0.36, w: 0.7, h: 0.5, axis: 'x', sign: 1 }
  ];
  coverSpecs.forEach((s) => {
    const hinge = group(`panel_hinge_${s.id}`, g, s.x, s.y, s.z);
    const cover = mesh(chamferedSlab(s.w, s.h, 0.025, 0.05), A.mats.paintIvory, `panel_${s.id}`, hinge);
    if (s.axis === 'z') {
      cover.position.set(0, 0, 0);
      cover.rotation.y = s.sign > 0 ? 0 : Math.PI;
      cover.translateZ(0.32);
    } else {
      cover.rotation.x = -HALF_PI;
      cover.translateZ(0.3);
    }
    cover.material = A.mats.paintIvory;
    refs.panels.push({ id: s.id, hinge, axis: s.axis, sign: s.sign, open: s.axis === 'x' ? -1.0 : 1.15 });
  });

  /* fasteners: instanced rivets distributed along authored hull seam rings */
  const rivet = new THREE.CylinderGeometry(0.014, 0.016, 0.008, 6);
  const seamX = [-2.8, -2.1, -1.2, 0.2, 1.3, 2.2, 3.0, 3.7];
  const perRing = 15;
  const total = seamX.length * perRing;
  const rivets = new THREE.InstancedMesh(rivet, A.mats.metalWarm, total);
  rivets.name = 'fastener_field';
  rivets.castShadow = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  const rows = resampleTable(HULL_STATIONS, 64);
  const findRow = (x) => rows.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a));
  let n = 0;
  seamX.forEach((x) => {
    const r = findRow(x);
    for (let i = 0; i < perRing; i++) {
      const a = -1.25 + (i / (perRing - 1)) * 2.5 + (rng() - 0.5) * 0.03;
      const pz = Math.sin(a), py = Math.cos(a);
      p.set(r[0] + (rng() - 0.5) * 0.02, r[3] + r[2] * py * 0.99, r[1] * pz * 0.99);
      e.set(0, Math.atan2(pz, py) + HALF_PI, -HALF_PI);
      q.setFromEuler(new THREE.Euler(Math.atan2(py, pz) - HALF_PI, 0, 0));
      m4.compose(p, q, s1);
      rivets.setMatrixAt(n++, m4);
    }
  });
  rivets.instanceMatrix.needsUpdate = true;
  g.add(rivets);

  /* recessed panel seams: instanced thin strips */
  const seamGeo = chamferedSlab(0.9, 0.018, 0.012, 0.004);
  const seamSpecs = [];
  seamX.forEach((x, i) => {
    const r = findRow(x);
    [1, -1].forEach((side) => {
      seamSpecs.push([r[0], r[3] + r[2] * 0.2, side * r[1] * 0.99, 0, 0, HALF_PI * side, 1.0]);
      seamSpecs.push([r[0], r[3] + r[2] * -0.3, side * r[1] * 0.985, 0, 0, HALF_PI * side, 0.7]);
    });
  });
  const seams = new THREE.InstancedMesh(seamGeo, A.mats.graphite, seamSpecs.length);
  seams.name = 'panel_seams';
  seams.castShadow = false;
  seamSpecs.forEach((sp, i) => {
    p.set(sp[0], sp[1], sp[2]);
    e.set(0, sp[5] > 0 ? 0 : Math.PI, HALF_PI);
    q.setFromEuler(e);
    m4.compose(p, q, s1.set(sp[6], 1, 1));
    seams.setMatrixAt(i, m4);
  });
  seams.instanceMatrix.needsUpdate = true;
  s1.set(1, 1, 1);
  g.add(seams);

  return g;
}

/* ------------------------------------------------------------------ */
/* hotspots                                                            */
/* ------------------------------------------------------------------ */

const HOTSPOT_SPECS = [
  { id: 'tilt-spindle', label: 'Tilt spindle', parent: 'nacelle_pivot_starboard', off: [0, 0.3, -0.4], dist: 2.6,
    text: 'Forged spindle and arc bracket carrying the whole nacelle. A pair of screwjacks drives the arc; the exposed toothed rim lets ground crews read tilt angle without power.' },
  { id: 'rotor-hub', label: 'Proprotor hub', parent: 'rotor_spin_port', off: [0, 0.45, 0], dist: 2.4,
    text: 'Five-blade articulated hub. Elastomeric cuffs take flap and lead-lag while the pitch links below the swashplate set collective and cyclic for both hover and cruise.' },
  { id: 'intake', label: 'Intake lip', parent: 'nacelle_body_starboard', off: [0, 0.66, 0.3], dist: 2.1,
    text: 'Anti-iced intake lip with an inset debris screen. The dark plenum behind it feeds the engine module through a splitter that dumps spray during water starts.' },
  { id: 'exhaust', label: 'Exhaust ring', parent: 'nacelle_body_port', off: [0, -0.95, 0.3], dist: 2.0,
    text: 'Ceramic-lined exhaust ring. In hover the efflux is turned outboard of the sponson so deck crews and the hoist cable stay out of the hot stream.' },
  { id: 'rescue-door', label: 'Rescue door', parent: 'rescue_door', off: [0.35, 0.1, 1.15], dist: 3.4,
    text: 'Powered sliding door on external rails. It runs aft and slightly outboard so the hoist arc clears the sill, and it interlocks with the winch to prevent a lowered basket behind a closed door.' },
  { id: 'winch', label: 'Rescue winch', parent: 'winch_arm', off: [0, 0.2, 0.5], dist: 2.4,
    text: 'Slewing hoist boom with a level-wind drum. The boom swings from stowed to outboard so the cable clears the sponson chine; the sheave head carries a cable-tension cut-out.' },
  { id: 'basket', label: 'Rescue basket', parent: 'rescue_basket', off: [0, 0.3, 0], dist: 2.0,
    text: 'Folding survivor basket with a buoyant collar. The bridle keeps the rim level under load and the mesh floor drains immediately after a water pick-up.' },
  { id: 'sensor', label: 'Sensor turret', parent: 'turret_pitch', off: [0.2, 0, 0], dist: 1.7,
    text: 'Two-axis gimballed turret with wide, narrow and thermal apertures. It scans automatically in search patterns and can be slaved to the hoist operator for manual pointing.' },
  { id: 'main-gear', label: 'Main gear', parent: 'gear_leg_main_starboard', off: [0, -0.35, 0], dist: 2.4,
    text: 'Trailing-arm main leg with a twin-chamber oleo and paired wheels for soft or damaged surfaces. It folds inboard into the sponson root once the bay doors are clear.' },
  { id: 'nose-gear', label: 'Nose gear', parent: 'gear_leg_nose', off: [0, -0.3, 0], dist: 2.0,
    text: 'Steerable, self-centring nose leg. Ground crews can free-castor it with a bypass pin for tight pad handling; the shortened stroke keeps the sensor turret clear of the deck.' },
  { id: 'sponson', label: 'Water sponson', parent: 'sponson_pivot_port', off: [0, 0.3, -0.6], dist: 3.0,
    text: 'Shallow buoyancy sponson with its own chine strake. Extended it gives roll stability on the water and shields the gear bay from spray; retracted it fairs flush for cruise.' },
  { id: 'chine', label: 'Hull chine', parent: 'chine_rail_starboard', off: [1.0, 0.05, 0.2], dist: 2.8,
    text: 'Spray rail along the hard chine. It throws water down and outboard so the proprotors stay dry during a taxi, and it doubles as the lifting point reference for beaching.' },
  { id: 'canopy', label: 'Cockpit canopy', parent: 'canopy_shell', off: [2.4, 1.1, 0], dist: 3.4,
    text: 'Curved tinted canopy in a graphite frame with two arch ribs. The forward ribs carry the crash-load path, and the sills double as rails for the sliding maintenance cover.' },
  { id: 'cabin', label: 'Cabin stretcher bay', parent: 'stretcher', off: [0, 0.35, 0], dist: 3.2,
    text: 'Single-stretcher casualty station with fold-down attendant seats. The recessed floor drains outboard, and the ceiling rails take both harness anchors and the litter lock.' },
  { id: 'wing-root', label: 'Wing carry-through', parent: 'wing_root_port', off: [0, 0.35, 0], dist: 3.0,
    text: 'Shoulder wing carry-through box. It routes the interconnect driveshaft between nacelles so a single engine can turn both proprotors, and it anchors the tilt actuator reaction load.' }
];

/* Exploded-view authoring: name -> direction + distance. */
const EXPLODE_SPECS = [
  ['nacelle_explode_starboard', [0.1, 0.55, 0.95], 1.5],
  ['nacelle_explode_port', [0.1, 0.55, -0.95], 1.5],
  ['sponson_explode_starboard', [-0.15, -0.5, 0.9], 1.2],
  ['sponson_explode_port', [-0.15, -0.5, -0.9], 1.2],
  ['gear_explode_main_starboard', [0, -0.85, 0.5], 1.0],
  ['gear_explode_main_port', [0, -0.85, -0.5], 1.0],
  ['gear_explode_nose', [0.75, -0.6, 0], 1.0],
  ['canopy_shell', [0.45, 0.9, 0], 1.3],
  ['door_explode', [-0.35, 0.1, 0.94], 1.1],
  ['turret_explode', [0.95, -0.3, 0], 1.0],
  ['winch_explode', [0, 0.75, 0.65], 1.0],
  ['wing_panel_starboard', [0, 1, 0.12], 0.7],
  ['wing_panel_port', [0, 1, -0.12], 0.7],
  ['panel_hinge_avionics', [0.3, 0.35, 0.85], 0.8],
  ['panel_hinge_hydraulics', [-0.3, 0.3, -0.85], 0.8],
  ['panel_hinge_gearbox', [0, 1, -0.3], 0.75]
];

/* ------------------------------------------------------------------ */
/* static draw-call reduction                                          */
/* ------------------------------------------------------------------ */

let _protectedNames = null;
function protectedNames() {
  if (!_protectedNames) {
    _protectedNames = new Set(REQUIRED_ASSEMBLIES.concat([
      'chine_rail_starboard', 'chine_rail_port', 'wing_root_port', 'wing_root_starboard',
      'rotor_disc_port', 'rotor_disc_starboard', 'hull_belly_band'
    ]));
  }
  return _protectedNames;
}

/**
 * Merge static sibling meshes that share a material into one mesh, baking their
 * transforms into the parent's space. Instanced meshes, protected names and
 * nested animated groups are never touched, so semantic lookups keep working.
 */
function mergeByMaterial(parent, { deep = false } = {}) {
  if (!parent) return 0;
  const guard = protectedNames();
  const buckets = new Map();
  const collect = (obj) => {
    for (const child of obj.children.slice()) {
      if (child.isInstancedMesh || guard.has(child.name)) continue;
      if (child.isMesh) {
        if (!buckets.has(child.material)) buckets.set(child.material, []);
        buckets.get(child.material).push(child);
      } else if (deep && child.isGroup) {
        collect(child);
      }
    }
  };
  collect(parent);

  parent.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const local = new THREE.Matrix4();
  let saved = 0;

  for (const [material, list] of buckets) {
    if (list.length < 2) continue;
    const parts = [];
    for (const m of list) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      m.updateMatrixWorld(true);
      g.applyMatrix4(local.multiplyMatrices(inv, m.matrixWorld));
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    if (!merged) continue;
    const out = new THREE.Mesh(merged, material);
    out.name = `${parent.name}_merged_${material.name || 'mat'}`;
    out.castShadow = list[0].castShadow;
    out.receiveShadow = list[0].receiveShadow;
    out.renderOrder = list[0].renderOrder;
    parent.add(out);
    for (const m of list) m.removeFromParent();
    saved += list.length - 1;
  }
  return saved;
}

const MERGE_PLAN = [
  ['canopy_shell', false], ['cockpit_interior', true], ['cabin_assembly', false],
  ['cabin_seat_hinge_0', false], ['cabin_seat_hinge_1', false],
  ['stretcher', false], ['rescue_basket', false],
  ['turret_pitch', false], ['turret_yaw', false], ['details', false],
  ['hull_placards', true], ['tail_chevrons', true],
  ['gear_leg_nose', true], ['gear_leg_main_starboard', true], ['gear_leg_main_port', true],
  ['sponson_pivot_starboard', false], ['sponson_pivot_port', false]
];

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

export function buildVehicle(A, rng) {
  const root = group('HX9_root', null, 0, 1.55, 0);
  const vib = group('vibration_carrier', root);
  const body = group('airframe', vib);

  const refs = {
    root, vibration: vib, airframe: body,
    nacelles: [], gear: [], sponsons: [], panels: [],
    navLights: [], beacons: [], interiorLights: [], statusLeds: [],
    exhaustGlows: [], antennas: [], panelDisplays: []
  };

  body.add(buildFuselage(A, rng, refs));
  buildCockpit(A, refs, body);
  buildCabin(A, refs, body);
  buildWings(A, refs, body);
  mirrorPair('nacelles', body, (holder, side, label) => buildNacelle(A, refs, holder, side, label));
  buildTail(A, refs, body);
  buildSponsons(A, refs, body);
  buildTurret(A, refs, body);
  const winch = buildWinch(A, refs, body);
  refs.winch = winch;
  buildDetails(A, rng, refs, body);

  const gearSpecs = [
    { id: 'nose', x: 3.0, y: -0.5, z: 0, len: 0.72, wheels: 2, track: 0.26, tyreR: 0.19, tyreW: 0.11,
      braceX: -0.2, axis: 'z', retractAngle: 1.5, doorZ: 0, doorLen: 0.9, doorW: 0.42, doorSide: 1, doorAngle: -1.5 },
    { id: 'main_starboard', x: -0.25, y: -0.46, z: 1.02, len: 0.9, wheels: 2, track: 0.3, tyreR: 0.24, tyreW: 0.14,
      braceX: 0.24, axis: 'x', retractAngle: -1.42, doorZ: 0.66, doorLen: 1.1, doorW: 0.5, doorSide: 1, doorAngle: 1.5 },
    { id: 'main_port', x: -0.25, y: -0.46, z: -1.02, len: 0.9, wheels: 2, track: 0.3, tyreR: 0.24, tyreW: 0.14,
      braceX: 0.24, axis: 'x', retractAngle: 1.42, doorZ: -0.66, doorLen: 1.1, doorW: 0.5, doorSide: -1, doorAngle: -1.5 }
  ];
  const gearHolder = group('landing_gear', body);
  gearSpecs.forEach((s) => buildGearLeg(A, refs, gearHolder, s));

  /* ---- static merge pass: fewer draw calls, identical silhouette ---- */
  let mergedAway = 0;
  for (const [name, deep] of MERGE_PLAN) {
    mergedAway += mergeByMaterial(root.getObjectByName(name), { deep });
  }
  refs.mergedDrawCallsSaved = mergedAway;

  /* ---- hotspot anchors + one instanced marker mesh ---- */
  const hotspots = [];
  HOTSPOT_SPECS.forEach((spec, i) => {
    const parent = root.getObjectByName(spec.parent);
    if (!parent) return;
    const anchor = new THREE.Object3D();
    anchor.name = `hotspot_${spec.id}`;
    anchor.position.fromArray(spec.off);
    parent.add(anchor);
    hotspots.push({ id: spec.id, label: spec.label, text: spec.text, anchor, dist: spec.dist, index: hotspots.length });
  });
  const markers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 10, 8), A.mats.hotspot, hotspots.length);
  markers.name = 'hotspot_markers';
  markers.castShadow = false;
  markers.receiveShadow = false;
  markers.frustumCulled = false;
  markers.renderOrder = 6;
  root.add(markers);

  /* ---- exploded-view groups with captured base positions ---- */
  const explodeGroups = [];
  EXPLODE_SPECS.forEach(([name, dir, dist]) => {
    const obj = root.getObjectByName(name);
    if (!obj) return;
    explodeGroups.push({
      name, obj, dist,
      dir: new THREE.Vector3().fromArray(dir).normalize(),
      base: obj.position.clone()
    });
  });

  refs.markers = markers;
  root.traverse((o) => { if (o.isMesh) o.frustumCulled = o.name !== 'hotspot_markers'; });

  return { root, refs, hotspots, explodeGroups };
}

export const REQUIRED_ASSEMBLIES = [
  'HX9_root', 'airframe', 'fuselage', 'fuselage_skin', 'cockpit_assembly', 'canopy_shell',
  'canopy_glass', 'cabin_assembly', 'rescue_door', 'wings', 'wing_skin_port', 'wing_skin_starboard',
  'nacelle_pivot_port', 'nacelle_pivot_starboard', 'rotor_spin_port', 'rotor_spin_starboard',
  'rotor_blades_port', 'rotor_blades_starboard', 'landing_gear', 'gear_leg_nose',
  'gear_leg_main_port', 'gear_leg_main_starboard', 'sponson_pivot_port', 'sponson_pivot_starboard',
  'winch_arm', 'winch_cable', 'rescue_basket', 'turret_yaw', 'turret_pitch', 'tail_assembly',
  'stretcher', 'hotspot_markers'
];
