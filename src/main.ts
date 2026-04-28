// Homepage — pilot the docLorean.
//
// WASD moves on a flat plane; Space triggers a short boost with a cooldown.
// The car keeps its hover bob (vertical sine), and its yaw smoothly chases
// the movement direction. Camera follows the car from behind + above with a
// damped lerp so quick direction changes feel weighty without snapping.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  attachHover, tickHover,
  addUnderglow,
  makeAfterburner, setAfterburnerThrottle, tickAfterburners,
  polishCarMaterials,
} from './shared/scene';
import { createFlightControls } from './shared/flight-controls';

const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement | null;
if (!canvas) throw new Error('hero canvas missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
// Distant horizon + atmospheric fog blends the ground into the sky.
scene.background = new THREE.Color(0x070a16);
scene.fog = new THREE.FogExp2(0x070a16, 0.012);

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 600);

// ---- Ground ----
//
// A massive flat plane plus a grid for sense of motion. The grid is a
// `GridHelper` — Three's built-in is fine for this scale and renders cheaply.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000),
  new THREE.MeshStandardMaterial({
    color: 0x0a0e1c,
    metalness: 0.5,
    roughness: 0.85,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(2000, 200, 0x4f46e5, 0x16203b);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.45;
scene.add(grid);

// ---- Lighting ----
//
// Same warm-fill / cool-key palette as the asset library, plus a moonlight
// hemisphere for soft top illumination.
const key = new THREE.DirectionalLight(0xc0e4ff, 1.5);
key.position.set(40, 80, 30);
const fill = new THREE.DirectionalLight(0xff7eb6, 0.65);
fill.position.set(-40, 20, -40);
const hemi = new THREE.HemisphereLight(0x445e9a, 0x06080f, 0.35);
const ambient = new THREE.AmbientLight(0x4a5878, 0.35);
scene.add(key, fill, hemi, ambient);

// ---- Car ----
//
// Wrap the FBX in an outer "rig" Group: hover effects bob the rig's Y, and
// the flight controls translate/rotate the rig's X/Z and yaw. The car FBX
// goes inside untouched so we don't fight the FBX's own pivot offsets.
const carRig = new THREE.Group();
carRig.name = 'car-rig';
scene.add(carRig);

const loader = new FBXLoader();
let carLoaded = false;
let flightControls: ReturnType<typeof createFlightControls> | null = null;
let flame: THREE.Object3D | null = null;
let pad: THREE.Mesh | null = null;

void loader.loadAsync('/models/docLorean.fbx').then((root) => {
  root.scale.setScalar(0.012);
  // Re-orient if the FBX's local "forward" is +Z; we want -Z = forward so
  // movement direction matches the model's nose.
  root.rotation.y = Math.PI;
  polishCarMaterials(root);
  carRig.add(root);
  addUnderglow(carRig, { intensity: 1.9, distance: 6 });

  // Afterburner sits in the engine direction (local +Z = behind the car
  // because we flipped the FBX to face -Z above).
  flame = makeAfterburner({ radius: 0.18, length: 1.4 });
  flame.position.set(0, 0.05, 0.85);
  carRig.add(flame);

  // Soft underpad disc — pulsing additive ring beneath the car. Lives at
  // a fixed *world* Y but follows the car's X/Z.
  const padGeom = new THREE.RingGeometry(0.6, 2.4, 64);
  const padMat = new THREE.MeshBasicMaterial({
    color: 0x6dd5ff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  pad = new THREE.Mesh(padGeom, padMat);
  pad.rotation.x = -Math.PI / 2;
  scene.add(pad);

  attachHover(carRig, { liftHeight: 1.05, bobAmplitude: 0.08, spinSpeed: 0 });

  flightControls = createFlightControls(carRig, {
    maxSpeed: 22,
    maxBoostSpeed: 38,
  });
  carLoaded = true;
}).catch((err) => {
  console.error('homepage: failed to load docLorean', err);
});

// ---- Chase camera ----
//
// Sits at a fixed local offset behind + above the car and lerps each frame
// toward that target. The camera looks slightly ahead of the car so the
// horizon framing tilts when the car turns.
const camOffset = new THREE.Vector3(0, 4.2, 9.5);
const lookOffset = new THREE.Vector3(0, 1.2, 0);
const _tmpTarget = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();

function updateCamera(dt: number) {
  // Compute the desired camera position in world space using the car's yaw.
  const yaw = carRig.rotation.y;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // Local offset (0, 4.2, 9.5) means "behind the car (+Z in local) and up".
  const ox = sin * camOffset.z;
  const oz = cos * camOffset.z;
  _tmpTarget.set(carRig.position.x + ox, carRig.position.y + camOffset.y, carRig.position.z + oz);
  // Damped lerp; coefficient picked so the camera lags noticeably behind
  // sharp turns but settles in under a second of straight flight.
  const k = 1 - Math.exp(-dt * 6);
  camera.position.lerp(_tmpTarget, k);

  _tmpLook.set(carRig.position.x, carRig.position.y + lookOffset.y, carRig.position.z);
  camera.lookAt(_tmpLook);
}

// ---- HUD wiring ----
const hudSpeed = document.getElementById('hud-speed') as HTMLElement | null;
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
  // Fill bar: 100% just after firing boost, drains over the active window,
  // then refills over the cooldown.
  let fill = 1;
  let label = 'BOOST READY';
  if (bs.active) { fill = bs.activeFraction; label = 'BOOST'; }
  else if (bs.cooldownFraction > 0) { fill = 1 - bs.cooldownFraction; label = 'RECHARGING'; }
  else { fill = 1; label = 'BOOST READY'; }
  if (hudBoostFill) hudBoostFill.style.transform = `scaleX(${Math.max(0, Math.min(1, fill))})`;
  if (hudBoostLabel) {
    hudBoostLabel.textContent = label;
    hudBoostLabel.dataset.state = bs.active ? 'active' : (bs.cooldownFraction > 0 ? 'cooldown' : 'ready');
  }
}

// ---- Loop ----
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta()); // cap big stalls so physics stays sane
  const t = clock.getElapsedTime();

  if (carLoaded && flightControls && flame) {
    flightControls.update(dt);
    tickHover(carRig, dt, t);
    setAfterburnerThrottle(flame, flightControls.throttle());
    tickAfterburners(carRig, dt, t);
    if (pad) {
      pad.position.set(carRig.position.x, 0.005, carRig.position.z);
      pad.scale.setScalar(1 + Math.sin(t * 1.5) * 0.06);
      (pad.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(t * 4) * 0.04;
    }
    updateCamera(dt);
    updateHud();
  } else {
    // Pre-load: park camera at the origin so the first frame isn't a black void.
    camera.position.set(0, 4.2, 9.5);
    camera.lookAt(0, 1.2, 0);
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
