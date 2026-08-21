/**
 * ui.js — semantic, keyboard-operable technical UI for the HX-9 viewer.
 * The DOM is authored in index.html; this module wires it, keeps ARIA state
 * honest, throttles telemetry writes and owns the hotspot marker overlay.
 */

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.el = {
      stateRadios: Array.from(document.querySelectorAll('input[name="hx9state"]')),
      lightRadios: Array.from(document.querySelectorAll('input[name="hx9light"]')),
      camButtons: Array.from(document.querySelectorAll('[data-cam]')),
      transition: $('transition-indicator'),
      explode: $('explode'),
      explodeOut: $('explode-out'),
      hoistDown: $('btn-hoist-down'),
      hoistUp: $('btn-hoist-up'),
      hoistStow: $('btn-hoist-stow'),
      az: $('sensor-az'),
      azOut: $('sensor-az-out'),
      el2: $('sensor-el'),
      elOut: $('sensor-el-out'),
      scan: $('btn-scan'),
      pause: $('btn-pause'),
      reset: $('btn-reset'),
      motion: $('btn-motion'),
      help: $('btn-help'),
      helpDialog: $('help'),
      helpClose: $('help-close'),
      list: $('hotspot-list'),
      hsTitle: $('hs-title'),
      hsBody: $('hs-body'),
      markers: $('markers'),
      boot: $('boot'),
      t: {
        nacelle: $('t-nacelle'), rpm: $('t-rpm'), gear: $('t-gear'), sponson: $('t-sponson'),
        door: $('t-door'), cable: $('t-cable'), cam: $('t-cam'), calls: $('t-calls'),
        tris: $('t-tris'), fps: $('t-fps')
      }
    };
    this.markerEls = [];
    this.activeHotspot = null;
    this._lastTel = 0;
    this._bind();
  }

  _bind() {
    const h = this.h;
    this.el.stateRadios.forEach((r) => r.addEventListener('change', () => r.checked && h.onState(r.value)));
    this.el.lightRadios.forEach((r) => r.addEventListener('change', () => r.checked && h.onLight(r.value)));
    this.el.camButtons.forEach((b) => b.addEventListener('click', () => h.onCamera(b.dataset.cam)));

    this.el.explode.addEventListener('input', () => h.onExplode(parseFloat(this.el.explode.value)));
    this.el.hoistDown.addEventListener('click', () => h.onHoist(1));
    this.el.hoistUp.addEventListener('click', () => h.onHoist(-1));
    this.el.hoistStow.addEventListener('click', () => h.onHoist(0));

    const sensor = () => h.onSensor(parseFloat(this.el.az.value), parseFloat(this.el2v()));
    this.el.az.addEventListener('input', sensor);
    this.el.el2.addEventListener('input', sensor);
    this.el.scan.addEventListener('click', () => h.onScan(this.el.scan.getAttribute('aria-pressed') !== 'true'));

    this.el.pause.addEventListener('click', () => h.onPause());
    this.el.reset.addEventListener('click', () => h.onReset());
    this.el.motion.addEventListener('click', () => h.onReducedMotion(this.el.motion.getAttribute('aria-pressed') !== 'true'));
    this.el.help.addEventListener('click', () => this.openHelp());
    this.el.helpClose.addEventListener('click', () => this.el.helpDialog.close());

    window.addEventListener('keydown', (e) => this._key(e));
  }

  el2v() { return this.el.el2.value; }

  _key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Escape') { if (this.el.helpDialog.open) this.el.helpDialog.close(); return; }
    if (typing) return;
    const h = this.h;
    const states = { 1: 'ground', 2: 'hover', 3: 'transition', 4: 'cruise', 5: 'rescue', 6: 'maintenance' };
    const cams = { q: 'threequarter', f: 'front', p: 'port', s: 'starboard', t: 'top', c: 'cockpit', w: 'winch' };
    const k = e.key.toLowerCase();
    if (states[e.key]) { h.onState(states[e.key]); e.preventDefault(); return; }
    if (cams[k]) { h.onCamera(cams[k]); e.preventDefault(); return; }
    if (k === 'l') { h.onLightCycle(); e.preventDefault(); return; }
    if (k === 'e') { h.onExplodeToggle(); e.preventDefault(); return; }
    if (k === ']') { h.onHoist(1); e.preventDefault(); return; }
    if (k === '[') { h.onHoist(-1); e.preventDefault(); return; }
    if (k === 'r') { h.onReset(); e.preventDefault(); return; }
    if (k === 'm') { h.onReducedMotion(this.el.motion.getAttribute('aria-pressed') !== 'true'); e.preventDefault(); return; }
    if (k === 'h') { this.openHelp(); e.preventDefault(); return; }
    if (e.key === ' ' && tag !== 'BUTTON') { h.onPause(); e.preventDefault(); }
  }

  openHelp() {
    if (typeof this.el.helpDialog.showModal === 'function') this.el.helpDialog.showModal();
    else this.el.helpDialog.setAttribute('open', '');
  }

  removeBoot() { if (this.el.boot) { this.el.boot.remove(); this.el.boot = null; } }

  /* ---------------- hotspots ---------------- */

  buildHotspots(hotspots) {
    const frag = document.createDocumentFragment();
    hotspots.forEach((hs, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${String(i + 1).padStart(2, '0')} · ${hs.label}`;
      b.setAttribute('aria-pressed', 'false');
      b.dataset.hotspot = hs.id;
      b.addEventListener('click', () => this.h.onHotspot(hs.id));
      li.appendChild(b);
      frag.appendChild(li);

      const m = document.createElement('div');
      m.className = 'marker';
      m.textContent = String(i + 1);
      m.style.display = 'none';
      this.el.markers.appendChild(m);
      this.markerEls.push(m);
    });
    this.el.list.appendChild(frag);
  }

  positionMarker(i, x, y, visible, active) {
    const m = this.markerEls[i];
    if (!m) return;
    if (!visible) { if (m.style.display !== 'none') m.style.display = 'none'; return; }
    if (m.style.display !== 'block') m.style.display = 'block';
    m.style.left = `${x.toFixed(1)}px`;
    m.style.top = `${y.toFixed(1)}px`;
    const a = active ? 'true' : 'false';
    if (m.dataset.active !== a) m.dataset.active = a;
  }

  setHotspot(hs) {
    this.activeHotspot = hs ? hs.id : null;
    this.el.list.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', hs && b.dataset.hotspot === hs.id ? 'true' : 'false');
    });
    this.el.hsTitle.textContent = hs ? hs.label : 'No point selected';
    this.el.hsBody.textContent = hs ? hs.text
      : 'Choose an inspection point to focus the camera and read its mechanical purpose.';
  }

  /* ---------------- control state ---------------- */

  setState(name) {
    this.el.stateRadios.forEach((r) => { r.checked = r.value === name; });
  }

  setLight(mode) {
    this.el.lightRadios.forEach((r) => { r.checked = r.value === mode; });
  }

  setCamera(name) {
    this.el.camButtons.forEach((b) => b.setAttribute('aria-pressed', b.dataset.cam === name ? 'true' : 'false'));
    this.el.t.cam.textContent = name;
  }

  setExplodeValue(v) {
    if (document.activeElement !== this.el.explode) this.el.explode.value = String(v);
    this.el.explodeOut.textContent = `${Math.round(v * 100)}%`;
  }

  setExplodeEnabled(on) {
    this.el.explode.disabled = !on;
    this.el.explode.setAttribute('aria-disabled', on ? 'false' : 'true');
  }

  setHoistEnabled(on) {
    [this.el.hoistDown, this.el.hoistUp, this.el.hoistStow].forEach((b) => { b.disabled = !on; });
  }

  setSensorEnabled(on) {
    [this.el.az, this.el.el2].forEach((s) => { s.disabled = !on; });
    this.el.scan.disabled = !on;
  }

  setSensor(az, el, autoScan) {
    if (document.activeElement !== this.el.az) this.el.az.value = String(Math.round(az));
    if (document.activeElement !== this.el.el2) this.el.el2.value = String(Math.round(el));
    this.el.azOut.textContent = `${Math.round(az)}°`;
    this.el.elOut.textContent = `${Math.round(el)}°`;
    this.el.scan.setAttribute('aria-pressed', autoScan ? 'true' : 'false');
  }

  setPaused(p) {
    this.el.pause.setAttribute('aria-pressed', p ? 'true' : 'false');
    this.el.pause.firstChild.textContent = p ? 'Resume ' : 'Pause ';
  }

  setReducedMotion(on) {
    this.el.motion.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  setTransition(text, moving) {
    this.el.transition.textContent = text;
    this.el.transition.dataset.moving = moving ? 'true' : 'false';
  }

  /** Throttled: telemetry text is refreshed about eight times a second. */
  setTelemetry(snap, perf, now) {
    if (now - this._lastTel < 125) return;
    this._lastTel = now;
    const t = this.el.t;
    t.nacelle.textContent = `${snap.nacelleAngleDeg.toFixed(1)}°`;
    t.rpm.textContent = `${Math.round(snap.rotorRpm)} rpm`;
    t.gear.textContent = snap.gear === 'down' ? `down · doors ${snap.gearDoors}` : `${snap.gear} · doors ${snap.gearDoors}`;
    t.sponson.textContent = snap.sponsons;
    t.door.textContent = snap.door;
    t.cable.textContent = `${snap.cableMetres.toFixed(2)} m`;
    t.calls.textContent = String(perf.calls);
    t.tris.textContent = perf.triangles.toLocaleString('en-US');
    t.fps.textContent = perf.fps.toFixed(0);
  }
}
