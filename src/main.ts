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
// Mutable so we can swap cars in place (no full-page reload). Updated by
// swapActiveCar() during teardown completion.
let ACTIVE_CAR = pickCarFromHash();

// Render the car-picker UI. Selecting a different car triggers a teardown
// animation (mirror of the intro) and then a full reload — the FBX loader
// cache makes the second pick of the same car instant, and a fresh reload
// is the simplest way to swap the WebGL scene cleanly.
function renderCarPicker() {
  const host = document.getElementById('car-picker');
  if (!host) return;
  host.innerHTML = CARS.map((c) =>
    `<a href="#car=${encodeURIComponent(c.id)}" data-id="${c.id}" class="${c.id === ACTIVE_CAR.id ? 'active' : ''}">${c.label}</a>`,
  ).join('');
  host.querySelectorAll<HTMLAnchorElement>('a[data-id]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.dataset.id;
      if (!id || id === ACTIVE_CAR.id) return;
      e.preventDefault();
      startTeardown(id);
    });
  });
}
renderCarPicker();
window.addEventListener('hashchange', () => {
  const id = pickCarFromHash().id;
  if (id !== ACTIVE_CAR.id) startTeardown(id);
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
// Two-tier atmosphere:
//   SKY_COLOR  — applied to background + fog. Distant geometry fades into
//                this twilight tone so the horizon stays visible.
//   VOID_COLOR — used by the deep backdrop only, rendered with `fog: false`
//                so it stays a solid dark below the play floor. The upper
//                view reads as atmospheric sky; the lower view (where the
//                columns rise from) reads as actual void.
const SKY_COLOR  = 0x10122a;
const VOID_COLOR = 0x02030a;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.009);

// Vertical "void" fog: an exponential fade toward VOID_COLOR keyed off
// world Y (not camera distance). At y >= VOID_PLANE_Y nothing happens; at
// y < VOID_PLANE_Y the depth below the plane drives the mix factor.
// The result: everything above the floor stays atmospheric, everything
// below it slams aggressively to black. Columns are invisible while
// sunken and emerge as their tops cross the plane during the intro wave.
//
// We inject this via `onBeforeCompile`. Each affected material gets a
// `vVoidWorld` varying (computed in the vertex shader, instance-aware)
// and a fragment-side mix that runs *after* the standard fog chunk.
const VOID_PLANE_Y = 0.0;
const VOID_DENSITY = 0.08;
function applyVerticalVoid(mat: THREE.Material) {
  if ((mat as any).__voidApplied) return;
  (mat as any).__voidApplied = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uVoidPlaneY = { value: VOID_PLANE_Y };
    shader.uniforms.uVoidColor = { value: new THREE.Color(VOID_COLOR) };
    shader.uniforms.uVoidDensity = { value: VOID_DENSITY };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vVoidWorld;',
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#ifdef USE_INSTANCING
  vVoidWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vVoidWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vVoidWorld;
uniform float uVoidPlaneY;
uniform vec3 uVoidColor;
uniform float uVoidDensity;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#include <fog_fragment>
float voidDepth = max(0.0, uVoidPlaneY - vVoidWorld.y);
float voidFactor = 1.0 - exp(-uVoidDensity * voidDepth);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uVoidColor, voidFactor);`,
    );
  };
  mat.needsUpdate = true;
}

function applyVoidToTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const matAny = (o as any).material as THREE.Material | THREE.Material[] | undefined;
    if (!matAny) return;
    const mats = Array.isArray(matAny) ? matAny : [matAny];
    for (const m of mats) if (m) applyVerticalVoid(m);
  });
}

// Floor-tile specific shader. Three pieces folded into one
// onBeforeCompile pass so they share one <fog_fragment> replacement:
//   1. Edge darken: each face fades to a darker gray near its perimeter.
//      Object-local position drives a per-axis "distance to face edge"
//      calculation that correctly handles top, bottom, and side faces.
//   2. Per-tile static noise: gentle world-stable grain so adjacent
//      columns read as discrete blocks instead of a single sheet.
//   3. Vertical void: aggressive exponential fade to VOID_COLOR below
//      y = VOID_PLANE_Y. Above the floor plane this is a no-op.
function applyFloorTileShader(mat: THREE.Material) {
  if ((mat as any).__voidApplied) return;
  (mat as any).__voidApplied = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uVoidPlaneY = { value: VOID_PLANE_Y };
    shader.uniforms.uVoidColor = { value: new THREE.Color(VOID_COLOR) };
    shader.uniforms.uVoidDensity = { value: VOID_DENSITY };
    // Box half-extents (after the geometry was translated so the top is
    // at y=0 and the body extends to y=-H). Used by the fragment edge
    // calc to know where each face's edges live in object space.
    shader.uniforms.uTileHalfExtent = {
      value: new THREE.Vector3(FLOOR_TILE_SIZE * 0.97 * 0.5, FLOOR_TILE_HEIGHT * 0.5, FLOOR_TILE_SIZE * 0.97 * 0.5),
    };
    shader.uniforms.uTileCenterY = { value: -FLOOR_TILE_HEIGHT * 0.5 };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vVoidWorld;
varying vec3 vTileObj;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vTileObj = transformed;
#ifdef USE_INSTANCING
  vVoidWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vVoidWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vVoidWorld;
varying vec3 vTileObj;
uniform float uVoidPlaneY;
uniform vec3 uVoidColor;
uniform float uVoidDensity;
uniform vec3 uTileHalfExtent;
uniform float uTileCenterY;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `// Edge darken: distance from this fragment to the nearest face edge.
// distEdge[i] is "how far the fragment is from the +/- extreme on axis i."
// One component is ~0 (the face normal axis); the smaller of the other
// two is the distance to the closest edge of that face.
vec3 fromCenter = vTileObj - vec3(0.0, uTileCenterY, 0.0);
vec3 distEdge = uTileHalfExtent - abs(fromCenter);
float minD = min(distEdge.x, min(distEdge.y, distEdge.z));
float maxD = max(distEdge.x, max(distEdge.y, distEdge.z));
float edgeDist = (distEdge.x + distEdge.y + distEdge.z) - minD - maxD;
// Edge band ~0.6 units wide. Inside the band, multiply rgb by 0.55 (45%
// darker). smoothstep gives a soft falloff so the edge isn't a hard line.
float edgeFactor = smoothstep(0.0, 0.6, edgeDist);
gl_FragColor.rgb *= mix(0.55, 1.0, edgeFactor);
// Per-tile static noise — stable in world space, each column has its
// own grain.
float n = fract(sin(dot(floor(vVoidWorld.xz * 0.5), vec2(12.9898, 78.233))) * 43758.5453);
gl_FragColor.rgb *= 1.0 + (n - 0.5) * 0.12;
#include <fog_fragment>
// Vertical void: aggressive fade to VOID_COLOR below the floor plane.
float voidDepth = max(0.0, uVoidPlaneY - vVoidWorld.y);
float voidFactor = 1.0 - exp(-uVoidDensity * voidDepth);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uVoidColor, voidFactor);`,
    );
  };
  mat.needsUpdate = true;
}

const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 600);

// ---- Ground ----
//
// The floor is built from a grid of square *box columns*. Each column's
// top face is at local y=0 and its body extends down to -FLOOR_TILE_HEIGHT,
// so when every column has landed at position.y=0 the tops form a flat
// floor and the bodies sit hidden underneath. During the intro wave, each
// column rises from far below — its top emerges through the void and the
// column reads as a building rising into place.
//
// A deep dark backdrop sits well below the columns' lowest reach so it
// never occludes them mid-rise. Outside the tiled radius the backdrop
// fills the horizon (heavy exponential fog hides the depth gap).
// Deep void floor: rendered with fog disabled so it stays solid dark at
// any distance. This is the "darkness" the columns rise out of — the
// global sky-coloured fog never tints it back toward the horizon.
const groundBackdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(3200, 3200),
  new THREE.MeshBasicMaterial({ color: VOID_COLOR, fog: false }),
);
groundBackdrop.rotation.x = -Math.PI / 2;
groundBackdrop.position.y = -120;
scene.add(groundBackdrop);

const FLOOR_TILE_SIZE   = 16;                                         // 4× larger
const FLOOR_TILE_HEIGHT = 24;
// Odd count so the center tile sits exactly at world origin — the car
// (which spawns at 0,0,0) lands on one tile instead of straddling four.
const FLOOR_TILE_COUNT  = 21;                                         // per axis (336 wide)
const FLOOR_TILE_TOTAL  = FLOOR_TILE_COUNT * FLOOR_TILE_COUNT;
const FLOOR_TILE_HALF   = (FLOOR_TILE_COUNT - 1) * 0.5;
const floorTileGeom = new THREE.BoxGeometry(
  FLOOR_TILE_SIZE * 0.97,
  FLOOR_TILE_HEIGHT,
  FLOOR_TILE_SIZE * 0.97,
);
// Translate so the top face is at local y=0 — landed columns flush to floor.
floorTileGeom.translate(0, -FLOOR_TILE_HEIGHT / 2, 0);

// Per-face vertex colors:
//   Top face (normal.y > 0)   → green deck.
//   Bottom face (normal.y < 0) → near-void dark.
//   Side faces                 → gradient from medium gray at the top
//                                edge to darker gray at the bottom.
// Branching by face normal is what lets the top face be green while the
// side-face top-edge vertices (same y, different normal) stay gray.
{
  const pos = floorTileGeom.attributes.position!;
  const nrm = floorTileGeom.attributes.normal!;
  const buf = new Float32Array(pos.count * 3);
  const topGreen = new THREE.Color(0x6da563);
  const sideTop  = new THREE.Color(0x6e7378);
  const sideBot  = new THREE.Color(0x33363b);
  const botFace  = new THREE.Color(0x1c1f23);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    let r: number, g: number, b: number;
    if (ny > 0.5) {
      r = topGreen.r; g = topGreen.g; b = topGreen.b;
    } else if (ny < -0.5) {
      r = botFace.r; g = botFace.g; b = botFace.b;
    } else {
      const y = pos.getY(i);                                 // y ∈ [-H, 0]
      const t = (y + FLOOR_TILE_HEIGHT) / FLOOR_TILE_HEIGHT; // 0 at bottom, 1 at top
      tmp.copy(sideBot).lerp(sideTop, t);
      r = tmp.r; g = tmp.g; b = tmp.b;
    }
    buf[i * 3 + 0] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  floorTileGeom.setAttribute('color', new THREE.BufferAttribute(buf, 3));
}

const floorTileMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,                       // multiplied by vertex + instance color
  vertexColors: true,
  metalness: 0.05,
  roughness: 0.95,
  emissive: new THREE.Color(0x111315),   // very faint warm-gray self-lift
  emissiveIntensity: 0.4,
});
const floorTiles = new THREE.InstancedMesh(floorTileGeom, floorTileMat, FLOOR_TILE_TOTAL);
floorTiles.receiveShadow = true;

// Per-instance brightness jitter — adjacent columns read as discrete
// blocks instead of a continuous sheet. Subtle: ±15% around 1.
{
  const inst = new Float32Array(FLOOR_TILE_TOTAL * 3);
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const v = 0.85 + Math.random() * 0.3;
    inst[i * 3 + 0] = v;
    inst[i * 3 + 1] = v;
    inst[i * 3 + 2] = v;
  }
  floorTiles.instanceColor = new THREE.InstancedBufferAttribute(inst, 3);
}
const _floorMtx = new THREE.Matrix4();
function tilePos(i: number): { x: number; z: number } {
  const ix = Math.floor(i / FLOOR_TILE_COUNT);
  const iz = i % FLOOR_TILE_COUNT;
  return {
    x: (ix - FLOOR_TILE_HALF) * FLOOR_TILE_SIZE,
    z: (iz - FLOOR_TILE_HALF) * FLOOR_TILE_SIZE,
  };
}
scene.add(floorTiles);

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

// Track lights/objects we attach to carRig per-load so we can clean them
// up cleanly on swap (without having to traverse and guess what's ours).
let carExtras: THREE.Object3D[] = [];

async function loadActiveCar(): Promise<void> {
  const root = await loader.loadAsync(ACTIVE_CAR.source);
  // FBX-ORIGINAL frame for this whole pack: car nose along +X. Rotate so
  // local -Z is forward — that's the direction flight-controls uses at yaw 0.
  root.scale.setScalar(0.012);
  root.rotation.y = -Math.PI / 2;
  await polishCarMaterials(root, { palettePath: palettePathFor(ACTIVE_CAR.fbm) });
  applyVoidToTree(root);
  carBody.add(root);

  if (ACTIVE_CAR.mode === 'fly') {
    const initialWheels = findCarWheels(root);
    attachWheelHardware(root, initialWheels.map((w) => w.obj.name));
    // Snapshot rig children before adding feature lights so we can
    // identify and remove just our additions later.
    const before = new Set(carRig.children);
    addDocLoreanFeatureLights(carRig, root);
    for (const c of carRig.children) if (!before.has(c)) carExtras.push(c);
    for (const w of findCarWheels(root)) {
      wheelTilts.push({ obj: w.obj, baseQuat: w.obj.quaternion.clone() });
    }
    attachHover(carRig, { liftHeight: 0.4, bobAmplitude: 0.05, spinSpeed: 0 });
  } else {
    const detected = findCarWheels(root);
    const wheels = wrapWheelPivots(detected, ACTIVE_CAR.wheelStrategy);
    wheelState = makeCarWheelState(wheels);
    wheelRadius = Math.max(0.05, estimateWheelRadius(wheels));
    root.position.y += groundOffsetY(root);
  }

  flightControls = createFlightControls(carRig, {
    maxSpeed: 22,
    maxBoostSpeed: 38,
    steerOutLag: 0.001,
  });
  carLoaded = true;
  (window as any).__home = {
    car: ACTIVE_CAR,
    carRig,
    carBody,
    flightControls,
    wheelState,
    wheelRadius,
    loaded: true,
  };
}

// Pre-load placeholder so tests can poll `window.__home.loaded`.
(window as any).__home = { car: ACTIVE_CAR, loaded: false };

void loadActiveCar().catch((err) => {
  console.error('homepage: failed to load car', ACTIVE_CAR.id, err);
});

// ---- Intro animation ----
//
// On every fresh load the world rises from out of view in a staggered wave.
// The car comes up first — reads as a central "column" arriving with the
// scene — and the surrounding pylons + pyramid blocks rise behind it in
// concentric rings outward from the origin. Cubic-out easing gives each
// piece a soft landing instead of a hard stop. The fine + major grids fade
// up alongside so the floor materialises with the rest of the world.
interface IntroTarget {
  obj: THREE.Object3D;
  finalY: number;
  delay: number;
  duration: number;
}
const INTRO_DROP            = 80;   // start this far below the floor
const INTRO_MAX_DELAY       = 2.4;  // outermost ring waits this long
const INTRO_FALLOFF_R       = 320;  // distance at which delay caps out
const INTRO_CAR_DURATION    = 1.05; // car rise duration
const INTRO_WORLD_LEAD      = 0.3;  // world starts this far before car finishes
// Stagger curve: pow(t, 0.2) is extremely steep near 0 and almost flat
// past mid-distance — the first few tiles arrive with long pauses
// between them, then the rest of the world cascades in fast. ~95% of
// tiles arrive in the back half of the timeline.
const INTRO_DELAY_CURVE     = 0.2;
// Rise duration also scales with distance: nearby tiles take their time
// climbing out of the void (so the body texture reads), outer rings snap
// up into place at the end.
const INTRO_RISE_NEAR       = 1.4;  // closest ring
const INTRO_RISE_FAR        = 0.35; // outermost ring
function staggerDelay(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return Math.pow(t, INTRO_DELAY_CURVE) * INTRO_MAX_DELAY;
}
function staggerRiseDuration(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return INTRO_RISE_NEAR + (INTRO_RISE_FAR - INTRO_RISE_NEAR) * t;
}

const introTargets: IntroTarget[] = [];
function registerIntroTarget(obj: THREE.Object3D) {
  const finalY = obj.position.y;
  const d = Math.hypot(obj.position.x, obj.position.z);
  introTargets.push({
    obj,
    finalY,
    delay: staggerDelay(d),
    duration: staggerRiseDuration(d),
  });
  obj.position.y = finalY - INTRO_DROP;
}
for (const b of blocks) registerIntroTarget(b.mesh);

// Floor tiles: same wave, but stored as flat typed arrays + applied via
// InstancedMesh matrices so we don't pay scene-graph overhead for 3600
// individual Object3Ds. Initial matrices park each tile below the floor.
const floorTileDelays    = new Float32Array(FLOOR_TILE_TOTAL);
const floorTileDurations = new Float32Array(FLOOR_TILE_TOTAL);
for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
  const { x, z } = tilePos(i);
  const d = Math.hypot(x, z);
  floorTileDelays[i]    = staggerDelay(d);
  floorTileDurations[i] = staggerRiseDuration(d);
  _floorMtx.makeTranslation(x, -INTRO_DROP, z);
  floorTiles.setMatrixAt(i, _floorMtx);
}
floorTiles.instanceMatrix.needsUpdate = true;

const gridFineMat = gridFine.material as THREE.Material;
const gridMajorMat = gridMajor.material as THREE.Material;
const gridFineFinal = gridFineMat.opacity;
const gridMajorFinal = gridMajorMat.opacity;
gridFineMat.opacity = 0;
gridMajorMat.opacity = 0;

let introStartTime = -1;     // wall-clock seconds when the intro begins
let introCarOffset = INTRO_DROP;
let introDone = false;

// Teardown (car-switch) animation. Mirror of the intro but much faster
// — the goal is a quick, snappy clear-out before the reload, not a
// cinematic build. Outer rings sink first, the car last.
const TEAR_RISE_DURATION = 0.28;
const TEAR_MAX_DELAY     = 0.6;
const TEAR_CAR_DURATION  = 0.28;
let tearingDown = false;
let tearStartTime = -1;
let tearTargetId: string | null = null;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInCubic  = (x: number) => x * x * x;

function startTeardown(targetId: string) {
  if (tearingDown || !introDone || targetId === ACTIVE_CAR.id) return;
  tearingDown = true;
  tearTargetId = targetId;
  tearStartTime = clock.getElapsedTime();
  // Update URL hash to reflect the choice (so a refresh keeps the new
  // car). replaceState doesn't re-fire hashchange.
  if (pickCarFromHash().id !== targetId) {
    history.replaceState(null, '', `#car=${encodeURIComponent(targetId)}`);
  }
  // Disable the picker so a second click can't queue a stacked teardown.
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = 'none';
}

// Swap the active car in place — no full-page reload. Disposes the old
// car's flight controls, removes its FBX from the body group, resets all
// car-related state, then loads the new car and lets the intro animation
// run again. The world (tiles + blocks) stays where teardown left it
// (sunk to -INTRO_DROP), so the intro lifts everything back up.
async function swapActiveCar(targetId: string) {
  const next = CARS.find((c) => c.id === targetId);
  if (!next || next.id === ACTIVE_CAR.id) return;

  // Tear down old car state.
  if (flightControls) {
    flightControls.dispose();
    flightControls = null;
  }
  for (const extra of carExtras) carRig.remove(extra);
  carExtras = [];
  // Drop everything inside carBody (the FBX root and any descendants).
  while (carBody.children.length > 0) carBody.remove(carBody.children[0]!);
  wheelTilts.length = 0;
  wheelState = null;
  wheelRadius = 0.3;
  carLoaded = false;
  carRig.position.set(0, 0, 0);
  carRig.rotation.set(0, 0, 0);
  carBody.rotation.set(0, 0, 0);
  fishtailYaw = 0;
  fishtailYawVel = 0;
  prevSteerInput = 0;
  smoothRoll = 0;
  smoothPitch = 0;

  ACTIVE_CAR = next;

  // Reset intro state so it runs again for the new car.
  introStartTime = -1;
  introDone = false;
  introCarOffset = INTRO_DROP;
  tearingDown = false;
  tearStartTime = -1;
  gridFineMat.opacity = 0;
  gridMajorMat.opacity = 0;

  // Update HUD + picker.
  const subj = document.getElementById('hud-subject');
  const fx = document.getElementById('hud-fx');
  if (subj) subj.textContent = ACTIVE_CAR.label;
  if (fx) fx.textContent = ACTIVE_CAR.mode === 'fly'
    ? 'neon · hover · afterburner'
    : 'neon · drive · rolling wheels';
  document.querySelectorAll<HTMLAnchorElement>('#car-picker a[data-id]').forEach((link) => {
    link.classList.toggle('active', link.dataset.id === ACTIVE_CAR.id);
  });
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = '';

  await loadActiveCar();
}

function tickIntro(t: number) {
  if (introDone) return;
  if (introStartTime < 0) {
    if (!carLoaded) return;
    introStartTime = t;
  }
  const elapsed = t - introStartTime;

  const carT = Math.min(1, elapsed / INTRO_CAR_DURATION);
  introCarOffset = (1 - easeOutCubic(carT)) * INTRO_DROP;

  // World rings start a touch before the car finishes its rise so the two
  // motions overlap into a single arrival rather than reading as a sequence.
  const worldElapsed = elapsed - (INTRO_CAR_DURATION - INTRO_WORLD_LEAD);
  let allLanded = carT >= 1;
  for (const target of introTargets) {
    const localT = (worldElapsed - target.delay) / target.duration;
    if (localT <= 0) {
      target.obj.position.y = target.finalY - INTRO_DROP;
      allLanded = false;
    } else if (localT < 1) {
      const k = easeOutCubic(localT);
      target.obj.position.y = target.finalY - (1 - k) * INTRO_DROP;
      allLanded = false;
    } else {
      target.obj.position.y = target.finalY;
    }
  }

  // Floor tiles share the wave: per-tile delay + duration, packed into an
  // InstancedMesh. Once every tile has landed we stop touching the buffer.
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const localT = (worldElapsed - floorTileDelays[i]!) / floorTileDurations[i]!;
    let y: number;
    if (localT <= 0) { y = -INTRO_DROP; allLanded = false; }
    else if (localT < 1) { y = -(1 - easeOutCubic(localT)) * INTRO_DROP; allLanded = false; }
    else { y = 0; }
    const { x, z } = tilePos(i);
    _floorMtx.makeTranslation(x, y, z);
    floorTiles.setMatrixAt(i, _floorMtx);
  }
  floorTiles.instanceMatrix.needsUpdate = true;

  // Grid fade tracks the car rise + the first wave of pylons.
  const fadeT = Math.min(1, elapsed / (INTRO_CAR_DURATION + 0.3));
  const k = easeOutCubic(fadeT);
  gridFineMat.opacity = gridFineFinal * k;
  gridMajorMat.opacity = gridMajorFinal * k;

  if (allLanded && fadeT >= 1) {
    introDone = true;
    introCarOffset = 0;
  }
}

function tickTeardown(t: number) {
  const elapsed = t - tearStartTime;
  // Map each piece's intro-delay (proportional to distance) onto the
  // shorter teardown window: outer rings sink first, center last. We
  // re-scale rather than reuse the intro delays directly so the whole
  // teardown stays inside TEAR_MAX_DELAY.
  const introDelayRange = INTRO_MAX_DELAY > 0 ? INTRO_MAX_DELAY : 1;

  let allDown = true;
  for (const target of introTargets) {
    const tearDelay = (1 - target.delay / introDelayRange) * TEAR_MAX_DELAY;
    const localT = (elapsed - tearDelay) / TEAR_RISE_DURATION;
    if (localT <= 0) {
      target.obj.position.y = target.finalY;
      allDown = false;
    } else if (localT < 1) {
      const k = easeInCubic(localT);
      target.obj.position.y = target.finalY - k * INTRO_DROP;
      allDown = false;
    } else {
      target.obj.position.y = target.finalY - INTRO_DROP;
    }
  }

  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const tearDelay = (1 - floorTileDelays[i]! / introDelayRange) * TEAR_MAX_DELAY;
    const localT = (elapsed - tearDelay) / TEAR_RISE_DURATION;
    let y: number;
    if (localT <= 0) { y = 0; allDown = false; }
    else if (localT < 1) { y = -easeInCubic(localT) * INTRO_DROP; allDown = false; }
    else { y = -INTRO_DROP; }
    const { x, z } = tilePos(i);
    _floorMtx.makeTranslation(x, y, z);
    floorTiles.setMatrixAt(i, _floorMtx);
  }
  floorTiles.instanceMatrix.needsUpdate = true;

  const carDelay = TEAR_MAX_DELAY + TEAR_RISE_DURATION * 0.3;
  const carT = Math.max(0, Math.min(1, (elapsed - carDelay) / TEAR_CAR_DURATION));
  introCarOffset = easeInCubic(carT) * INTRO_DROP;
  if (carT < 1) allDown = false;

  const fadeT = Math.min(1, elapsed / (TEAR_MAX_DELAY * 0.7));
  const fadeK = easeInCubic(fadeT);
  gridFineMat.opacity = gridFineFinal * (1 - fadeK);
  gridMajorMat.opacity = gridMajorFinal * (1 - fadeK);

  if (allDown && tearTargetId) {
    const target = tearTargetId;
    tearTargetId = null;
    void swapActiveCar(target).catch((err) => {
      console.error('homepage: failed to swap car', target, err);
    });
  }
}

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

  if (tearingDown) tickTeardown(t);
  else tickIntro(t);

  if (carLoaded && flightControls && introDone && !tearingDown) {
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
    const fishTarget = steerNow * FISHTAIL_HOLD_OFFSET * fishtailScale;
    const fishDamp = steerNow !== 0 ? FISHTAIL_DAMP_PRESS : FISHTAIL_DAMP_RELEASE;
    const fishAccel =
      (fishTarget - fishtailYaw) * FISHTAIL_OMEGA * FISHTAIL_OMEGA
      - fishtailYawVel * 2 * fishDamp * FISHTAIL_OMEGA;
    fishtailYawVel += fishAccel * dt;
    fishtailYaw += fishtailYawVel * dt;
    carBody.rotation.y = fishtailYaw;

    updateBlocks(dt);
    if (ACTIVE_CAR.mode === 'fly') tickHover(carRig, dt, t);
    updateCamera(dt);
    updateHud();
  } else if (carLoaded) {
    // Intro phase: hold the car at the origin and let it rise into view with
    // the rest of the world. Run hover so the docLorean is already bobbing
    // when it lands; skip input + drive integration.
    if (ACTIVE_CAR.mode === 'fly') tickHover(carRig, dt, t);
    updateCamera(dt);
    updateHud();
  } else {
    // Pre-load: park the camera somewhere sane so first frame isn't black.
    camera.position.set(camOffset.x, camOffset.y, camOffset.z);
    camera.lookAt(0, 0.6, 0);
  }

  // Apply the intro rise to the car last, after every other Y write. Drive
  // mode never writes carRig.y on its own (no hover, no flight integration),
  // so we anchor it to 0 first — otherwise the offset would accumulate frame
  // over frame and the car would sink endlessly. Fly mode already had its y
  // written by tickHover above, so we just subtract from there.
  if (carLoaded) {
    if (ACTIVE_CAR.mode === 'drive') carRig.position.y = 0;
    if (introCarOffset > 0) carRig.position.y -= introCarOffset;
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

// Floor tile material gets its own combined shader (texture + void) so
// the column body has visible banding/noise during the rise. Apply
// before the broad scene pass so it claims the __voidApplied flag and
// the generic applyVerticalVoid skips it.
applyFloorTileShader(floorTileMat);
applyVoidToTree(scene);

tick();
