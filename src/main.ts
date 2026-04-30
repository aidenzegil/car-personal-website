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
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
type CarMode = 'fly' | 'drive' | 'pet';
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
  // Pet — animated corgi. Loads the base FBX + lazy-loads run/sit/idle
  // animation clips on demand. WASD movement: W = run forward (with
  // CorgiRun loop), A/D = yaw, S = sit (no movement). Idle (no keys)
  // cycles through random idle clips every few seconds.
  { id: 'Corgi', label: 'Corgi', source: '/models/corgi/CorgiCorgi.fbx', fbm: '', mode: 'pet' },
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
      setActiveCarPicker(id);
      startTeardown(id);
    });
  });
}
function setActiveCarPicker(id: string) {
  document.querySelectorAll<HTMLAnchorElement>('#car-picker a[data-id]').forEach((link) => {
    link.classList.toggle('active', link.dataset.id === id);
  });
}
renderCarPicker();

// If we just came back from the asset library, play the slide-in-from-
// left animation once. Cold loads and same-page reloads skip it.
try {
  if (sessionStorage.getItem('nav-from') === 'library') {
    document.body.classList.add('nav-back-from-library');
  }
  sessionStorage.removeItem('nav-from');
} catch { /* private mode etc. — ignore */ }

// Intercept the "Asset library →" link so it triggers the same teardown
// wave as a car swap, then navigates. Without this, the page would just
// hard-cut to /library.html and there's no exit motion.
document.querySelectorAll<HTMLAnchorElement>('a.lib').forEach((link) => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    e.preventDefault();
    startTeardownForNav(href);
  });
});

window.addEventListener('hashchange', () => {
  const id = pickCarFromHash().id;
  if (id !== ACTIVE_CAR.id) {
    setActiveCarPicker(id);
    startTeardown(id);
  }
});

// Update the static HUD copy to reflect the chosen car's mode.
{
  const subj = document.getElementById('hud-subject');
  const fx = document.getElementById('hud-fx');
  if (subj) subj.textContent = ACTIVE_CAR.label;
  if (fx) fx.textContent =
    ACTIVE_CAR.mode === 'fly' ? 'neon · hover · afterburner' :
    ACTIVE_CAR.mode === 'pet' ? 'wasd · run · sit (S)' :
    'neon · drive · rolling wheels';
  const splashVerb = document.getElementById('splash-verb');
  if (splashVerb) splashVerb.textContent =
    ACTIVE_CAR.mode === 'fly' ? 'WASD to fly' :
    ACTIVE_CAR.mode === 'pet' ? 'WAD to walk · S to sit' :
    'WASD to drive';
}

const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement | null;
if (!canvas) throw new Error('hero canvas missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// DPR capped at 1.25 — chunky toon art doesn't read any sharper at 1.5
// or 2.0, and 1.25 cuts fillrate ~30% vs 1.5 on Retina. Biggest single
// perf knob.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
// Real shadow map for the car only — the floor receives, foliage does
// not participate. Tight shadow camera frustum (set on the key light
// below) keeps the depth pass to a tiny budget.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;

const scene = new THREE.Scene();
// Daytime arcade atmosphere — bright sky overhead, dark soil below.
// SKY_COLOR drives the background + fog so distance fades cleanly to a
// daylight horizon; VOID_COLOR is the deep underground that the
// columns rise out of (still aggressive below y=0 so the intro reads).
const SKY_COLOR  = 0xb8e2f5;
// Void = sky color so when a column dips below the floor (intro start /
// teardown end) it dissolves into the same daylight blue we see at the
// horizon. The world reads as a tile-island floating in sky instead of
// columns rising out of dark earth.
const VOID_COLOR = 0xb8e2f5;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.0055);

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
// The face-normal axis is ~0; the smaller of the other two is the
// distance to the closest edge. Tight band + gentle darkening so the
// edges read as a clean seam line, not a thick muddy frame.
vec3 fromCenter = vTileObj - vec3(0.0, uTileCenterY, 0.0);
vec3 distEdge = uTileHalfExtent - abs(fromCenter);
float minD = min(distEdge.x, min(distEdge.y, distEdge.z));
float maxD = max(distEdge.x, max(distEdge.y, distEdge.z));
float edgeDist = (distEdge.x + distEdge.y + distEdge.z) - minD - maxD;
float edgeFactor = smoothstep(0.0, 0.35, edgeDist);
gl_FragColor.rgb *= mix(0.72, 1.0, edgeFactor);
// Per-tile static noise — very subtle so each tile has its own grain
// without looking dirty.
float n = fract(sin(dot(floor(vVoidWorld.xz * 0.5), vec2(12.9898, 78.233))) * 43758.5453);
gl_FragColor.rgb *= 1.0 + (n - 0.5) * 0.05;
#include <fog_fragment>
// Vertical void: fade toward VOID_COLOR below the floor plane.
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

// 3/4 of previous size for a more natural scale relative to the car.
// Pet mode (corgi) plays in a smaller world: tiles half-size + tighter
// camera, so the dog reads as a real dog instead of a tiny smudge in
// the distance. Cars stay at the original scale.
const WORLD_SCALE = ACTIVE_CAR.mode === 'pet' ? 0.5 : 1;
const FLOOR_TILE_SIZE   = 12 * WORLD_SCALE;
const FLOOR_TILE_HEIGHT = 18 * WORLD_SCALE;
// Odd count so the center tile sits exactly at world origin — the car
// (which spawns at 0,0,0) lands on one tile instead of straddling four.
// Bumped count to keep coverage area roughly the same after the size
// reduction (28 × 12 = 336, matches the previous 21 × 16).
const FLOOR_TILE_COUNT  = 27;
const FLOOR_TILE_TOTAL  = FLOOR_TILE_COUNT * FLOOR_TILE_COUNT;
const FLOOR_TILE_HALF   = (FLOOR_TILE_COUNT - 1) * 0.5;
// Tiles fully connect (no gap) — adjacent tiles' edge-darken bands
// butt up against each other, forming a chunky continuous grid line at
// every shared seam. Reads as the underlying tile structure without any
// visible "missing pixel" between columns.
const floorTileGeom = new THREE.BoxGeometry(
  FLOOR_TILE_SIZE,
  FLOOR_TILE_HEIGHT,
  FLOOR_TILE_SIZE,
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
  // Crossy-Roads-ish: saturated grass green on the deck, warm dirt
  // browns on the sides (light at the topsoil, deep umber at depth).
  const topGreen = new THREE.Color(0x6db93a);
  const sideTop  = new THREE.Color(0x9b6d3e);
  const sideBot  = new THREE.Color(0x4a3320);
  const botFace  = new THREE.Color(0x1f1410);
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

// Per-instance brightness + hue jitter so tiles read as discrete
// patches of grass instead of one uniform carpet. Brightness ±10%; R
// and B independently nudge ±7% so some tiles tilt warmer (yellow-
// green) and others cooler (blue-green), the way real grass does.
{
  const inst = new Float32Array(FLOOR_TILE_TOTAL * 3);
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const v = 0.9 + Math.random() * 0.2;
    inst[i * 3 + 0] = v * (0.93 + Math.random() * 0.14);
    inst[i * 3 + 1] = v;
    inst[i * 3 + 2] = v * (0.93 + Math.random() * 0.14);
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

// ---- Foliage scatter ----
//
// Decorative trees / bushes / flowers / mushrooms / rocks scattered on
// top of the floor tiles. No collisions — the car drives straight
// through them. One InstancedMesh per prop type so the entire scatter
// is a handful of draw calls regardless of count.
//
// Placement is deterministic (seeded PRNG per tile) so the world looks
// the same across reloads. Each foliage instance is bound to a tile
// index — during intro/teardown its Y is computed from that tile's
// current rise/sink Y so the scatter rides up with the tile beneath it.
const objLoader = new OBJLoader();
const naturePaletteTex = new THREE.TextureLoader().load('/models/nature/TexturePalette.png');
naturePaletteTex.magFilter = THREE.NearestFilter;
naturePaletteTex.minFilter = THREE.NearestFilter;
naturePaletteTex.colorSpace = THREE.SRGBColorSpace;
naturePaletteTex.generateMipmaps = false;

interface FoliagePropDef {
  id: string;
  category: 'tree' | 'bush' | 'flower' | 'mushroom' | 'rock';
  /** Final-world max-dimension target so trees end up roughly tile-tall
   *  and flowers stay small. Multiplied by per-instance jitter. */
  targetSize: number;
  /** Horizontal collision radius (XZ plane) — when the car is closer
   *  than this + the car's own half-width, the prop explodes into
   *  smoke. Roughly the visible canopy half-width. */
  collisionRadius: number;
  /** How many smoke particles to emit on hit. Bigger props = bigger
   *  puff. Capped to keep the pool from running dry on tree clusters. */
  smokeParticles: number;
}
// Sizes calibrated relative to the car (~3 units long after FBX scale).
// Pet mode shrinks them by WORLD_SCALE so the corgi doesn't look like
// it's running through a redwood forest.
const FS = WORLD_SCALE;
const FOLIAGE_PROPS: FoliagePropDef[] = [
  { id: 'Tree1_Green', category: 'tree', targetSize: 11 * FS, collisionRadius: 1.6 * FS, smokeParticles: 10 },
  { id: 'Tree2_Green', category: 'tree', targetSize: 12 * FS, collisionRadius: 1.7 * FS, smokeParticles: 11 },
  { id: 'Tree3',       category: 'tree', targetSize: 9  * FS, collisionRadius: 1.4 * FS, smokeParticles: 9  },
  { id: 'Tree4_Green', category: 'tree', targetSize: 8  * FS, collisionRadius: 1.3 * FS, smokeParticles: 8  },
  { id: 'Tree5_Green', category: 'tree', targetSize: 8  * FS, collisionRadius: 1.3 * FS, smokeParticles: 8  },
  { id: 'Tree6_Green', category: 'tree', targetSize: 10 * FS, collisionRadius: 1.5 * FS, smokeParticles: 9  },
  { id: 'CircularBush_Green', category: 'bush', targetSize: 2.4 * FS, collisionRadius: 0.9 * FS, smokeParticles: 6 },
  { id: 'CubyBush_Green',     category: 'bush', targetSize: 2.2 * FS, collisionRadius: 0.9 * FS, smokeParticles: 6 },
  { id: 'Flower1', category: 'flower', targetSize: 0.8 * FS, collisionRadius: 0.4 * FS, smokeParticles: 3 },
  { id: 'Flower2', category: 'flower', targetSize: 0.8 * FS, collisionRadius: 0.4 * FS, smokeParticles: 3 },
  { id: 'Flower3', category: 'flower', targetSize: 0.7 * FS, collisionRadius: 0.4 * FS, smokeParticles: 3 },
  { id: 'Flower4', category: 'flower', targetSize: 0.7 * FS, collisionRadius: 0.4 * FS, smokeParticles: 3 },
  { id: 'Flower5', category: 'flower', targetSize: 0.8 * FS, collisionRadius: 0.4 * FS, smokeParticles: 3 },
  { id: 'Mushroom1', category: 'mushroom', targetSize: 1.3 * FS, collisionRadius: 0.5 * FS, smokeParticles: 4 },
  { id: 'Mushroom2', category: 'mushroom', targetSize: 1.0 * FS, collisionRadius: 0.5 * FS, smokeParticles: 4 },
  { id: 'Rock1', category: 'rock', targetSize: 2.5 * FS, collisionRadius: 1.0 * FS, smokeParticles: 7 },
  { id: 'Rock2', category: 'rock', targetSize: 2.0 * FS, collisionRadius: 0.8 * FS, smokeParticles: 6 },
  { id: 'Rock3', category: 'rock', targetSize: 1.8 * FS, collisionRadius: 0.7 * FS, smokeParticles: 5 },
  { id: 'Rock4', category: 'rock', targetSize: 1.5 * FS, collisionRadius: 0.6 * FS, smokeParticles: 5 },
];

interface FoliagePlacement {
  tileIdx: number;
  worldX: number;
  worldZ: number;
  scale: number;       // base prop scale × per-instance jitter
  rotY: number;
  /** Captured current Y at teardown start (lerps from current → sunken). */
  tearStartY: number;
  /** True once the car has clipped this prop. The InstancedMesh matrix
   *  for this slot is squashed to scale=0 so the prop disappears, and
   *  collision skips it on subsequent frames. Reset on map reset. */
  hit: boolean;
}
interface FoliageGroup {
  mesh: THREE.InstancedMesh;
  /** Y offset that places the prop's bbox MIN.Y at 0 once scaled — so a
   *  tree's trunk-bottom touches the tile top, not floats above it. */
  groundOffsetY: number;
  instances: FoliagePlacement[];
  /** Source prop def — needed for per-prop collision radius + smoke
   *  particle count when the car runs into one of these instances. */
  def: FoliagePropDef;
}
const foliageGroups: FoliageGroup[] = [];
let foliageReady = false;

// Tiny stateless PRNG so per-tile placement is deterministic across
// page loads. Seeded by tile index so reload doesn't reshuffle.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFoliageType(rng: () => number): FoliagePropDef | null {
  // 60% empty, 40% something. Within "something" weights:
  //   tree 35%, bush 18%, rock 22%, flower 17%, mushroom 8%
  const r = rng();
  if (r < 0.60) return null;
  const p = (r - 0.60) / 0.40; // 0..1 within "something"
  const trees    = FOLIAGE_PROPS.filter((d) => d.category === 'tree');
  const bushes   = FOLIAGE_PROPS.filter((d) => d.category === 'bush');
  const flowers  = FOLIAGE_PROPS.filter((d) => d.category === 'flower');
  const mushroom = FOLIAGE_PROPS.filter((d) => d.category === 'mushroom');
  const rocks    = FOLIAGE_PROPS.filter((d) => d.category === 'rock');
  const cat = p < 0.35 ? trees
            : p < 0.53 ? bushes
            : p < 0.75 ? rocks
            : p < 0.92 ? flowers
            : mushroom;
  return cat[Math.floor(rng() * cat.length)] ?? null;
}

function generateFoliagePlacements(): Map<string, FoliagePlacement[]> {
  const map = new Map<string, FoliagePlacement[]>();
  // Half-tile size around the spawn so the car's tile + its 8 neighbors
  // stay clear — keeps the immediate spawn area readable.
  const clearR = FLOOR_TILE_SIZE * 1.5;
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const { x: tx, z: tz } = tilePos(i);
    if (Math.abs(tx) <= clearR && Math.abs(tz) <= clearR) continue;
    const rng = mulberry32(i + 1);
    const def = pickFoliageType(rng);
    if (!def) continue;
    const offsetX = (rng() - 0.5) * (FLOOR_TILE_SIZE * 0.55);
    const offsetZ = (rng() - 0.5) * (FLOOR_TILE_SIZE * 0.55);
    const scale   = 0.85 + rng() * 0.3;
    const rotY    = rng() * Math.PI * 2;
    const list = map.get(def.id) ?? [];
    list.push({ tileIdx: i, worldX: tx + offsetX, worldZ: tz + offsetZ, scale, rotY, tearStartY: 0, hit: false });
    map.set(def.id, list);
  }
  return map;
}

const _foliageMtx   = new THREE.Matrix4();
const _foliageQuat  = new THREE.Quaternion();
const _foliageEuler = new THREE.Euler();
const _foliageVec   = new THREE.Vector3();
const _foliageScale = new THREE.Vector3();

// Single shared material for every foliage prop — they all sample the
// same TexturePalette.png, so this saves per-prop material/program
// state changes at render time. The vertical-void shader is compiled
// exactly once for this material and reused by every InstancedMesh.
const sharedFoliageMat = new THREE.MeshStandardMaterial({
  map: naturePaletteTex,
  roughness: 0.85,
  metalness: 0.05,
});
applyVerticalVoid(sharedFoliageMat);

async function buildFoliage(): Promise<void> {
  const placements = generateFoliagePlacements();
  await Promise.all([...placements.entries()].map(async ([propId, list]) => {
    if (list.length === 0) return;
    const def = FOLIAGE_PROPS.find((d) => d.id === propId);
    if (!def) return;
    const obj = await objLoader.loadAsync(`/models/nature/${propId}.obj`);
    let firstMesh: THREE.Mesh | null = null;
    obj.traverse((node) => { if (!firstMesh && (node as any).isMesh) firstMesh = node as THREE.Mesh; });
    if (!firstMesh) return;
    const meshNode: THREE.Mesh = firstMesh;
    const baseBox = new THREE.Box3().setFromBufferAttribute(meshNode.geometry.attributes.position as THREE.BufferAttribute);
    const baseSize = baseBox.getSize(new THREE.Vector3());
    const baseMaxDim = Math.max(baseSize.x, baseSize.y, baseSize.z);
    const baseScale = baseMaxDim > 0 ? def.targetSize / baseMaxDim : 1;
    const groundOffsetY = -baseBox.min.y * baseScale;

    const inst = new THREE.InstancedMesh(meshNode.geometry, sharedFoliageMat, list.length);
    inst.userData.__baseScale = baseScale;
    inst.frustumCulled = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      _foliageEuler.set(0, p.rotY, 0);
      _foliageQuat.setFromEuler(_foliageEuler);
      _foliageScale.setScalar(baseScale * p.scale);
      _foliageVec.set(p.worldX, -INTRO_DROP, p.worldZ);
      _foliageMtx.compose(_foliageVec, _foliageQuat, _foliageScale);
      inst.setMatrixAt(i, _foliageMtx);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    foliageGroups.push({ mesh: inst, groundOffsetY, instances: list, def });
  }));
  foliageReady = true;
}

void buildFoliage().catch((err) => console.error('foliage load failed', err));

// ---- Smoke particles + foliage collision ----
//
// Pooled InstancedMesh of small white spheres. When the car runs into
// a tree / bush / flower, that prop's instance gets squashed to scale
// 0 (the prop "vanishes") and we allocate N particles from the pool
// at the prop's position with random outward + upward velocity.
// Particles age out, drag horizontally, sag under light gravity, and
// scale-fade to nothing — when their life hits 0 the slot becomes
// reusable. Additive blending + brightness fade reads as a wispy
// cartoon puff against either the green deck or the sky.
const SMOKE_MAX = 320;
const _smokeGeom = new THREE.SphereGeometry(0.55, 8, 6);
// Normal alpha blending instead of additive — additive white clips
// against the bright sky (white + light blue ≈ white = invisible).
// Solid opaque white reads on every background; scale-based fade
// (expand then shrink) handles dissipation.
const smokeMat = new THREE.MeshBasicMaterial({
  color: 0xfbfdff,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  fog: false,
});
const smokeMesh = new THREE.InstancedMesh(_smokeGeom, smokeMat, SMOKE_MAX);
smokeMesh.frustumCulled = false;
scene.add(smokeMesh);

interface SmokeParticle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;        // remaining life, 1 → 0
  active: boolean;
}
const smokePool: SmokeParticle[] = [];
for (let i = 0; i < SMOKE_MAX; i++) {
  smokePool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, active: false });
}
// Hide every slot at boot — empty slots stay scale-0 until allocated.
// Prevents a frame-1 flash of clumped particles at origin.
const _smokeMtx = new THREE.Matrix4();
const _smokeZero = new THREE.Vector3(0, 0, 0);
const _smokeIdent = new THREE.Quaternion();
for (let i = 0; i < SMOKE_MAX; i++) {
  _smokeMtx.compose(_smokeZero, _smokeIdent, _smokeZero);
  smokeMesh.setMatrixAt(i, _smokeMtx);
}
smokeMesh.instanceMatrix.needsUpdate = true;

const SMOKE_LIFE = 0.9;
const SMOKE_GRAVITY = 0.4;
const SMOKE_DRAG = 1.4;
// Minimum particle count so even a flower hit produces a visible
// puff. Per-prop count is the bigger of (def value × 1.5, this floor).
const SMOKE_MIN_PARTICLES = 6;
function spawnSmoke(x: number, y: number, z: number, count: number, intensity: number) {
  const want = Math.max(SMOKE_MIN_PARTICLES, Math.round(count * 1.5));
  let spawned = 0;
  for (let i = 0; i < SMOKE_MAX && spawned < want; i++) {
    const p = smokePool[i]!;
    if (p.active) continue;
    p.active = true;
    p.x = x + (Math.random() - 0.5) * 0.4;
    p.y = y + (Math.random() - 0.5) * 0.3;
    p.z = z + (Math.random() - 0.5) * 0.4;
    const a = Math.random() * Math.PI * 2;
    const speed = (1.8 + Math.random() * 2.5) * Math.max(0.6, intensity);
    p.vx = Math.cos(a) * speed;
    p.vz = Math.sin(a) * speed;
    p.vy = 1.5 + Math.random() * 2.5;
    p.life = 1;
    spawned++;
  }
}
function clearSmoke() {
  for (let i = 0; i < SMOKE_MAX; i++) {
    smokePool[i]!.active = false;
    _smokeMtx.compose(_smokeZero, _smokeIdent, _smokeZero);
    smokeMesh.setMatrixAt(i, _smokeMtx);
  }
  smokeMesh.instanceMatrix.needsUpdate = true;
}
const _smokeScaleVec = new THREE.Vector3();
const _smokePosVec = new THREE.Vector3();
function tickSmoke(dt: number) {
  for (let i = 0; i < SMOKE_MAX; i++) {
    const p = smokePool[i]!;
    if (!p.active) continue;
    p.life -= dt / SMOKE_LIFE;
    if (p.life <= 0) {
      p.active = false;
      _smokeMtx.compose(_smokeZero, _smokeIdent, _smokeZero);
      smokeMesh.setMatrixAt(i, _smokeMtx);
      continue;
    }
    const dragK = Math.max(0, 1 - SMOKE_DRAG * dt);
    p.vx *= dragK;
    p.vz *= dragK;
    p.vy -= SMOKE_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    // Scale curve: expand fast in the first 60% of life, then shrink
    // to nothing over the last 40%. Replaces the per-instance opacity
    // fade we used with additive blending — the puff now reads as a
    // billowing cloud that dissipates instead of just vanishing.
    const ageT = 1 - p.life;
    let scale: number;
    if (ageT < 0.6) {
      scale = 0.6 + (ageT / 0.6) * 1.8;          // 0.6 → 2.4
    } else {
      const k = (ageT - 0.6) / 0.4;              // 0 → 1 over last 40%
      scale = 2.4 * (1 - k * k);                  // ease-out shrink to 0
    }
    _smokeScaleVec.set(scale, scale, scale);
    _smokePosVec.set(p.x, p.y, p.z);
    _smokeMtx.compose(_smokePosVec, _smokeIdent, _smokeScaleVec);
    smokeMesh.setMatrixAt(i, _smokeMtx);
  }
  smokeMesh.instanceMatrix.needsUpdate = true;
}

// Player half-width for foliage collision. Pet mode is a smaller dog
// in a smaller world — 1.5 would crush half a tile of bushes around
// the corgi just by standing near them.
const CAR_COLLIDE_RADIUS = 1.5 * WORLD_SCALE;
const _hitMtx = new THREE.Matrix4();
const _hitZero3 = new THREE.Vector3(0, 0, 0);
function tickFoliageCollisions() {
  if (!introDone || tearingDown || isFalling || !carLoaded) return;
  const cx = carRig.position.x;
  const cz = carRig.position.z;
  for (const grp of foliageGroups) {
    const r = grp.def.collisionRadius + CAR_COLLIDE_RADIUS;
    const r2 = r * r;
    for (let i = 0; i < grp.instances.length; i++) {
      const p = grp.instances[i]!;
      if (p.hit) continue;
      const dx = p.worldX - cx;
      const dz = p.worldZ - cz;
      if (dx * dx + dz * dz < r2) {
        p.hit = true;
        // Squash the prop's instance matrix to zero so it disappears.
        _hitMtx.compose(_hitZero3, _smokeIdent, _hitZero3);
        grp.mesh.setMatrixAt(i, _hitMtx);
        grp.mesh.instanceMatrix.needsUpdate = true;
        // Spawn smoke at the prop base — a touch above the floor so the
        // first particle doesn't clip through the deck.
        const intensity = grp.def.collisionRadius;
        spawnSmoke(p.worldX, 0.6 + grp.def.targetSize * 0.25, p.worldZ, grp.def.smokeParticles, intensity);
      }
    }
  }
}

// ---- Shadows ----
//
// Cheap blob shadows: a radial-gradient PNG painted onto a small Plane
// per moving object (car + plane). Two extra draw calls total, no
// shadow maps, no per-pixel light cost. Foliage doesn't get shadows —
// hundreds of overlapping discs would look noisy AND erase the perf
// budget we're trying to preserve.
const SHADOW_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0,   'rgba(0,0,0,0.85)');
  g.addColorStop(0.55,'rgba(0,0,0,0.45)');
  g.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
})();

function createShadowDisc(width: number, depth: number, opacity: number): THREE.Mesh {
  // Stretching the circular gradient into a non-square plane gives an
  // ellipse — much closer to a car's footprint than a hard circle.
  const geom = new THREE.PlaneGeometry(width, depth);
  const mat = new THREE.MeshBasicMaterial({
    map: SHADOW_TEX,
    transparent: true,
    opacity,
    depthWrite: false,
    fog: false,
  });
  const m = new THREE.Mesh(geom, mat);
  m.rotation.x = -Math.PI / 2; // lie flat on the floor
  m.renderOrder = 1;            // draw after the floor so it composites cleanly
  return m;
}

// Sit just above the tile tops (y=0) so the shadow lands on the deck
// without z-fighting against the tile surface.
const SHADOW_Y = 0.04;


// ---- Plane fly-by ----
//
// Cartoony low-poly plane crosses the scene high overhead on a fixed
// path, alternating directions. Pass timeline (one full cycle):
//   0..14s    fly right → left
//   14..24s   off-screen left, world quiet
//   24..38s   fly left → right
//   38..48s   off-screen right, world quiet
//   then loop
//
// Propeller spin is driven by the baked HeliceAction clip via an
// AnimationMixer. Plane Y stays well above the tile field so it never
// intersects foliage; X is the direction of motion; rotation.y flips
// 180° between passes so the nose always leads.
const glbLoader = new GLTFLoader();
const PLANE_SPAN          = 360;  // total X distance per pass (in/out of view)
const PLANE_FLY_DURATION  = 14;   // seconds per crossing
const PLANE_REST_DURATION = 10;   // seconds parked off-screen between passes
// Camera looks ~35° down from y=22, so anything above y≈18 is out of
// frustum near the play area. Cruise at 14 — clearly above the tile
// tops (y=0) but inside the visible cone.
const PLANE_ALTITUDE      = 14;
const PLANE_Z_OFFSET      = -10;  // slightly behind the camera target so
                                  // the path crosses through frame center
const PLANE_SCALE         = 0.6;
let planeAircraft: THREE.Object3D | null = null;
let planeMixer: THREE.AnimationMixer | null = null;
let planeStartT = -1;             // wall-clock time when the loop begins
const planeShadow = createShadowDisc(5.0, 2.5, 0.22);
planeShadow.visible = false;
scene.add(planeShadow);

async function loadPlane(): Promise<void> {
  const gltf = await glbLoader.loadAsync('/models/aircraft/plane.glb');
  const root = gltf.scene;
  root.scale.setScalar(PLANE_SCALE);
  applyVoidToTree(root);
  if (gltf.animations?.length) {
    planeMixer = new THREE.AnimationMixer(root);
    const clip = gltf.animations.find((a) => a.name === 'HeliceAction');
    if (clip) planeMixer.clipAction(clip).play();
  }
  // Park off-screen to the right; the first call to tickPlane will move
  // it onto the path.
  root.position.set(PLANE_SPAN * 0.5, PLANE_ALTITUDE, PLANE_Z_OFFSET);
  root.visible = false;
  scene.add(root);
  planeAircraft = root;
}
void loadPlane().catch((err) => console.error('plane load failed', err));

function tickPlane(t: number, dt: number) {
  if (!planeAircraft) return;
  if (planeMixer) planeMixer.update(dt);
  // Wait until the world intro is in progress so the plane shows up
  // alongside the rising tiles, not before there's anything to fly over.
  if (planeStartT < 0) {
    if (introStartTime < 0) return;
    planeStartT = t;
  }
  const cycle = (PLANE_FLY_DURATION + PLANE_REST_DURATION) * 2;
  const cyclePos = (t - planeStartT) % cycle;
  const xRight = PLANE_SPAN * 0.5;
  const xLeft  = -PLANE_SPAN * 0.5;
  if (cyclePos < PLANE_FLY_DURATION) {
    // Right → left. Easing-in-out so the entry/exit feel smoother than a
    // dead-uniform crawl, but the bulk of the path is steady cruising.
    const u = cyclePos / PLANE_FLY_DURATION;
    planeAircraft.position.x = xRight + (xLeft - xRight) * u;
    planeAircraft.rotation.y = -Math.PI * 0.5; // nose -X (motion direction)
    planeAircraft.visible = true;
  } else if (cyclePos < PLANE_FLY_DURATION + PLANE_REST_DURATION) {
    planeAircraft.visible = false;
  } else if (cyclePos < PLANE_FLY_DURATION * 2 + PLANE_REST_DURATION) {
    const u = (cyclePos - PLANE_FLY_DURATION - PLANE_REST_DURATION) / PLANE_FLY_DURATION;
    planeAircraft.position.x = xLeft + (xRight - xLeft) * u;
    planeAircraft.rotation.y = Math.PI * 0.5;  // nose +X (motion direction)
    planeAircraft.visible = true;
  } else {
    planeAircraft.visible = false;
  }
  // Shadow tracks the plane's XZ; visibility mirrors the plane.
  if (planeAircraft.visible) {
    planeShadow.position.set(planeAircraft.position.x, SHADOW_Y, planeAircraft.position.z);
    planeShadow.visible = true;
  } else {
    planeShadow.visible = false;
  }
}

/** Compute a tile's current Y given the intro animation's worldElapsed.
 *  Mirrors the math used for floorTiles in tickIntro. */
function tileYAtIntroElapsed(tileIdx: number, worldElapsed: number): number {
  const localT = (worldElapsed - floorTileDelays[tileIdx]!) / floorTileDurations[tileIdx]!;
  if (localT <= 0) return -INTRO_DROP;
  if (localT < 1) return -(1 - easeOutCubic(localT)) * INTRO_DROP;
  return 0;
}

function writeFoliageMatrix(grp: FoliageGroup, idx: number, y: number) {
  const p = grp.instances[idx]!;
  if (p.hit) {
    // Smoked prop: keep its instance squashed to zero so neither the
    // intro rise nor the teardown sink resurrects it mid-animation.
    // The hit flag is cleared by resetMap() / swapActiveCar() at the
    // end of teardown, which is the only legal moment to bring the
    // prop back.
    _foliageMtx.compose(_smokeZero, _smokeIdent, _smokeZero);
    grp.mesh.setMatrixAt(idx, _foliageMtx);
    return;
  }
  _foliageEuler.set(0, p.rotY, 0);
  _foliageQuat.setFromEuler(_foliageEuler);
  const baseScale = grp.mesh.userData.__baseScale as number;
  _foliageScale.setScalar(baseScale * p.scale);
  _foliageVec.set(p.worldX, y + grp.groundOffsetY, p.worldZ);
  _foliageMtx.compose(_foliageVec, _foliageQuat, _foliageScale);
  grp.mesh.setMatrixAt(idx, _foliageMtx);
}

// ---- Pet (corgi) controls ----
//
// State machine + lazy animation loader. The corgi pack ships one
// FBX per clip (43 total), so we only fetch the clips we actually need
// for play: a few idle variants, run, and the sit chain. Each clip's
// AnimationClip is plucked off the loaded FBX's `animations[0]` and
// played on a mixer attached to the loaded base mesh.
//
// Movement: W = run forward, A/D = yaw, S = sit (no movement). No
// reverse, no boost — that's why we don't use flightControls here.

const corgiTex = new THREE.TextureLoader().load('/models/corgi/CorgiExample1.png');
corgiTex.colorSpace = THREE.SRGBColorSpace;
corgiTex.anisotropy = 4;

type PetAnimState = 'idle' | 'running';
interface PetController {
  mixer: THREE.AnimationMixer;
  velocity: THREE.Vector3;
  forwardSpeed(): number;
  speedFraction(): number;
  /** Wired by the tick loop each frame so we can drive the carRig. */
  update(dt: number): void;
  dispose(): void;
}
let petController: PetController | null = null;

const PET_CLIP_RUN = 'CorgiRun';
// Idle pool — cycled randomly when no input.
const PET_IDLE_POOL = [
  'CorgiIdle', 'CorgiIdleSniff', 'CorgiIdleDig', 'CorgiIdleMouthClosed', 'CorgiIdleBarking',
];
const PET_IDLE_MIN_DURATION = 3.5;
const PET_IDLE_MAX_DURATION = 6.0;

// 8-direction snap movement. WASD = N/W/S/E (with diagonals via two
// keys). The corgi rotates to face the direction of motion. No
// acceleration, no deceleration, no sit state — just translate while
// keys are held.
const PET_RUN_SPEED = 10.5;      // world units / s (75% of original 14)
const PET_BASE_SCALE = 0.014;
const PET_GROUND_Y = 0;

function createPetController(root: THREE.Object3D, loader: FBXLoader): PetController {
  const mixer = new THREE.AnimationMixer(root);
  // Cache loaded clips so each FBX only hits the network once.
  const loaded = new Map<string, THREE.AnimationClip>();
  // Pre-cache the base FBX's own animation if it has one (the rest pose
  // FBX often ships with a default idle clip).
  if (root.animations.length) {
    root.animations[0]!.name = 'CorgiCorgi';
    loaded.set('CorgiCorgi', root.animations[0]!);
  }

  let currentAction: THREE.AnimationAction | null = null;
  let currentName: string | null = null;
  let pending: string | null = null; // most recent clip request, even pre-load

  /** Strip root-motion translation tracks from a clip so the corgi
   *  stays in place under skeleton control — our PetController owns
   *  world position via carRig, the clip only owns the in-place pose.
   *  Without this every frame's mixer.update yanks the mesh ~94 world
   *  units away from carRig (Mixamo-style root motion baked in). */
  function stripRootMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
    clip.tracks = clip.tracks.filter((t) => !/\.position$/.test(t.name));
    return clip;
  }

  // Same root-motion fix on the base FBX's own clip cache.
  if (loaded.has('CorgiCorgi')) stripRootMotion(loaded.get('CorgiCorgi')!);

  async function ensureClip(name: string): Promise<THREE.AnimationClip> {
    let clip = loaded.get(name);
    if (clip) return clip;
    const fbx = await loader.loadAsync(`/models/corgi/${name}.fbx`);
    const c = fbx.animations[0];
    if (!c) throw new Error(`pet clip ${name} has no animations`);
    c.name = name;
    stripRootMotion(c);
    loaded.set(name, c);
    return c;
  }

  function playLoaded(clip: THREE.AnimationClip, opts?: { loop?: boolean; crossfade?: number }) {
    const next = mixer.clipAction(clip);
    next.reset();
    next.setLoop(opts?.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce, opts?.loop !== false ? Infinity : 1);
    next.clampWhenFinished = opts?.loop === false;
    if (currentAction && currentAction !== next) {
      next.crossFadeFrom(currentAction, opts?.crossfade ?? 0.25, false);
      next.play();
    } else {
      next.play();
    }
    currentAction = next;
  }

  /** Request playback of a named clip. If not loaded, kicks off the
   *  fetch and plays as soon as it lands — IF the request is still
   *  the most recent (avoids stale fetches reasserting old state). */
  function play(name: string, opts?: { loop?: boolean; crossfade?: number }) {
    pending = name;
    if (currentName === name && opts?.loop !== false) return;
    currentName = name;
    const cached = loaded.get(name);
    if (cached) {
      playLoaded(cached, opts);
      return;
    }
    void ensureClip(name).then((c) => {
      if (pending !== name) return;
      playLoaded(c, opts);
    }).catch((err) => console.warn('pet clip load failed', name, err));
  }

  // Animation state machine.
  let animState: PetAnimState = 'idle';
  let idleTimer = 0;
  function pickIdle() {
    const id = PET_IDLE_POOL[Math.floor(Math.random() * PET_IDLE_POOL.length)]!;
    play(id);
    idleTimer = PET_IDLE_MIN_DURATION + Math.random() * (PET_IDLE_MAX_DURATION - PET_IDLE_MIN_DURATION);
  }
  pickIdle();

  // Input state — separate listener so we don't share with flightControls
  // (which doesn't exist in pet mode anyway). Stored uppercase code for
  // determinism across keyboard layouts.
  const keys = new Set<string>();
  function onKeyDown(e: KeyboardEvent) {
    keys.add(e.code);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function onBlur() {
    keys.clear();
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const velocity = new THREE.Vector3();
  let forwardSpeed = 0;
  const _forwardVec = new THREE.Vector3();

  // Movement smoothing. Snapped instant transitions felt jarring per
  // user feedback; this adds a light lerp toward the target speed +
  // angle. Time constants are short (≤0.18s) so the dog still feels
  // responsive — no car-style "coasts to a stop over 2 seconds."
  let displaySpeed = 0;
  let displayYaw = 0;
  const PET_SPEED_TAU = 0.10;   // ~6 frames @60fps to reach target
  const PET_YAW_TAU   = 0.08;   // even snappier on direction swaps
  const PET_CROSSFADE = 0.4;
  return {
    mixer,
    velocity,
    forwardSpeed: () => forwardSpeed,
    speedFraction: () => Math.abs(forwardSpeed) / PET_RUN_SPEED,
    update(dt: number) {
      mixer.update(dt);

      const fwd  = keys.has('KeyW') || keys.has('ArrowUp')    ? 1 : 0;
      const back = keys.has('KeyS') || keys.has('ArrowDown')  ? 1 : 0;
      const left = keys.has('KeyA') || keys.has('ArrowLeft')  ? 1 : 0;
      const right = keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0;
      const dx = right - left;
      const dz = back - fwd;
      const moving = dx !== 0 || dz !== 0;

      if (moving) {
        if (animState !== 'running') {
          animState = 'running';
          play(PET_CLIP_RUN, { crossfade: PET_CROSSFADE });
        }
        // Yaw: lerp toward the target direction along the shorter
        // arc so a W→D swap rotates 90° smoothly instead of snapping.
        const targetYaw = Math.atan2(-dx, -dz);
        let delta = targetYaw - displayYaw;
        while (delta >  Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        displayYaw += delta * (1 - Math.exp(-dt / PET_YAW_TAU));
        carRig.rotation.y = displayYaw;
      } else if (animState === 'running') {
        animState = 'idle';
        pickIdle();
      } else {
        idleTimer -= dt;
        if (idleTimer <= 0) pickIdle();
      }

      // Speed: ease toward target. Velocity always points along the
      // current display yaw so the brief settle-in/out happens along
      // the dog's facing direction, not the input vector.
      const targetSpeed = moving ? PET_RUN_SPEED : 0;
      displaySpeed += (targetSpeed - displaySpeed) * (1 - Math.exp(-dt / PET_SPEED_TAU));
      if (Math.abs(displaySpeed - targetSpeed) < 0.05) displaySpeed = targetSpeed;
      forwardSpeed = displaySpeed;

      _forwardVec.set(0, 0, -1).applyQuaternion(carRig.quaternion);
      velocity.copy(_forwardVec).multiplyScalar(forwardSpeed);
      if (forwardSpeed !== 0) {
        carRig.position.x += velocity.x * dt;
        carRig.position.z += velocity.z * dt;
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}

// ---- Lighting ----
// Daylight setup. Sun-key is warm + bright, sky-rim is a soft cool blue,
// hemi pulls the sky tone down onto everything so shadowed faces still
// read as outdoors instead of black.
const key = new THREE.DirectionalLight(0xfff4dc, 1.6);
key.position.set(40, 80, 30);
// Real shadow map: tight frustum (±9 units) following the car each
// frame so the 1024² depth buffer is dedicated entirely to the car
// silhouette. Foliage / plane / backdrop are excluded by leaving their
// `castShadow` at the default `false`.
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 200;
key.shadow.camera.left   = -9;
key.shadow.camera.right  =  9;
key.shadow.camera.top    =  9;
key.shadow.camera.bottom = -9;
key.shadow.bias = -0.0005;
key.shadow.radius = 3;        // PCF soft-edge falloff
scene.add(key);
scene.add(key.target);        // light direction is `position → target`

const rim = new THREE.DirectionalLight(0x9fc8ff, 0.45);
rim.position.set(-30, 40, -50);
scene.add(rim);

const hemi = new THREE.HemisphereLight(0xb8e2f5, 0x3a2a18, 0.55);
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

// Track lights/objects we attach to carRig per-load so we can clean them
// up cleanly on swap (without having to traverse and guess what's ours).
let carExtras: THREE.Object3D[] = [];

async function loadActiveCar(): Promise<void> {
  const root = await loader.loadAsync(ACTIVE_CAR.source);
  carBody.add(root);

  if (ACTIVE_CAR.mode === 'pet') {
    // Corgi: skip palette polish (no .fbm sidecar), apply the
    // CorgiExample1.png diffuse map manually, build the animation
    // controller.
    root.scale.setScalar(PET_BASE_SCALE);
    // FBX-original frame for the corgi pack: head along +Z. Rotate +π
    // around Y so the head ends up along -Z (the rig's "forward"
    // direction at yaw 0). Without this the corgi runs backwards.
    root.rotation.y = Math.PI;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!(mesh as any).isMesh && !(mesh as any).isSkinnedMesh) return;
      mesh.castShadow = true;
      mesh.material = new THREE.MeshStandardMaterial({
        map: corgiTex,
        roughness: 0.85,
        metalness: 0.05,
      });
    });
    applyVoidToTree(root);
    // Auto-lift to put the bind-pose feet on the deck. The corgi's
    // SkinnedMesh has bind-pose vertices that live at huge negative Y
    // values (the skeleton root bone translates them back up at
    // render time). Box3.setFromObject reports the unskinned/object
    // bbox — we subtract its min.y to map it onto y >= 0. Library's
    // buildAnimatedFbx uses the same trick to land the corgi on its
    // platform.
    {
      const bbox = new THREE.Box3().setFromObject(root);
      if (Number.isFinite(bbox.min.y)) {
        root.position.y = PET_GROUND_Y - bbox.min.y;
      }
    }

    petController = createPetController(root, loader);
    carLoaded = true;
    (window as any).__home = {
      car: ACTIVE_CAR,
      carRig,
      carBody,
      petController,
      loaded: true,
    };
    return;
  }

  // FBX-ORIGINAL frame for this whole pack: car nose along +X. Rotate so
  // local -Z is forward — that's the direction flight-controls uses at yaw 0.
  root.scale.setScalar(0.012);
  root.rotation.y = -Math.PI / 2;
  await polishCarMaterials(root, { palettePath: palettePathFor(ACTIVE_CAR.fbm) });
  applyVoidToTree(root);
  // Mark every car mesh as a shadow caster so the directional light's
  // tight shadow camera (configured above) renders a real car-shaped
  // shadow onto the floor tiles.
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).castShadow = true;
  });

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
const INTRO_DROP            = 80;   // start this far below the floor
const INTRO_MAX_DELAY       = 1.6;  // outermost ring waits this long
const INTRO_FALLOFF_R       = 320;  // distance at which delay caps out
const INTRO_CAR_DURATION    = 0.7;  // car rise duration
const INTRO_WORLD_LEAD      = 0.2;  // world starts this far before car finishes
// Stagger curve: pow(t, 0.2) is extremely steep near 0 and almost flat
// past mid-distance — the first few tiles arrive with long pauses
// between them, then the rest of the world cascades in fast. ~95% of
// tiles arrive in the back half of the timeline.
const INTRO_DELAY_CURVE     = 0.2;
// Rise duration also scales with distance: nearby tiles take their time
// climbing out of the void (so the body texture reads), outer rings snap
// up into place at the end.
const INTRO_RISE_NEAR       = 0.93; // closest ring
const INTRO_RISE_FAR        = 0.23; // outermost ring
function staggerDelay(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return Math.pow(t, INTRO_DELAY_CURVE) * INTRO_MAX_DELAY;
}
function staggerRiseDuration(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return INTRO_RISE_NEAR + (INTRO_RISE_FAR - INTRO_RISE_NEAR) * t;
}

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

let introStartTime = -1;     // wall-clock seconds when the intro begins
let introCarOffset = INTRO_DROP;
let introDone = false;

// Teardown (car-switch) animation. Snappy clear-out before the in-place
// car swap. Wave radiates outward FROM the car's current position (not
// world origin), so even after the player has driven away the sink reads
// as a clean outburst from where they are right now.
const TEAR_RISE_DURATION = 0.19;
const TEAR_MAX_DELAY     = 0.37;
const TEAR_CAR_DURATION  = 0.19;
const TEAR_FALLOFF_R     = 280;
let tearingDown = false;
let tearStartTime = -1;
let tearTargetId: string | null = null;
let tearStartCarOffset = 0;
const floorTileTearDelays = new Float32Array(FLOOR_TILE_TOTAL);
const floorTileTearStartY = new Float32Array(FLOOR_TILE_TOTAL);
const _tearReadMtx = new THREE.Matrix4();
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInCubic  = (x: number) => x * x * x;

// Capture the state needed by tickTeardown: per-piece sink delay
// (radiating outward from the car's current position so the wave reads
// as centered on the player) and per-piece current y (so the sink lerps
// from where things are, even mid-intro). Shared by both car-swap
// teardown and page-nav teardown.
function captureTeardownStart() {
  const cx = carRig.position.x;
  const cz = carRig.position.z;
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const { x, z } = tilePos(i);
    const d = Math.hypot(x - cx, z - cz);
    const t = Math.min(d / TEAR_FALLOFF_R, 1);
    floorTileTearDelays[i] = (1 - t) * TEAR_MAX_DELAY;
    floorTiles.getMatrixAt(i, _tearReadMtx);
    floorTileTearStartY[i] = _tearReadMtx.elements[13]!;
  }
  // Foliage: walk the per-prop instance lists and capture their current
  // Y from the InstancedMesh buffer so we can lerp from there. Also
  // disable frustum culling — we're about to animate matrices again,
  // so the cached bounding sphere is no longer trustworthy.
  for (const grp of foliageGroups) {
    grp.mesh.frustumCulled = false;
    for (let i = 0; i < grp.instances.length; i++) {
      grp.mesh.getMatrixAt(i, _tearReadMtx);
      grp.instances[i]!.tearStartY = _tearReadMtx.elements[13]!;
    }
  }
  tearStartCarOffset = introCarOffset;
}

function startTeardown(targetId: string) {
  // Allow interrupting an in-flight intro: clicking another car mid-rise
  // freezes everything where it is and runs teardown from there. The only
  // guard is "no double teardown" and "no swap to the same car."
  if (tearingDown || targetId === ACTIVE_CAR.id) return;
  tearingDown = true;
  tearTargetId = targetId;
  tearStartTime = clock.getElapsedTime();
  if (pickCarFromHash().id !== targetId) {
    history.replaceState(null, '', `#car=${encodeURIComponent(targetId)}`);
  }
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = 'none';
  captureTeardownStart();
}

// Page-nav teardown: same wave, different completion — navigate to the
// given URL instead of swapping cars in-place. Used by the "Asset
// library →" link so the home page tears down before the library loads.
let tearNavUrl: string | null = null;
// Reset teardown: triggered after the car falls off the world. The
// teardown wave plays (tiles + foliage sink), then resetMap() rebuilds
// the scene + replays the intro. The map "doesn't reset until
// teardown is complete" — this flag carries that intent across frames.
let tearShouldReset = false;
function startTeardownForReset() {
  if (tearingDown) return;
  tearingDown = true;
  tearTargetId = null;
  tearNavUrl = null;
  tearShouldReset = true;
  tearStartTime = clock.getElapsedTime();
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = 'none';
  captureTeardownStart();
}
function startTeardownForNav(url: string) {
  if (tearingDown) return;
  tearingDown = true;
  tearTargetId = null;
  tearNavUrl = url;
  tearStartTime = clock.getElapsedTime();
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = 'none';
  captureTeardownStart();
}

// Swap the active car in place — no full-page reload. Disposes the old
// car's flight controls, removes its FBX from the body group, resets all
// car-related state, then loads the new car and lets the intro animation
// run again. The world (tiles + blocks) stays where teardown left it
// (sunk to -INTRO_DROP), so the intro lifts everything back up.
async function swapActiveCar(targetId: string) {
  const next = CARS.find((c) => c.id === targetId);
  if (!next || next.id === ACTIVE_CAR.id) return;

  // Pet mode runs at WORLD_SCALE = 0.5: tiles, foliage geometry, edge
  // distances, camera offset all baked at module-load. Crossing the
  // pet ↔ car boundary requires a full reload so everything rebuilds
  // at the new scale. Same-class swaps (car ↔ car, or pet ↔ pet if we
  // ever add another pet) skip the reload and keep the smooth
  // teardown→intro feel.
  const crossesScaleBoundary = (ACTIVE_CAR.mode === 'pet') !== (next.mode === 'pet');
  if (crossesScaleBoundary) {
    window.location.href = `${window.location.pathname}#car=${encodeURIComponent(targetId)}`;
    window.location.reload();
    return;
  }

  // Tear down old car state.
  if (flightControls) {
    flightControls.dispose();
    flightControls = null;
  }
  if (petController) {
    petController.dispose();
    petController = null;
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

  // Clear any props the player smashed during the previous run + dump
  // in-flight smoke puffs. The teardown wave that just finished won't
  // have un-squashed hit instances on its own (writeFoliageMatrix
  // honors the hit flag), so this is the only legal moment to bring
  // those props back for the next intro.
  for (const grp of foliageGroups) {
    for (let i = 0; i < grp.instances.length; i++) {
      grp.instances[i]!.hit = false;
    }
  }
  clearSmoke();

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
    // Wait for both the car AND the foliage scatter so the scene rises
    // as one cohesive piece — otherwise trees pop in mid-rise.
    if (!carLoaded || !foliageReady) return;
    introStartTime = t;
  }
  const elapsed = t - introStartTime;

  const carT = Math.min(1, elapsed / INTRO_CAR_DURATION);
  introCarOffset = (1 - easeOutCubic(carT)) * INTRO_DROP;

  // World rings start a touch before the car finishes its rise so the two
  // motions overlap into a single arrival rather than reading as a sequence.
  const worldElapsed = elapsed - (INTRO_CAR_DURATION - INTRO_WORLD_LEAD);
  let allLanded = carT >= 1;

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

  // Foliage rides on top of its tile — Y derived from the tile's
  // current intro state so trees rise out of the void in lockstep with
  // the dirt block they're growing on.
  for (const grp of foliageGroups) {
    for (let i = 0; i < grp.instances.length; i++) {
      const tileY = tileYAtIntroElapsed(grp.instances[i]!.tileIdx, worldElapsed);
      writeFoliageMatrix(grp, i, tileY);
    }
    grp.mesh.instanceMatrix.needsUpdate = true;
  }

  if (allLanded) {
    introDone = true;
    introCarOffset = 0;
    // Once everything is in its final pose, recompute foliage bounding
    // spheres from the actual instance matrices and re-enable frustum
    // culling. Cuts draw calls when the camera looks toward the edge of
    // the play area (groups outside the view get skipped).
    for (const grp of foliageGroups) {
      grp.mesh.computeBoundingSphere();
      grp.mesh.frustumCulled = true;
    }
  }
}

function tickTeardown(t: number) {
  const elapsed = t - tearStartTime;
  let allDown = true;

  // Floor tiles: same lerp, packed into the InstancedMesh buffer.
  const tileEndY = -INTRO_DROP;
  // Cache tile Ys for the foliage pass below.
  const tileYs = new Float32Array(FLOOR_TILE_TOTAL);
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const startY = floorTileTearStartY[i]!;
    const localT = (elapsed - floorTileTearDelays[i]!) / TEAR_RISE_DURATION;
    let y: number;
    if (localT <= 0) {
      y = startY;
      if (startY > tileEndY) allDown = false;
    } else if (localT < 1) {
      const k = easeInCubic(localT);
      y = startY + (tileEndY - startY) * k;
      allDown = false;
    } else {
      y = tileEndY;
    }
    tileYs[i] = y;
    const { x, z } = tilePos(i);
    _floorMtx.makeTranslation(x, y, z);
    floorTiles.setMatrixAt(i, _floorMtx);
  }
  floorTiles.instanceMatrix.needsUpdate = true;

  // Foliage: ride down with its tile.
  for (const grp of foliageGroups) {
    for (let i = 0; i < grp.instances.length; i++) {
      writeFoliageMatrix(grp, i, tileYs[grp.instances[i]!.tileIdx]!);
    }
    grp.mesh.instanceMatrix.needsUpdate = true;
  }

  // Car: drops last, after the world wave is mostly clear. Lerp from the
  // current intro offset (captured at teardown start) up to INTRO_DROP.
  const carDelay = TEAR_MAX_DELAY + TEAR_RISE_DURATION * 0.3;
  const carT = Math.max(0, Math.min(1, (elapsed - carDelay) / TEAR_CAR_DURATION));
  introCarOffset = tearStartCarOffset + (INTRO_DROP - tearStartCarOffset) * easeInCubic(carT);
  if (carT < 1) allDown = false;

  if (allDown) {
    if (tearTargetId) {
      const target = tearTargetId;
      tearTargetId = null;
      void swapActiveCar(target).catch((err) => {
        console.error('homepage: failed to swap car', target, err);
      });
    } else if (tearNavUrl) {
      const url = tearNavUrl;
      tearNavUrl = null;
      window.location.href = url;
    } else if (tearShouldReset) {
      tearShouldReset = false;
      resetMap();
    }
  }
}

// ---- Crossy Road camera ----
//
// Fixed isometric-ish angle in world space — the camera never rotates with
// the car. It just translates to keep the car in frame. That means when you
// steer, the car visibly rotates inside the viewport instead of staying
// glued to the same screen-space orientation.
// Crossy-Road-ish chase angle. Pet mode pulls in 35% to keep the corgi
// visibly the size of a real dog rather than a tiny mote in the field.
const camOffset = new THREE.Vector3(
  18 * (ACTIVE_CAR.mode === 'pet' ? 0.55 : 1),
  22 * (ACTIVE_CAR.mode === 'pet' ? 0.55 : 1),
  24 * (ACTIVE_CAR.mode === 'pet' ? 0.55 : 1),
);
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

// While falling, tilt the lookAt down with the car so the player can
// watch it tumble out of the world instead of cutting on the horizon.
function updateCameraFalling() {
  camera.position.set(
    carRig.position.x + camOffset.x,
    camOffset.y,
    carRig.position.z + camOffset.z,
  );
  _tmpLook.set(carRig.position.x, carRig.position.y, carRig.position.z);
  camera.lookAt(_tmpLook);
}

// ---- Edge fall + map reset ----
//
// Outermost tile centers sit at ±FLOOR_TILE_HALF·SIZE; their outer
// edge is half a tile further out. The car body is ~3 units long and
// ~1.5 wide, so we trigger the fall slightly *before* the center
// reaches the tile edge — by then the front bumper is hanging off and
// the car visibly looks overcommitted. Without this offset the player
// can perch comfortably half-off-the-map before gravity bites.
const CAR_HALF_LENGTH = 1.6 * WORLD_SCALE;
const MAP_EDGE =
  FLOOR_TILE_HALF * FLOOR_TILE_SIZE   // outermost tile center
  + FLOOR_TILE_SIZE * 0.5              // outer edge of that tile
  - CAR_HALF_LENGTH;                   // pull back so overhang trips the fall
const FALL_GRAVITY  = 28;     // world units / s²
const FALL_RESET_Y  = -120;   // when the car drops past this we reset
const FALL_DRAG     = 0.5;    // air drag on horizontal velocity (1/s)
let isFalling     = false;
let fallVelX      = 0;
let fallVelY      = 0;
let fallVelZ      = 0;
let fallSpinX     = 0;        // body tumble rates so the car flips as it falls
let fallSpinZ     = 0;

function startFalling() {
  if (isFalling) return;
  // Carry the car's last forward velocity into the fall so it arcs off
  // the edge naturally. Disposing flight controls cuts input + the
  // controller's own integration; we own the car's transform now.
  if (flightControls) {
    fallVelX = flightControls.velocity.x;
    fallVelZ = flightControls.velocity.z;
    flightControls.dispose();
    flightControls = null;
    (window as any).__home = { ...((window as any).__home ?? {}), flightControls: null };
  }
  if (petController) {
    fallVelX = petController.velocity.x;
    fallVelZ = petController.velocity.z;
    petController.dispose();
    petController = null;
    (window as any).__home = { ...((window as any).__home ?? {}), petController: null };
  }
  // True-to-physics edge departure: if the car center is past the
  // trigger edge on an axis, force a minimum outward velocity on that
  // axis. This guarantees the body slides clear of the tile bodies
  // (which extend down 24 units) BEFORE gravity has time to drop it
  // through them — no more clipping through the floor mid-fall.
  const OUTWARD_PUSH = 14;
  if (carRig.position.x >  MAP_EDGE) fallVelX = Math.max(fallVelX,  OUTWARD_PUSH);
  if (carRig.position.x < -MAP_EDGE) fallVelX = Math.min(fallVelX, -OUTWARD_PUSH);
  if (carRig.position.z >  MAP_EDGE) fallVelZ = Math.max(fallVelZ,  OUTWARD_PUSH);
  if (carRig.position.z < -MAP_EDGE) fallVelZ = Math.min(fallVelZ, -OUTWARD_PUSH);
  // No upward kick — gravity is the only Y force from the moment the
  // car leaves the platform. Mild random tumble for visual interest
  // (a real car nosediving off a cliff *does* rotate, but exact pitch
  // would require knowing the wheelbase / mass distribution; this
  // reads close enough at the chunky toon scale).
  fallVelY = 0;
  fallSpinX = (Math.random() - 0.5) * 2.5;
  fallSpinZ = (Math.random() - 0.5) * 2.0;
  isFalling = true;
}

function tickFall(dt: number) {
  fallVelY -= FALL_GRAVITY * dt;
  fallVelX *= Math.max(0, 1 - FALL_DRAG * dt);
  fallVelZ *= Math.max(0, 1 - FALL_DRAG * dt);
  carRig.position.x += fallVelX * dt;
  carRig.position.y += fallVelY * dt;
  carRig.position.z += fallVelZ * dt;
  carBody.rotation.x += fallSpinX * dt;
  carBody.rotation.z += fallSpinZ * dt;
  if (carRig.position.y < FALL_RESET_Y) {
    // Done falling. Hide the car and recenter it so the teardown
    // camera frames the world sinking from above origin (the car xz
    // is now far off the play area). The map doesn't reset until the
    // teardown completes — that's handled by tickTeardown calling
    // resetMap() once allDown is true.
    isFalling = false;
    fallVelX = fallVelY = fallVelZ = 0;
    fallSpinX = fallSpinZ = 0;
    carRig.visible = false;
    carRig.position.set(0, 0, 0);
    carRig.rotation.set(0, 0, 0);
    carBody.rotation.set(0, 0, 0);
    startTeardownForReset();
  }
}

function resetMap() {
  // Reset car transform + per-frame smoothing state.
  isFalling = false;
  fallVelX = fallVelY = fallVelZ = 0;
  fallSpinX = fallSpinZ = 0;
  carRig.position.set(0, 0, 0);
  carRig.rotation.set(0, 0, 0);
  carBody.rotation.set(0, 0, 0);
  carRig.visible = true;
  fishtailYaw = 0;
  fishtailYawVel = 0;
  prevSteerInput = 0;
  smoothRoll = 0;
  smoothPitch = 0;

  // Push every tile and foliage instance back to its sunken pose so
  // the intro re-rises the world cleanly.
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const { x, z } = tilePos(i);
    _floorMtx.makeTranslation(x, -INTRO_DROP, z);
    floorTiles.setMatrixAt(i, _floorMtx);
  }
  floorTiles.instanceMatrix.needsUpdate = true;
  for (const grp of foliageGroups) {
    grp.mesh.frustumCulled = false;
    const baseScale = grp.mesh.userData.__baseScale as number;
    for (let i = 0; i < grp.instances.length; i++) {
      const p = grp.instances[i]!;
      // Un-explode every prop the player smoked on the previous run.
      p.hit = false;
      _foliageEuler.set(0, p.rotY, 0);
      _foliageQuat.setFromEuler(_foliageEuler);
      _foliageScale.setScalar(baseScale * p.scale);
      _foliageVec.set(p.worldX, -INTRO_DROP, p.worldZ);
      _foliageMtx.compose(_foliageVec, _foliageQuat, _foliageScale);
      grp.mesh.setMatrixAt(i, _foliageMtx);
    }
    grp.mesh.instanceMatrix.needsUpdate = true;
  }

  // Drop any in-flight smoke puffs so the new run starts clean.
  clearSmoke();

  // Reset intro state — tickIntro will re-arm itself the next frame
  // since carLoaded + foliageReady are still true. Also clear
  // teardown state so the tick loop stops calling tickTeardown and
  // routes to tickIntro instead.
  introStartTime = -1;
  introDone = false;
  introCarOffset = INTRO_DROP;
  tearingDown = false;
  tearStartTime = -1;
  tearShouldReset = false;
  tearTargetId = null;
  tearNavUrl = null;
  // Re-enable the picker — startTeardownForReset disabled it.
  const host = document.getElementById('car-picker');
  if (host) host.style.pointerEvents = '';

  // Re-arm controls (the previous instance was disposed when the fall
  // started). Pet mode uses petController instead of flightControls;
  // the existing FBX root is still parented in carBody so we just
  // wire a fresh controller to it.
  if (ACTIVE_CAR.mode === 'pet') {
    const root = carBody.children[0];
    if (root) {
      petController = createPetController(root, loader);
      (window as any).__home = {
        ...((window as any).__home ?? {}),
        petController,
        flightControls: null,
        loaded: true,
      };
    }
    return;
  }
  flightControls = createFlightControls(carRig, {
    maxSpeed: 22,
    maxBoostSpeed: 38,
    steerOutLag: 0.001,
  });
  (window as any).__home = {
    ...((window as any).__home ?? {}),
    flightControls,
    loaded: true,
  };
}

// ---- HUD wiring ----
const hudSpeed     = document.getElementById('hud-speed') as HTMLElement | null;
const hudBoostFill = document.getElementById('hud-boost-fill') as HTMLElement | null;
const hudBoostLabel = document.getElementById('hud-boost-label') as HTMLElement | null;
const hudPosX = document.getElementById('hud-x') as HTMLElement | null;
const hudPosZ = document.getElementById('hud-z') as HTMLElement | null;

function updateHud() {
  if (hudPosX) hudPosX.textContent = String(Math.round(carRig.position.x));
  if (hudPosZ) hudPosZ.textContent = String(Math.round(carRig.position.z));

  if (petController) {
    const speed = Math.abs(petController.forwardSpeed());
    if (hudSpeed) hudSpeed.textContent = String(Math.round(speed));
    // Pet mode has no boost. Park the bar at full + label "—".
    if (hudBoostFill) hudBoostFill.style.transform = 'scaleX(1)';
    if (hudBoostLabel) {
      hudBoostLabel.textContent = 'GOOD BOY';
      hudBoostLabel.dataset.state = 'ready';
    }
    return;
  }
  if (!flightControls) return;
  const speed = flightControls.velocity.length();
  if (hudSpeed) hudSpeed.textContent = String(Math.round(speed));

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

// ---- Loop ----
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();

  if (tearingDown) tickTeardown(t);
  else tickIntro(t);

  tickPlane(t, dt);
  tickSmoke(dt);
  tickFoliageCollisions();

  // Falling state: own the car's transform, gate normal play.
  if (isFalling) {
    tickFall(dt);
    updateCameraFalling();
    updateHud();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
    return;
  }

  play: if (carLoaded && (flightControls || petController) && introDone && !tearingDown) {
    if (Math.abs(carRig.position.x) > MAP_EDGE || Math.abs(carRig.position.z) > MAP_EDGE) {
      startFalling();
      break play;
    }
    if (ACTIVE_CAR.mode === 'pet' && petController) {
      // Pet mode: the controller owns input + state + movement +
      // animation mixer advancement. None of the car-specific bits
      // (wheel rotation, body fishtail, hover bob, pitch/roll lean)
      // apply to the corgi.
      petController.update(dt);
      // Reset any leftover body rotations from a previous car-mode run
      // — swapActiveCar already does this, but a paranoid reset costs
      // nothing and prevents accumulated drift.
      carBody.rotation.x = 0;
      carBody.rotation.y = 0;
      carBody.rotation.z = 0;
      updateCamera(dt);
      updateHud();
      break play;
    }
    if (!flightControls) break play;
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
      // Flight-controls already inverts yaw rate when reversing, so A/D
      // turn the body the player-expected direction. Flip the visible
      // front-wheel angle to match: pressing A while reversing should
      // show the wheels angled the way the car is actually pivoting,
      // not the forward-motion direction.
      const reverseDir = v < -0.05 ? -1 : 1;
      const steerAngle = -roll * DRIVE_STEER_MAX * reverseDir;
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
    // Drive + pet modes don't write carRig.y on their own each frame
    // (only fly mode does, via tickHover). Without this anchor, the
    // intro's `y -= introCarOffset` accumulates frame over frame and
    // the rig sinks endlessly out of view.
    if (ACTIVE_CAR.mode !== 'fly') carRig.position.y = 0;
    if (introCarOffset > 0) carRig.position.y -= introCarOffset;
  }

  // Real-shadow tracking: keep the directional light's position +
  // target locked at a fixed sun-angle offset from the car's XZ. The
  // 18-unit frustum on key.shadow.camera (set at lighting setup) means
  // the depth buffer is always dedicated to a 18×18-unit footprint
  // centered on the car — crisp silhouette, tiny budget.
  if (carLoaded && introCarOffset < 2) {
    const cx = carRig.position.x;
    const cz = carRig.position.z;
    key.position.set(cx + 40, 80, cz + 30);
    key.target.position.set(cx, 0, cz);
    key.target.updateMatrixWorld();
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
