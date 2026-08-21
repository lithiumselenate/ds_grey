// animation.js — deterministic state machine, channel integrator and pose application.
// All motion is frame-rate independent; poses are recomputed from authored home
// transforms every frame, so explode=0 restores originals with zero drift.
import * as THREE from 'three';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;

export const STATE_ORDER = ['ground', 'hover', 'transition', 'cruise', 'rescue', 'maintenance'];

export const STATE_DEFS = {
  ground:      { nacelle: 0.0, rpm: 0.12, gear: 1, sponson: 1, door: 0, alt: 0.0, power: 0.35 },
  hover:       { nacelle: 0.0, rpm: 1.0,  gear: 1, sponson: 1, door: 0, alt: 0.6, power: 0.7 },
  transition:  { nacelle: 0.5, rpm: 1.0,  gear: 0, sponson: 0, door: 0, alt: 0.85, power: 0.7 },
  cruise:      { nacelle: 1.0, rpm: 0.85, gear: 0, sponson: 0, door: 0, alt: 1.0, power: 0.7 },
  rescue:      { nacelle: 0.0, rpm: 1.0,  gear: 1, sponson: 1, door: 1, alt: 0.6, power: 1.0 },
  maintenance: { nacelle: 0.15, rpm: 0.0, gear: 1, sponson: 1, door: 1, alt: 0.0, power: 0.15 },
};

const CHANNELS = ['nacelle', 'rpm', 'gear', 'gearDoors', 'sponson', 'door',
  'cable', 'arm', 'panels', 'alt', 'power', 'explode'];

const RATES = {
  nacelle: 0.22, rpm: 0.3, gear: 0.45, gearDoors: 1.1, sponson: 0.5, door: 0.7,
  cable: 0.4, arm: 0.8, panels: 0.7, alt: 0.35, power: 1.5, explode: 0.8,
};

const AXIS = { x: 'x', y: 'y', z: 'z' };
const T1 = new THREE.Vector3(), T2 = new THREE.Vector3(), T3 = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

function moveToward(v, t, rate, dt) {
  const d = t - v;
  const step = rate * dt;
  if (Math.abs(d) <= step) return t;
  return v + Math.sign(d) * step;
}

export class Animator {
  constructor(vehicle, M) {
    this.v = vehicle;
    this.M = M;
    this.state = 'ground';
    this.userExplode = 0;
    this.userCable = 0;
    this.turret = { auto: true, yaw: 0, pitch: -0.2 };
    this.turretCur = { yaw: 0, pitch: -0.2 };
    this.t = 0;
    this.spin = 0;
    this.prevCable = 0;
    this.reducedMotion = false;
    this.emissiveBoost = 1;

    this.ch = {};
    for (const k of CHANNELS) this.ch[k] = { v: 0 };
    this.tgt = {};
    for (const k of CHANNELS) this.tgt[k] = 0;

    // Build the position-driven node list (rig positional deltas + explode vectors).
    const map = new Map();
    const entry = (name) => {
      const node = vehicle.parts[name];
      if (!node) throw new Error(`Animator: missing part "${name}"`);
      if (!map.has(name)) {
        map.set(name, { name, node, home: node.position.clone(), binds: [], ex: null });
      }
      return map.get(name);
    };
    this.rotRig = [];
    this.sclRig = [];
    for (const r of vehicle.rig) {
      const node = vehicle.parts[r.n];
      if (!node) throw new Error(`Animator: missing rig node "${r.n}"`);
      if (r.p[0] === 'r') this.rotRig.push({ node, ax: AXIS[r.p[1]], a: r.a, b: r.b, c: r.c });
      else if (r.p[0] === 's') this.sclRig.push({ node, ax: AXIS[r.p[1]], a: r.a, b: r.b, c: r.c });
      else entry(r.n).binds.push({ ax: AXIS[r.p[1]], a: r.a, b: r.b, c: r.c });
    }
    for (const e of vehicle.explodables) entry(e.n).ex = { dir: e.dir, dist: e.dist };
    this.posList = [...map.values()];

    this.applyStateInstant('ground');
  }

  setState(name) {
    if (!STATE_DEFS[name]) return false;
    this.state = name;
    return true;
  }
  canExplode() {
    return this.state === 'maintenance' && this.ch.rpm.v < 0.02;
  }
  setExplode(x) {
    this.userExplode = clamp(Number(x) || 0, 0, 1);
    return this.canExplode();
  }
  setCable(x) {
    this.userCable = clamp(Number(x) || 0, 0, 1);
    return this.state === 'rescue';
  }

  applyStateInstant(name) {
    const S = STATE_DEFS[name];
    this.state = name;
    const c = this.ch;
    c.nacelle.v = S.nacelle; c.rpm.v = S.rpm; c.gear.v = S.gear;
    c.gearDoors.v = S.gear > 0 ? 1 : 0;
    c.sponson.v = S.sponson; c.door.v = S.door;
    c.cable.v = 0; c.arm.v = 0;
    c.panels.v = name === 'maintenance' ? 1 : 0;
    c.alt.v = S.alt; c.power.v = S.power; c.explode.v = 0;
    this.userExplode = 0; this.userCable = 0;
    this.spin = 0; this.t = 0; this.prevCable = 0;
    this.turret = { auto: true, yaw: 0, pitch: -0.2 };
    this.turretCur = { yaw: 0, pitch: -0.2 };
    Object.assign(this.tgt, {
      nacelle: S.nacelle, rpm: S.rpm, gear: S.gear, gearDoors: c.gearDoors.v,
      sponson: S.sponson, door: S.door, cable: 0, arm: 0,
      panels: c.panels.v, alt: S.alt, power: S.power, explode: 0,
    });
  }
  reset() { this.applyStateInstant('ground'); }

  isSettled() {
    for (const k of CHANNELS) {
      if (Math.abs(this.ch[k].v - this.tgt[k]) > 0.012) return false;
    }
    return true;
  }

  update(dt) {
    this.t += dt;
    const S = STATE_DEFS[this.state];
    const c = this.ch, T = this.tgt;

    T.nacelle = S.nacelle;
    T.alt = S.alt;
    T.power = S.power;
    T.sponson = S.sponson;
    T.panels = (this.state === 'maintenance' && c.rpm.v < 0.05) ? 1 : 0;
    T.explode = this.canExplode() ? this.userExplode : 0;
    T.rpm = (c.explode.v > 0.02 || c.panels.v > 0.05) ? 0 : S.rpm;
    T.arm = (this.state === 'rescue' && c.door.v > 0.9) ? 1 : 0;
    if (T.arm < c.arm.v && c.cable.v > 0.02) T.arm = c.arm.v; // no fold with cable out
    T.cable = (this.state === 'rescue' && c.door.v > 0.95 && c.arm.v > 0.9) ? this.userCable : 0;
    T.door = S.door;
    if (T.door < c.door.v - 0.001 && (c.cable.v > 0.02 || c.arm.v > 0.05)) T.door = c.door.v;
    T.gearDoors = (c.gear.v > 0.02 || S.gear > 0.5) ? 1 : 0;
    T.gear = (c.gearDoors.v > 0.9) ? S.gear : c.gear.v;

    for (const k of CHANNELS) {
      let rate = RATES[k];
      if (k === 'rpm' && T.rpm < c.rpm.v) rate = 0.5;
      c[k].v = moveToward(c[k].v, T[k], rate, dt);
    }
    this.spin = (this.spin + dt * c.rpm.v * 26) % (Math.PI * 2);
  }

  computePos(e, out) {
    out.copy(e.home);
    for (const b of e.binds) out[b.ax] += lerp(b.a, b.b, this.ch[b.c].v);
    if (e.ex) out.addScaledVector(e.ex.dir, this.ch.explode.v * e.ex.dist);
    return out;
  }

  apply() {
    const P = this.v.parts, c = this.ch, M = this.M, t = this.t;

    for (const r of this.rotRig) r.node.rotation[r.ax] = lerp(r.a, r.b, c[r.c].v);
    for (const s of this.sclRig) s.node.scale[s.ax] = Math.max(lerp(s.a, s.b, c[s.c].v), 0.02);
    for (const e of this.posList) e.node.position.copy(this.computePos(e, T1));

    // rotors + motion disc
    P.rotorR.rotation.y = this.spin;
    P.rotorL.rotation.y = -this.spin;
    const rpm = c.rpm.v;
    M.blade.opacity = 1 - smoothstep(rpm, 0.55, 0.95) * 0.85;
    M.disc.opacity = smoothstep(rpm, 0.5, 0.9) * 0.5;

    // winch cable, hook, drum
    const len = lerp(0.02, 3.0, c.cable.v);
    P.hook.position.y = -len - 0.04;
    P.winchDrum.rotation.x += (c.cable.v - this.prevCable) * 34;
    this.prevCable = c.cable.v;

    // lighting-driven emissives
    const powerOn = smoothstep(c.power.v, 0.1, 0.35);
    const eb = this.emissiveBoost;
    M.navRed.emissiveIntensity = 2.4 * powerOn * eb;
    M.navGreen.emissiveIntensity = 2.4 * powerOn * eb;
    const sPh = t % 1.4;
    M.strobe.emissiveIntensity = powerOn * ((sPh < 0.06 || (sPh > 0.16 && sPh < 0.22)) ? 4 : 0);
    M.beacon.emissiveIntensity = powerOn * (((t % 0.9) < 0.12) ? 4 : 0.15) * eb;
    M.cabinLight.emissiveIntensity = c.power.v * 2.1 * eb;
    M.screen.emissiveIntensity = powerOn * 1.5 * eb;
    M.statusCyan.emissiveIntensity = (0.4 + powerOn * 1.4) * eb;

    // sensor turret: auto scan or rate-limited manual pointing
    let yawT, pitchT;
    if (this.turret.auto && powerOn > 0.4 && !this.reducedMotion) {
      yawT = Math.sin(t * 0.5) * 0.85;
      pitchT = -0.28 + Math.sin(t * 0.23) * 0.16;
    } else {
      yawT = this.turret.yaw;
      pitchT = this.turret.pitch;
    }
    this.turretCur.yaw = moveToward(this.turretCur.yaw, yawT, 1.1, 1 / 60);
    this.turretCur.pitch = moveToward(this.turretCur.pitch, pitchT, 1.1, 1 / 60);
    P.turretYaw.rotation.y = this.turretCur.yaw;
    P.turretPitch.rotation.x = this.turretCur.pitch;

    // tilt actuators track their nacelle anchors through tilt and explode
    for (const s of ['R', 'L']) {
      const rod = P['actRod' + s], anchor = P['actAnchor' + s];
      anchor.getWorldPosition(T2);
      rod.parent.updateWorldMatrix(true, false);
      rod.parent.worldToLocal(T2);
      T3.copy(T2).sub(rod.position);
      const L = Math.max(T3.length(), 0.05);
      rod.quaternion.setFromUnitVectors(UPV, T3.normalize());
      rod.scale.set(1, L, 1);
    }

    // root altitude, bob and mechanical vibration
    const root = this.v.root;
    const alt = c.alt.v;
    let y = this.v.baseY + alt * 1.15;
    if (!this.reducedMotion) {
      y += Math.sin(t * 1.15) * 0.045 * alt * Math.min(rpm * 2, 1);
      if (rpm > 0.25) {
        const a = 0.0035 * rpm;
        root.position.x = Math.sin(t * 57.3) * a;
        root.position.z = Math.cos(t * 49.1) * a;
      } else {
        root.position.x = 0; root.position.z = 0;
      }
    } else {
      root.position.x = 0; root.position.z = 0;
    }
    root.position.y = y;
  }

  snapshot() {
    const chans = {};
    for (const k of CHANNELS) chans[k] = Math.round(this.ch[k].v * 1000) / 1000;
    return {
      state: this.state,
      settled: this.isSettled(),
      channels: chans,
      userExplode: this.userExplode,
      userCable: this.userCable,
      turret: { auto: this.turret.auto, yaw: this.turretCur.yaw, pitch: this.turretCur.pitch },
      rotorRpm: Math.round(this.ch.rpm.v * 1450),
      nacelleDeg: Math.round(this.ch.nacelle.v * 90),
      time: Math.round(this.t * 100) / 100,
    };
  }
}
