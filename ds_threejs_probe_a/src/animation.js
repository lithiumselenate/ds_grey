/**
 * animation.js — deterministic state machine and frame-rate independent
 * mechanism animation for the Asterion HX-9.
 *
 * One authored table defines every legal configuration. Continuous values
 * chase their targets with eased, rate-limited motion, so selecting a new
 * state mid-transition is always valid: nothing is scripted as a timeline.
 */

import * as THREE from 'three';

const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;
const RPM_MAX = 332;                      // rotor design speed, rev/min
const RPM_RADS = (RPM_MAX * Math.PI * 2) / 60;

export const STATE_NAMES = ['ground', 'hover', 'transition', 'cruise', 'rescue', 'maintenance'];

/**
 * tilt      0 = proprotors vertical, 1 = fully forward
 * rpm       normalised rotor speed
 * gear      1 = down and locked
 * sponson   1 = extended for water operations
 * door      1 = rescue door fully open
 * winch     1 = hoist boom slewed outboard
 * panels    1 = service covers open
 * powered   1 = avionics and lighting live
 */
export const STATES = {
  ground: { tilt: 0.0, rpm: 0.0, gear: 1, sponson: 1, door: 0, winch: 0, panels: 0, powered: 1, explodeAllowed: false },
  hover: { tilt: 0.0, rpm: 1.0, gear: 1, sponson: 1, door: 0, winch: 0, panels: 0, powered: 1, explodeAllowed: false },
  transition: { tilt: 0.5, rpm: 1.0, gear: 0, sponson: 0.5, door: 0, winch: 0, panels: 0, powered: 1, explodeAllowed: false },
  cruise: { tilt: 1.0, rpm: 0.94, gear: 0, sponson: 0, door: 0, winch: 0, panels: 0, powered: 1, explodeAllowed: false },
  rescue: { tilt: 0.0, rpm: 0.9, gear: 1, sponson: 1, door: 1, winch: 1, panels: 0, powered: 1, explodeAllowed: false },
  maintenance: { tilt: 0.14, rpm: 0.0, gear: 1, sponson: 1, door: 1, winch: 0, panels: 1, powered: 0, explodeAllowed: true }
};

/* mechanism rate limits, units per second */
const RATE = {
  tilt: 0.19, gear: 0.3, gearDoor: 0.55, sponson: 0.32, door: 0.55,
  winch: 0.5, panels: 0.4, cable: 0.55, explode: 0.85, rpmUp: 0.24, rpmDown: 0.18, light: 1.6
};

export const CABLE_MAX = 1.4;   // clamped so the basket clears the hangar deck

/** Eased, rate-limited approach with an exact terminal snap (no drift). */
function approach(cur, tgt, rate, dt) {
  const d = tgt - cur;
  const ad = Math.abs(d);
  if (ad < 1e-5) return tgt;
  const max = rate * dt;
  let step = d * (1 - Math.exp(-5.5 * dt));
  if (Math.abs(step) > max) step = Math.sign(d) * max;
  if (ad <= Math.abs(step) + 1e-5) return tgt;
  return cur + step;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Animator {
  constructor(assets, refs, explodeGroups, hotspots) {
    this.A = assets;
    this.refs = refs;
    this.explodeGroups = explodeGroups;
    this.hotspots = hotspots;
    this.time = 0;
    this.state = 'ground';
    this.reducedMotion = false;
    this.autoScan = true;
    this.sensorAz = 0;
    this.sensorEl = -8;
    this.rotorAngle = 0;
    this.cableRequest = 0;

    this.v = {
      tilt: 0, rpm: 0, gear: 1, gearDoor: 1, sponson: 1, door: 0,
      winch: 0, panels: 0, cable: 0, explode: 0, cabin: 0.45, avionics: 0.6
    };
    this.explodeRequest = 0;

    /* dedicated light materials so blink groups never share intensity */
    this._ownMaterials = [];
    for (const b of refs.beacons) {
      b.material = b.material.clone();
      this._ownMaterials.push(b.material);
      assets.materials.push(b.material);
    }
    for (const n of refs.navLights) {
      n.material = n.material.clone();
      this._ownMaterials.push(n.material);
      assets.materials.push(n.material);
    }

    this.applyImmediate('ground');
  }

  /* ------------------------------------------------------------ */

  setState(name) {
    if (!STATES[name]) return false;
    this.state = name;
    if (name !== 'maintenance') this.explodeRequest = 0;
    if (name !== 'rescue') this.cableRequest = 0;
    return true;
  }

  setExplodeRequest(value) {
    const v = Math.min(1, Math.max(0, Number(value) || 0));
    this.explodeRequest = this.explodeAllowed() ? v : 0;
    return this.explodeRequest;
  }

  setCableRequest(metres) {
    const m = Math.min(CABLE_MAX, Math.max(0, Number(metres) || 0));
    this.cableRequest = this.hoistAllowed() ? m : 0;
    return this.cableRequest;
  }

  explodeAllowed() {
    return STATES[this.state].explodeAllowed && this.v.rpm < 0.02;
  }

  hoistAllowed() {
    return this.state === 'rescue' && this.v.door > 0.9 && this.v.winch > 0.75;
  }

  targets() {
    return STATES[this.state];
  }

  isMoving() {
    const t = this.targets();
    const v = this.v;
    const gearDoorTarget = (t.gear > 0.02 || v.gear > 0.02) ? 1 : 0;
    return Math.abs(v.tilt - t.tilt) > 0.004 || Math.abs(v.rpm - t.rpm) > 0.01 ||
      Math.abs(v.gear - t.gear) > 0.004 || Math.abs(v.gearDoor - gearDoorTarget) > 0.004 ||
      Math.abs(v.sponson - t.sponson) > 0.004 || Math.abs(v.door - t.door) > 0.004 ||
      Math.abs(v.winch - t.winch) > 0.004 || Math.abs(v.panels - t.panels) > 0.004 ||
      Math.abs(v.cable - this.cableRequest) > 0.01 ||
      Math.abs(v.explode - (this.explodeAllowed() ? this.explodeRequest : 0)) > 0.004;
  }

  /** Snap every mechanism to a state — used by reset(). */
  applyImmediate(name) {
    if (STATES[name]) this.state = name;
    const t = this.targets();
    const v = this.v;
    v.tilt = t.tilt; v.rpm = t.rpm; v.gear = t.gear; v.sponson = t.sponson;
    v.door = t.door; v.winch = t.winch; v.panels = t.panels;
    v.gearDoor = t.gear > 0.02 ? 1 : 0;
    v.cable = 0; v.explode = 0;
    v.cabin = t.powered ? 0.45 : 0.0;
    v.avionics = t.powered ? 0.6 : 0.0;
    this.explodeRequest = 0;
    this.cableRequest = 0;
    this.rotorAngle = 0;
    this.time = 0;
    this.sensorAz = 0;
    this.sensorEl = -8;
    this.autoScan = true;
    this.update(0);
  }

  /* ------------------------------------------------------------ */

  update(dtRaw) {
    const dt = Math.min(0.05, Math.max(0, dtRaw));
    this.time += dt;
    const t = this.targets();
    const v = this.v;
    const rpmCap = this.reducedMotion ? 0.3 : 1.0;

    /* --- interlocks resolved before any motion --- */
    const gearDoorTarget = (t.gear > 0.001 || v.gear > 0.001) ? 1 : 0;
    const explodeTarget = this.explodeAllowed() ? this.explodeRequest : 0;
    const cableTarget = this.hoistAllowed() ? this.cableRequest : 0;
    const rpmTarget = (this.v.explode > 0.005 || explodeTarget > 0) ? 0 : Math.min(t.rpm, rpmCap);

    v.gearDoor = approach(v.gearDoor, gearDoorTarget, RATE.gearDoor, dt);
    /* bay doors lead the legs out; only the last millimetres of the tuck may
       finish while the doors are already swinging shut */
    if (v.gearDoor > 0.92 || (t.gear < 0.02 && v.gear < 0.03)) {
      v.gear = approach(v.gear, t.gear, RATE.gear, dt);
    }
    v.tilt = approach(v.tilt, t.tilt, RATE.tilt, dt);
    v.sponson = approach(v.sponson, t.sponson, RATE.sponson, dt);
    /* the door cannot close and the boom cannot stow over a lowered basket */
    const cableOut = v.cable > 0.02 || cableTarget > 0.02;
    v.door = approach(v.door, cableOut ? Math.max(t.door, 0.98) : t.door, RATE.door, dt);
    v.winch = approach(v.winch, cableOut ? Math.max(t.winch, 0.98) : t.winch, RATE.winch, dt);
    v.panels = approach(v.panels, t.panels, RATE.panels, dt);
    v.cable = approach(v.cable, cableTarget, RATE.cable, dt);
    v.explode = approach(v.explode, explodeTarget, RATE.explode, dt);
    v.rpm = approach(v.rpm, rpmTarget, rpmTarget > v.rpm ? RATE.rpmUp : RATE.rpmDown, dt);
    v.cabin = approach(v.cabin, t.powered ? (this.state === 'rescue' ? 0.85 : 0.45) : 0, RATE.light, dt);
    v.avionics = approach(v.avionics, t.powered ? 0.7 : 0, RATE.light, dt);

    this._applyMechanisms(dt);
    this._applyLights();
    this._applyExplode(v.explode);
  }

  _applyMechanisms(dt) {
    const v = this.v;
    const refs = this.refs;

    /* nacelle tilt + visible actuator travel */
    for (const n of refs.nacelles) {
      n.pivot.rotation.z = -v.tilt * HALF_PI;
      const ext = 0.55 + v.tilt * 0.55;
      n.rod.scale.y = ext;
      n.rod.position.x = ext * 0.5;
    }

    /* rotor speed, direction, blade/disc treatment */
    this.rotorAngle += v.rpm * RPM_RADS * dt;
    if (this.rotorAngle > Math.PI * 2) this.rotorAngle -= Math.PI * 2;
    const discOpacity = smoothstep(0.18, 0.62, v.rpm) * 0.9;
    for (const n of refs.nacelles) {
      n.spin.rotation.y = this.rotorAngle * (n.side > 0 ? 1 : -1);
      const bladesVisible = v.rpm < 0.5;
      n.blades.visible = bladesVisible;
      n.cuffs.visible = true;
      n.disc.visible = v.rpm > 0.06;
      n.disc.material.opacity = discOpacity;
    }

    /* gear legs and bay doors */
    for (const g of refs.gear) {
      g.pivot.rotation[g.axis] = (1 - v.gear) * g.retractAngle;
      g.doorHinge.rotation.x = v.gearDoor * g.doorAngle;
    }

    /* sponsons tuck up and inboard */
    for (const s of refs.sponsons) {
      s.pivot.rotation.x = (1 - v.sponson) * s.side * 0.95;
      s.pivot.position.y = -0.28 + (1 - v.sponson) * 0.1;
    }

    /* sliding rescue door */
    refs.doorSlider.position.x = -1.06 * v.door;
    refs.doorSlider.position.z = 0.13 * v.door;

    /* winch boom, drum, cable, hook and basket */
    refs.winchArm.rotation.y = -HALF_PI * (1 - v.winch);
    refs.winchDrum.rotation.x = -v.cable * 6.5;
    const len = Math.max(0.02, v.cable);
    refs.winchCable.scale.y = len;
    refs.winchCable.position.y = -len / 2;
    refs.winchLoad.position.y = -len;
    const sway = this.reducedMotion ? 0 : Math.sin(this.time * 0.9) * 0.012 * v.cable;
    refs.winchLoad.rotation.z = sway;
    refs.winchLoad.rotation.y = Math.sin(this.time * 0.35) * 0.25 * (v.cable > 0.05 ? 1 : 0);

    /* service covers */
    for (const p of refs.panels) {
      const a = v.panels * p.open;
      if (p.axis === 'z') p.hinge.rotation.x = a * p.sign;
      else p.hinge.rotation.z = a;
    }

    /* sensor turret: scan or manual pointing */
    if (this.autoScan && this.targets().powered) {
      const s = this.reducedMotion ? 0.15 : 0.42;
      this.sensorAz = Math.sin(this.time * s) * 62;
      this.sensorEl = -12 + Math.sin(this.time * s * 1.9) * 7;
    }
    refs.turretYaw.rotation.y = this.sensorAz * DEG;
    refs.turretPitch.rotation.z = this.sensorEl * DEG;

    /* idle vibration only when the rotors are actually turning */
    const amp = (this.reducedMotion ? 0 : 1) * Math.max(0, (v.rpm - 0.18) / 0.82);
    const tt = this.time;
    refs.vibration.position.y = Math.sin(tt * 58.0) * 0.0017 * amp + Math.sin(tt * 37.3) * 0.0011 * amp;
    refs.vibration.position.x = Math.sin(tt * 41.7) * 0.0009 * amp;
    refs.vibration.rotation.z = Math.sin(tt * 44.1) * 0.0008 * amp;
    refs.vibration.rotation.x = Math.sin(tt * 27.5) * 0.0006 * amp;
  }

  _applyLights() {
    const v = this.v;
    const M = this.A.mats;
    const powered = this.targets().powered === 1;

    M.emCabin.emissiveIntensity = v.cabin * 1.4;
    M.emPanel.emissiveIntensity = v.avionics * 1.1;
    M.emExhaust.emissiveIntensity = v.rpm * 0.75;

    /* navigation lights: steady while powered, port red / starboard green */
    for (const n of this.refs.navLights) n.material.emissiveIntensity = powered ? 1.6 : 0.05;

    /* anti-collision: two independent flash periods, deterministic in sim time */
    const t = this.time;
    const upper = ((t * 0.85) % 1) < 0.1 ? 3.4 : 0.06;
    const lower = ((t * 0.85 + 0.5) % 1) < 0.07 ? 2.6 : 0.05;
    this.refs.beacons.forEach((b, i) => {
      b.material.emissiveIntensity = powered ? (i === 0 ? upper : lower) : 0.02;
    });
    for (const l of this.refs.statusLeds) l.visible = powered;
    if (this.refs.landingLight) {
      this.refs.landingLight.material.emissiveIntensity =
        powered && (this.state === 'rescue' || this.state === 'hover') ? 2.2 : 0.04;
    }
  }

  _applyExplode(value) {
    for (const g of this.explodeGroups) {
      if (value <= 0) {
        g.obj.position.copy(g.base);
      } else {
        g.obj.position.set(
          g.base.x + g.dir.x * g.dist * value,
          g.base.y + g.dir.y * g.dist * value,
          g.base.z + g.dir.z * g.dist * value
        );
      }
    }
  }

  /* ------------------------------------------------------------ */

  snapshot() {
    const v = this.v;
    return {
      state: this.state,
      moving: this.isMoving(),
      nacelleAngleDeg: +(v.tilt * 90).toFixed(2),
      rotorRpm: +(v.rpm * RPM_MAX).toFixed(1),
      rotorNormalised: +v.rpm.toFixed(4),
      gear: v.gear > 0.99 ? 'down' : v.gear < 0.01 ? 'up' : 'in transit',
      gearValue: +v.gear.toFixed(4),
      gearDoors: v.gearDoor > 0.99 ? 'open' : v.gearDoor < 0.01 ? 'closed' : 'moving',
      sponsons: v.sponson > 0.99 ? 'extended' : v.sponson < 0.01 ? 'retracted' : 'in transit',
      sponsonValue: +v.sponson.toFixed(4),
      door: v.door > 0.99 ? 'open' : v.door < 0.01 ? 'closed' : 'moving',
      doorValue: +v.door.toFixed(4),
      winchBoom: v.winch > 0.99 ? 'outboard' : v.winch < 0.01 ? 'stowed' : 'slewing',
      cableMetres: +v.cable.toFixed(3),
      cableMax: CABLE_MAX,
      explode: +v.explode.toFixed(4),
      explodeAllowed: this.explodeAllowed(),
      hoistAllowed: this.hoistAllowed(),
      panels: +v.panels.toFixed(3),
      powered: this.targets().powered === 1,
      sensorAzimuthDeg: +this.sensorAz.toFixed(1),
      sensorElevationDeg: +this.sensorEl.toFixed(1),
      autoScan: this.autoScan,
      reducedMotion: this.reducedMotion,
      simTime: +this.time.toFixed(3)
    };
  }

  /** Legality of the current mechanical combination — used by validate(). */
  legality() {
    const errors = [];
    const warnings = [];
    const v = this.v;
    if (v.cable > 0.02 && v.door < 0.85) errors.push('cable extended with the rescue door not open');
    if (v.cable > 0.02 && this.state !== 'rescue') warnings.push('cable still stowing after leaving the rescue state');
    if (v.gear > 0.05 && v.gearDoor < 0.85) errors.push('landing gear extended with bay doors not open');
    if (v.explode > 0.005 && this.state !== 'maintenance') errors.push('exploded view active outside maintenance');
    if (v.explode > 0.005 && v.rpm > 0.02) errors.push('exploded view active with rotors turning');
    if (this.state === 'maintenance' && v.rpm > 0.02) warnings.push('maintenance selected while rotors are still spinning down');
    if (this.state === 'cruise' && v.gear > 0.05) warnings.push('cruise selected while the gear is still retracting');
    if (v.winch < 0.75 && v.cable > 0.02) errors.push('cable extended with the hoist boom stowed');
    return { errors, warnings };
  }

  dispose() {
    for (const m of this._ownMaterials) m.dispose();
    this._ownMaterials.length = 0;
  }
}
