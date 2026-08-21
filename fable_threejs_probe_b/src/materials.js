// materials.js — deterministic seeded RNG, procedural CanvasTextures and PBR material families.
// All markings are original fiction for the "Asterion HX-9" and are generated at runtime.
import * as THREE from 'three';

export const SEED_STRING = 'HX9-FABLE-PROBE';

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function createRng(seed = SEED_STRING) { return mulberry32(xmur3(seed)()); }

const INK = '#23272c';
const IVORY = '#ece7da';
const ORANGE = '#d3641f';
const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

export function createMaterials(rng, maxAnisotropy = 4) {
  const textures = [];
  const mats = [];

  function canvasTex(w, h, draw, { srgb = true, wrap = false } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = maxAnisotropy;
    if (wrap) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
    textures.push(t);
    return t;
  }

  // ---- textures -----------------------------------------------------------
  const tex = {};

  tex.noise = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = 215 + Math.floor(rng() * 40);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(rng() * w, rng() * h, 1 + rng() * 6, 1 + rng() * 6);
    }
  }, { srgb: false, wrap: true });

  tex.hull = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = IVORY; g.fillRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(120,125,130,0.10)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    grad.addColorStop(1, 'rgba(90,95,100,0.12)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(60,64,70,0.30)'; g.lineWidth = 2;
    for (const fy of [0.16, 0.31, 0.47, 0.62, 0.78, 0.9]) {
      g.beginPath(); g.moveTo(0, fy * h); g.lineTo(w, fy * h); g.stroke();
    }
    for (const fx of [0.13, 0.3, 0.5, 0.7, 0.87]) {
      const y0 = rng() * 0.3 * h, y1 = y0 + (0.3 + rng() * 0.5) * h;
      g.beginPath(); g.moveTo(fx * w, y0); g.lineTo(fx * w, y1); g.stroke();
    }
    // chine accents (u = around section; chines near u≈0.125 and 0.875)
    g.strokeStyle = 'rgba(50,52,56,0.35)'; g.lineWidth = 3;
    for (const fx of [0.125, 0.875]) {
      g.beginPath(); g.moveTo(fx * w, 0.04 * h); g.lineTo(fx * w, 0.9 * h); g.stroke();
    }
    // restrained wear streaks
    for (let i = 0; i < 34; i++) {
      g.fillStyle = `rgba(80,78,70,${0.03 + rng() * 0.04})`;
      const x = rng() * w, y = rng() * h;
      g.fillRect(x, y, 2 + rng() * 5, 12 + rng() * 60);
    }
  });

  tex.wordmark = canvasTex(1024, 256, (g) => {
    g.clearRect(0, 0, 1024, 256);
    g.fillStyle = ORANGE;
    g.beginPath(); // skewed accent block behind the numeral
    g.moveTo(560, 96); g.lineTo(700, 96); g.lineTo(660, 224); g.lineTo(520, 224);
    g.closePath(); g.fill();
    g.fillStyle = INK;
    g.font = `600 46px ${FONT}`;
    g.save(); g.translate(60, 62); g.scale(1.12, 1);
    g.fillText('A S T E R I O N', 0, 0); g.restore();
    g.font = `800 148px ${FONT}`;
    g.fillText('HX-9', 58, 218);
    g.fillStyle = '#4a5057';
    g.font = `600 30px ${FONT}`;
    g.fillText('AMPHIBIOUS RESCUE TILTROTOR', 400, 60);
    g.strokeStyle = INK; g.lineWidth = 5;
    g.beginPath(); g.moveTo(400, 78); g.lineTo(960, 78); g.stroke();
    g.fillStyle = INK; g.font = `700 54px ${FONT}`;
    g.fillText('RSQ-091', 730, 200);
  });

  tex.chevron = canvasTex(512, 256, (g) => {
    g.clearRect(0, 0, 512, 256);
    g.fillStyle = ORANGE;
    for (const x0 of [40, 150]) {
      g.beginPath();
      g.moveTo(x0, 30); g.lineTo(x0 + 70, 128); g.lineTo(x0, 226);
      g.lineTo(x0 + 46, 226); g.lineTo(x0 + 116, 128); g.lineTo(x0 + 46, 30);
      g.closePath(); g.fill();
    }
    g.fillStyle = INK; g.font = `800 66px ${FONT}`;
    g.fillText('RESCUE', 300, 152);
  });

  tex.doorSign = canvasTex(512, 256, (g) => {
    g.clearRect(0, 0, 512, 256);
    g.strokeStyle = ORANGE; g.lineWidth = 10; g.setLineDash([26, 14]);
    g.strokeRect(12, 12, 488, 232);
    g.setLineDash([]);
    g.fillStyle = INK;
    g.font = `800 54px ${FONT}`; g.fillText('RESCUE ACCESS', 46, 100);
    g.font = `700 40px ${FONT}`; g.fillText('SLIDE AFT', 46, 170);
    g.fillStyle = ORANGE;
    for (const x0 of [270, 340, 410]) {
      g.beginPath();
      g.moveTo(x0, 130); g.lineTo(x0 + 44, 158); g.lineTo(x0, 186);
      g.closePath(); g.fill();
    }
  });

  tex.caution = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = ORANGE; g.fillRect(0, 0, w, h);
    g.fillStyle = INK;
    for (let x = -h; x < w + h; x += 32) {
      g.beginPath();
      g.moveTo(x, h); g.lineTo(x + h, 0); g.lineTo(x + h + 14, 0); g.lineTo(x + 14, h);
      g.closePath(); g.fill();
    }
  }, { wrap: true });
  tex.caution.repeat.set(6, 1);

  tex.finCode = canvasTex(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = INK;
    g.font = `800 74px ${FONT}`; g.fillText('RSQ', 42, 104);
    g.font = `800 96px ${FONT}`; g.fillText('091', 42, 208);
    g.fillStyle = ORANGE; g.fillRect(36, 122, 184, 10);
  });

  const label = (text, wide = false) => canvasTex(wide ? 512 : 256, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = INK; g.lineWidth = 4; g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = INK;
    g.font = `700 ${wide ? 30 : 26}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  });
  tex.labelNoStep = label('NO STEP');
  tex.labelIntake = label('INTAKE — KEEP CLEAR', true);
  tex.labelHoist = label('HOIST 270 KG MAX', true);
  tex.labelSvc = label('SVC PANEL B2');
  tex.labelStatic = label('STATIC PORT');
  tex.labelTie = label('TIE-DOWN');

  tex.wear = canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = `rgba(70,64,54,${0.08 + rng() * 0.09})`;
      g.fillRect(rng() * w * 0.8, rng() * h * 0.3, 3 + rng() * 8, 30 + rng() * 80);
    }
  });

  tex.disc = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const r = w / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0.0, 'rgba(215,220,226,0)');
    grad.addColorStop(0.18, 'rgba(215,220,226,0.10)');
    grad.addColorStop(0.55, 'rgba(215,220,226,0.55)');
    grad.addColorStop(0.93, 'rgba(190,196,204,0.35)');
    grad.addColorStop(1.0, 'rgba(190,196,204,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  });

  tex.pad = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#363b41'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2b2f35'; g.lineWidth = 4;
    for (let i = 0; i <= 8; i++) {
      const p = (i / 8) * w;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke();
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(20,22,25,${0.03 + rng() * 0.05})`;
      g.beginPath(); g.arc(rng() * w, rng() * h, 8 + rng() * 46, 0, Math.PI * 2); g.fill();
    }
    const cx = w / 2, cy = h / 2;
    g.strokeStyle = ORANGE; g.lineWidth = 16;
    g.beginPath(); g.arc(cx, cy, 205, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 6; g.setLineDash([30, 22]);
    g.beginPath(); g.arc(cx, cy, 160, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#cfd6dc'; g.lineWidth = 10;
    g.beginPath();
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      const x = cx + Math.cos(a) * 120, y = cy + Math.sin(a) * 120;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#cfd6dc'; g.font = `800 118px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('H9', cx, cy + 6);
    g.fillStyle = ORANGE;
    for (let k = 0; k < 4; k++) { // threshold chevrons toward the sea opening
      const y0 = 60 + k * 44;
      g.beginPath();
      g.moveTo(cx - 90, y0 + 30); g.lineTo(cx, y0); g.lineTo(cx + 90, y0 + 30);
      g.lineTo(cx + 90, y0 + 14); g.lineTo(cx, y0 - 16); g.lineTo(cx - 90, y0 + 14);
      g.closePath(); g.fill();
    }
  });

  tex.wall = canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = '#2e3338'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#262a2f'; g.lineWidth = 5;
    for (let i = 0; i <= 10; i++) {
      const x = (i / 10) * w;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    g.beginPath(); g.moveTo(0, h * 0.68); g.lineTo(w, h * 0.68); g.stroke();
    g.fillStyle = ORANGE; g.fillRect(0, h * 0.72, w, 18);
    g.fillStyle = '#aeb7bf'; g.font = `700 44px ${FONT}`;
    g.fillText('ASTERION COASTAL AIR RESCUE  ·  BAY 03', 60, h * 0.35);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(15,17,20,${0.05 + rng() * 0.07})`;
      g.fillRect(rng() * w, h * (0.75 + rng() * 0.2), 8 + rng() * 40, 4 + rng() * 20);
    }
  });

  tex.sky = canvasTex(256, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.0, '#131e38');
    grad.addColorStop(0.45, '#3d5382');
    grad.addColorStop(0.72, '#c07a45');
    grad.addColorStop(0.8, '#e0975a');
    grad.addColorStop(0.84, '#33455e');
    grad.addColorStop(1.0, '#152232');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,220,170,0.5)';
    g.beginPath(); g.ellipse(w * 0.62, h * 0.76, 46, 12, 0, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 12; i++) { // dusk cloud bars
      g.fillStyle = `rgba(24,30,44,${0.15 + rng() * 0.2})`;
      g.beginPath();
      g.ellipse(rng() * w, h * (0.2 + rng() * 0.4), 30 + rng() * 60, 4 + rng() * 8, 0, 0, Math.PI * 2);
      g.fill();
    }
  });

  // ---- materials ----------------------------------------------------------
  function std(name, params) {
    const m = new THREE.MeshStandardMaterial(params);
    m.name = name;
    if (params.envMapIntensity === undefined) m.envMapIntensity = 0.45;
    mats.push(m);
    return m;
  }
  function phys(name, params) {
    const m = new THREE.MeshPhysicalMaterial(params);
    m.name = name; mats.push(m); return m;
  }

  const M = { tex, rng };

  M.paintHull = std('paintHull', { map: tex.hull, roughnessMap: tex.noise, roughness: 0.5, metalness: 0.12 });
  M.paintIvory = std('paintIvory', { color: 0xece7da, roughnessMap: tex.noise, roughness: 0.5, metalness: 0.12 });
  M.paintOrange = std('paintOrange', { color: 0xd3641f, roughnessMap: tex.noise, roughness: 0.46, metalness: 0.1 });
  M.graphite = std('graphite', { color: 0x2b2f34, roughness: 0.62, metalness: 0.25 });
  M.graphiteLight = std('graphiteLight', { color: 0x4a5057, roughness: 0.5, metalness: 0.3 });
  M.metal = std('metal', { color: 0x9aa3ab, roughness: 0.32, metalness: 0.85, envMapIntensity: 0.7 });
  M.rubber = std('rubber', { color: 0x1a1c1e, roughness: 0.95, metalness: 0.0 });
  M.fabric = std('fabric', { color: 0x39434c, roughness: 0.92, metalness: 0.0 });
  M.cavity = std('cavity', { color: 0x0c0e10, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.05 });
  M.cable = std('cable', { color: 0x15171a, roughness: 0.55, metalness: 0.6 });
  M.blade = std('blade', { color: 0x23262a, roughness: 0.5, metalness: 0.3, transparent: true, opacity: 1 });
  M.caution = std('caution', { map: tex.caution, roughness: 0.5, metalness: 0.1 });
  M.crate = std('crate', { color: 0x565349, roughness: 0.82, metalness: 0.05 });
  M.steel = std('steel', { color: 0x39424c, roughness: 0.6, metalness: 0.6 });
  M.concrete = std('concrete', { map: tex.pad, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.25 });
  M.wall = std('wall', { map: tex.wall, roughness: 0.9, metalness: 0.0, envMapIntensity: 0.2 });
  M.water = std('water', { color: 0x0e2434, roughness: 0.14, metalness: 0.05, envMapIntensity: 1.3 });

  M.glassCanopy = phys('glassCanopy', {
    color: 0x6d8b93, roughness: 0.07, metalness: 0.0,
    transparent: true, opacity: 0.3, depthWrite: false, envMapIntensity: 1.15,
  });
  M.glassLens = phys('glassLens', {
    color: 0x11181d, roughness: 0.06, metalness: 0.1,
    clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.0,
  });

  const emissive = (name, color, base) => std(name, {
    color: 0x101214, emissive: color, emissiveIntensity: base, roughness: 0.5, metalness: 0.0,
  });
  M.navRed = emissive('navRed', 0xff2a20, 0);
  M.navGreen = emissive('navGreen', 0x2aff66, 0);
  M.strobe = emissive('strobe', 0xffffff, 0);
  M.beacon = emissive('beacon', 0xff3524, 0);
  M.statusCyan = emissive('statusCyan', 0x35e0ff, 1.2);
  M.cabinLight = std('cabinLight', {
    color: 0xdadfe2, emissive: 0xfff2dc, emissiveIntensity: 0, roughness: 0.4, metalness: 0.0,
  });
  M.screen = emissive('screen', 0x77d8e8, 0);
  M.marker = std('marker', {
    color: 0x0a2a31, emissive: 0x35e0ff, emissiveIntensity: 1.6,
    transparent: true, opacity: 0.92, depthTest: false, roughness: 0.4,
  });
  mats.push(M.cabinLight);

  M.disc = new THREE.MeshBasicMaterial({
    map: tex.disc, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  M.disc.name = 'disc'; mats.push(M.disc);

  M.sky = new THREE.MeshBasicMaterial({ map: tex.sky, fog: false });
  M.sky.name = 'sky'; mats.push(M.sky);

  const decalCache = new Map();
  M.decal = (t) => {
    if (decalCache.has(t)) return decalCache.get(t);
    const m = std('decal', {
      map: t, transparent: true, roughness: 0.55, metalness: 0.05,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    });
    decalCache.set(t, m);
    return m;
  };

  M.dispose = () => {
    for (const t of textures) t.dispose();
    for (const m of mats) m.dispose();
  };
  M.textureCount = () => textures.length;
  return M;
}
