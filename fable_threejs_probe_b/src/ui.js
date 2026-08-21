// ui.js — DOM control panel, telemetry, hotspot card, keyboard shortcuts.
// Pure DOM module; talks to the app facade created in main.js.

const STATE_LABELS = {
  ground: 'Ground', hover: 'Hover', transition: 'Transition',
  cruise: 'Cruise', rescue: 'Rescue', maintenance: 'Maintenance',
};
const CAMERA_LABELS = {
  threeq: '3/4 view', front: 'Front', port: 'Port', door: 'Rescue door',
  top: 'Top', cockpit: 'Cockpit', winch: 'Winch',
};

export function initUI(app) {
  const $ = (id) => document.getElementById(id);
  const stateBox = $('state-controls');
  const camBox = $('camera-controls');
  const transInd = $('transition-ind');
  const explode = $('explode');
  const explodeVal = $('explode-val');
  const lightSel = $('light-mode');
  const winchLower = $('winch-lower');
  const winchRaise = $('winch-raise');
  const winchStatus = $('winch-status');
  const sensorAuto = $('sensor-auto');
  const sensorYaw = $('sensor-yaw');
  const sensorPitch = $('sensor-pitch');
  const btnPause = $('btn-pause');
  const btnReset = $('btn-reset');
  const btnHelp = $('btn-help');
  const reduced = $('reduced-motion');
  const card = $('hotspot-card');
  const cardTitle = $('card-title');
  const cardBody = $('card-body');
  const hotspotList = $('hotspot-list');

  const stateButtons = {};
  app.stateNames.forEach((name, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${i + 1} ${STATE_LABELS[name] || name}`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => app.setState(name));
    stateBox.appendChild(b);
    stateButtons[name] = b;
  });

  const camButtons = {};
  for (const name of app.cameraNames) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = CAMERA_LABELS[name] || name;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => app.setCamera(name));
    camBox.appendChild(b);
    camButtons[name] = b;
  }

  for (const h of app.hotspots) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = h.title;
    b.addEventListener('click', () => app.focusHotspot(h.id));
    li.appendChild(b);
    hotspotList.appendChild(li);
  }

  explode.addEventListener('input', () => app.setExplode(parseFloat(explode.value)));
  lightSel.addEventListener('change', () => app.setLighting(lightSel.value));
  winchLower.addEventListener('click', () => app.winchNudge(0.2));
  winchRaise.addEventListener('click', () => app.winchNudge(-0.2));
  sensorAuto.addEventListener('change', () => {
    app.setTurret(sensorAuto.checked, parseFloat(sensorYaw.value), parseFloat(sensorPitch.value));
  });
  const sensorManual = () => {
    if (!sensorAuto.checked) {
      app.setTurret(false, parseFloat(sensorYaw.value), parseFloat(sensorPitch.value));
    }
  };
  sensorYaw.addEventListener('input', sensorManual);
  sensorPitch.addEventListener('input', sensorManual);
  btnPause.addEventListener('click', () => app.pause(!app.isPaused()));
  btnReset.addEventListener('click', () => app.reset());
  btnHelp.addEventListener('click', () => $('help-dialog').showModal());
  reduced.checked = app.reducedMotion();
  reduced.addEventListener('change', () => app.setReducedMotion(reduced.checked));
  $('card-close').addEventListener('click', () => app.clearHotspot());

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' && tag === 'BUTTON') return;
    const idx = '123456'.indexOf(e.key);
    if (idx >= 0 && idx < app.stateNames.length) { app.setState(app.stateNames[idx]); return; }
    switch (e.key.toLowerCase()) {
      case 'c': {
        const names = app.cameraNames;
        const i = names.indexOf(app.activeCamera());
        app.setCamera(names[(i + 1) % names.length]);
        break;
      }
      case 'l': app.setLighting(app.lightingMode() === 'day' ? 'night' : 'day'); break;
      case '[': app.setExplode(Math.max(0, app.getExplode() - 0.1)); break;
      case ']': app.setExplode(Math.min(1, app.getExplode() + 0.1)); break;
      case 'w': app.winchNudge(0.15); break;
      case 'q': app.winchNudge(-0.15); break;
      case 'p': app.pause(!app.isPaused()); break;
      case ' ': e.preventDefault(); app.pause(!app.isPaused()); break;
      case 'r': app.reset(); break;
      case 'm': {
        const v = !app.reducedMotion();
        app.setReducedMotion(v);
        reduced.checked = v;
        break;
      }
      case 'h': case '?': $('help-dialog').showModal(); break;
      case 'x': app.clearHotspot(); break;
      default: break;
    }
  });

  function refresh() {
    const state = app.getStateName();
    for (const [name, b] of Object.entries(stateButtons)) {
      b.setAttribute('aria-pressed', String(name === state));
    }
    for (const [name, b] of Object.entries(camButtons)) {
      b.setAttribute('aria-pressed', String(name === app.activeCamera()));
    }
    transInd.value = app.isSettled()
      ? `${STATE_LABELS[state]} · steady`
      : `→ ${STATE_LABELS[state]} · configuring…`;

    const canEx = app.canExplode();
    explode.disabled = !canEx;
    const exv = app.getExplode();
    if (document.activeElement !== explode) explode.value = String(exv);
    explodeVal.textContent = exv.toFixed(2);

    const winchOK = app.winchAvailable();
    winchLower.disabled = !winchOK;
    winchRaise.disabled = !winchOK;
    winchStatus.textContent = winchOK
      ? `Cable out: ${app.cableMeters().toFixed(1)} m`
      : 'Winch locked — requires Rescue state, door open.';

    const auto = app.turretAuto();
    if (sensorAuto.checked !== auto) sensorAuto.checked = auto;
    sensorYaw.disabled = auto;
    sensorPitch.disabled = auto;

    btnPause.textContent = app.isPaused() ? 'Resume' : 'Pause';
    btnPause.setAttribute('aria-pressed', String(app.isPaused()));

    if (lightSel.value !== app.lightingMode()) lightSel.value = app.lightingMode();
  }

  function updateTelemetry(d) {
    $('t-nacelle').textContent = `${d.nacelleDeg}°`;
    $('t-rpm').textContent = String(d.rotorRpm);
    $('t-gear').textContent = d.gear;
    $('t-sponson').textContent = d.sponson;
    $('t-door').textContent = d.door;
    $('t-cable').textContent = `${d.cable.toFixed(1)} m`;
    $('t-camera').textContent = d.camera;
    $('t-calls').textContent = String(d.calls);
    $('t-tris').textContent = d.tris.toLocaleString('en-US');
    $('t-fps').textContent = String(d.fps);
  }

  function showCard(h) {
    if (!h) { card.hidden = true; return; }
    card.hidden = false;
    cardTitle.textContent = h.title;
    cardBody.textContent = h.body;
  }

  return { refresh, updateTelemetry, showCard };
}
