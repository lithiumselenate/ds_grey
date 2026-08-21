// Asterion HX-9 — deterministic state machine + frame-rate independent animator.
// Channels are rate-limited scalars; interlocks make impossible combinations
// unreachable even when the state changes mid-transition.
import * as THREE from 'three';

export const STATE_NAMES = ['ground', 'hover', 'transition', 'cruise', 'rescue', 'maintenance'];

const TARGETS = {
  ground:      { alt: 0.0, tilt: 0.0, rotor: 0.12, gear: 1, sponson: 1, door: 0, arm: 0, panels: 0, power: 0.55 },
  hover:       { alt: 0.9, tilt: 0.0, rotor: 1.00, gear: 1, sponson: 1, door: 0, arm: 0, panels: 0, power: 1.0 },
  transition:  { alt: 1.2, tilt: 0.5, rotor: 1.00, gear: 0, sponson: 0, door: 0, arm: 0, panels: 0, power: 1.0 },
  cruise:      { alt: 1.4, tilt: 1.0, rotor: 1.00, gear: 0, sponson: 0, door: 0, arm: 0, panels: 0, power: 1.0 },
  rescue:      { alt: 1.0, tilt: 0.0, rotor: 1.00, gear: 1, sponson: 1, door: 1, arm: 1, panels: 0, power: 1.0 },
  maintenance: { alt: 0.0, tilt: 0.0, rotor: 0.00, gear: 1, sponson: 1, door: 1, arm: 0, panels: 1, power: 0.0 },
};

const RATES = {
  alt: 0.45, tilt: 0.22, rotor: 0.3, gear: 0.28, sponson: 0.5, door: 0.55,
  arm: 0.6, cable: 0.3, panels: 0.6, power: 0.9, explode: 0.8,
};

const CHANNEL_KEYS = Object.keys(RATES);
export const MAX_CABLE_M = 3.2;
export const MAX_RPM = 318;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const sm = (v) => v * v * (3 - 2 * v);
const smoothstep = (a, b, v) => sm(clamp01((v - a) / (b - a)));

export class Animator {
  constructor(vehicle) {
    this.v = vehicle;
    this.p = vehicle.parts;
    this.dyn = vehicle.dyn;
    this.gearDoors = vehicle.gearDoors;
    this.reduced = false;
    this.cabinBoost = 1;
    this.state = 'ground';
    this.userCable = 0;
    this.userExplode = 0;
    this.sensor = { auto: true, az: 0, el: -0.31 };
    this._az = 0;
    this._el = -0.31;
    this.simTime = 0;
    this.visAngle = 0;
    this.ch = { ...TARGETS.ground, cable: 0, explode: 0 };
    this._eff = { ...this.ch };
    // cache hot-path references (no per-frame lookups)
    this.bladeMat = this.p.rotorL.getObjectByName('bladesL').material;
    this.discMat = this.p.rotorL.getObjectByName('rotorDiscL').material;
    this.cableMesh = this.p.winch.getObjectByName('winchCable');
    this.drumMesh = this.p.winch.getObjectByName('winchDrum');
    this.navLMat = this.p.wingL.getObjectByName('navL').material;
    this.navRMat = this.p.wingR.getObjectByName('navR').material;
    this.apply();
  }

  setState(name) {
    if (!TARGETS[name]) return false;
    this.state = name;
    if (name !== 'maintenance') this.userExplode = 0;
    if (name !== 'rescue') this.userCable = 0;
    return true;
  }

  requestExplode(v) {
    if (this.state !== 'maintenance') return false;
    this.userExplode = clamp01(v);
    return true;
  }

  canExplode() {
    return this.state === 'maintenance' && this.ch.rotor < 0.02;
  }

  requestCable(v) {
    this.userCable = clamp01(v);
    return this.state === 'rescue';
  }

  setSensor(o) {
    Object.assign(this.sensor, o);
  }

  /* effective targets with interlocks */
  effTargets() {
    const s = TARGETS[this.state];
    const c = this.ch;
    const t = { ...s, cable: 0, explode: 0 };

    // gear/sponson sequencing: sponsons wait for gear up; gear waits for sponsons down
    if (t.sponson < 0.5 && c.gear > 0.3) t.sponson = 1;
    if (t.gear > 0.5 && c.sponson < 0.6) t.gear = 0;

    // winch chain: door -> arm -> cable (and reverse on the way in)
    let cable = this.state === 'rescue' ? this.userCable : 0;
    let arm = t.arm;
    if (arm > 0 && c.door < 0.95) arm = 0;      // arm waits for door
    if (c.cable > 0.02) arm = 1;                 // hold arm while cable is out
    if (cable > 0 && c.arm < 0.97) cable = 0;    // cable waits for arm
    let door = t.door;
    if (c.arm > 0.03 || c.cable > 0.02) door = 1; // hold door while winch is out
    t.cable = cable;
    t.arm = arm;
    t.door = door;

    // exploded view only in maintenance with rotors stopped
    t.explode = this.state === 'maintenance' && c.rotor < 0.02 ? this.userExplode : 0;
    if (c.explode > 0.02) t.rotor = 0;

    // never settle onto the pad with gear up
    if (t.alt < 0.25 && c.alt > 0.3 && c.gear < 0.95) t.alt = 0.35;

    return t;
  }

  step(dt) {
    if (dt > 0) {
      this.simTime += dt;
      const t = this.effTargets();
      this._eff = t;
      for (const k of CHANNEL_KEYS) {
        const cur = this.ch[k];
        const tgt = t[k] !== undefined ? t[k] : cur;
        const d = tgt - cur;
        const mx = RATES[k] * dt;
        this.ch[k] = Math.abs(d) <= mx ? tgt : cur + Math.sign(d) * mx;
      }
      const spin = this.ch.rotor * (this.reduced ? 4 : 42);
      this.visAngle = (this.visAngle + spin * dt) % (Math.PI * 2);
      // sensor smoothing
      const k = Math.min(1, 3 * dt);
      let azT, elT;
      if (this.sensor.auto && this.ch.power > 0.4) {
        azT = Math.sin(this.simTime * 0.45) * 0.9;
        elT = -0.3 + Math.sin(this.simTime * 0.21) * 0.22;
      } else if (!this.sensor.auto) {
        azT = this.sensor.az;
        elT = this.sensor.el;
      } else {
        azT = 0; elT = -0.31;
      }
      this._az += (azT - this._az) * k;
      this._el += (elT - this._el) * k;
    }
    this.apply();
  }

  transitionLabels() {
    const out = [];
    const t = this._eff;
    const pretty = {
      alt: 'altitude', tilt: 'nacelles', rotor: 'rotors', gear: 'gear',
      sponson: 'sponsons', door: 'door', arm: 'winch arm', cable: 'cable',
      panels: 'panels', power: 'power', explode: 'explode',
    };
    for (const k of CHANNEL_KEYS) {
      const tgt = t[k];
      if (tgt === undefined) continue;
      const d = tgt - this.ch[k];
      if (Math.abs(d) > 0.004) out.push(`${pretty[k]} ${d > 0 ? '▲' : '▼'}`);
    }
    return out;
  }

  apply() {
    const c = this.ch;
    const p = this.p;
    const t = this.simTime;
    const red = this.reduced;

    // altitude + hover bob
    let y = c.alt;
    if (!red && c.alt > 0.2 && c.rotor > 0.3) {
      y += Math.sin(t * 0.85) * 0.035 * c.rotor * (1 - 0.6 * c.tilt);
    }
    p.HX9.position.y = y;

    // idle vibration only when rotors are turning
    const rigN = p.vibrationRig;
    if (!red && c.rotor > 0.15) {
      const a = 0.006 * c.rotor;
      rigN.position.y = a * Math.sin(t * 43);
      rigN.position.z = 0.7 * a * Math.sin(t * 31 + 1.7);
      rigN.rotation.x = 0.004 * c.rotor * Math.sin(t * 27);
    } else {
      rigN.position.set(0, 0, 0);
      rigN.rotation.x = 0;
    }

    // nacelle tilt
    const tiltRad = -sm(c.tilt) * Math.PI * 0.5;
    p.nacellePivotL.rotation.z = tiltRad;
    p.nacellePivotR.rotation.z = tiltRad;

    // rotors: spin + blur disc
    p.rotorL.rotation.y = this.visAngle;
    p.rotorR.rotation.y = -this.visAngle;
    const bladeFade = smoothstep(0.55, 1, c.rotor);
    this.bladeMat.opacity = red ? 1 - 0.3 * bladeFade : 1 - 0.55 * bladeFade;
    this.discMat.opacity = smoothstep(0.4, 0.95, c.rotor) * (red ? 0.42 : 0.32);

    // landing gear + doors
    const amt = smoothstep(0.1, 0.92, c.gear);
    const doorAmt = smoothstep(0.02, 0.18, c.gear);
    for (const g of [p.gearNose, p.gearMainL, p.gearMainR]) {
      const rot = (1 - amt) * g.userData.retractRot;
      if (g.userData.retractAxis === 'z') g.rotation.z = rot;
      else g.rotation.x = rot;
    }
    for (const key of ['nose', 'R', 'L']) {
      const d = this.gearDoors[key];
      const rot = doorAmt * d.userData.openRot;
      if (d.userData.openAxis === 'x') d.rotation.x = rot;
      else d.rotation.z = rot;
    }

    // sponsons
    const spAmt = smoothstep(0.05, 0.95, c.sponson);
    for (const nm of ['R', 'L']) {
      const sp = p[`sponson${nm}`];
      sp.position.lerpVectors(sp.userData.posB, sp.userData.posA, spAmt);
      sp.rotation.x = (1 - spAmt) * sp.userData.foldRot;
    }

    // cabin door (gullwing up)
    p.cabinDoor.rotation.x = -1.9 * sm(c.door);

    // winch
    p.winchArm.rotation.y = (Math.PI / 2) * sm(c.arm);
    const cableLen = c.cable * MAX_CABLE_M;
    this.cableMesh.scale.y = Math.max(cableLen, 0.03);
    p.winchHook.position.y = -cableLen;
    this.drumMesh.rotation.z = cableLen * 9;

    // maintenance panels
    const pa = sm(c.panels);
    for (const nm of ['nacellePanelL', 'nacellePanelR']) {
      const g = p[nm];
      g.rotation.y = pa * g.userData.openRot;
    }
    p.nosePanel.rotation.z = pa * p.nosePanel.userData.openRot;

    // lights
    const pw = c.power;
    const on = pw > 0.45;
    this.dyn.dash.emissiveIntensity = 0.1 + pw * 1.0;
    this.dyn.cabinLight.emissiveIntensity = (0.1 + 1.6 * pw) * this.cabinBoost;
    this.dyn.landingLight.emissiveIntensity = on && c.gear > 0.5 ? 2.4 : 0;
    const navBase = on ? 1.6 : 0.05;
    const st = t % 1.3;
    this.dyn.strobe.emissiveIntensity = on && st < 0.06 ? 5 : 0.02;
    const b = t % 2;
    this.dyn.beacon.emissiveIntensity = on && (b < 0.08 || (b > 0.18 && b < 0.26)) ? 4 : 0.05;
    this.navLMat.emissiveIntensity = navBase;
    this.navRMat.emissiveIntensity = navBase;

    // sensor turret
    p.turretYaw.rotation.y = this._az;
    p.turretBall.rotation.z = this._el;

    // exploded view (positions derive exactly from stored bases)
    const e = c.explode;
    for (const set of this.v.explodeSets) {
      set.object.position.copy(set.base).addScaledVector(set.dir, set.dist * e);
    }
  }

  reset() {
    this.state = 'ground';
    this.userCable = 0;
    this.userExplode = 0;
    this.sensor = { auto: true, az: 0, el: -0.31 };
    this._az = 0;
    this._el = -0.31;
    this.simTime = 0;
    this.visAngle = 0;
    this.ch = { ...TARGETS.ground, cable: 0, explode: 0 };
    this._eff = { ...this.ch };
    this.apply();
  }

  snapshot() {
    const c = this.ch;
    const r = (v) => Math.round(v * 1000) / 1000;
    const chans = {};
    for (const k of CHANNEL_KEYS) chans[k] = r(c[k]);
    return {
      state: this.state,
      transitioning: this.transitionLabels(),
      channels: chans,
      nacelleDeg: Math.round(c.tilt * 90),
      rotorRpm: Math.round(c.rotor * MAX_RPM),
      cableM: r(c.cable * MAX_CABLE_M),
      explode: r(c.explode),
      sensor: { auto: this.sensor.auto, az: r(this._az), el: r(this._el) },
      simTime: r(this.simTime),
      reducedMotion: this.reduced,
    };
  }
}

export { TARGETS, RATES, smoothstep };
