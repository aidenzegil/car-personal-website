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
  findCarWheels,
  wrapWheelPivots,
  makeCarWheelState,
  tickCarWheels,
  groundOffsetY,
  estimateWheelRadius,
  CarWheelState,
  WheelStrategy,
} from './shared/scene';
import { createFlightControls } from './shared/flight-controls';

// ---- Car catalog ----
//
// `fly` = docLorean-style: hovers, no rolling wheels, turbine pod tilt + body
// fishtail. `drive` = ground car: sits flat on the platform, wheels roll with
// forward speed, front wheels steer.
type CarMode = 'fly' | 'drive';
interface CarOption {
  id: string;          // hash key
  label: string;       // HUD-friendly name
  source: string;
  fbm: string;
  mode: CarMode;
  /** Per-car wheel rotation strategy. Each Designersoup model authored its
   *  wheels differently — there's no clean generic detection that works for
   *  all of them, so we hand-tune each. Only used in `drive` mode. */
  wheelStrategy?: WheelStrategy;
}
const SHARED_PALETTE = '387359c5580f06c08c266126b3b46db47e48ba44.png';
const palettePathFor = (fbm: string) => `/models/${fbm}/${SHARED_PALETTE}`;
const CARS: CarOption[] = [
  { id: 'docLorean', label: 'docLorean', source: '/models/docLorean.fbx', fbm: 'docLorean.fbm', mode: 'fly' },
  {
    id: 'Beatall', label: 'Beatall',
    source: '/models/Beatall.fbx', fbm: 'Beatall.fbm', mode: 'drive',
    wheelStrategy: { rollAxis: new THREE.Vector3(0, 0, 1), steerAxis: new THREE.Vector3(0, 1, 0) },
  },
  {
    id: 'Landyroamer', label: 'Landyroamer',
    source: '/models/Landyroamer.fbx', fbm: 'Landyroamer.fbm', mode: 'drive',
    // Wheels modelled lying flat with axle along pivot Y, so rolling is a
    // turntable spin. Steer around Z (sideways) per user feedback.
    wheelStrategy: { rollAxis: new THREE.Vector3(0, -1, 0), steerAxis: new THREE.Vector3(0, 0, 1) },
  },
  {
    id: 'Toyoyo', label: 'Toyoyo Highlight',
    source: '/models/Toyoyo Highlight.fbx', fbm: 'Toyoyo Highlight.fbm', mode: 'drive',
    // Steer around Z (sideways) instead of Y per user feedback.
    wheelStrategy: { rollAxis: new THREE.Vector3(1, 0, 0), steerAxis: new THREE.Vector3(0, 0, 1) },
  },
  {
    id: 'Tristar', label: 'Tristar Racer',
    source: '/models/Tristar Racer.fbx', fbm: 'Tristar Racer.fbm', mode: 'drive',
    wheelStrategy: { rollAxis: new THREE.Vector3(0, 1, 0), steerAxis: new THREE.Vector3(0, 0, 1) },
  },
];

// Hash-based picker: `#car=Beatall`. Default is docLorean — keeps the
// original site behavior intact for anyone with the bare URL bookmarked.
function pickCarFromHash(): CarOption {
  const m = window.location.hash.match(/car=([^&]+)/i);
  const id = m ? decodeURIComponent(m[1]!) : 'docLorean';
  return CARS.find((c) => c.id.toLowerCase() === id.toLowerCase()) ?? CARS[0]!;
}
const ACTIVE_CAR = pickCarFromHash();

// Render the car-picker UI + reload on selection. Hash changes drive a full
// page reload — simpler than tearing down the WebGL scene live, and the FBX
// loader cache means the second pick of the same car is instant anyway.
function renderCarPicker() {
  const host = document.getElementById('car-picker');
  if (!host) return;
  host.innerHTML = CARS.map((c) =>
    `<a href="#car=${encodeURIComponent(c.id)}" data-id="${c.id}" class="${c.id === ACTIVE_CAR.id ? 'active' : ''}">${c.label}</a>`,
  ).join('');
}
renderCarPicker();
window.addEventListener('hashchange', () => {
  if (pickCarFromHash().id !== ACTIVE_CAR.id) window.location.reload();
});

// Update the static HUD copy to reflect the chosen car's mode.
{
  const subj = document.getElementById('hud-subject');
  const fx = document.getElementById('hud-fx');
  if (subj) subj.textContent = ACTIVE_CAR.label;
  if (fx) fx.textContent = ACTIVE_CAR.mode === 'fly'
    ? 'neon · hover · afterburner'
    : 'neon · drive · rolling wheels';
  const splashVerb = document.getElementById('splash-verb');
  if (splashVerb) splashVerb.textContent = ACTIVE_CAR.mode === 'fly' ? 'WASD to fly' : 'WASD to drive';
}

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

// Wheel-pod tilt rig — captured after the FBX loads (docLorean only). We
// store each wheel's rest quaternion so per-frame tilts compose against the
// original orientation instead of accumulating drift.
interface WheelTilt { obj: THREE.Object3D; baseQuat: THREE.Quaternion }
const wheelTilts: WheelTilt[] = [];
const _tiltQuat = new THREE.Quaternion();
const _tiltEuler = new THREE.Euler();
const WHEEL_PITCH_MAX = 0.4;  // radians (~23°): pods angle on accel/brake
const WHEEL_ROLL_MAX  = 0.35; // radians (~20°): lean into turns
const CAR_PITCH_MAX   = 0.11; // radians (~6°): subtle body squat/lift
const CAR_ROLL_MAX    = 0.14; // radians (~8°): body leans into the turn

// Wheeled-car rig (drive mode only). `wheelState` owns the four classified
// wheels + accumulated roll angle; `wheelRadius` converts forward velocity to
// angular velocity so the spin rate visually matches the ground speed.
let wheelState: CarWheelState | null = null;
let wheelRadius = 0.3;
const DRIVE_STEER_MAX = 0.45; // radians (~26°): max front-wheel steer angle

// Drift fishtail — purely visual yaw on carBody. Body stays neutral during
// the turn (so the actual yaw reads cleanly) and only kicks at the END:
// release fires a velocity impulse opposite the steer direction, and an
// underdamped spring back to 0 sweeps through into a smaller counter-flick
// before settling.
let fishtailYaw = 0;
let fishtailYawVel = 0;
let prevSteerInput = 0;
const FISHTAIL_OMEGA        = 6.5;  // rad/s — natural frequency
const FISHTAIL_DAMP          = 0.5; // underdamped: counter-flick on swing-back
const FISHTAIL_RELEASE_KICK = 2;    // velocity impulse on release

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

void loader.loadAsync(ACTIVE_CAR.source).then(async (root) => {
  // FBX-ORIGINAL frame for this whole pack: car nose along +X. Rotate so
  // local -Z is forward — that's the direction flight-controls uses at yaw 0.
  root.scale.setScalar(0.012);
  root.rotation.y = -Math.PI / 2;
  await polishCarMaterials(root, { palettePath: palettePathFor(ACTIVE_CAR.fbm) });
  carBody.add(root);

  if (ACTIVE_CAR.mode === 'fly') {
    // docLorean: cyan turbine pools + rear thruster glow, hovering rig, pod
    // pitch/roll on accel/turn. The hovercraft conceit means strut-cluster
    // tilting reads correctly here — re-parenting the struts into the wheel
    // node lets each pod tilt as one unit.
    const initialWheels = findCarWheels(root);
    attachWheelHardware(root, initialWheels.map((w) => w.obj.name));
    addDocLoreanFeatureLights(carRig, root);
    for (const w of findCarWheels(root)) {
      wheelTilts.push({ obj: w.obj, baseQuat: w.obj.quaternion.clone() });
    }
    attachHover(carRig, { liftHeight: 0.4, bobAmplitude: 0.05, spinSpeed: 0 });
  } else {
    // Wheeled ground car. Pivot-wrap each wheel so rotation happens at the
    // visible wheel center, not the FBX root pivot — without this the FBX
    // wheels orbit around the car instead of spinning. We deliberately skip
    // `attachWheelHardware` here: on cars with mirrors / spoilers / wide
    // wheel arches it grabs body geometry by bbox proximity, then drags it
    // around with the wheel rotation, which is what produced the floating
    // green panels. Plain mesh-only wheel rotation looks correct.
    const detected = findCarWheels(root);
    const wheels = wrapWheelPivots(detected, ACTIVE_CAR.wheelStrategy);
    wheelState = makeCarWheelState(wheels);
    wheelRadius = Math.max(0.05, estimateWheelRadius(wheels));
    root.position.y += groundOffsetY(root);
  }

  flightControls = createFlightControls(carRig, {
    maxSpeed: 22,
    maxBoostSpeed: 38,
    // Zero out-lag — yawRate snaps to 0 the instant you release A/D. The
    // post-turn drift feel comes entirely from the visual carBody fishtail.
    steerOutLag: 0.001,
  });
  carLoaded = true;
  // Test hooks: refreshed once the car is fully loaded so Playwright can
  // synchronously read wheel state, position, etc.
  (window as any).__home = {
    car: ACTIVE_CAR,
    carRig,
    carBody,
    flightControls,
    wheelState,
    wheelRadius,
    loaded: true,
  };
}).catch((err) => {
  console.error('homepage: failed to load car', ACTIVE_CAR.id, err);
});

// Pre-load placeholder so tests can poll `window.__home.loaded`.
(window as any).__home = { car: ACTIVE_CAR, loaded: false };

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
    const rawPitch = flightControls.pitchFraction();
    const rawRoll = flightControls.rollFraction();
    const pitchTau = Math.abs(rawPitch) > Math.abs(smoothPitch) ? TILT_TAU_IN : TILT_TAU_OUT;
    const rollTau  = Math.abs(rawRoll)  > Math.abs(smoothRoll)  ? TILT_TAU_IN : TILT_TAU_OUT;
    smoothPitch += (rawPitch - smoothPitch) * (1 - Math.exp(-dt / pitchTau));
    smoothRoll  += (rawRoll  - smoothRoll)  * (1 - Math.exp(-dt / rollTau));
    const pitch = smoothPitch;
    const roll = smoothRoll;

    if (ACTIVE_CAR.mode === 'fly') {
      // Tilt the four turbine pods to match input. Wheels live in
      // FBX-original local space (pre-yaw), where the car's long axis is +X
      // — so pitch about local Z reads as nose-up/nose-down, and roll about
      // local X leans the pods left/right when steering.
      _tiltEuler.set(roll * WHEEL_ROLL_MAX, 0, -pitch * WHEEL_PITCH_MAX);
      _tiltQuat.setFromEuler(_tiltEuler);
      for (const { obj, baseQuat } of wheelTilts) {
        obj.quaternion.copy(baseQuat).multiply(_tiltQuat);
      }
    } else if (wheelState) {
      // Roll all wheels at angular velocity v/r so the rim's linear speed
      // matches the car's. Each wheel's `rollAxis` is signed during pivot
      // wrap (see `detectRollAxis`) so a positive omega rolls top-forward
      // regardless of how the FBX exporter oriented the wheel mesh — the
      // call site can stay sign-agnostic. Front wheels also pick up a
      // steer yaw; flightControls.rollFraction returns +1 for D (right
      // turn), but rotating the wheel around +Y by a positive angle yaws
      // it left, so we negate.
      const v = flightControls.forwardSpeed();
      const rollOmega = v / wheelRadius;
      const steerAngle = -roll * DRIVE_STEER_MAX;
      tickCarWheels(wheelState, dt, { rollOmega, steerAngle });
    }
    // Pitch/roll body lean is fly-mode only — real cars don't pitch their
    // whole chassis on a flat road. Fishtail (body Y-yaw) applies to both
    // modes: reads as hover drift on the docLorean and as a smaller
    // weight-transfer slide on ground cars.
    if (ACTIVE_CAR.mode === 'fly') {
      carBody.rotation.x = -pitch * CAR_PITCH_MAX;
      carBody.rotation.z = -roll * CAR_ROLL_MAX;
    } else {
      carBody.rotation.x = 0;
      carBody.rotation.z = 0;
    }

    // Fishtail scaling: docLorean keeps its hover-rooted constant amount so
    // the feel doesn't change under the user. Ground cars scale by speed —
    // no fishtail when parked, 2× the docLorean's amount at top speed —
    // because IRL weight-transfer slide is a function of momentum.
    const fishtailScale = ACTIVE_CAR.mode === 'fly' ? 1 : flightControls.speedFraction() * 2;
    const steerNow = flightControls.steerInput();
    if (steerNow === 0 && prevSteerInput !== 0) {
      fishtailYawVel += -Math.sign(prevSteerInput) * FISHTAIL_RELEASE_KICK * fishtailScale;
    }
    prevSteerInput = steerNow;
    // Spring always pulls toward 0 — no held offset during the turn.
    const fishAccel =
      -fishtailYaw * FISHTAIL_OMEGA * FISHTAIL_OMEGA
      - fishtailYawVel * 2 * FISHTAIL_DAMP * FISHTAIL_OMEGA;
    fishtailYawVel += fishAccel * dt;
    fishtailYaw += fishtailYawVel * dt;
    carBody.rotation.y = fishtailYaw;

    updateBlocks(dt);
    if (ACTIVE_CAR.mode === 'fly') tickHover(carRig, dt, t);
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
