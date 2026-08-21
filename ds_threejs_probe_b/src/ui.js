/**
 * Asterion HX-9 — technical UI layer.
 * Owns all DOM wiring, keyboard shortcuts, telemetry and the hotspot card.
 * The 3D layer never renders essential text into the canvas.
 */

const el = (id) => document.getElementById(id);

export const SHORTCUTS = [
  ['1 … 6', 'Select state: ground, hover, transition, cruise, rescue, maintenance'],
  ['F / L / R', 'Camera: front, port beam, starboard rescue door'],
  ['O / K / N', 'Camera: overhead, cockpit, winch'],
  ['G', 'Cycle lighting mode (dusk ⇄ night inspection)'],
  ['[ / ]', 'Exploded view −/+ (maintenance only)'],
  ['↑ / ↓', 'Hoist cable raise / lower (rescue only)'],
  ['B', 'Deploy or stow the hoist boom'],
  [', / .', 'Point sensor turret left / right'],
  ['S', 'Toggle automatic turret scan'],
  ['Space', 'Pause / resume animation'],
  ['X', 'Deterministic reset'],
  ['M', 'Toggle reduced motion'],
  ['H or ?', 'Help'],
  ['Esc', 'Dismiss hotspot card / help']
];

export function createUI(api) {
  const ui = {};
  const stateGroup = el('stateGroup');
  const camGroup = el('camGroup');
  const lightGroup = el('lightGroup');
  const explode = el('explode');
  const explodeVal = el('explodeVal');
  const explodeHint = el('explodeHint');
  const hotspotList = el('hotspotList');
  const card = el('hotspotCard');
  const cardTitle = el('hsTitle');
  const cardBody = el('hsBody');
  const transitionIndicator = el('transitionIndicator');
  const winchBtn = el('winchToggle');
  const cableDown = el('cableDown');
  const cableUp = el('cableUp');
  const winchHint = el('winchHint');
  const scanBtn = el('sensorScan');
  const panBtns = [el('sensorLeft'), el('sensorRight'), el('sensorUp'), el('sensorDown')];
  const pauseBtn = el('pause');
  const resetBtn = el('reset');
  const helpBtn = el('help');
  const rmBtn = el('reducedMotion');
  const helpDialog = el('helpDialog');
  const t = {
    state: el('tState'), nacelle: el('tNacelle'), rpm: el('tRpm'), gear: el('tGear'),
    sponson: el('tSponson'), door: el('tDoor'), cable: el('tCable'), cam: el('tCam'),
    calls: el('tCalls'), tris: el('tTris'), fps: el('tFps'), turret: el('tTurret')
  };

  /* ---------- state buttons ---------- */
  const stateButtons = Array.from(stateGroup.querySelectorAll('button[data-state]'));
  stateButtons.forEach((b) => {
    b.addEventListener('click', () => api.setState(b.dataset.state));
  });
  const camButtons = Array.from(camGroup.querySelectorAll('button[data-cam]'));
  camButtons.forEach((b) => b.addEventListener('click', () => api.setCamera(b.dataset.cam)));
  const lightButtons = Array.from(lightGroup.querySelectorAll('button[data-light]'));
  lightButtons.forEach((b) => b.addEventListener('click', () => api.setLighting(b.dataset.light)));

  explode.addEventListener('input', () => {
    api.setExplode(Number(explode.value) / 100);
  });

  winchBtn.addEventListener('click', () => api.toggleBoom());
  const holdCable = (btn, dir) => {
    const start = (ev) => {
      ev.preventDefault();
      api.setCableCommand(dir);
    };
    const stop = () => api.setCableCommand(0);
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') api.setCableCommand(dir);
    });
    btn.addEventListener('keyup', stop);
    btn.addEventListener('blur', stop);
  };
  holdCable(cableDown, 1);
  holdCable(cableUp, -1);

  scanBtn.addEventListener('click', () => api.toggleScan());
  const panDeltas = [[-0.09, 0], [0.09, 0], [0, 0.07], [0, -0.07]];
  panBtns.forEach((b, i) => b.addEventListener('click', () => api.pointTurret(panDeltas[i][0], panDeltas[i][1])));

  pauseBtn.addEventListener('click', () => api.togglePause());
  resetBtn.addEventListener('click', () => api.reset());
  rmBtn.addEventListener('click', () => api.toggleReducedMotion());
  helpBtn.addEventListener('click', () => openHelp(true));
  el('helpClose').addEventListener('click', () => openHelp(false));
  el('hsClose').addEventListener('click', () => ui.hideHotspot());

  function openHelp(open) {
    if (open) {
      if (typeof helpDialog.showModal === 'function') helpDialog.showModal();
      else helpDialog.setAttribute('open', '');
    } else if (typeof helpDialog.close === 'function') helpDialog.close();
    else helpDialog.removeAttribute('open');
  }

  /* ---------- help contents + hotspot list ---------- */
  const shortcutTable = el('shortcutTable');
  SHORTCUTS.forEach(([k, d]) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = d;
    tr.append(th, td);
    shortcutTable.append(tr);
  });

  api.hotspots.forEach((h) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hs';
    b.dataset.hotspot = h.id;
    b.textContent = h.title;
    b.addEventListener('click', () => api.focusHotspot(h.id));
    li.append(b);
    hotspotList.append(li);
  });

  /* ---------- keyboard ---------- */
  const stateKeys = { 1: 'ground', 2: 'hover', 3: 'transition', 4: 'cruise', 5: 'rescue', 6: 'maintenance' };
  const camKeys = { f: 'front', l: 'port', r: 'starboard', o: 'top', k: 'cockpit', n: 'winch' };
  window.addEventListener('keydown', (ev) => {
    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' && ev.target.type === 'range' && (ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End')) return;
    const k = ev.key;
    const lower = k.toLowerCase();
    if (stateKeys[k]) {
      api.setState(stateKeys[k]);
    } else if (camKeys[lower]) {
      api.setCamera(camKeys[lower]);
    } else if (lower === 'g') {
      api.cycleLighting();
    } else if (k === '[' || k === ']') {
      api.nudgeExplode(k === '[' ? -0.1 : 0.1);
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      api.nudgeCable(k === 'ArrowDown' ? 1 : -1);
    } else if (lower === 'b') {
      api.toggleBoom();
    } else if (k === ',' || k === '.') {
      api.pointTurret(k === ',' ? -0.12 : 0.12, 0);
    } else if (lower === 's') {
      api.toggleScan();
    } else if (k === ' ') {
      api.togglePause();
    } else if (lower === 'x') {
      api.reset();
    } else if (lower === 'm') {
      api.toggleReducedMotion();
    } else if (lower === 'h' || k === '?') {
      openHelp(!helpDialog.open);
    } else if (k === 'Escape') {
      ui.hideHotspot();
      openHelp(false);
      return;
    } else {
      return;
    }
    ev.preventDefault();
  });

  /* ---------- public surface ---------- */
  ui.showHotspot = (h) => {
    cardTitle.textContent = h.title;
    cardBody.textContent = h.body;
    card.hidden = false;
    Array.from(hotspotList.querySelectorAll('button')).forEach((b) =>
      b.setAttribute('aria-current', b.dataset.hotspot === h.id ? 'true' : 'false')
    );
  };
  ui.hideHotspot = () => {
    card.hidden = true;
    Array.from(hotspotList.querySelectorAll('button')).forEach((b) => b.setAttribute('aria-current', 'false'));
  };
  ui.setLightingMode = (mode) => {
    lightButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.light === mode)));
  };
  ui.setPaused = (p) => {
    pauseBtn.setAttribute('aria-pressed', String(p));
    pauseBtn.textContent = p ? 'Resume' : 'Pause';
  };
  ui.setReducedMotion = (p) => rmBtn.setAttribute('aria-pressed', String(p));
  ui.setCamera = (id) => camButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === id)));
  ui.showError = (msg) => {
    const panel = el('errorPanel');
    el('errorText').textContent = msg;
    panel.hidden = false;
  };

  let last = 0;
  ui.update = (snap, metrics, now) => {
    stateButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === snap.state)));
    if (now - last < 110) return;
    last = now;
    const maint = snap.state === 'maintenance';
    explode.disabled = !maint;
    explode.setAttribute('aria-disabled', String(!maint));
    explodeHint.textContent = maint
      ? 'Assemblies separate along authored service vectors.'
      : 'Available in maintenance state only.';
    const sliderPct = Math.round((snap.explodeTarget != null ? snap.explodeTarget : snap.explode) * 100);
    if (document.activeElement !== explode) explode.value = String(sliderPct);
    explodeVal.textContent = `${Math.round(snap.explode * 100)}%`;

    const hoist = snap.state === 'rescue';
    winchBtn.disabled = !hoist;
    winchBtn.setAttribute('aria-pressed', String(snap.winchBoom > 0.5));
    const cableOk = hoist && snap.rescueDoor > 0.9 && snap.winchBoom > 0.85;
    cableDown.disabled = !cableOk;
    cableUp.disabled = !cableOk;
    winchHint.textContent = hoist
      ? cableOk
        ? 'Hoist live — boom out, door open.'
        : 'Waiting for door and boom.'
      : 'Hoist enabled in rescue state only.';
    scanBtn.setAttribute('aria-pressed', String(snap.scanning));
    scanBtn.disabled = maint;
    panBtns.forEach((b) => (b.disabled = maint));

    transitionIndicator.textContent = snap.transitioning ? `TRANSITION → ${snap.state}` : 'CONFIGURATION STEADY';
    transitionIndicator.dataset.busy = String(snap.transitioning);

    t.state.textContent = snap.state;
    t.nacelle.textContent = `${snap.nacelleAngleDeg.toFixed(1)}°`;
    t.rpm.textContent = `${snap.rotorRpm} rpm`;
    t.gear.textContent = `${pct(snap.gear)} / doors ${pct(snap.gearDoors)}`;
    t.sponson.textContent = pct(snap.sponsons);
    t.door.textContent = pct(snap.rescueDoor);
    t.cable.textContent = `${snap.cableLengthM.toFixed(2)} m`;
    t.turret.textContent = `${snap.turretYawDeg.toFixed(0)}° / ${snap.turretPitchDeg.toFixed(0)}°`;
    t.cam.textContent = metrics.camera;
    t.calls.textContent = String(metrics.calls);
    t.tris.textContent = metrics.triangles.toLocaleString('en-US');
    t.fps.textContent = String(Math.round(metrics.fps));
  };

  const pct = (v) => (v > 0.995 ? 'deployed' : v < 0.005 ? 'stowed' : `${Math.round(v * 100)}%`);
  return ui;
}
