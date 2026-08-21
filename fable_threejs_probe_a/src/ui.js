// Asterion HX-9 — DOM UI bindings, keyboard shortcuts, accessibility glue.
import { STATE_NAMES, MAX_CABLE_M } from './animation.js';

const $ = (id) => document.getElementById(id);

const tState = (v, a, b, mid) => (v > 0.97 ? a : v < 0.03 ? b : mid);

export function initUI(app) {
  const anim = app.anim;

  const stateButtons = Array.from(document.querySelectorAll('#state-group button'));
  const camButtons = Array.from(document.querySelectorAll('#cam-group button'));
  const explodeSlider = $('explode-slider');
  const explodeValue = $('explode-value');
  const winchSlider = $('winch-cable');
  const winchValue = $('winch-value');
  const sensorAuto = $('sensor-auto');
  const sensorAz = $('sensor-az');
  const sensorEl = $('sensor-el');
  const lightingBtn = $('lighting-toggle');
  const pauseBtn = $('btn-pause');
  const resetBtn = $('btn-reset');
  const helpBtn = $('btn-help');
  const helpDialog = $('help-dialog');
  const helpClose = $('help-close');
  const reducedChk = $('chk-reduced');
  const indicator = $('transition-indicator');
  const hotspotSelect = $('hotspot-select');
  const card = $('hotspot-card');
  const cardTitle = $('hotspot-title');
  const cardBody = $('hotspot-body');
  const cardClear = $('hotspot-clear');

  /* state buttons */
  stateButtons.forEach((b) =>
    b.addEventListener('click', () => app.setState(b.dataset.state))
  );

  /* camera presets */
  camButtons.forEach((b) =>
    b.addEventListener('click', () => app.goPreset(b.dataset.cam))
  );

  /* lighting */
  lightingBtn.addEventListener('click', () => {
    app.setLighting(app.getLighting() === 'dusk' ? 'night' : 'dusk');
  });

  /* explode */
  explodeSlider.addEventListener('input', () => {
    app.setExplode(explodeSlider.value / 100);
  });

  /* winch */
  winchSlider.addEventListener('input', () => {
    app.setCable(winchSlider.value / 100);
  });

  /* sensor */
  const syncSensor = () => {
    anim.setSensor({
      auto: sensorAuto.checked,
      az: (sensorAz.value * Math.PI) / 180,
      el: (sensorEl.value * Math.PI) / 180,
    });
    sensorAz.disabled = sensorAuto.checked;
    sensorEl.disabled = sensorAuto.checked;
  };
  sensorAuto.addEventListener('change', syncSensor);
  sensorAz.addEventListener('input', syncSensor);
  sensorEl.addEventListener('input', syncSensor);

  /* playback */
  pauseBtn.addEventListener('click', () => app.setPaused(!app.isPaused()));
  resetBtn.addEventListener('click', () => app.reset());
  helpBtn.addEventListener('click', () => helpDialog.showModal());
  helpClose.addEventListener('click', () => helpDialog.close());

  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedChk.checked = media.matches;
  app.setReducedMotion(reducedChk.checked);
  reducedChk.addEventListener('change', () => app.setReducedMotion(reducedChk.checked));

  /* hotspots */
  for (const h of app.hotspots) {
    const opt = document.createElement('option');
    opt.value = h.id;
    opt.textContent = h.title;
    hotspotSelect.appendChild(opt);
  }
  hotspotSelect.addEventListener('change', () => {
    if (hotspotSelect.value) app.focusHotspot(hotspotSelect.value);
  });
  cardClear.addEventListener('click', () => app.clearHotspot());

  /* keyboard */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') {
      if (helpDialog.open) helpDialog.close();
      else app.clearHotspot();
      return;
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '6') {
      app.setState(STATE_NAMES[Number(k) - 1]);
    } else if (k === 'c') {
      app.cyclePreset();
    } else if (k === 'l') {
      app.setLighting(app.getLighting() === 'dusk' ? 'night' : 'dusk');
    } else if (k === ' ') {
      e.preventDefault();
      app.setPaused(!app.isPaused());
    } else if (k === 'r') {
      app.reset();
    } else if (k === 'h') {
      if (!helpDialog.open) helpDialog.showModal();
    } else if (k === 'm') {
      reducedChk.checked = !reducedChk.checked;
      app.setReducedMotion(reducedChk.checked);
    } else if (k === '[') {
      app.setExplode(Math.max(0, anim.userExplode - 0.1));
    } else if (k === ']') {
      app.setExplode(Math.min(1, anim.userExplode + 0.1));
    } else if (k === 'v') {
      app.setCable(anim.userCable > 0.05 ? 0 : 0.85);
    }
  });

  /* ---- periodic sync ---- */
  function sync() {
    const s = anim.state;
    stateButtons.forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.state === s))
    );
    camButtons.forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.cam === app.currentPreset()))
    );
    const canEx = anim.canExplode();
    explodeSlider.disabled = !canEx;
    if (!canEx && anim.userExplode === 0 && Number(explodeSlider.value) !== 0) {
      explodeSlider.value = 0;
    }
    explodeValue.textContent = `${Math.round(anim.ch.explode * 100)}%`;
    const winchOk = s === 'rescue';
    winchSlider.disabled = !winchOk;
    if (!winchOk && Number(winchSlider.value) !== 0) winchSlider.value = 0;
    winchValue.textContent = `${(anim.ch.cable * MAX_CABLE_M).toFixed(1)} m`;
    pauseBtn.textContent = app.isPaused() ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(app.isPaused()));
    const mode = app.getLighting();
    lightingBtn.textContent =
      mode === 'dusk' ? 'Mode: Dusk — switch to Night Inspection' : 'Mode: Night Inspection — switch to Dusk';
    lightingBtn.setAttribute('aria-pressed', String(mode === 'night'));
    const labels = anim.transitionLabels();
    indicator.textContent = labels.length ? `⇄ ${labels.join(' · ')}` : 'stable';
  }

  function updateTelemetry(d) {
    $('t-state').textContent = d.state;
    $('t-nacelle').textContent = `${d.nacelleDeg}°`;
    $('t-rpm').textContent = `${d.rotorRpm} rpm`;
    $('t-gear').textContent = tState(anim.ch.gear, 'DOWN', 'UP', 'TRANSIT');
    $('t-sponson').textContent = tState(anim.ch.sponson, 'OUT', 'IN', 'TRANSIT');
    $('t-door').textContent = tState(anim.ch.door, 'OPEN', 'CLOSED', 'MOVING');
    $('t-cable').textContent = `${d.cableM.toFixed ? d.cableM.toFixed(1) : d.cableM} m`;
    $('t-camera').textContent = d.camera;
    $('t-calls').textContent = String(d.drawCalls);
    $('t-tris').textContent = d.triangles.toLocaleString('en-US');
    $('t-fps').textContent = String(d.fps);
    sync();
  }

  function showHotspot(h) {
    if (!h) {
      card.hidden = true;
      hotspotSelect.value = '';
      return;
    }
    cardTitle.textContent = h.title;
    cardBody.textContent = h.body;
    card.hidden = false;
    hotspotSelect.value = h.id;
  }

  sync();
  return { updateTelemetry, showHotspot, sync };
}
