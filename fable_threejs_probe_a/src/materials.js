// Asterion HX-9 — seeded RNG, procedural CanvasTextures and PBR material kit.
// Every marking is original and generated at runtime; nothing is downloaded.
import * as THREE from 'three';

export const SEED_STRING = 'HX9-FABLE-PROBE';

export function createRng(seedStr = SEED_STRING) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTE = {
  ivory: 0xe9e4d8,
  orange: 0xe3591c,
  graphite: 0x282b31,
  darkMech: 0x1a1c20,
  steel: 0x9aa2ab,
  cyan: 0x3fd6e4,
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function scuff(ctx, rng, w, h, n, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = alpha * (0.4 + rng() * 0.6);
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 14, 1 + rng() * 2.5);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function createMaterialKit(rng) {
  const textures = [];
  const tex = (cnv, srgb = true) => {
    const t = new THREE.CanvasTexture(cnv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  };

  /* ---- micro detail (roughness variation) ---- */
  const dC = canvas(256, 256);
  const dg = dC.getContext('2d');
  dg.fillStyle = '#8f8f8f';
  dg.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = 120 + Math.floor(rng() * 60);
    dg.fillStyle = `rgba(${v},${v},${v},0.10)`;
    dg.fillRect(rng() * 256, rng() * 256, 1 + rng() * 3, 1 + rng() * 3);
  }
  for (let i = 0; i < 30; i++) {
    dg.fillStyle = 'rgba(60,60,60,0.05)';
    dg.fillRect(rng() * 256, rng() * 256, 20 + rng() * 60, 1);
  }
  const detailTex = tex(dC, false);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.repeat.set(3, 3);

  /* ---- HX-9 wordmark ---- */
  function wordmark(worn) {
    const c = canvas(1024, 256);
    const g = c.getContext('2d');
    g.clearRect(0, 0, 1024, 256);
    g.fillStyle = '#e3591c';
    g.beginPath();
    g.moveTo(28, 40); g.lineTo(300, 40); g.lineTo(262, 216); g.lineTo(28, 216);
    g.closePath(); g.fill();
    g.fillStyle = '#f3efe6';
    g.font = '700 132px Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('HX-9', 52, 132);
    g.fillStyle = '#e9e4d8';
    g.font = '600 46px Arial, sans-serif';
    let x = 340;
    for (const ch of 'ASTERION') { g.fillText(ch, x, 92); x += 52; }
    g.fillStyle = '#3fd6e4';
    g.fillRect(340, 128, 412, 4);
    g.fillStyle = '#a9b2bd';
    g.font = '500 30px Arial, sans-serif';
    g.fillText('COASTAL RESCUE UNIT · PROTOTYPE 01', 340, 168);
    if (worn) scuff(g, rng, 1024, 256, 140, 0.5);
    else scuff(g, rng, 1024, 256, 40, 0.25);
    return tex(c);
  }
  const wordmarkPort = wordmark(false);
  const wordmarkStbd = wordmark(true);

  /* ---- fin chevrons ---- */
  const chC = canvas(256, 512);
  {
    const g = chC.getContext('2d');
    g.clearRect(0, 0, 256, 512);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#e9e4d8' : '#e3591c';
      const y = 60 + i * 88;
      g.beginPath();
      g.moveTo(20, y); g.lineTo(128, y + 52); g.lineTo(236, y);
      g.lineTo(236, y + 40); g.lineTo(128, y + 92); g.lineTo(20, y + 40);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#a9b2bd';
    g.font = '600 26px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('RESCUE', 128, 470);
    scuff(g, rng, 256, 512, 60, 0.3);
  }
  const chevronTex = tex(chC);

  /* ---- caution stripes (repeatable) ---- */
  const caC = canvas(256, 64);
  {
    const g = caC.getContext('2d');
    g.fillStyle = '#e3591c';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#21242a';
    for (let x = -64; x < 300; x += 64) {
      g.beginPath();
      g.moveTo(x, 64); g.lineTo(x + 32, 0); g.lineTo(x + 64, 0); g.lineTo(x + 32, 64);
      g.closePath(); g.fill();
    }
  }
  const cautionTex = tex(caC);
  cautionTex.wrapS = THREE.RepeatWrapping;
  cautionTex.repeat.set(3, 1);

  /* ---- rotor warning band ---- */
  const rwC = canvas(512, 64);
  {
    const g = rwC.getContext('2d');
    g.fillStyle = '#e3591c';
    g.fillRect(0, 0, 512, 64);
    g.fillStyle = '#16181c';
    g.font = '700 30px Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('DANGER · ROTOR PLANE · STAY CLEAR ·', 8, 34);
  }
  const rotorWarnTex = tex(rwC);
  rotorWarnTex.wrapS = THREE.RepeatWrapping;
  rotorWarnTex.repeat.set(2, 1);

  /* ---- cabin door marking ---- */
  const doC = canvas(512, 384);
  {
    const g = doC.getContext('2d');
    g.clearRect(0, 0, 512, 384);
    g.strokeStyle = '#e3591c';
    g.lineWidth = 10;
    g.strokeRect(14, 14, 484, 356);
    g.fillStyle = '#e9e4d8';
    g.font = '700 54px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('RESCUE', 256, 96);
    g.fillStyle = '#3fd6e4';
    g.beginPath();
    g.moveTo(256, 150); g.lineTo(316, 230); g.lineTo(276, 230); g.lineTo(276, 300);
    g.lineTo(236, 300); g.lineTo(236, 230); g.lineTo(196, 230);
    g.closePath(); g.fill();
    g.fillStyle = '#a9b2bd';
    g.font = '500 24px Arial, sans-serif';
    g.fillText('LIFT HANDLE · DOOR SWINGS UP', 256, 344);
    scuff(g, rng, 512, 384, 80, 0.35);
  }
  const doorTex = tex(doC);

  /* ---- small label factory ---- */
  function label(lines, w = 256, h = 96, accent = '#e3591c') {
    const c = canvas(w, h);
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(20,23,28,0.85)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.fillRect(0, 0, 8, h);
    g.fillStyle = '#e9e4d8';
    g.font = `600 ${Math.floor(h / (lines.length + 1))}px Arial, sans-serif`;
    lines.forEach((ln, i) => g.fillText(ln, 18, (i + 1) * (h / (lines.length + 0.6))));
    scuff(g, rng, w, h, 24, 0.3);
    return tex(c);
  }
  const labels = {
    noStep: label(['NO STEP'], 192, 64),
    intake: label(['INTAKE', 'KEEP CLEAR'], 224, 96),
    winchZone: label(['WINCH ZONE', 'STAND CLEAR'], 256, 96, '#3fd6e4'),
    panelId: label(['ACCESS AP-04', 'HYD 210 BAR'], 256, 96, '#8d99a8'),
    registry: label(['HX9-01R', 'ASTERION WORKS'], 256, 96, '#3fd6e4'),
  };

  /* ---- cockpit instrument face ---- */
  const daC = canvas(512, 256);
  {
    const g = daC.getContext('2d');
    g.fillStyle = '#0a0e13';
    g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#3fd6e4';
    g.lineWidth = 3;
    for (let i = 0; i < 3; i++) g.strokeRect(28 + i * 160, 36, 130, 110);
    g.strokeStyle = '#2b6d76';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(38 + i * 160, 120);
      for (let x = 0; x < 110; x += 8) g.lineTo(38 + i * 160 + x, 120 - Math.abs(Math.sin((x + i * 40) * 0.11)) * 60);
      g.stroke();
    }
    g.fillStyle = '#e3591c';
    for (let i = 0; i < 8; i++) g.fillRect(40 + i * 56, 190, 34, 18);
    g.fillStyle = '#3fd6e4';
    g.font = '600 20px Arial, sans-serif';
    g.fillText('HX-9 FLIGHT DECK', 30, 236);
  }
  const dashTex = tex(daC);

  /* ---- rotor motion disc ---- */
  const diC = canvas(256, 256);
  {
    const g = diC.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grad.addColorStop(0, 'rgba(190,195,205,0)');
    grad.addColorStop(0.55, 'rgba(190,195,205,0.35)');
    grad.addColorStop(0.92, 'rgba(210,214,222,0.55)');
    grad.addColorStop(1, 'rgba(210,214,222,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(128, 128, 128, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      g.save(); g.translate(128, 128); g.rotate(a);
      g.globalAlpha = 0.10 + rng() * 0.12;
      g.fillRect(24, -1, 104, 2);
      g.restore();
    }
  }
  const discTex = tex(diC);

  /* ---- hangar floor ---- */
  const flC = canvas(1024, 768);
  {
    const g = flC.getContext('2d');
    g.fillStyle = '#3a3d40';
    g.fillRect(0, 0, 1024, 768);
    for (let i = 0; i < 5200; i++) {
      const v = 48 + Math.floor(rng() * 28);
      g.fillStyle = `rgba(${v},${v + 2},${v + 4},0.35)`;
      g.fillRect(rng() * 1024, rng() * 768, 1 + rng() * 2, 1 + rng() * 2);
    }
    g.strokeStyle = 'rgba(18,20,22,0.9)';
    g.lineWidth = 3;
    for (let x = 0; x <= 1024; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 768); g.stroke(); }
    for (let y = 0; y <= 768; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(1024, y); g.stroke(); }
    // landing pad
    g.strokeStyle = '#c8551d';
    g.lineWidth = 14;
    g.beginPath(); g.arc(512, 384, 260, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 6;
    g.beginPath(); g.arc(512, 384, 300, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#c9c4b6';
    g.font = '700 150px Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('H9', 512, 384);
    g.fillStyle = '#c8551d';
    for (let i = 0; i < 6; i++) g.fillRect(120 + i * 40, 700, 24, 40);
    for (let i = 0; i < 24; i++) {
      g.fillStyle = 'rgba(12,12,14,0.12)';
      g.beginPath();
      g.ellipse(rng() * 1024, rng() * 768, 8 + rng() * 30, 5 + rng() * 14, rng() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  const floorTex = tex(flC);

  /* ---- hangar wall ---- */
  const waC = canvas(1024, 512);
  {
    const g = waC.getContext('2d');
    g.fillStyle = '#2c3138';
    g.fillRect(0, 0, 1024, 512);
    for (let x = 0; x < 1024; x += 64) {
      g.fillStyle = x % 128 ? '#2f343c' : '#2a2f36';
      g.fillRect(x, 0, 62, 512);
    }
    g.fillStyle = '#22262c';
    g.fillRect(0, 430, 1024, 82);
    g.fillStyle = '#e3591c';
    g.fillRect(60, 120, 300, 60);
    g.fillStyle = '#e9e4d8';
    g.font = '700 44px Arial, sans-serif';
    g.fillText('BAY 03', 84, 165);
    g.fillStyle = '#3fd6e4';
    g.font = '600 26px Arial, sans-serif';
    g.fillText('ASTERION WORKS · TIDEWATCH STATION', 60, 220);
    for (let i = 0; i < 400; i++) {
      const v = 30 + Math.floor(rng() * 22);
      g.fillStyle = `rgba(${v},${v},${v},0.4)`;
      g.fillRect(rng() * 1024, rng() * 512, 2, 2 + rng() * 8);
    }
  }
  const wallTex = tex(waC);

  /* ---- dusk sky ---- */
  const skC = canvas(512, 256);
  {
    const g = skC.getContext('2d');
    const grad = g.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, '#f08c3f');
    grad.addColorStop(0.28, '#a05a58');
    grad.addColorStop(0.6, '#3c3a63');
    grad.addColorStop(1, '#181f3c');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = 'rgba(255,220,170,0.7)';
    g.beginPath(); g.arc(150, 218, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(240,240,255,0.8)';
    for (let i = 0; i < 40; i++) g.fillRect(rng() * 512, rng() * 120, 1, 1);
    g.fillStyle = 'rgba(30,34,52,0.8)';
    for (let i = 0; i < 5; i++) {
      const y = 200 + i * 8;
      g.fillRect(0, y, 512, 2 + rng() * 2);
    }
  }
  const skyTex = tex(skC);

  /* ---- materials ---- */
  const M = {};
  M.ivory = new THREE.MeshPhysicalMaterial({
    color: PALETTE.ivory, roughness: 0.48, metalness: 0.12,
    clearcoat: 0.5, clearcoatRoughness: 0.4, roughnessMap: detailTex, envMapIntensity: 0.5,
  });
  M.orange = new THREE.MeshPhysicalMaterial({
    color: PALETTE.orange, roughness: 0.5, metalness: 0.1,
    clearcoat: 0.45, clearcoatRoughness: 0.45, roughnessMap: detailTex, envMapIntensity: 0.5,
  });
  M.graphite = new THREE.MeshStandardMaterial({
    color: PALETTE.graphite, roughness: 0.62, metalness: 0.25, roughnessMap: detailTex, envMapIntensity: 0.4,
  });
  M.darkMech = new THREE.MeshStandardMaterial({
    color: PALETTE.darkMech, roughness: 0.5, metalness: 0.45, envMapIntensity: 0.5,
  });
  M.steel = new THREE.MeshStandardMaterial({
    color: PALETTE.steel, roughness: 0.32, metalness: 0.9, envMapIntensity: 0.8,
  });
  M.steelDark = new THREE.MeshStandardMaterial({
    color: 0x555b63, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.7,
  });
  M.rubber = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.95, metalness: 0 });
  M.glass = new THREE.MeshPhysicalMaterial({
    color: 0x2a4652, transparent: true, opacity: 0.3, roughness: 0.06, metalness: 0,
    clearcoat: 1, envMapIntensity: 1.1, side: THREE.DoubleSide, depthWrite: false,
  });
  M.lens = new THREE.MeshPhysicalMaterial({
    color: 0x04090f, roughness: 0.06, metalness: 0.2, clearcoat: 1, envMapIntensity: 1.4,
  });
  M.fabric = new THREE.MeshStandardMaterial({ color: 0x39404a, roughness: 0.92, metalness: 0.02 });
  M.fabricOrange = new THREE.MeshStandardMaterial({ color: 0x9c4a20, roughness: 0.9, metalness: 0.02 });
  M.interior = new THREE.MeshStandardMaterial({ color: 0xb4b7b0, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
  M.cavity = new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 1, metalness: 0 });
  M.blade = new THREE.MeshStandardMaterial({
    color: 0x24262b, roughness: 0.55, metalness: 0.3, transparent: true, opacity: 1,
  });
  M.disc = new THREE.MeshBasicMaterial({
    map: discTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });

  const emissive = (color, intensity) => new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1,
  });
  M.cyanGlow = emissive(PALETTE.cyan, 1.4);
  M.navRed = emissive(0xff3b30, 0);
  M.navGreen = emissive(0x30ff70, 0);
  M.strobe = emissive(0xffffff, 0);
  M.beacon = emissive(0xff2418, 0);
  M.cabinLight = emissive(0xffd9a8, 0.2);
  M.landingLight = emissive(0xfff4d8, 0);
  M.dash = new THREE.MeshStandardMaterial({
    color: 0x11141a, map: dashTex, emissive: 0xffffff, emissiveMap: dashTex,
    emissiveIntensity: 0.6, roughness: 0.6, metalness: 0.1,
  });

  const decal = (t) => new THREE.MeshStandardMaterial({
    map: t, transparent: true, alphaTest: 0.08, roughness: 0.5, metalness: 0.08,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, envMapIntensity: 0.3,
  });
  const bandMat = (t) => new THREE.MeshStandardMaterial({
    map: t, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.4,
  });

  const D = {
    wordmarkPort: decal(wordmarkPort),
    wordmarkStbd: decal(wordmarkStbd),
    chevron: decal(chevronTex),
    door: decal(doorTex),
    noStep: decal(labels.noStep),
    intake: decal(labels.intake),
    winchZone: decal(labels.winchZone),
    panelId: decal(labels.panelId),
    registry: decal(labels.registry),
    caution: bandMat(cautionTex),
    rotorWarn: bandMat(rotorWarnTex),
  };

  return {
    materials: M,
    decals: D,
    floorTex,
    wallTex,
    skyTex,
    textures,
    applyAnisotropy(n) {
      for (const t of textures) { t.anisotropy = n; t.needsUpdate = true; }
    },
    dispose() {
      for (const t of textures) t.dispose();
      for (const k of Object.keys(M)) M[k].dispose();
      for (const k of Object.keys(D)) D[k].dispose();
    },
  };
}
