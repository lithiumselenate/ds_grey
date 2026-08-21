/**
 * materials.js — deterministic procedural texture + PBR material library
 * for the Asterion HX-9 Amphibious Rescue Tiltrotor.
 *
 * Everything visible here is generated at runtime from the fixed seed string
 * "HX9-FABLE-PROBE". No external images, fonts or binary blobs are used.
 */

import * as THREE from 'three';

export const SEED_STRING = 'HX9-FABLE-PROBE';

/** FNV-1a style string hash -> uint32. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small, fast, fully deterministic PRNG (mulberry32). */
export function makeRNG(seedString = SEED_STRING) {
  let a = hashSeed(seedString) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTE = {
  ivory: 0xe6e2d7,
  ivoryShadow: 0xcfcabd,
  orange: 0xef5f16,
  orangeDeep: 0xc2410a,
  graphite: 0x24282d,
  graphiteLight: 0x3a4046,
  metal: 0x9ea6ad,
  metalWarm: 0xb0a294,
  rubber: 0x121417,
  glass: 0x1d2c33,
  fabric: 0x353b44,
  lens: 0x080f13,
  cyan: 0x4fd6ef,
  amber: 0xf2a33c,
  red: 0xff3b30,
  green: 0x2fe08a,
  deck: 0x2c3035
};

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  return { c, ctx };
}

function hairline(ctx, x0, y0, x1, y1, w, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Diagonal hazard band used on nacelles, gear bays and the door sill. */
function hazardBand(ctx, x, y, w, h, pitch, a, b) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = a;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = b;
  for (let i = -h; i < w + h; i += pitch * 2) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + pitch, y + h);
    ctx.lineTo(x + i + pitch + h, y);
    ctx.lineTo(x + i + h, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function stencilText(ctx, text, x, y, size, color, spacing, weight) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${weight || 700} ${size}px ${size > 30 ? 'sans-serif' : 'monospace'}`;
  ctx.textBaseline = 'middle';
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + (spacing || 0);
  }
  ctx.restore();
  return cx - x;
}

/** Soft, seeded blotches: used for wear and roughness break-up. */
function blotches(ctx, rng, count, w, h, maxR, color) {
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = maxR * (0.25 + rng() * 0.75);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
}

/* ------------------------------------------------------------------ */
/* asset library                                                       */
/* ------------------------------------------------------------------ */

export class Assets {
  constructor(rng, maxAnisotropy) {
    this.rng = rng;
    this.aniso = Math.min(8, Math.max(1, maxAnisotropy || 1));
    this.textures = [];
    this.materials = [];
    this.tex = {};
    this.mats = {};
    this._buildTextures();
    this._buildMaterials();
  }

  _track(t, srgb, repeatX, repeatY) {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = this.aniso;
    if (repeatX) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeatX, repeatY || repeatX);
    }
    t.needsUpdate = true;
    this.textures.push(t);
    return t;
  }

  _reg(name, material) {
    material.name = name;
    this.materials.push(material);
    this.mats[name] = material;
    return material;
  }

  /* ---------------- textures ---------------- */

  _buildTextures() {
    const rng = this.rng;
    const T = this.tex;

    /* Painted-composite micro roughness: gentle panel break-up, never dirty. */
    {
      const { c, ctx } = canvas2d(512, 512);
      ctx.fillStyle = '#7c7c7c';
      ctx.fillRect(0, 0, 512, 512);
      blotches(ctx, rng, 90, 512, 512, 70, 'rgba(255,255,255,0.10)');
      blotches(ctx, rng, 70, 512, 512, 44, 'rgba(0,0,0,0.10)');
      for (let i = 0; i < 26; i++) {
        const y = Math.floor(rng() * 512);
        hairline(ctx, 0, y, 512, y, 1, 'rgba(0,0,0,0.06)');
      }
      T.paintRough = this._track(new THREE.CanvasTexture(c), false, 3, 3);
    }

    /* Brushed metal roughness. */
    {
      const { c, ctx } = canvas2d(512, 512);
      ctx.fillStyle = '#5a5a5a';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 900; i++) {
        const y = rng() * 512;
        const l = 60 + rng() * 300;
        const x = rng() * 512;
        hairline(ctx, x, y, x + l, y + (rng() - 0.5) * 2, 0.8,
          rng() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
      }
      T.metalRough = this._track(new THREE.CanvasTexture(c), false, 2, 2);
    }

    /* Fuselage side placard: original wordmark + rescue block. */
    {
      const { c, ctx } = canvas2d(1024, 256);
      ctx.clearRect(0, 0, 1024, 256);
      stencilText(ctx, 'ASTERION', 26, 78, 62, '#20252b', 12, 500);
      ctx.fillStyle = '#ef5f16';
      ctx.fillRect(26, 116, 470, 7);
      stencilText(ctx, 'HX-9', 30, 176, 92, '#ef5f16', 6, 800);
      stencilText(ctx, 'AMPHIBIOUS RESCUE TILTROTOR', 250, 156, 22, '#2a3138', 3, 600);
      stencilText(ctx, 'SERIAL HX9-0007 · COASTAL WING 4', 250, 196, 17, '#4a5560', 2, 500);
      /* small original geometric mark: three stacked chevrons in a ring */
      ctx.save();
      ctx.translate(880, 128);
      ctx.strokeStyle = '#20252b';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(0, 0, 74, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = '#ef5f16';
      ctx.lineWidth = 13;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-40, 20 - i * 30);
        ctx.lineTo(0, -12 - i * 30 + 22);
        ctx.lineTo(40, 20 - i * 30);
        ctx.stroke();
      }
      ctx.restore();
      T.wordmark = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Rescue chevron band for the tail and door. */
    {
      const { c, ctx } = canvas2d(512, 128);
      ctx.clearRect(0, 0, 512, 128);
      ctx.fillStyle = '#ef5f16';
      for (let i = -1; i < 7; i++) {
        const x = i * 76;
        ctx.beginPath();
        ctx.moveTo(x, 128);
        ctx.lineTo(x + 44, 0);
        ctx.lineTo(x + 76, 0);
        ctx.lineTo(x + 32, 128);
        ctx.closePath();
        ctx.fill();
      }
      T.chevrons = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Nacelle caution wrap. */
    {
      const { c, ctx } = canvas2d(1024, 128);
      ctx.clearRect(0, 0, 1024, 128);
      hazardBand(ctx, 0, 0, 1024, 44, 22, '#f2a33c', '#20252b');
      hazardBand(ctx, 0, 96, 1024, 32, 22, '#f2a33c', '#20252b');
      ctx.fillStyle = 'rgba(20,24,28,0.86)';
      ctx.fillRect(0, 46, 1024, 48);
      stencilText(ctx, 'CAUTION · PROPROTOR ARC · KEEP CLEAR WHEN LIT', 24, 70, 24, '#ffd9a8', 3, 700);
      stencilText(ctx, 'DUCT INTAKE · FOD SCREEN CHECK BEFORE START', 560, 70, 18, '#9fb0bb', 2, 500);
      T.nacelleWarn = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Rescue door graphics: arrow, latch instruction, load placard. */
    {
      const { c, ctx } = canvas2d(512, 512);
      ctx.clearRect(0, 0, 512, 512);
      hazardBand(ctx, 0, 470, 512, 42, 18, '#ef5f16', '#f0ebe0');
      ctx.save();
      ctx.strokeStyle = '#20252b';
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.moveTo(392, 96);
      ctx.lineTo(120, 96);
      ctx.stroke();
      ctx.fillStyle = '#20252b';
      ctx.beginPath();
      ctx.moveTo(96, 96);
      ctx.lineTo(150, 62);
      ctx.lineTo(150, 130);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      stencilText(ctx, 'RESCUE DOOR', 96, 168, 40, '#20252b', 5, 700);
      stencilText(ctx, 'SLIDE AFT TO OPEN', 100, 212, 22, '#3c454e', 3, 600);
      stencilText(ctx, 'HOIST STATION · 272 kg', 100, 268, 20, '#c2410a', 2, 700);
      stencilText(ctx, 'DO NOT OPEN ABOVE 90 kt', 100, 300, 17, '#4a5560', 2, 500);
      ctx.strokeStyle = 'rgba(32,37,43,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeRect(88, 40, 336, 300);
      T.doorDecal = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Maintenance label sheet (port aft) + panel identifiers. */
    {
      const { c, ctx } = canvas2d(512, 512);
      ctx.clearRect(0, 0, 512, 512);
      const rows = [
        ['SVC-A2', 'HYDRAULIC ACCESS · 210 bar'],
        ['SVC-B1', 'TILT ACTUATOR GREASE POINT'],
        ['SVC-C4', 'BILGE DRAIN · CHECK AFTER WATER OPS'],
        ['GND-01', 'BONDING POINT BEFORE FUELLING'],
        ['NO STEP', 'COMPOSITE SKIN · WALK ON RAILS ONLY'],
        ['P-14/L', 'PANEL SET 14 PORT · 26 FASTENERS']
      ];
      rows.forEach((r, i) => {
        const y = 44 + i * 80;
        ctx.fillStyle = 'rgba(240,236,228,0.9)';
        ctx.fillRect(24, y - 26, 464, 60);
        ctx.fillStyle = '#ef5f16';
        ctx.fillRect(24, y - 26, 8, 60);
        stencilText(ctx, r[0], 46, y - 6, 26, '#20252b', 2, 700);
        stencilText(ctx, r[1], 46, y + 20, 15, '#49525b', 1, 500);
      });
      T.labels = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Asymmetric operational wear (starboard lower hull only). */
    {
      const { c, ctx } = canvas2d(512, 256);
      ctx.clearRect(0, 0, 512, 256);
      blotches(ctx, rng, 26, 512, 256, 58, 'rgba(74,84,92,0.20)');
      blotches(ctx, rng, 14, 512, 256, 30, 'rgba(120,104,84,0.16)');
      for (let i = 0; i < 22; i++) {
        const x = rng() * 512;
        const y = 90 + rng() * 150;
        hairline(ctx, x, y, x + 20 + rng() * 60, y + (rng() - 0.5) * 8, 1 + rng(), 'rgba(60,68,74,0.18)');
      }
      T.wear = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Rotor motion disc: soft radial banding, additive. */
    {
      const { c, ctx } = canvas2d(512, 512);
      const g = ctx.createRadialGradient(256, 256, 40, 256, 256, 256);
      g.addColorStop(0.0, 'rgba(150,170,180,0.00)');
      g.addColorStop(0.55, 'rgba(160,180,190,0.10)');
      g.addColorStop(0.88, 'rgba(190,205,214,0.22)');
      g.addColorStop(0.97, 'rgba(226,236,240,0.34)');
      g.addColorStop(1.0, 'rgba(226,236,240,0.0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = 'rgba(239,95,22,0.5)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(256, 256, 240, 0, TAU);
      ctx.stroke();
      T.motionDisc = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Hangar deck: segmented slabs, joints, pad ring and original pad mark. */
    {
      const { c, ctx } = canvas2d(1024, 1024);
      ctx.fillStyle = '#3a3f45';
      ctx.fillRect(0, 0, 1024, 1024);
      blotches(ctx, rng, 120, 1024, 1024, 130, 'rgba(255,255,255,0.045)');
      blotches(ctx, rng, 80, 1024, 1024, 90, 'rgba(0,0,0,0.06)');
      ctx.strokeStyle = 'rgba(18,20,23,0.85)';
      ctx.lineWidth = 6;
      for (let i = 0; i <= 4; i++) {
        const p = (i / 4) * 1024;
        hairline(ctx, p, 0, p, 1024, 6, 'rgba(18,20,23,0.8)');
        hairline(ctx, 0, p, 1024, p, 6, 'rgba(18,20,23,0.8)');
      }
      for (let i = 0; i < 60; i++) {
        const x = rng() * 1024;
        const y = rng() * 1024;
        hairline(ctx, x, y, x + 30 + rng() * 90, y + (rng() - 0.5) * 6, 1.2, 'rgba(0,0,0,0.10)');
      }
      /* landing pad: dashed ring + original triple-chevron mark + designator */
      ctx.save();
      ctx.translate(512, 512);
      ctx.setLineDash([34, 22]);
      ctx.strokeStyle = 'rgba(240,236,228,0.62)';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(0, 0, 404, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(239,95,22,0.55)';
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.arc(0, 0, 336, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,236,228,0.5)';
      ctx.lineWidth = 20;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-120, 40 + i * 70);
        ctx.lineTo(0, -40 + i * 70);
        ctx.lineTo(120, 40 + i * 70);
        ctx.stroke();
      }
      ctx.restore();
      stencilText(ctx, 'PAD 04 · RESCUE', 372, 856, 40, 'rgba(240,236,228,0.45)', 5, 700);
      T.deck = this._track(new THREE.CanvasTexture(c), true, 1, 1);
    }

    /* Rear service wall panels. */
    {
      const { c, ctx } = canvas2d(1024, 512);
      ctx.fillStyle = '#4a5158';
      ctx.fillRect(0, 0, 1024, 512);
      for (let i = 0; i < 16; i++) {
        const x = i * 64;
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.05)';
        ctx.fillRect(x, 0, 64, 512);
        hairline(ctx, x, 0, x, 512, 3, 'rgba(16,18,21,0.55)');
      }
      hairline(ctx, 0, 122, 1024, 122, 5, 'rgba(16,18,21,0.5)');
      hairline(ctx, 0, 372, 1024, 372, 5, 'rgba(16,18,21,0.5)');
      hazardBand(ctx, 0, 470, 1024, 42, 26, '#c9a24a', '#2a2e33');
      blotches(ctx, rng, 60, 1024, 512, 120, 'rgba(0,0,0,0.05)');
      stencilText(ctx, 'BAY 4 · TILTROTOR SERVICE', 40, 200, 44, 'rgba(226,232,236,0.30)', 6, 700);
      T.wall = this._track(new THREE.CanvasTexture(c), true, 2, 1);
    }

    /* Exterior opening: dusk sky over water. */
    {
      const { c, ctx } = canvas2d(1024, 512);
      const g = ctx.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0.0, '#16273a');
      g.addColorStop(0.34, '#3d5670');
      g.addColorStop(0.52, '#8c7a72');
      g.addColorStop(0.6, '#d78a4c');
      g.addColorStop(0.63, '#5d6f7d');
      g.addColorStop(1.0, '#1b2b36');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1024, 512);
      /* horizon haze + water glitter, seeded */
      ctx.fillStyle = 'rgba(255,196,140,0.16)';
      ctx.fillRect(0, 316, 1024, 10);
      for (let i = 0; i < 420; i++) {
        const y = 330 + Math.pow(rng(), 1.7) * 180;
        const x = rng() * 1024;
        const w = 4 + rng() * 26 * (y - 320) / 180;
        ctx.fillStyle = `rgba(226,208,190,${0.05 + rng() * 0.16})`;
        ctx.fillRect(x, y, w, 1.6);
      }
      for (let i = 0; i < 40; i++) {
        const x = rng() * 1024;
        const y = 40 + rng() * 220;
        const r = 40 + rng() * 150;
        const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
        cg.addColorStop(0, 'rgba(214,180,170,0.10)');
        cg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      T.exterior = this._track(new THREE.CanvasTexture(c), true);
    }

    /* Equirectangular dusk environment source for PMREM. */
    {
      const { c, ctx } = canvas2d(512, 256);
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0.0, '#0d1620');
      g.addColorStop(0.42, '#2f4356');
      g.addColorStop(0.52, '#7d6a63');
      g.addColorStop(0.56, '#b07a4f');
      g.addColorStop(0.62, '#41505c');
      g.addColorStop(1.0, '#141a1f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 256);
      /* warm practical pools so metal has something to reflect */
      for (let i = 0; i < 5; i++) {
        const x = 40 + i * 96;
        const rg = ctx.createRadialGradient(x, 176, 0, x, 176, 70);
        rg.addColorStop(0, 'rgba(255,206,150,0.55)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, 176, 70, 0, TAU);
        ctx.fill();
      }
      T.envSource = this._track(new THREE.CanvasTexture(c), true);
      T.envSource.mapping = THREE.EquirectangularReflectionMapping;
    }

    /* Interior fabric weave. */
    {
      const { c, ctx } = canvas2d(256, 256);
      ctx.fillStyle = '#6d6d6d';
      ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 256; i += 4) {
        hairline(ctx, i, 0, i, 256, 2, 'rgba(255,255,255,0.06)');
        hairline(ctx, 0, i, 256, i, 2, 'rgba(0,0,0,0.07)');
      }
      blotches(ctx, rng, 30, 256, 256, 40, 'rgba(0,0,0,0.08)');
      T.fabricRough = this._track(new THREE.CanvasTexture(c), false, 4, 4);
    }
  }

  /* ---------------- materials ---------------- */

  _buildMaterials() {
    const T = this.tex;

    const painted = (color, rough, extra) => new THREE.MeshPhysicalMaterial(Object.assign({
      color,
      roughness: rough,
      metalness: 0.06,
      roughnessMap: T.paintRough,
      clearcoat: 0.34,
      clearcoatRoughness: 0.42,
      envMapIntensity: 0.85
    }, extra || {}));

    this._reg('paintIvory', painted(PALETTE.ivory, 0.44));
    this._reg('paintIvoryLower', painted(PALETTE.ivoryShadow, 0.52));
    this._reg('paintOrange', painted(PALETTE.orange, 0.4));
    this._reg('paintOrangeDeep', painted(PALETTE.orangeDeep, 0.46));

    this._reg('metal', new THREE.MeshStandardMaterial({
      color: PALETTE.metal, metalness: 0.96, roughness: 0.32,
      roughnessMap: T.metalRough, envMapIntensity: 1.0
    }));
    this._reg('metalWarm', new THREE.MeshStandardMaterial({
      color: PALETTE.metalWarm, metalness: 0.9, roughness: 0.45,
      roughnessMap: T.metalRough, envMapIntensity: 0.9
    }));
    this._reg('graphite', new THREE.MeshStandardMaterial({
      color: PALETTE.graphite, metalness: 0.68, roughness: 0.52, envMapIntensity: 0.7
    }));
    this._reg('graphiteLight', new THREE.MeshStandardMaterial({
      color: PALETTE.graphiteLight, metalness: 0.6, roughness: 0.6, envMapIntensity: 0.7
    }));
    this._reg('cavity', new THREE.MeshStandardMaterial({
      color: 0x0a0c0e, metalness: 0.3, roughness: 0.95, envMapIntensity: 0.18
    }));
    this._reg('rubber', new THREE.MeshStandardMaterial({
      color: PALETTE.rubber, metalness: 0.0, roughness: 0.94
    }));
    this._reg('fabric', new THREE.MeshStandardMaterial({
      color: PALETTE.fabric, metalness: 0.0, roughness: 0.92, roughnessMap: T.fabricRough
    }));
    this._reg('lens', new THREE.MeshPhysicalMaterial({
      color: PALETTE.lens, metalness: 0.15, roughness: 0.06,
      clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.4
    }));

    this._reg('canopy', new THREE.MeshPhysicalMaterial({
      color: PALETTE.glass, metalness: 0.0, roughness: 0.07,
      transparent: true, opacity: 0.42, side: THREE.DoubleSide,
      depthWrite: false, clearcoat: 1.0, clearcoatRoughness: 0.05,
      envMapIntensity: 1.5
    }));
    this._reg('windowGlass', new THREE.MeshPhysicalMaterial({
      color: 0x243239, metalness: 0.0, roughness: 0.1,
      transparent: true, opacity: 0.5, depthWrite: false,
      clearcoat: 1.0, envMapIntensity: 1.2
    }));

    const emissive = (color, intensity) => new THREE.MeshStandardMaterial({
      color: 0x0b0f12, emissive: color, emissiveIntensity: intensity,
      metalness: 0.2, roughness: 0.4, toneMapped: true
    });
    this._reg('emCyan', emissive(PALETTE.cyan, 1.5));
    this._reg('emRed', emissive(PALETTE.red, 1.4));
    this._reg('emGreen', emissive(PALETTE.green, 1.4));
    this._reg('emWhite', emissive(0xf2f8ff, 1.6));
    this._reg('emAmber', emissive(PALETTE.amber, 1.2));
    this._reg('emCabin', emissive(0xffcf9a, 0.9));
    this._reg('emPanel', emissive(0x63e2ff, 0.7));
    this._reg('emExhaust', emissive(0xff7a3c, 0.0));

    const decal = (map, opts) => new THREE.MeshStandardMaterial(Object.assign({
      map, transparent: true, roughness: 0.5, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      depthWrite: false, envMapIntensity: 0.5
    }, opts || {}));

    this._reg('decalWordmark', decal(T.wordmark));
    this._reg('decalChevrons', decal(T.chevrons));
    this._reg('decalDoor', decal(T.doorDecal));
    this._reg('decalLabels', decal(T.labels));
    this._reg('decalWear', decal(T.wear, { opacity: 0.75 }));
    this._reg('decalNacelle', decal(T.nacelleWarn, { side: THREE.DoubleSide }));

    this._reg('motionDisc', new THREE.MeshBasicMaterial({
      map: T.motionDisc, transparent: true, opacity: 0.0,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    }));

    /* environment */
    this._reg('deck', new THREE.MeshStandardMaterial({
      map: T.deck, color: 0xffffff, metalness: 0.06, roughness: 0.86
    }));
    this._reg('wall', new THREE.MeshStandardMaterial({
      map: T.wall, metalness: 0.1, roughness: 0.82
    }));
    this._reg('structure', new THREE.MeshStandardMaterial({
      color: 0x555c63, metalness: 0.55, roughness: 0.62
    }));
    this._reg('structureDark', new THREE.MeshStandardMaterial({
      color: 0x2b3036, metalness: 0.4, roughness: 0.72
    }));
    this._reg('exterior', new THREE.MeshBasicMaterial({ map: T.exterior, toneMapped: true }));
    this._reg('propPaint', new THREE.MeshStandardMaterial({
      color: 0x4a5a63, metalness: 0.2, roughness: 0.7
    }));
    this._reg('propWarn', new THREE.MeshStandardMaterial({
      color: 0xb9862f, metalness: 0.3, roughness: 0.6
    }));
    this._reg('hotspot', new THREE.MeshBasicMaterial({
      color: PALETTE.cyan, transparent: true, opacity: 0.55, depthWrite: false
    }));
  }

  /** Apply the generated PMREM environment to every material that wants it. */
  applyEnvironment(envTexture) {
    for (const m of this.materials) {
      if ('envMap' in m && m.envMapIntensity !== undefined) m.envMap = envTexture;
      m.needsUpdate = true;
    }
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.textures.length = 0;
    this.materials.length = 0;
  }
}
