// Car-style controls for the hovering docLorean.
//
// Drive model:
//   - Forward/reverse motion lives on a single scalar `forwardSpeed`. W and
//     S apply acceleration; releasing them decays speed gently.
//   - Steering controls a `yawRate` (angular velocity), not yaw directly.
//     Holding A/D ramps yawRate up toward a target proportional to speed;
//     releasing decays it slowly. That decay is what produces the "drift
//     out of the turn" feel — the car keeps rotating a beat after you let go.
//   - Boost is a smooth 0..1 factor, not a hard toggle. Top speed and thrust
//     interpolate against it so engaging/disengaging boost feels like the
//     car winding up and back down rather than snapping.

import * as THREE from 'three';

export interface FlightControlsOpts {
  maxSpeed?: number;
  maxBoostSpeed?: number;
  maxReverseSpeed?: number;
  acceleration?: number;
  brakeStrength?: number;
  reverseAccel?: number;
  coastDamping?: number;
  steerRate?: number;          // peak yaw-rate (rad/sec) at full speed
  steerSpeedFloor?: number;    // speed at which steering reaches full strength
  steerInLag?: number;         // time constant (s) to spin up to target yaw-rate
  steerOutLag?: number;        // time constant (s) for yaw-rate to decay after release
  boostDuration?: number;
  boostCooldown?: number;
  boostRampIn?: number;        // time constant (s) for boost factor 0→1
  boostRampOut?: number;       // time constant (s) for boost factor 1→0
}

export interface FlightControls {
  target: THREE.Object3D;
  velocity: THREE.Vector3;
  speedFraction(): number;
  boostState(): { active: boolean; activeFraction: number; cooldownFraction: number; ready: boolean };
  throttle(): number;
  /** Signed [-1, 1]. Positive = accelerating forward, negative = reversing. */
  pitchFraction(): number;
  /** Signed [-1, 1]. Positive = turning right, negative = turning left. */
  rollFraction(): number;
  /** Raw discrete steer input (-1, 0, +1). Useful for triggering visuals on
   *  the exact frame the user presses or releases A/D — `rollFraction` is
   *  smoothed and won't show those edges cleanly. */
  steerInput(): number;
  /** Signed scalar forward speed in world units / second. Negative during
   *  reverse. Unlike `velocity.length()`, preserves the direction sign needed
   *  for things like wheel-roll direction. */
  forwardSpeed(): number;
  update(dt: number): void;
  dispose(): void;
}

export function createFlightControls(target: THREE.Object3D, opts: FlightControlsOpts = {}): FlightControls {
  const cfg = {
    maxSpeed:        opts.maxSpeed        ?? 22,
    maxBoostSpeed:   opts.maxBoostSpeed   ?? 42,
    maxReverseSpeed: opts.maxReverseSpeed ?? 11,
    acceleration:    opts.acceleration    ?? 30,
    brakeStrength:   opts.brakeStrength   ?? 42,
    reverseAccel:    opts.reverseAccel    ?? 18,
    coastDamping:    opts.coastDamping    ?? 1.2,
    steerRate:       opts.steerRate       ?? 2.4,
    steerSpeedFloor: opts.steerSpeedFloor ?? 7,
    steerInLag:      opts.steerInLag      ?? 0.18,
    steerOutLag:     opts.steerOutLag     ?? 0.55,
    boostDuration:   opts.boostDuration   ?? 1.2,
    boostCooldown:   opts.boostCooldown   ?? 2.6,
    boostRampIn:     opts.boostRampIn     ?? 0.35,
    boostRampOut:    opts.boostRampOut    ?? 0.7,
  };

  const keys = new Set<string>();
  let boostTimer = 0;
  let cooldownTimer = 0;
  let boostActive = false;
  let boostFactor = 0;       // smoothed 0..1 used for speed/thrust interp

  let forwardSpeed = 0;
  let yaw = target.rotation.y;
  let yawRate = 0;
  let lastSteerInput = 0; // raw discrete steer for edge-triggered visuals
  const velocity = new THREE.Vector3();

  function tryBoost() {
    if (boostActive || cooldownTimer > 0) return;
    boostActive = true;
    boostTimer = cfg.boostDuration;
  }

  function onKeyDown(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) tryBoost();
      return;
    }
    keys.add(e.key);
    const norm = e.code === 'KeyW' ? 'w' : e.code === 'KeyA' ? 'a' : e.code === 'KeyS' ? 's' : e.code === 'KeyD' ? 'd' : null;
    if (norm) keys.add(norm);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.key);
    const norm = e.code === 'KeyW' ? 'w' : e.code === 'KeyA' ? 'a' : e.code === 'KeyS' ? 's' : e.code === 'KeyD' ? 'd' : null;
    if (norm) keys.delete(norm);
  }
  function onBlur() { keys.clear(); }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // Frame-rate-independent lerp factor for a given time constant tau (sec).
  const lerpK = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(0.001, tau));

  function update(dt: number) {
    // Boost timers + smoothed boost factor.
    if (boostActive) {
      boostTimer -= dt;
      if (boostTimer <= 0) {
        boostActive = false;
        boostTimer = 0;
        cooldownTimer = cfg.boostCooldown;
      }
    } else if (cooldownTimer > 0) {
      cooldownTimer = Math.max(0, cooldownTimer - dt);
    }
    const targetBoost = boostActive ? 1 : 0;
    const ramp = boostActive ? cfg.boostRampIn : cfg.boostRampOut;
    boostFactor += (targetBoost - boostFactor) * lerpK(dt, ramp);

    const fwdInput = (keys.has('w') || keys.has('ArrowUp')) ? 1 : 0;
    const revInput = (keys.has('s') || keys.has('ArrowDown')) ? 1 : 0;
    const left  = (keys.has('a') || keys.has('ArrowLeft'))  ? 1 : 0;
    const right = (keys.has('d') || keys.has('ArrowRight')) ? 1 : 0;
    const steerInput = right - left;
    lastSteerInput = steerInput;

    // Top speed + accel both ramp with boost factor.
    const topFwd = cfg.maxSpeed + (cfg.maxBoostSpeed - cfg.maxSpeed) * boostFactor;
    const accelMul = 1 + boostFactor * 0.7;

    if (fwdInput && !revInput) {
      forwardSpeed += cfg.acceleration * accelMul * dt;
      if (forwardSpeed > topFwd) forwardSpeed = topFwd;
    } else if (revInput && !fwdInput) {
      if (forwardSpeed > 0.05) {
        forwardSpeed -= cfg.brakeStrength * dt;
        if (forwardSpeed < 0) forwardSpeed = 0;
      } else {
        forwardSpeed -= cfg.reverseAccel * dt;
        if (forwardSpeed < -cfg.maxReverseSpeed) forwardSpeed = -cfg.maxReverseSpeed;
      }
    } else {
      const decay = Math.max(0, 1 - cfg.coastDamping * dt);
      forwardSpeed *= decay;
      if (Math.abs(forwardSpeed) < 0.02) forwardSpeed = 0;
    }
    // Boost just dropped while we're going faster than the new top — bleed off
    // smoothly instead of snapping.
    if (forwardSpeed > topFwd) {
      forwardSpeed = Math.max(topFwd, forwardSpeed - cfg.brakeStrength * 0.4 * dt);
    }

    // Steering as yaw-rate. Target rate is proportional to current speed and
    // inverted in reverse (so A/D feel right when backing up). Holding the
    // key ramps in fast; releasing decays slowly → drift settle.
    let targetYawRate = 0;
    if (steerInput !== 0 && Math.abs(forwardSpeed) > 0.1) {
      const speedRatio = Math.min(1, Math.abs(forwardSpeed) / cfg.steerSpeedFloor);
      const dir = forwardSpeed >= 0 ? 1 : -1;
      targetYawRate = -steerInput * cfg.steerRate * speedRatio * dir;
    }
    const tau = steerInput !== 0 ? cfg.steerInLag : cfg.steerOutLag;
    yawRate += (targetYawRate - yawRate) * lerpK(dt, tau);
    if (Math.abs(yawRate) < 0.005 && steerInput === 0) yawRate = 0;
    yaw += yawRate * dt;

    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    target.position.x += fx * forwardSpeed * dt;
    target.position.z += fz * forwardSpeed * dt;
    target.rotation.y = yaw;

    velocity.set(fx * forwardSpeed, 0, fz * forwardSpeed);
  }

  return {
    target,
    velocity,
    speedFraction() {
      const cap = cfg.maxSpeed + (cfg.maxBoostSpeed - cfg.maxSpeed) * boostFactor;
      return Math.min(1, Math.abs(forwardSpeed) / cap);
    },
    boostState() {
      // For the HUD: treat the smoothed factor as the visible state so the
      // bar fades rather than snaps. `active` still flips at the input edge
      // so labels switch immediately.
      return {
        active: boostActive,
        activeFraction: boostActive ? boostTimer / cfg.boostDuration : boostFactor,
        cooldownFraction: cooldownTimer > 0 ? cooldownTimer / cfg.boostCooldown : 0,
        ready: !boostActive && cooldownTimer === 0,
      };
    },
    throttle() {
      const base = 0.4 + 0.6 * Math.min(1, Math.abs(forwardSpeed) / cfg.maxSpeed);
      return Math.min(1.7, base + boostFactor * 0.6);
    },
    pitchFraction() {
      return Math.max(-1, Math.min(1, forwardSpeed / cfg.maxSpeed));
    },
    rollFraction() {
      // yawRate is negated against right-input in the steering math, so flip
      // here to give "right turn → positive" semantics for visual rigging.
      return Math.max(-1, Math.min(1, -yawRate / cfg.steerRate));
    },
    steerInput() { return lastSteerInput; },
    forwardSpeed() { return forwardSpeed; },
    update,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
