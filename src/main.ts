// Homepage — pilot the docLorean across a textured neon plane.
//
// Layout:
//   - Wide flat ground with a brighter grid + scattered glowing pylons so
//     you can read motion at any speed.
//   - Arcade chase camera: high up + angled down, like Crazy Taxi / 2D
//     racer cousins. Smooth lerp behind the car so direction changes feel
//     weighty.
//   - Hover bob, cyan/magenta underglow disc on the ground, no afterburner.
//
// WASD moves on the XZ plane; Space triggers a short boost with cooldown.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  attachHover, tickHover,
  polishCarMaterials,
  addDocLoreanFeatureLights,
  attachWheelHardware,
} from './shared/scene';
import { createFlightControls } from './shared/flight-controls';

const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement | null;
if (!canvas) throw new Error('hero canvas missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;

const scene = new THREE.Scene();
// Twilight purple horizon — gives the dark plane atmosphere instead of
// pure black-on-black, so the eye has something to read motion against.
scene.background = new THREE.Color(0x10122a);
scene.fog = new THREE.FogExp2(0x10122a, 0.006);

const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 600);

// ---- Ground ----
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2400, 2400),
  new THREE.MeshStandardMaterial({
    color: 0x121633,
    metalness: 0.55,
    roughness: 0.75,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Two-tier neon grid stamped onto the ground. The fine grid gives texture
// at ground level; the major grid gives the eye discrete punctuation marks
// to track motion against.
const gridFine = new THREE.GridHelper(2400, 480, 0x6dd5ff, 0x4860a8);
(gridFine.material as THREE.Material).transparent = true;
(gridFine.material as THREE.Material).opacity = 0.85;
scene.add(gridFine);

const gridMajor = new THREE.GridHelper(2400, 48, 0xe879f9, 0x884e9c);
(gridMajor.material as THREE.Material).transparent = true;
(gridMajor.material as THREE.Material).opacity = 0.9;
gridMajor.position.y = 0.02;
scene.add(gridMajor);

// ---- Scattered neon pylons ----
//
// Hundreds of glowing vertical bars across the plane. As the car moves, they
// scroll past — the cheapest, most legible "I'm moving fast" cue.
// Dense field of glowing pylons clustered near the play area + thinning out
// further. Many small ones near the car = strong motion parallax; the big
// scattered ones in the distance fill the horizon.
const pylonGroup = new THREE.Group();
{
  const cyanMat = new THREE.MeshBasicMaterial({ color: 0x6dd5ff, toneMapped: false });
  const magMat  = new THREE.MeshBasicMaterial({ color: 0xe879f9, toneMapped: false });
  const ambMat  = new THREE.MeshBasicMaterial({ color: 0xffb547, toneMapped: false });
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);

  // Inner ring: dense + medium height. Lots of motion cues near the car.
  for (let i = 0; i < 1500; i++) {
    const palette = i % 11 === 0 ? ambMat : (i % 3 === 0 ? magMat : cyanMat);
    const x = (Math.random() - 0.5) * 240;
    const z = (Math.random() - 0.5) * 240;
    if (Math.abs(x) < 8 && Math.abs(z) < 8) { i--; continue; }
    const m = new THREE.Mesh(boxGeom, palette);
    const h = 1 + Math.random() * 3;
    m.scale.set(0.4 + Math.random() * 0.5, h, 0.4 + Math.random() * 0.5);
    m.position.set(x, h / 2, z);
    pylonGroup.add(m);
  }

  // Outer ring: sparser + taller, for horizon silhouette.
  for (let i = 0; i < 400; i++) {
    const palette = i % 5 === 0 ? ambMat : (i % 2 === 0 ? magMat : cyanMat);
    const angle = Math.random() * Math.PI * 2;
    const r = 220 + Math.random() * 320;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const m = new THREE.Mesh(boxGeom, palette);
    const h = 4 + Math.random() * 14;
    m.scale.set(0.8 + Math.random() * 1.4, h, 0.8 + Math.random() * 1.4);
    m.position.set(x, h / 2, z);
    pylonGroup.add(m);
  }
}
scene.add(pylonGroup);

// ---- Pyramid of breakable blocks ----
//
// Stack of glowing cubes the car can plow through. Each block tracks its own
// state — when the car gets within knock-radius, it switches from `static`
// to `tumbling`, integrates gravity + spin, bounces once on the ground, then
// despawns. Block geometry is shared; materials are shared per color.
interface Block {
  mesh: THREE.Mesh;
  state: 'static' | 'tumbling' | 'gone';
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  life: number;
}
const BLOCK_SIZE = 1.5;
const PYRAMID_LEVELS = 5;
const PYRAMID_CENTER = new THREE.Vector3(0, 0, -32);
const blocks: Block[] = [];
{
  const palette = [
    new THREE.MeshBasicMaterial({ color: 0x6dd5ff, toneMapped: false }),
    new THREE.MeshBasicMaterial({ color: 0xe879f9, toneMapped: false }),
    new THREE.MeshBasicMaterial({ color: 0xffb547, toneMapped: false }),
  ];
  const geom = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
  for (let level = 0; level < PYRAMID_LEVELS; level++) {
    const dim = PYRAMID_LEVELS - level;
    const half = (dim - 1) * 0.5;
    for (let ix = 0; ix < dim; ix++) {
      for (let iz = 0; iz < dim; iz++) {
        const mat = palette[(ix + iz + level) % palette.length]!;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(
          PYRAMID_CENTER.x + (ix - half) * BLOCK_SIZE,
          BLOCK_SIZE * 0.5 + level * BLOCK_SIZE,
          PYRAMID_CENTER.z + (iz - half) * BLOCK_SIZE,
        );
        scene.add(mesh);
        blocks.push({
          mesh,
          state: 'static',
          vel: new THREE.Vector3(),
          angVel: new THREE.Vector3(),
          life: 0,
        });
      }
    }
  }
}

// Faint distant ring of light — pretends to be a horizon city. Single big
// ring of additive points well outside the play area.
{
  const N = 400;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const palette = [new THREE.Color(0x6dd5ff), new THREE.Color(0xe879f9), new THREE.Color(0xffb547)];
  for (let i = 0; i < N; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 720 + Math.random() * 80;
    positions[i * 3 + 0] = Math.cos(angle) * r;
    positions[i * 3 + 1] = 1 + Math.random() * 14;
    positions[i * 3 + 2] = Math.sin(angle) * r;
    const c = palette[i % palette.length]!;
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.4,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  scene.add(new THREE.Points(geom, mat));
}

// ---- Lighting ----
// Toon lighting: bright key + cool magenta-cyan rim so the cel-shaded car
// pops out of the dark plane. Hemi gives shadow-side lift so the toon ramp
// doesn't slam to its darkest band on every backside.
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(40, 80, 30);
scene.add(key);

const rim = new THREE.DirectionalLight(0xe879f9, 0.6);
rim.position.set(-30, 40, -50);
scene.add(rim);

// Low hemi so bands don't wash — the directional + rim do the cel work.
const hemi = new THREE.HemisphereLight(0x9ec0ff, 0x10122a, 0.2);
scene.add(hemi);

// ---- Car ----
//
// Two nested groups: `carRig` owns position + yaw (driven by flight-controls),
// `carBody` owns subtle pitch/roll lean for arcade weight transfer. Splitting
// them keeps yaw composing cleanly while letting the body tilt in car-local
// space without affecting steering.
const carRig = new THREE.Group();
carRig.name = 'car-rig';
const carBody = new THREE.Group();
carBody.name = 'car-body';
carRig.add(carBody);
scene.add(carRig);

const loader = new FBXLoader();
let carLoaded = false;
let flightControls: ReturnType<typeof createFlightControls> | null = null;

// Wheel-pod tilt rig — captured after the FBX loads. We store each wheel's
// rest quaternion so per-frame tilts compose against the original orientation
// instead of accumulating drift.
interface WheelTilt { obj: THREE.Object3D; baseQuat: THREE.Quaternion }
const wheelTilts: WheelTilt[] = [];
const _tiltQuat = new THREE.Quaternion();
const _tiltEuler = new THREE.Euler();
const WHEEL_PITCH_MAX = 0.4;  // radians (~23°): pods angle on accel/brake
const WHEEL_ROLL_MAX  = 0.35; // radians (~20°): lean into turns
const CAR_PITCH_MAX   = 0.11; // radians (~6°): subtle body squat/lift
const CAR_ROLL_MAX    = 0.14; // radians (~8°): body leans into the turn

// Drift fishtail — purely visual yaw on carBody. Two phases:
//   1. Press/hold: critically-damped spring drives body to a steady rear-out
//      offset proportional to steerInput. No press flick.
//   2. Release: instant velocity kick AWAY from the held offset, plus a
//      switch to underdamped low-damp spring with target 0. The body sweeps
//      through 0 into a smaller counter-flick and settles. No linger —
//      motion starts on the exact frame the key comes up.
let fishtailYaw = 0;
let fishtailYawVel = 0;
let prevSteerInput = 0;
const FISHTAIL_OMEGA        = 6.5;  // rad/s — natural frequency
const FISHTAIL_DAMP_PRESS   = 1.0;  // critical: no overshoot on press
const FISHTAIL_DAMP_RELEASE = 0.5;  // underdamped: counter-flick on swing-back
const FISHTAIL_HOLD_OFFSET  = 0.22; // ~12.5° rear-out while turning
const FISHTAIL_RELEASE_KICK = 1.5;  // velocity impulse on release

// Smoothed copies of pitch/roll. Now that steerOutLag is ~0, rollFraction
// snaps to 0 on release — driving carBody.rotation.z and the wheel tilt
// directly from the raw value would visibly snap the lean back to upright.
// Asymmetric tau: fast when the magnitude is growing (snappy press, snappy
// direction reversals) and slow when shrinking (smooth post-release decay
// that lines up with the fishtail's linger + counter-flick timing).
let smoothRoll = 0;
let smoothPitch = 0;
const TILT_TAU_IN  = 0.05; // s — engaging or growing magnitude
const TILT_TAU_OUT = 0.35; // s — returning toward 0 after release

void loader.loadAsync('/models/docLorean.fbx').then((root) => {
  root.scale.setScalar(0.012);
  // The FBX ships with its long axis along +X, so a 90° turn brings the nose
  // around to local -Z — which is the forward direction flight-controls uses
  // at yaw 0.
  root.rotation.y = -Math.PI / 2;
  void polishCarMaterials(root, { palettePath: '/models/docLorean.fbm/387359c5580f06c08c266126b3b46db47e48ba44.png' });
  carBody.add(root);
  addDocLoreanFeatureLights(carRig, root);

  // Pull wheel struts/connectors into each wheel so they tilt as one unit.
  // Must run before we cache wheel rest quats (in case attach() mutates).
  const wheelNames = ['lFWheel', 'rFWheel', 'lRWheel', 'rRWheel'];
  attachWheelHardware(root, wheelNames);

  for (const name of wheelNames) {
    const w = root.getObjectByName(name);
    if (w) wheelTilts.push({ obj: w, baseQuat: w.quaternion.clone() });
  }

  attachHover(carRig, { liftHeight: 0.4, bobAmplitude: 0.05, spinSpeed: 0 });
  flightControls = createFlightControls(carRig, {
    maxSpeed: 22,
    maxBoostSpeed: 38,
    // Zero out-lag — yawRate snaps to 0 the instant you release A/D. The
    // post-turn drift feel comes entirely from the visual carBody fishtail.
    steerOutLag: 0.001,
  });
  carLoaded = true;
}).catch((err) => {
  console.error('homepage: failed to load docLorean', err);
});

// ---- Crossy Road camera ----
//
// Fixed isometric-ish angle in world space — the camera never rotates with
// the car. It just translates to keep the car in frame. That means when you
// steer, the car visibly rotates inside the viewport instead of staying
// glued to the same screen-space orientation.
const camOffset = new THREE.Vector3(18, 22, 24); // up + slightly to the side, like Crossy Road
const _tmpLook = new THREE.Vector3();

function updateCamera(_dt: number) {
  camera.position.set(
    carRig.position.x + camOffset.x,
    camOffset.y,
    carRig.position.z + camOffset.z,
  );
  _tmpLook.set(carRig.position.x, 0.6, carRig.position.z);
  camera.lookAt(_tmpLook);
}

// ---- HUD wiring ----
const hudSpeed     = document.getElementById('hud-speed') as HTMLElement | null;
const hudBoostFill = document.getElementById('hud-boost-fill') as HTMLElement | null;
const hudBoostLabel = document.getElementById('hud-boost-label') as HTMLElement | null;
const hudPosX = document.getElementById('hud-x') as HTMLElement | null;
const hudPosZ = document.getElementById('hud-z') as HTMLElement | null;

function updateHud() {
  if (!flightControls) return;
  const speed = flightControls.velocity.length();
  if (hudSpeed) hudSpeed.textContent = String(Math.round(speed));
  if (hudPosX) hudPosX.textContent = String(Math.round(carRig.position.x));
  if (hudPosZ) hudPosZ.textContent = String(Math.round(carRig.position.z));

  const bs = flightControls.boostState();
  let fill = 1;
  let label = 'BOOST READY';
  if (bs.active) { fill = bs.activeFraction; label = 'BOOST'; }
  else if (bs.cooldownFraction > 0) { fill = 1 - bs.cooldownFraction; label = 'RECHARGING'; }
  if (hudBoostFill) hudBoostFill.style.transform = `scaleX(${Math.max(0, Math.min(1, fill))})`;
  if (hudBoostLabel) {
    hudBoostLabel.textContent = label;
    hudBoostLabel.dataset.state = bs.active ? 'active' : (bs.cooldownFraction > 0 ? 'cooldown' : 'ready');
  }
}

// ---- Block knock + tumble ----
//
// Cheap arcade physics: while a block is `static`, check XZ-distance to the
// car each frame and trigger a tumble if the car is close enough. While a
// block is `tumbling`, integrate gravity + spin, bounce off the ground once
// or twice, then despawn after `life` runs out.
const KNOCK_RADIUS = BLOCK_SIZE * 0.75 + 1.5;
const KNOCK_RADIUS_SQ = KNOCK_RADIUS * KNOCK_RADIUS;
function updateBlocks(dt: number) {
  if (!flightControls) return;
  const carPos = carRig.position;
  const carSpeed = flightControls.velocity.length();
  for (const b of blocks) {
    if (b.state === 'gone') continue;
    if (b.state === 'static') {
      const dx = b.mesh.position.x - carPos.x;
      const dz = b.mesh.position.z - carPos.z;
      // Block must be within roughly the car's hover slab vertically too,
      // otherwise the top of the pyramid would knock from a passing car
      // that's nowhere near it.
      const dy = b.mesh.position.y - 0.5;
      if (dx * dx + dz * dz < KNOCK_RADIUS_SQ && dy < BLOCK_SIZE * 1.5 && dy > -1) {
        const len = Math.sqrt(dx * dx + dz * dz) + 0.001;
        const speed = Math.max(15, carSpeed * 1.4);
        b.vel.set((dx / len) * speed, 6 + Math.random() * 6, (dz / len) * speed);
        b.angVel.set(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
        );
        b.state = 'tumbling';
        b.life = 4.0;
      }
    } else {
      b.vel.y -= 28 * dt;
      b.mesh.position.x += b.vel.x * dt;
      b.mesh.position.y += b.vel.y * dt;
      b.mesh.position.z += b.vel.z * dt;
      b.mesh.rotation.x += b.angVel.x * dt;
      b.mesh.rotation.y += b.angVel.y * dt;
      b.mesh.rotation.z += b.angVel.z * dt;
      const floorY = BLOCK_SIZE * 0.5;
      if (b.mesh.position.y < floorY) {
        b.mesh.position.y = floorY;
        b.vel.y = b.vel.y < -0.5 ? -b.vel.y * 0.35 : 0;
        b.vel.x *= 0.65;
        b.vel.z *= 0.65;
        b.angVel.multiplyScalar(0.55);
      }
      b.life -= dt;
      if (b.life <= 0) {
        scene.remove(b.mesh);
        b.state = 'gone';
      }
    }
  }
}

// ---- Loop ----
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();

  if (carLoaded && flightControls) {
    flightControls.update(dt);
    // Tilt the four turbine pods to match input. Wheels live in FBX-original
    // local space (pre-yaw), where the car's long axis is +X — so pitch about
    // local Z reads as nose-up/nose-down, and roll about local X leans the
    // pods left/right when steering.
    const rawPitch = flightControls.pitchFraction();
    const rawRoll = flightControls.rollFraction();
    const pitchTau = Math.abs(rawPitch) > Math.abs(smoothPitch) ? TILT_TAU_IN : TILT_TAU_OUT;
    const rollTau  = Math.abs(rawRoll)  > Math.abs(smoothRoll)  ? TILT_TAU_IN : TILT_TAU_OUT;
    smoothPitch += (rawPitch - smoothPitch) * (1 - Math.exp(-dt / pitchTau));
    smoothRoll  += (rawRoll  - smoothRoll)  * (1 - Math.exp(-dt / rollTau));
    const pitch = smoothPitch;
    const roll = smoothRoll;
    _tiltEuler.set(roll * WHEEL_ROLL_MAX, 0, -pitch * WHEEL_PITCH_MAX);
    _tiltQuat.setFromEuler(_tiltEuler);
    for (const { obj, baseQuat } of wheelTilts) {
      obj.quaternion.copy(baseQuat).multiply(_tiltQuat);
    }
    // Subtle full-car lean: nose rises a touch on acceleration, body banks
    // into the turn. Smaller magnitude than the wheel tilt so the wheels
    // still read as the active suspension.
    carBody.rotation.x = -pitch * CAR_PITCH_MAX;
    carBody.rotation.z = -roll * CAR_ROLL_MAX;

    // Fishtail. On release we inject a velocity kick AWAY from the held
    // offset and switch to underdamped spring chasing 0 — body sweeps
    // immediately, with no linger, then overshoots into a smaller
    // counter-flick before settling.
    const steerNow = flightControls.steerInput();
    if (steerNow === 0 && prevSteerInput !== 0) {
      fishtailYawVel += -Math.sign(prevSteerInput) * FISHTAIL_RELEASE_KICK;
    }
    prevSteerInput = steerNow;
    const fishTarget = steerNow * FISHTAIL_HOLD_OFFSET;
    const fishDamp = steerNow !== 0 ? FISHTAIL_DAMP_PRESS : FISHTAIL_DAMP_RELEASE;
    const fishAccel =
      (fishTarget - fishtailYaw) * FISHTAIL_OMEGA * FISHTAIL_OMEGA
      - fishtailYawVel * 2 * fishDamp * FISHTAIL_OMEGA;
    fishtailYawVel += fishAccel * dt;
    fishtailYaw += fishtailYawVel * dt;
    carBody.rotation.y = fishtailYaw;

    updateBlocks(dt);
    tickHover(carRig, dt, t);
    updateCamera(dt);
    updateHud();
  } else {
    // Pre-load: park the camera somewhere sane so first frame isn't black.
    camera.position.set(camOffset.x, camOffset.y, camOffset.z);
    camera.lookAt(0, 0.6, 0);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  const wrap = canvas!.parentElement!;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement!);
resize();
tick();
