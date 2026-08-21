/**
 * Asterion HX-9 — procedural material + texture library.
 * All markings, roughness variation and environment data are generated at
 * runtime from a fixed seed. No external assets, no base64 blobs.
 */
import * as THREE from 'three';

export const SEED_STRING = 'HX9-FABLE-PROBE';

/** Deterministic FNV-1a seeded mulberry32. */
export function makeRng(seed = SEED_STRING) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let s = h >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTE = {
  ivory: '#e7e2d6',
  ivoryDim: '#cdc7ba',
  orange: '#dd611c',
  orangeDeep: '#a8420f',
  graphite: '#23272b',
  graphiteLight: '#3a4046',
  cyan: '#59dcf2',
  amber: '#f0a63c'
};

const FONT = '"Arial Narrow", "Helvetica Neue", Arial, Helvetica, sans-serif';

function mkCanvas(w, h, fill) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
  }
  return { c, ctx };
}

/** Letter-spaced technical lettering; returns drawn width. */
function techText(ctx, text, x, y, o = {}) {
  const size = o.size || 40;
  const weight = o.weight || 700;
  const spacing = o.spacing == null ? size * 0.14 : o.spacing;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  let w = -spacing;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  let cx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  ctx.fillStyle = o.color || PALETTE.ivory;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return w;
}

/* ------------------------------------------------------------------ *
 * Individual procedural textures
 * ------------------------------------------------------------------ */

function texWordmark() {
  const { c, ctx } = mkCanvas(1024, 256);
  ctx.save();
  ctx.translate(112, 128);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const px = Math.cos(a) * 78;
    const py = Math.sin(a) * 78;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.lineWidth = 12;
  ctx.strokeStyle = PALETTE.orange;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-38, 26);
  ctx.lineTo(0, -34);
  ctx.lineTo(38, 26);
  ctx.lineTo(18, 26);
  ctx.lineTo(0, -2);
  ctx.lineTo(-18, 26);
  ctx.closePath();
  ctx.fillStyle = PALETTE.ivory;
  ctx.fill();
  ctx.restore();

  techText(ctx, 'ASTERION', 226, 118, { size: 84, color: PALETTE.ivory, spacing: 12 });
  techText(ctx, 'HX-9', 226, 208, { size: 76, color: PALETTE.orange, spacing: 8 });
  ctx.fillStyle = PALETTE.cyan;
  ctx.fillRect(452, 150, 292, 6);
  techText(ctx, 'AMPHIBIOUS RESCUE TILTROTOR', 452, 208, {
    size: 28,
    weight: 600,
    color: PALETTE.ivoryDim,
    spacing: 5
  });
  return c;
}

function texChevron() {
  const { c, ctx } = mkCanvas(512, 128);
  for (let i = -1; i < 8; i++) {
    ctx.beginPath();
    const x = i * 76;
    ctx.moveTo(x, 128);
    ctx.lineTo(x + 46, 0);
    ctx.lineTo(x + 90, 0);
    ctx.lineTo(x + 44, 128);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? PALETTE.orangeDeep : PALETTE.orange;
    ctx.fill();
  }
  return c;
}

function texCaution() {
  const { c, ctx } = mkCanvas(512, 96, PALETTE.graphite);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 512, 96);
  ctx.clip();
  for (let i = -2; i < 14; i++) {
    ctx.beginPath();
    const x = i * 44;
    ctx.moveTo(x, 96);
    ctx.lineTo(x + 26, 0);
    ctx.lineTo(x + 50, 0);
    ctx.lineTo(x + 24, 96);
    ctx.closePath();
    ctx.fillStyle = PALETTE.amber;
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(20,22,25,0.9)';
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, 512, 96);
  return c;
}

function texDoorArrow() {
  const { c, ctx } = mkCanvas(512, 256);
  ctx.strokeStyle = PALETTE.orange;
  ctx.lineWidth = 9;
  ctx.strokeRect(16, 16, 480, 224);
  ctx.fillStyle = PALETTE.orange;
  ctx.beginPath();
  ctx.moveTo(56, 128);
  ctx.lineTo(146, 62);
  ctx.lineTo(146, 100);
  ctx.lineTo(238, 100);
  ctx.lineTo(238, 156);
  ctx.lineTo(146, 156);
  ctx.lineTo(146, 194);
  ctx.closePath();
  ctx.fill();
  techText(ctx, 'RESCUE ACCESS', 270, 112, { size: 36, color: PALETTE.ivory, spacing: 4 });
  techText(ctx, 'LIFT HANDLE — SLIDE AFT', 270, 156, {
    size: 21,
    weight: 600,
    color: PALETTE.ivoryDim,
    spacing: 3
  });
  techText(ctx, 'HX-9 / DR-2', 270, 200, { size: 20, weight: 600, color: PALETTE.cyan, spacing: 3 });
  return c;
}

function texLabel(lines, o = {}) {
  const { c, ctx } = mkCanvas(512, 256);
  if (o.plate) {
    ctx.fillStyle = 'rgba(28,31,35,0.9)';
    ctx.fillRect(8, 8, 496, 240);
    ctx.strokeStyle = 'rgba(168,176,183,0.75)';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, 496, 240);
  }
  lines.forEach((line, i) => {
    techText(ctx, line, 256, i === 0 ? 118 : 186, {
      size: i === 0 ? 62 : 34,
      weight: i === 0 ? 700 : 600,
      align: 'center',
      color: i === 0 ? o.color || PALETTE.graphite : o.sub || PALETTE.ivoryDim,
      spacing: 4
    });
  });
  return c;
}

function texNacelleWarn() {
  const { c, ctx } = mkCanvas(1024, 128);
  ctx.fillStyle = 'rgba(24,27,30,0.95)';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = PALETTE.amber;
  ctx.fillRect(0, 6, 1024, 5);
  ctx.fillRect(0, 117, 1024, 5);
  for (let i = 0; i < 2; i++) {
    techText(ctx, 'ROTOR HAZARD — STAND CLEAR', 34 + i * 512, 58, {
      size: 32,
      color: PALETTE.amber,
      spacing: 4
    });
    techText(ctx, 'EXHAUST HOT · PIVOT LOCK P-4', 34 + i * 512, 98, {
      size: 22,
      weight: 600,
      color: PALETTE.ivoryDim,
      spacing: 3
    });
  }
  return c;
}

function texPaintRough(rng) {
  const { c, ctx } = mkCanvas(512, 512, '#8c8c8c');
  for (let i = 0; i < 420; i++) {
    const x = rng() * 512;
    const y = rng() * 512;
    const r = 6 + rng() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = 118 + Math.floor(rng() * 44);
    g.addColorStop(0, `rgba(${v},${v},${v},0.3)`);
    g.addColorStop(1, 'rgba(140,140,140,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(176,176,176,0.4)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo((i * 512) / 8, 0);
    ctx.lineTo((i * 512) / 8, 512);
    ctx.moveTo(0, (i * 512) / 8);
    ctx.lineTo(512, (i * 512) / 8);
    ctx.stroke();
  }
  return c;
}

function texWear(rng) {
  const { c, ctx } = mkCanvas(512, 512);
  for (let i = 0; i < 90; i++) {
    const x = rng() * 512;
    const y = 300 + rng() * 200;
    ctx.strokeStyle = `rgba(58,62,66,${0.05 + rng() * 0.09})`;
    ctx.lineWidth = 1 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 40, y + 40 + rng() * 120);
    ctx.stroke();
  }
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(96,100,104,${0.04 + rng() * 0.06})`;
    ctx.beginPath();
    ctx.ellipse(rng() * 512, rng() * 512, 8 + rng() * 30, 4 + rng() * 12, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function texDisc() {
  const { c, ctx } = mkCanvas(512, 512);
  const g = ctx.createRadialGradient(256, 256, 60, 256, 256, 250);
  g.addColorStop(0, 'rgba(28,31,35,0)');
  g.addColorStop(0.45, 'rgba(34,38,42,0.3)');
  g.addColorStop(0.88, 'rgba(52,57,62,0.42)');
  g.addColorStop(1, 'rgba(52,57,62,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(226,222,212,0.16)';
  for (let i = 0; i < 5; i++) {
    ctx.lineWidth = 6;
    ctx.beginPath();
    const a = (i / 5) * Math.PI * 2;
    ctx.moveTo(256 + Math.cos(a) * 70, 256 + Math.sin(a) * 70);
    ctx.lineTo(256 + Math.cos(a) * 244, 256 + Math.sin(a) * 244);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(221,97,28,0.35)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(256, 256, 238, 0, Math.PI * 2);
  ctx.stroke();
  return c;
}

function texHotspot() {
  const { c, ctx } = mkCanvas(128, 128);
  ctx.strokeStyle = 'rgba(16,22,26,0.85)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 64, 47, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(89,220,242,0.95)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(64, 64, 42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(231,226,214,0.95)';
  ctx.beginPath();
  ctx.arc(64, 64, 11, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function texFloor(rng) {
  const { c, ctx } = mkCanvas(1024, 1024, '#3b3d40');
  for (let gx = 0; gx < 4; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      const v = 52 + Math.floor(rng() * 12);
      ctx.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
      ctx.fillRect(gx * 256 + 3, gy * 256 + 3, 250, 250);
      for (let i = 0; i < 70; i++) {
        const s = 2 + rng() * 9;
        ctx.fillStyle = `rgba(${v + 26},${v + 26},${v + 28},${0.05 + rng() * 0.12})`;
        ctx.fillRect(gx * 256 + rng() * 250, gy * 256 + rng() * 250, s, s);
      }
    }
  }
  ctx.strokeStyle = 'rgba(20,22,24,0.9)';
  ctx.lineWidth = 6;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 256, 0);
    ctx.lineTo(i * 256, 1024);
    ctx.moveTo(0, i * 256);
    ctx.lineTo(1024, i * 256);
    ctx.stroke();
  }
  return c;
}

function texPad() {
  const { c, ctx } = mkCanvas(1024, 1024);
  ctx.save();
  ctx.translate(512, 512);
  ctx.strokeStyle = 'rgba(221,97,28,0.72)';
  ctx.lineWidth = 16;
  ctx.setLineDash([56, 34]);
  ctx.beginPath();
  ctx.arc(0, 0, 430, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(231,226,214,0.5)';
  ctx.beginPath();
  ctx.arc(0, 0, 340, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate((Math.PI / 2) * i);
    ctx.strokeStyle = 'rgba(231,226,214,0.62)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(180, -300);
    ctx.lineTo(300, -300);
    ctx.lineTo(300, -180);
    ctx.stroke();
    ctx.restore();
  }
  techText(ctx, 'PAD 03', 0, -50, {
    size: 96,
    align: 'center',
    color: 'rgba(231,226,214,0.58)',
    spacing: 14
  });
  techText(ctx, 'AMPHIB · MAX 9.4 t', 0, 30, {
    size: 44,
    weight: 600,
    align: 'center',
    color: 'rgba(221,97,28,0.6)',
    spacing: 6
  });
  ctx.restore();
  return c;
}

function texWall(rng) {
  const { c, ctx } = mkCanvas(1024, 512, '#2c3034');
  for (let i = 0; i < 32; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(58,64,70,0.55)' : 'rgba(34,38,42,0.55)';
    ctx.fillRect(i * 32, 0, 26, 512);
  }
  ctx.fillStyle = 'rgba(20,23,26,0.8)';
  ctx.fillRect(0, 0, 1024, 14);
  ctx.fillRect(0, 498, 1024, 14);
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(90,96,102,${0.03 + rng() * 0.05})`;
    ctx.fillRect(rng() * 1024, rng() * 512, 3 + rng() * 18, 2 + rng() * 5);
  }
  techText(ctx, 'BAY 3 · SEA RESCUE', 40, 120, {
    size: 58,
    color: 'rgba(150,158,166,0.45)',
    spacing: 8
  });
  return c;
}

function texSky() {
  const { c, ctx } = mkCanvas(1024, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#0a1424');
  g.addColorStop(0.42, '#22364f');
  g.addColorStop(0.66, '#4b5f74');
  g.addColorStop(0.82, '#9a6f4b');
  g.addColorStop(0.92, '#c8834a');
  g.addColorStop(1, '#141d26');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  const glow = ctx.createRadialGradient(700, 420, 10, 700, 420, 300);
  glow.addColorStop(0, 'rgba(255,196,128,0.55)');
  glow.addColorStop(1, 'rgba(255,196,128,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1024, 512);
  return c;
}

function texWater(rng) {
  const { c, ctx } = mkCanvas(512, 512, '#12212c');
  for (let i = 0; i < 900; i++) {
    const y = rng() * 512;
    const w = 10 + rng() * 90;
    const a = 0.02 + rng() * 0.07 * (1 - y / 512);
    ctx.fillStyle = `rgba(${150 + Math.floor(rng() * 60)},160,150,${a})`;
    ctx.fillRect(rng() * 512, y, w, 1 + rng() * 2);
  }
  return c;
}

/* ------------------------------------------------------------------ *
 * Material library
 * ------------------------------------------------------------------ */

export function createMaterials(renderer) {
  const rng = makeRng(SEED_STRING + '/materials');
  const aniso = renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;
  const textures = [];

  const wrapTex = (canvas, o = {}) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = o.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    if (o.repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(o.repeat[0], o.repeat[1]);
    }
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    textures.push(t);
    return t;
  };

  const skyTex = wrapTex(texSky());
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(skyTex).texture;
  pmrem.dispose();

  const T = {
    sky: skyTex,
    rough: wrapTex(texPaintRough(rng), { data: true, repeat: [3, 3] }),
    wear: wrapTex(texWear(rng)),
    wordmark: wrapTex(texWordmark()),
    chevron: wrapTex(texChevron()),
    caution: wrapTex(texCaution()),
    doorArrow: wrapTex(texDoorArrow()),
    nacelleWarn: wrapTex(texNacelleWarn()),
    labelNoStep: wrapTex(texLabel(['NO STEP', 'PANEL S-7'])),
    labelLift: wrapTex(texLabel(['LIFT POINT', 'RATED 2.4 t'], { plate: true, color: PALETTE.ivory })),
    labelSvc: wrapTex(texLabel(['SVC ACCESS', 'HYD A3 · 190 bar'], { plate: true, color: PALETTE.ivory })),
    labelPitot: wrapTex(texLabel(['DO NOT COVER', 'PROBE HEAT'], { plate: true, color: PALETTE.amber })),
    panelId: wrapTex(texLabel(['P-14', 'HX-9 STA 4.2'])),
    disc: wrapTex(texDisc()),
    hotspot: wrapTex(texHotspot()),
    floor: wrapTex(texFloor(rng), { repeat: [5, 5] }),
    pad: wrapTex(texPad()),
    wall: wrapTex(texWall(rng), { repeat: [4, 1] }),
    water: wrapTex(texWater(rng), { repeat: [3, 1] })
  };

  const mats = {};
  const reg = (name, m) => {
    m.name = name;
    mats[name] = m;
    return m;
  };

  const Std = THREE.MeshStandardMaterial;
  const Phys = THREE.MeshPhysicalMaterial;

  reg('paintIvory', new Std({
    color: 0xd9d4c6, roughness: 0.62, metalness: 0.08, roughnessMap: T.rough, envMapIntensity: 1.0
  }));
  reg('paintOrange', new Std({
    color: 0xc2521a, roughness: 0.55, metalness: 0.08, roughnessMap: T.rough, envMapIntensity: 1.0
  }));
  reg('paintGraphite', new Std({
    color: 0x24282d, roughness: 0.62, metalness: 0.24, roughnessMap: T.rough, envMapIntensity: 1.1
  }));
  reg('metalBare', new Std({ color: 0x8f969d, roughness: 0.34, metalness: 0.95, envMapIntensity: 1.2 }));
  reg('metalDark', new Std({ color: 0x33383d, roughness: 0.44, metalness: 0.86, envMapIntensity: 1.1 }));
  reg('mech', new Std({ color: 0x1b1e21, roughness: 0.52, metalness: 0.7, envMapIntensity: 0.9 }));
  reg('rubber', new Std({ color: 0x13151a, roughness: 0.94, metalness: 0.02 }));
  reg('fabric', new Std({ color: 0x38414d, roughness: 0.95, metalness: 0.0 }));
  reg('fabricWarm', new Std({ color: 0x6d5442, roughness: 0.94, metalness: 0.0 }));
  reg('cavity', new Std({ color: 0x0a0c0e, roughness: 1.0, metalness: 0.1, side: THREE.BackSide }));
  reg('interior', new Std({ color: 0x2a2f34, roughness: 0.8, metalness: 0.15, side: THREE.DoubleSide }));
  reg('glass', new Phys({
    color: 0x9dc0cc, roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.36,
    side: THREE.DoubleSide, depthWrite: false, ior: 1.46, envMapIntensity: 1.6,
    clearcoat: 1.0, clearcoatRoughness: 0.04
  }));
  reg('lens', new Phys({
    color: 0x0a1216, roughness: 0.05, metalness: 0.2, clearcoat: 1.0, envMapIntensity: 1.8
  }));

  const emissive = (name, color, intensity, base) =>
    reg(name, new Std({
      color: base != null ? base : 0x05080a, emissive: color, emissiveIntensity: intensity,
      roughness: 0.4, metalness: 0.0, toneMapped: true
    }));
  emissive('emCyan', 0x53d8f0, 1.5);
  emissive('emStatus', 0x8ff0c2, 1.2);
  emissive('emRed', 0xff2f3a, 1.6);
  emissive('emGreen', 0x2fff86, 1.6);
  emissive('emStrobe', 0xffffff, 1.4);
  emissive('emBeacon', 0xff3b2a, 1.4);
  emissive('emCabin', 0xffd9a8, 1.0, 0x2a241d);
  emissive('emPanel', 0x6fe0ff, 1.1, 0x08131a);
  emissive('emExhaust', 0xff7a3c, 0.35, 0x1a0f0a);

  // Blade material fades toward a motion disc at speed.
  reg('blade', new Std({
    color: 0x2b3035, roughness: 0.5, metalness: 0.35, roughnessMap: T.rough,
    transparent: true, opacity: 1.0
  }));
  reg('disc', new Std({
    map: T.disc, transparent: true, opacity: 0.0, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide, depthWrite: false
  }));

  const decal = (name, map, o = {}) =>
    reg(name, new Std({
      map, transparent: true, roughness: 0.55, metalness: 0.05, roughnessMap: T.rough,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      depthWrite: false, opacity: o.opacity == null ? 1 : o.opacity, side: THREE.FrontSide
    }));
  decal('decalWordmark', T.wordmark);
  decal('decalChevron', T.chevron);
  decal('decalCaution', T.caution);
  decal('decalDoor', T.doorArrow);
  decal('decalNoStep', T.labelNoStep);
  decal('decalLift', T.labelLift);
  decal('decalSvc', T.labelSvc);
  decal('decalPitot', T.labelPitot);
  decal('decalPanelId', T.panelId);
  decal('decalWear', T.wear, { opacity: 0.85 });
  reg('decalNacelle', new Std({
    map: T.nacelleWarn, roughness: 0.6, metalness: 0.1, transparent: true,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, depthWrite: false
  }));

  // scene / hangar
  reg('floor', new Std({ color: 0x9a9a9a, map: T.floor, roughness: 0.78, metalness: 0.1, envMapIntensity: 0.5 }));
  reg('pad', new Std({
    map: T.pad, transparent: true, roughness: 0.85, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, depthWrite: false
  }));
  reg('wall', new Std({ color: 0x8d949a, map: T.wall, roughness: 0.7, metalness: 0.35, envMapIntensity: 0.5 }));
  reg('beam', new Std({ color: 0x353a40, roughness: 0.6, metalness: 0.5, envMapIntensity: 0.5 }));
  reg('prop', new Std({ color: 0x4a4f55, roughness: 0.72, metalness: 0.3 }));
  reg('propOrange', new Std({ color: 0x8d4718, roughness: 0.7, metalness: 0.15 }));
  reg('water', new Std({
    color: 0x22323d, map: T.water, roughness: 0.16, metalness: 0.5, envMapIntensity: 1.4
  }));
  reg('sky', new THREE.MeshBasicMaterial({ map: T.sky, toneMapped: true, side: THREE.DoubleSide }));
  reg('hotspot', new THREE.SpriteMaterial({
    map: T.hotspot, transparent: true, depthTest: true, depthWrite: false, opacity: 0.95
  }));

  for (const key of Object.keys(mats)) {
    const m = mats[key];
    if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) m.envMap = env;
  }

  const dispose = () => {
    for (const t of textures) t.dispose();
    for (const key of Object.keys(mats)) mats[key].dispose();
    env.dispose();
  };

  return { mats, textures: T, env, dispose, aniso, rngSeed: SEED_STRING };
}
