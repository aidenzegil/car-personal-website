// WASD-with-boost flight controls for a hovering car.
//
// Simple physics: input contributes to a desired velocity in the world XZ
// plane; actual velocity lerps toward it (so you slide a little when you
// release). The car's heading auto-rotates to face the movement direction —
// no separate look-around input needed.
//
// Space triggers a short boost: stronger thrust + higher max speed for a
// limited duration, then a cooldown before you can boost again.

import * as THREE from 'three';

export interface FlightControlsOpts {
  maxSpeed?: number;
  maxBoostSpeed?: number;
  acceleration?: number;
  damping?: number;            // velocity decay when no input (per second)
  rotationSpeed?: number;      // radians/sec the car can yaw
  boostDuration?: number;      // seconds
  boostCooldown?: number;      // seconds (total cycle = duration + cooldown)
}

export interface FlightControls {
  /** Object the controller drives. The Y position is left alone (the hover
   *  effect handles vertical bob); we only set X/Z and yaw on this. */
  target: THREE.Object3D;
  velocity: THREE.Vector3;
  /** 0..1 normalized speed for HUD readouts. */
  speedFraction(): number;
  /** Boost state for HUD: 0..1 active fill, 0..1 cooldown fill, isReady. */
  boostState(): { active: boolean; activeFraction: number; cooldownFraction: number; ready: boolean };
  /** Throttle 0..1.6 for the afterburner — combines forward thrust + boost. */
  throttle(): number;
  /** Per-frame update; call from your animation loop. */
  update(dt: number): void;
  /** Tear down keyboard listeners. */
  dispose(): void;
}

export function createFlightControls(target: THREE.Object3D, opts: FlightControlsOpts = {}): FlightControls {
  const cfg = {
    maxSpeed:       opts.maxSpeed       ?? 22,
    maxBoostSpeed:  opts.maxBoostSpeed  ?? 38,
    acceleration:   opts.acceleration   ?? 35,
    damping:        opts.damping        ?? 4,
    rotationSpeed:  opts.rotationSpeed  ?? 4.5,
    boostDuration:  opts.boostDuration  ?? 1.2,
    boostCooldown:  opts.boostCooldown  ?? 2.6,
  };

  const keys = new Set<string>();
  let boostTimer = 0;        // counts down from boostDuration while active
  let cooldownTimer = 0;     // counts down from boostCooldown after release
  let boostActive = false;

  // Track current heading (yaw) separately from target rotation so we can
  // smooth-lerp the car to face its movement direction without snapping.
  let yaw = target.rotation.y;
  const velocity = new THREE.Vector3();

  function isMoving(): boolean {
    return keys.has('w') || keys.has('a') || keys.has('s') || keys.has('d')
        || keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight');
  }

  function inputDirection(): THREE.Vector2 {
    let x = 0, z = 0;
    if (keys.has('w') || keys.has('ArrowUp'))    z -= 1;
    if (keys.has('s') || keys.has('ArrowDown'))  z += 1;
    if (keys.has('a') || keys.has('ArrowLeft'))  x -= 1;
    if (keys.has('d') || keys.has('ArrowRight')) x += 1;
    if (x === 0 && z === 0) return new THREE.Vector2(0, 0);
    const v = new THREE.Vector2(x, z); v.normalize();
    return v;
  }

  function tryBoost() {
    if (boostActive) return;
    if (cooldownTimer > 0) return;
    boostActive = true;
    boostTimer = cfg.boostDuration;
  }

  // Keyboard listeners — guard against capturing keys while the user is
  // typing in some hypothetical input field (none today, but cheap safety).
  function onKeyDown(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.repeat) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      tryBoost();
      return;
    }
    keys.add(e.key);
    keys.add(e.code === 'KeyW' ? 'w' : e.code === 'KeyA' ? 'a' : e.code === 'KeyS' ? 's' : e.code === 'KeyD' ? 'd' : e.key);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.key);
    keys.delete(e.code === 'KeyW' ? 'w' : e.code === 'KeyA' ? 'a' : e.code === 'KeyS' ? 's' : e.code === 'KeyD' ? 'd' : e.key);
  }
  function onBlur() { keys.clear(); }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function update(dt: number) {
    // Boost timer bookkeeping.
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

    const dir = inputDirection();
    const wantsMove = dir.lengthSq() > 0;
    const maxSpeed = boostActive ? cfg.maxBoostSpeed : cfg.maxSpeed;

    if (wantsMove) {
      // Acceleration in input direction.
      const desiredVel = new THREE.Vector3(dir.x, 0, dir.y).multiplyScalar(maxSpeed);
      // Approach the desired velocity; faster acceleration when boosting.
      const accelStep = (boostActive ? cfg.acceleration * 1.6 : cfg.acceleration) * dt;
      const delta = desiredVel.clone().sub(velocity);
      const stepLen = Math.min(delta.length(), accelStep);
      delta.normalize().multiplyScalar(stepLen);
      velocity.add(delta);
    } else {
      // Damping decay: exponential-ish so it feels light to release.
      velocity.multiplyScalar(Math.max(0, 1 - cfg.damping * dt));
      if (velocity.lengthSq() < 0.0009) velocity.set(0, 0, 0);
    }

    // Cap to current max — covers the case where boost ends mid-flight.
    if (velocity.length() > maxSpeed) velocity.setLength(maxSpeed);

    // Apply translation in world space (X/Z only — Y is owned by the hover effect).
    target.position.x += velocity.x * dt;
    target.position.z += velocity.z * dt;

    // Heading: face the velocity direction when moving.
    if (velocity.lengthSq() > 0.5) {
      const targetYaw = Math.atan2(velocity.x, velocity.z) + Math.PI; // car's local "front" is -Z
      // Shortest-path lerp through the unit circle.
      let diff = targetYaw - yaw;
      while (diff > Math.PI)  diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const step = Math.sign(diff) * Math.min(Math.abs(diff), cfg.rotationSpeed * dt);
      yaw += step;
    }
    target.rotation.y = yaw;
    void isMoving; // appease the linter — kept exported for HUD if wanted later.
  }

  return {
    target,
    velocity,
    speedFraction() {
      const cap = boostActive ? cfg.maxBoostSpeed : cfg.maxSpeed;
      return Math.min(1, velocity.length() / cap);
    },
    boostState() {
      return {
        active: boostActive,
        activeFraction: boostActive ? boostTimer / cfg.boostDuration : 0,
        cooldownFraction: cooldownTimer > 0 ? cooldownTimer / cfg.boostCooldown : 0,
        ready: !boostActive && cooldownTimer === 0,
      };
    },
    throttle() {
      // 0.4 idle + speed contribution + boost bonus. Keeps the flame visibly
      // breathing at rest, ramps up as you accelerate, pulses on boost.
      const base = 0.4 + 0.6 * (velocity.length() / cfg.maxSpeed);
      const boostBonus = boostActive ? 0.6 : 0;
      return Math.min(1.7, base + boostBonus);
    },
    update,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
