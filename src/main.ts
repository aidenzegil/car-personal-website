// Homepage hero scene — a single flying docLorean shot from a low,
// magazine-cover angle. Uses the shared scene helpers so visual tweaks ripple
// through both this hero and the asset library at /library.html.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  attachHover, tickHover,
  addUnderglow,
  makeThrusterTrail, tickThrusters,
  polishCarMaterials,
} from './shared/scene';

const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement | null;
if (!canvas) throw new Error('hero canvas missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
// Subtle blue-violet fog blends the car into the dark page background so the
// canvas + DOM read as one image rather than a panel pasted on top.
scene.fog = new THREE.Fog(0x080a14, 6, 18);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
// Low-angle hero shot — gives the docLorean that "lifting off" silhouette.
camera.position.set(2.6, 1.0, 4.2);
camera.lookAt(0, 1.05, 0);

// Lighting — cool key + warm fill + soft ambient. Reads as showroom-at-night.
const key = new THREE.DirectionalLight(0xc0e4ff, 1.7);
key.position.set(5, 7, 4);
const fill = new THREE.DirectionalLight(0xff7eb6, 0.85);
fill.position.set(-4, 2, -3);
const ambient = new THREE.AmbientLight(0x4a5878, 0.5);
scene.add(key, fill, ambient);

// Floor: a faint infinite-grid feel. Subtler than the library's grid since
// the homepage runs the canvas behind copy and we don't want it to fight.
const grid = new THREE.GridHelper(40, 80, 0x4f46e5, 0x101422);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.18;
grid.position.y = 0;
scene.add(grid);

// Big subtle radial "spotlight pad" beneath the car — a soft additive glow
// disc. Sells the levitation without cluttering the silhouette.
const padGeom = new THREE.RingGeometry(0.6, 2.2, 64);
const padMat = new THREE.MeshBasicMaterial({
  color: 0x6dd5ff,
  transparent: true,
  opacity: 0.18,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const pad = new THREE.Mesh(padGeom, padMat);
pad.rotation.x = -Math.PI / 2;
pad.position.y = 0.005;
scene.add(pad);

const loader = new FBXLoader();
let car: THREE.Object3D | null = null;

void loader.loadAsync('/models/docLorean.fbx').then((root) => {
  root.scale.setScalar(0.01);
  polishCarMaterials(root);
  const group = new THREE.Group();
  group.name = 'hero-docLorean';
  group.add(root);
  addUnderglow(group, { intensity: 1.9, distance: 6 });
  const trail = makeThrusterTrail({ count: 120, length: 1.9, color: 0x6dd5ff });
  trail.position.set(0, 0.05, -0.85);
  trail.rotation.x = Math.PI / 2;
  group.add(trail);
  attachHover(group, { liftHeight: 1.05, bobAmplitude: 0.08, spinSpeed: 0.22 });
  scene.add(group);
  car = group;
}).catch((err) => {
  console.error('hero: failed to load docLorean', err);
});

const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();
  if (car) {
    tickHover(car, dt, t);
    tickThrusters(car, dt, t);
    // Pulse the underpad in sync with the bob — same frequency as the
    // car's vertical sine, slightly delayed for a "shadow" effect.
    pad.scale.setScalar(1 + Math.sin(t * 1.5 - 0.4) * 0.05);
    (pad.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(t * 4) * 0.04;
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
