/**
 * Asterion HX-9 — deterministic state machine + animation.
 *
 * One authoritative scalar set describes the aircraft configuration. Every
 * frame the scalars ease toward state targets (frame-rate independent), the
 * constraint layer forbids impossible combinations, and transforms are then
 * written absolutely — so pausing, re-targeting mid-transition or returning
 * the explode slider to zero never accumulates drift.
 */
import * as THREE from 'three';

export const STATE_NAMES = ['ground', 'hover', 'transition', 'cruise', 'rescue', 'maintenance'];
export const RPM_MAX = 342;
const CABLE_STOW = 0.28;
const CABLE_MAX = 6.4;

const STATE_TARGETS = {
  ground: { tilt: 1, rpm: 0.07, gear: 1, sponson: 1, door: 0, arm: 0, panels: 0, cabin: 0.25, nav: 1, scan: 0 },
  hover: { tilt: 1, rpm: 1, gear: 1, sponson: 1, door: 0, arm: 0, panels: 0, cabin: 0.35, nav: 1, scan: 1 },
  transition: { tilt: 0.5, rpm: 1, gear: 0, sponson: 0, door: 0, arm: 0, panels: 0, cabin: 0.35, nav: 1, scan: 1 },
  cruise: { tilt: 0, rpm: 0.94, gear: 0, sponson: 0, door: 0, arm: 0, panels: 0, cabin: 0.3, nav: 1, scan: 1 },
  rescue: { tilt: 1, rpm: 0.9, gear: 1, sponson: 1, door: 1, arm: 1, panels: 0, cabin: 1, nav: 1, scan: 1 },
  maintenance: { tilt: 1, rpm: 0, gear: 1, sponson: 1, door: 1, arm: 0, panels: 1, cabin: 0.8, nav: 0, scan: 0 }
};

const RATE = {
  tilt: { k: 1.6, max: 0.26 },
  rpm: { k: 1.1, max: 0.2 },
  gear: { k: 2.0, max: 0.32 },
  gearDoor: { k: 3.0, max: 0.7 },
  sponson: { k: 2.0, max: 0.34 },
  door: { k: 2.6, max: 0.55 },
  arm: { k: 2.4, max: 0.5 },
  panels: { k: 2.2, max: 0.5 },
  cabin: { k: 3.0, max: 1.6 },
  nav: { k: 6.0, max: 4.0 },
  explode: { k: 3.2, max: 0.9 },
  cable: { k: 3.0, max: 1.1 }
};

function ease(v, target, r, dt) {
  const d = target - v;
  if (Math.abs(d) < 1e-5) return target;
  let step = d * (1 - Math.exp(-r.k * dt));
  const lim = r.max * dt;
  if (Math.abs(step) > lim) step = Math.sign(step) * lim;
  return v + step;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createAnimator(vehicle, mats) {
  const P = vehicle.parts;
  const get = (n) => P[n];

  const s = {
    tilt: 1, rpm: 0.07, gear: 1, gearDoor: 1, sponson: 1, door: 0, arm: 0,
    panels: 0, cabin: 0.25, nav: 1, explode: 0, cable: CABLE_STOW
  };
  const initial = Object.assign({}, s);

  const ctl = {
    state: 'ground',
    requested: 'ground',
    explodeTarget: 0,
    cableTarget: CABLE_STOW,
    cableCommand: 0,
    scanning: true,
    turretManual: false,
    turretYaw: 0,
    turretPitch: 0.1,
    reducedMotion: false,
    boomOverride: null,
    clock: 0,
    rotorAngle: 0,
    drumAngle: 0,
    transitioning: false
  };

  // authored explode vectors resolved to live objects
  const explodeItems = vehicle.explodeSpec
    .map((spec) => {
      const obj = get(spec.name);
      if (!obj) return null;
      return { obj, vec: new THREE.Vector3(spec.vec[0], spec.vec[1], spec.vec[2]), base: obj.position.clone() };
    })
    .filter(Boolean);
  const dynamicBase = new Map();

  const gearLegs = vehicle.names.gear.map(get).filter(Boolean);
  const gearDoors = vehicle.names.gearDoors.map(get).filter(Boolean);
  const nacelles = vehicle.names.nacelles.map(get).filter(Boolean);
  const rotors = vehicle.names.rotors.map(get).filter(Boolean);
  const sponsonObjs = vehicle.names.sponsons.map(get).filter(Boolean);
  const panelObjs = vehicle.names.panels.map(get).filter(Boolean);
  const discs = ['rotor.port.disc', 'rotor.stbd.disc'].map(get).filter(Boolean);
  const doorObj = get('cabin.door');
  const doorBase = doorObj ? doorObj.position.clone() : new THREE.Vector3();
  const armObj = get('winch.arm');
  const cableObj = get('winch.cable');
  const hookObj = get('winch.hookGroup');
  const drumObj = get('winch.drum');
  const yawObj = get('turret.yaw');
  const pitchObj = get('turret.pitch');

  const sideOf = (obj) => (obj.name.endsWith('stbd') ? 1 : -1);

  function targets() {
    const t = Object.assign({}, STATE_TARGETS[ctl.state]);
    // ---- constraint layer ----
    if (ctl.state !== 'maintenance') ctl.explodeTarget = 0;
    ctl.explodeTarget = Math.min(1, Math.max(0, ctl.explodeTarget));
    if (ctl.boomOverride !== null && ctl.state === 'rescue') t.arm = ctl.boomOverride ? 1 : 0;
    // exploded or powered-down airframe never turns rotors
    if (s.explode > 0.005 || ctl.explodeTarget > 0.005 || ctl.state === 'maintenance') t.rpm = 0;
    // hoist may only run through an open door with the boom out
    const cableOut = s.cable > CABLE_STOW + 0.02;
    if (cableOut) {
      t.door = Math.max(t.door, 1);
      t.arm = Math.max(t.arm, 1);
    }
    return t;
  }

  function applyTransforms() {
    // nacelle tilt: 1 = vertical (helicopter), 0 = forward (aeroplane)
    const tiltAngle = -(1 - s.tilt) * (Math.PI / 2);
    for (const n of nacelles) n.rotation.z = tiltAngle;

    // rotors
    for (const r of rotors) r.rotation.y = ctl.rotorAngle * (sideOf(r) > 0 ? 1 : -1);
    const blur = smoothstep(0.42, 0.86, s.rpm);
    mats.blade.opacity = 1 - 0.72 * blur;
    mats.disc.opacity = 0.62 * blur;
    for (const d of discs) d.visible = mats.disc.opacity > 0.02;

    // landing gear + doors
    for (const leg of gearLegs) {
      const r = leg.userData.retract;
      const a = (1 - s.gear) * r.angle;
      leg.rotation.set(0, 0, 0);
      if (r.axis === 'x') leg.rotation.x = a;
      else leg.rotation.z = a;
    }
    for (const d of gearDoors) d.rotation.x = (d.userData.hinge || 1) * s.gearDoor * 1.55;

    // water sponsons fold up against the hull sides
    for (const sp of sponsonObjs) sp.rotation.x = -(1 - s.sponson) * sideOf(sp) * 1.18;

    // sliding rescue door
    if (doorObj) {
      doorObj.position.set(doorBase.x - 1.2 * s.door, doorBase.y, doorBase.z + 0.05 * s.door);
      dynamicBase.set(doorObj, doorObj.position.clone());
    }

    // maintenance panels
    for (const p of panelObjs) p.rotation.z = s.panels * 1.25;

    // winch
    if (armObj) armObj.rotation.x = -(1 - s.arm) * 1.16;
    if (cableObj) cableObj.scale.set(1, s.cable, 1);
    if (hookObj) hookObj.position.y = -s.cable;
    if (drumObj) drumObj.rotation.y = ctl.drumAngle;

    // sensor turret
    if (yawObj) yawObj.rotation.y = ctl.turretYaw;
    if (pitchObj) pitchObj.rotation.z = ctl.turretPitch;

    // ---- exploded view (authored vectors, absolute writes) ----
    const e = s.explode;
    for (const item of explodeItems) {
      const base = dynamicBase.get(item.obj) || item.base;
      item.obj.position.set(base.x + item.vec.x * e, base.y + item.vec.y * e, base.z + item.vec.z * e);
    }
  }

  function applyLights(dt) {
    const c = ctl.clock;
    mats.emCabin.emissiveIntensity = 0.12 + 1.5 * s.cabin;
    mats.emPanel.emissiveIntensity = 0.15 + 1.4 * s.cabin;
    vehicle.lights.cabin.intensity = 5.5 * s.cabin * (s.door > 0.2 ? 1.15 : 1);
    vehicle.lights.cockpit.intensity = 2.2 * s.cabin;
    mats.emExhaust.emissiveIntensity = 0.04 + 0.85 * s.rpm;
    mats.emCyan.emissiveIntensity = 0.4 + 1.4 * (0.6 + 0.4 * Math.sin(c * 2.1));
    mats.emStatus.emissiveIntensity = 0.5 + 0.8 * (0.5 + 0.5 * Math.sin(c * 1.3 + 1.1));

    const navOn = s.nav;
    mats.emGreen.emissiveIntensity = 2.4 * navOn;
    mats.emRed.emissiveIntensity = 2.4 * navOn;
    // double-pulse tail strobe
    const ph = c % 1.7;
    const strobe = ph < 0.07 || (ph > 0.19 && ph < 0.26) ? 1 : 0;
    mats.emStrobe.emissiveIntensity = navOn * (0.05 + 7 * strobe);
    // slower anti-collision beacon, deliberately out of phase
    const bph = (c * 0.85) % 1;
    mats.emBeacon.emissiveIntensity = navOn * (0.1 + 5.5 * Math.pow(Math.max(0, Math.sin(bph * Math.PI)), 6));
  }

  function applyVibration() {
    const f = vehicle.frame;
    const active = !ctl.reducedMotion && s.rpm > 0.06 && ctl.state !== 'maintenance' && s.explode < 0.01;
    if (!active) {
      f.position.set(0, 0, 0);
      f.rotation.set(0, 0, 0);
      return;
    }
    const c = ctl.clock;
    const a = s.rpm;
    f.position.set(
      Math.sin(c * 21.7) * 0.0016 * a,
      (Math.sin(c * 31.3) * 0.0032 + Math.sin(c * 17.1) * 0.0018) * a,
      Math.sin(c * 26.9) * 0.0014 * a
    );
    f.rotation.set(Math.sin(c * 13.3) * 0.0009 * a, Math.sin(c * 9.7) * 0.0007 * a, Math.sin(c * 23.1) * 0.0013 * a);
  }

  function update(dt) {
    ctl.clock += dt;
    const t = targets();

    s.tilt = ease(s.tilt, t.tilt, RATE.tilt, dt);
    s.rpm = ease(s.rpm, t.rpm, RATE.rpm, dt);
    s.sponson = ease(s.sponson, t.sponson, RATE.sponson, dt);
    s.door = ease(s.door, t.door, RATE.door, dt);
    s.arm = ease(s.arm, t.arm, RATE.arm, dt);
    s.panels = ease(s.panels, t.panels, RATE.panels, dt);
    s.cabin = ease(s.cabin, t.cabin, RATE.cabin, dt);
    s.nav = ease(s.nav, t.nav, RATE.nav, dt);
    s.explode = ease(s.explode, ctl.explodeTarget, RATE.explode, dt);

    // gear / gear-door sequencing
    let doorTarget;
    if (t.gear > 0.5) {
      doorTarget = 1;
      if (s.gearDoor > 0.9) s.gear = ease(s.gear, 1, RATE.gear, dt);
    } else {
      s.gear = ease(s.gear, 0, RATE.gear, dt);
      doorTarget = s.gear < 0.03 ? 0 : 1;
    }
    s.gearDoor = ease(s.gearDoor, doorTarget, RATE.gearDoor, dt);

    // hoist cable: only extends through an open door with the boom deployed
    const hoistReady = ctl.state === 'rescue' && s.door > 0.9 && s.arm > 0.85;
    if (!hoistReady) ctl.cableTarget = CABLE_STOW;
    else if (ctl.cableCommand !== 0) {
      ctl.cableTarget = Math.min(CABLE_MAX, Math.max(CABLE_STOW, ctl.cableTarget + ctl.cableCommand * 2.2 * dt));
    }
    const prevCable = s.cable;
    s.cable = ease(s.cable, ctl.cableTarget, RATE.cable, dt);
    ctl.drumAngle += ((s.cable - prevCable) / 0.075) * -1;

    // rotor rotation
    const omega = (s.rpm * RPM_MAX * Math.PI * 2) / 60;
    ctl.rotorAngle = (ctl.rotorAngle + omega * dt) % (Math.PI * 2);

    // turret scan / manual pointing
    const powered = ctl.state !== 'maintenance';
    if (powered && ctl.scanning && !ctl.turretManual) {
      const w = ctl.reducedMotion ? 0.12 : 0.32;
      ctl.turretYaw = Math.sin(ctl.clock * w) * 0.95;
      ctl.turretPitch = 0.12 + Math.sin(ctl.clock * w * 1.7) * 0.1;
    }

    applyTransforms();
    applyLights(dt);
    applyVibration();

    const diffs = [
      Math.abs(s.tilt - t.tilt), Math.abs(s.rpm - t.rpm), Math.abs(s.gear - t.gear),
      Math.abs(s.sponson - t.sponson), Math.abs(s.door - t.door), Math.abs(s.arm - t.arm),
      Math.abs(s.panels - t.panels), Math.abs(s.gearDoor - doorTarget), Math.abs(s.explode - ctl.explodeTarget)
    ];
    ctl.transitioning = diffs.some((d) => d > 0.012);
  }

  function requestState(name) {
    if (!STATE_NAMES.includes(name)) return false;
    ctl.state = name;
    ctl.requested = name;
    ctl.boomOverride = null;
    if (name !== 'maintenance') ctl.explodeTarget = 0;
    if (name !== 'rescue') ctl.cableTarget = CABLE_STOW;
    return true;
  }

  function setExplode(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return false;
    if (ctl.state !== 'maintenance') return false;
    ctl.explodeTarget = Math.min(1, Math.max(0, num));
    return true;
  }

  function reset() {
    Object.assign(s, initial);
    ctl.state = 'ground';
    ctl.requested = 'ground';
    ctl.explodeTarget = 0;
    ctl.cableTarget = CABLE_STOW;
    ctl.cableCommand = 0;
    ctl.boomOverride = null;
    ctl.scanning = true;
    ctl.turretManual = false;
    ctl.turretYaw = 0;
    ctl.turretPitch = 0.1;
    ctl.clock = 0;
    ctl.rotorAngle = 0;
    ctl.drumAngle = 0;
    ctl.transitioning = false;
    applyTransforms();
    applyLights(0);
    applyVibration();
  }

  function snapshot() {
    return {
      state: ctl.state,
      transitioning: ctl.transitioning,
      nacelleAngleDeg: +(s.tilt * 90).toFixed(1),
      rotorRpm: +(s.rpm * RPM_MAX).toFixed(0),
      rotorBlur: +smoothstep(0.42, 0.86, s.rpm).toFixed(2),
      gear: +s.gear.toFixed(3),
      gearDoors: +s.gearDoor.toFixed(3),
      sponsons: +s.sponson.toFixed(3),
      rescueDoor: +s.door.toFixed(3),
      winchBoom: +s.arm.toFixed(3),
      cableLengthM: +s.cable.toFixed(2),
      explode: +s.explode.toFixed(3),
      explodeTarget: +ctl.explodeTarget.toFixed(3),
      servicePanels: +s.panels.toFixed(3),
      cabinLight: +s.cabin.toFixed(2),
      navLights: s.nav > 0.5,
      turretYawDeg: +((ctl.turretYaw * 180) / Math.PI).toFixed(1),
      turretPitchDeg: +((ctl.turretPitch * 180) / Math.PI).toFixed(1),
      scanning: ctl.scanning,
      turretManual: ctl.turretManual,
      reducedMotion: ctl.reducedMotion,
      clock: +ctl.clock.toFixed(3)
    };
  }

  /** Non-mutating legality report used by validate(). */
  function legality() {
    const errors = [];
    const warnings = [];
    if (s.gear > 0.05 && s.gearDoor < 0.6) errors.push('gear extended while gear doors are closing');
    if (s.cable > CABLE_STOW + 0.05 && s.door < 0.8) errors.push('hoist cable extended through a closed rescue door');
    if (s.cable > CABLE_STOW + 0.05 && s.arm < 0.7) errors.push('hoist cable extended with the boom stowed');
    if (s.explode > 0.005 && ctl.state !== 'maintenance') errors.push('exploded view active outside maintenance');
    if (s.explode > 0.005 && s.rpm > 0.02) errors.push('rotors turning while exploded view is active');
    if (ctl.state === 'maintenance' && s.rpm > 0.05 && !ctl.transitioning) errors.push('rotors turning in maintenance');
    if (ctl.state === 'cruise' && !ctl.transitioning && (s.gear > 0.05 || s.sponson > 0.05)) {
      errors.push('cruise state with gear or sponsons deployed');
    }
    if (ctl.state === 'rescue' && !ctl.transitioning && s.door < 0.9) warnings.push('rescue state door not fully open yet');
    if (ctl.state === 'hover' && !ctl.transitioning && s.tilt < 0.98) warnings.push('hover state nacelles not vertical');
    return { errors, warnings };
  }

  applyTransforms();
  applyLights(0);

  return {
    ctl,
    scalars: s,
    update,
    requestState,
    setExplode,
    reset,
    snapshot,
    legality,
    setCableCommand: (dir) => {
      ctl.cableCommand = Math.sign(dir);
    },
    setBoom: (out) => {
      if (ctl.state !== 'rescue') return false;
      ctl.boomOverride = !!out;
      if (!out) ctl.cableTarget = CABLE_STOW;
      return true;
    },
    /** null when exploded; otherwise max deviation from authored transforms. */
    explodeCheck: () => {
      if (s.explode > 1e-6) return null;
      let max = 0;
      for (const item of explodeItems) {
        const ref = dynamicBase.get(item.obj) || item.base;
        max = Math.max(max, item.obj.position.distanceTo(ref));
      }
      return max;
    },
    setScanning: (on) => {
      ctl.scanning = !!on;
      if (on) ctl.turretManual = false;
    },
    pointTurret: (dyaw, dpitch) => {
      ctl.turretManual = true;
      ctl.scanning = false;
      ctl.turretYaw = Math.min(1.6, Math.max(-1.6, ctl.turretYaw + dyaw));
      ctl.turretPitch = Math.min(0.7, Math.max(-0.7, ctl.turretPitch + dpitch));
    },
    setReducedMotion: (on) => {
      ctl.reducedMotion = !!on;
    },
    isHoistReady: () => ctl.state === 'rescue' && s.door > 0.9 && s.arm > 0.85,
    limits: { CABLE_STOW, CABLE_MAX, RPM_MAX }
  };
}
