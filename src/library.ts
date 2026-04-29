// Asset Library — browse and preview the 3D assets used in this project.
//
// Mirrors the pattern from farmer-game's library.ts: one Three.js scene with
// orbit controls, a sidebar listing every asset, click-to-load. Built so
// adding a new asset is a single entry in ASSETS — load logic, hover, and
// info-panel content are derived from there.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  attachHover, tickHover,
  polishCarMaterials,
  addDocLoreanFeatureLights,
  findCarWheels,
  wrapWheelPivots,
  makeCarWheelState,
  tickCarWheels,
  groundOffsetY,
  CarWheelState,
  WheelStrategy,
} from './shared/scene';

// Per-car wheel rotation strategies. Each Designersoup model authored its
// wheels differently — there's no clean generic detection that works for
// all of them, so we hand-tune each car. Adding a new wheeled car =
// adding an entry here + the asset entry below.
const WHEEL_STRATEGIES: Record<string, WheelStrategy> = {
  Beatall: {
    rollAxis:  new THREE.Vector3(0, 0, 1),
    steerAxis: new THREE.Vector3(0, 1, 0),
  },
  Landyroamer: {
    // Wheels modelled lying flat with axle along pivot Y, so rolling is a
    // turntable spin. Steer around Z (sideways) per user feedback.
    rollAxis:  new THREE.Vector3(0, -1, 0),
    steerAxis: new THREE.Vector3(0, 0, 1),
  },
  Toyoyo: {
    rollAxis:  new THREE.Vector3(1, 0, 0),
    // Steer around Z (sideways) instead of Y per user feedback — Y was
    // producing a camber-tilt visual because of how the mesh is oriented.
    steerAxis: new THREE.Vector3(0, 0, 1),
  },
  Tristar: {
    rollAxis:  new THREE.Vector3(0, 1, 0),
    steerAxis: new THREE.Vector3(0, 0, 1),
  },
};

interface AssetEntry {
  category: 'vehicle';
  name: string;
  source: string;
  /** Color dot in the sidebar — keeps categories visually distinct. */
  dot: string;
  /** Build the renderable Object3D + per-asset extras (lights, etc.). */
  build(loader: FBXLoader): Promise<THREE.Object3D>;
  notes?: string;
}

// All Designersoup low-poly cars share a single palette texture inside their
// .fbm sidecar, so the polish helper only ever needs one path per car.
const SHARED_PALETTE = '387359c5580f06c08c266126b3b46db47e48ba44.png';
const palettePathFor = (fbm: string) => `/models/${fbm}/${SHARED_PALETTE}`;

/** Build a ground-car: sit it flat on the platform, roll its wheels slowly
 *  for showroom flair, no hover. Wheel roll state lives on userData so the
 *  shared tick loop can advance it. */
async function buildWheeledCar(
  loader: FBXLoader,
  opts: { source: string; fbm: string; groupName: string; strategyKey: string; idleRollOmega?: number },
): Promise<THREE.Object3D> {
  const car = await loader.loadAsync(opts.source);
  // FBX from this pack ships at ~100x scale; same factor used for the
  // docLorean keeps every car at consistent showroom scale.
  car.scale.setScalar(0.01);
  // FBX-original frame has the car nose along +X. Rotate so it faces -Z (the
  // viewer-friendly "front of the platform" direction for the orbit camera).
  car.rotation.y = -Math.PI / 2;
  await polishCarMaterials(car, { palettePath: palettePathFor(opts.fbm) });

  const group = new THREE.Group();
  group.name = opts.groupName;
  group.add(car);

  // Wrap each wheel in a pivot group at its world-space center. The FBX
  // wheels are children of the car root with their own origins still at the
  // car center, so rotating them naively would orbit the wheel around the
  // car instead of spinning it around its axle. The pivot fixes the rotation
  // center; the strategy decides which axes the pivot rotates around.
  const detected = findCarWheels(car);
  const strategy = WHEEL_STRATEGIES[opts.strategyKey];
  const wheels = wrapWheelPivots(detected, strategy);
  const wheelState = makeCarWheelState(wheels);

  // Sit the car flat on the platform. Compute after wheel pivots are in
  // place — the bbox is unchanged but updateMatrixWorld is now consistent.
  car.position.y += groundOffsetY(car);

  (group.userData as any).carWheels = wheelState;
  // Slow idle wheel-roll — purely visual life on an otherwise static
  // showcase. Sign convention: each wheel's stored `rollAxis` is already
  // signed so that positive omega rolls top-forward, regardless of how the
  // FBX wheel was oriented.
  (group.userData as any).idleRollOmega = (opts.idleRollOmega ?? 1.6);
  return group;
}

const ASSETS: AssetEntry[] = [
  {
    category: 'vehicle',
    name: 'docLorean (Flying)',
    source: '/models/docLorean.fbx',
    dot: '#a78bfa',
    notes: "Designersoup Low Poly Car Pack — DeLorean homage. Hover-converted in this build: cyan point lights pin under each turbine wheel-pod and the rear thruster strip.",
    async build(loader) {
      const car = await loader.loadAsync('/models/docLorean.fbx');
      car.scale.setScalar(0.01);
      await polishCarMaterials(car, { palettePath: palettePathFor('docLorean.fbm') });

      const group = new THREE.Group();
      group.name = 'docLorean-flying';
      group.add(car);

      addDocLoreanFeatureLights(group, car);

      // Hover low to the platform so the cyan turbine pools land cleanly
      // on the surface instead of dispersing into mid-air.
      attachHover(group, { liftHeight: 0.4, bobAmplitude: 0.05, spinSpeed: 0 });
      return group;
    },
  },
  {
    category: 'vehicle',
    name: 'Beatall',
    source: '/models/Beatall.fbx',
    dot: '#ffb547',
    notes: "Designersoup Low Poly Car Pack — VW Beetle homage. Wheeled ground car: sits flat on the platform with a slow idle roll on all four wheels.",
    async build(loader) {
      return buildWheeledCar(loader, {
        source: '/models/Beatall.fbx',
        fbm: 'Beatall.fbm',
        groupName: 'beatall',
        strategyKey: 'Beatall',
      });
    },
  },
  {
    category: 'vehicle',
    name: 'Landyroamer',
    source: '/models/Landyroamer.fbx',
    dot: '#7dd3fc',
    notes: "Designersoup Low Poly Car Pack — Land Rover Defender homage. Tall stance, bull-bar grille, idle wheel roll.",
    async build(loader) {
      return buildWheeledCar(loader, {
        source: '/models/Landyroamer.fbx',
        fbm: 'Landyroamer.fbm',
        groupName: 'landyroamer',
        strategyKey: 'Landyroamer',
      });
    },
  },
  {
    category: 'vehicle',
    name: 'Toyoyo Highlight',
    source: '/models/Toyoyo Highlight.fbx',
    dot: '#86efac',
    notes: "Designersoup Low Poly Car Pack — Toyota Hilux homage (FBX names its body `hilux body`). Pickup truck silhouette, idle wheel roll.",
    async build(loader) {
      return buildWheeledCar(loader, {
        source: '/models/Toyoyo Highlight.fbx',
        fbm: 'Toyoyo Highlight.fbm',
        groupName: 'toyoyo-highlight',
        strategyKey: 'Toyoyo',
      });
    },
  },
  {
    category: 'vehicle',
    name: 'Tristar Racer',
    source: '/models/Tristar Racer.fbx',
    dot: '#f87171',
    notes: "Designersoup Low Poly Car Pack — Mercedes AMG GT homage (FBX names its body `amg Gt body`). Low slung sports coupe, idle wheel roll.",
    async build(loader) {
      return buildWheeledCar(loader, {
        source: '/models/Tristar Racer.fbx',
        fbm: 'Tristar Racer.fbm',
        groupName: 'tristar-racer',
        strategyKey: 'Tristar',
      });
    },
  },
];

// ---- Boot ----

const canvas = document.getElementById('lib-canvas') as HTMLCanvasElement;
const sidebar = document.getElementById('sidebar') as HTMLElement;
const infoName = document.getElementById('info-name') as HTMLElement;
const infoSource = document.getElementById('info-source') as HTMLElement;
const infoNotes = document.getElementById('info-notes') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060912);
scene.fog = new THREE.Fog(0x060912, 8, 22);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(3.2, 2.0, 4.4);

// Toon lighting: a strong key from camera-right + a cool fill from the
// opposite side so the cel-shaded body shows two distinct bands instead of
// collapsing into one. Hemi gives the shadow side just enough lift to read
// without flattening the bands.
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(5, 7, 4);
scene.add(key);

const fill = new THREE.DirectionalLight(0x6dd5ff, 0.55);
fill.position.set(-6, 3, -3);
scene.add(fill);

// Low hemi so the bands don't get washed out — toon banding only reads when
// the directional contribution dominates the additive ambient.
const hemi = new THREE.HemisphereLight(0xb8c8ff, 0x1a1f3a, 0.18);
scene.add(hemi);

// Display platform + grid floor — gives the floating car a frame of reference.
const platform = new THREE.Mesh(
  new THREE.CircleGeometry(2.5, 64),
  new THREE.MeshStandardMaterial({ color: 0x1a2138, metalness: 0.6, roughness: 0.4 }),
);
platform.rotation.x = -Math.PI / 2;
platform.position.y = -0.01;
scene.add(platform);

const grid = new THREE.GridHelper(20, 40, 0x4f46e5, 0x1f2542);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
scene.add(grid);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1, 0);
controls.minDistance = 2;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI / 1.95;

const loader = new FBXLoader();

let activeAsset: THREE.Object3D | null = null;
let activeIndex = -1;

function clearActive() {
  if (!activeAsset) return;
  scene.remove(activeAsset);
  // The asset's underglow disc lives in scene-space, not as a child of the
  // group, so dispose / detach it explicitly when swapping assets.
  const disc = (activeAsset.userData as any).underglowDisc as THREE.Mesh | undefined;
  if (disc) {
    scene.remove(disc);
    disc.geometry.dispose();
    (disc.material as THREE.Material | THREE.Material[] | undefined);
    const m = disc.material as THREE.MeshBasicMaterial | undefined;
    m?.map?.dispose?.();
    m?.dispose?.();
  }
  activeAsset.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if ((mesh as any).isMesh) {
      mesh.geometry?.dispose?.();
      const m = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
      else (m as THREE.Material | undefined)?.dispose?.();
    }
  });
  activeAsset = null;
}

async function showAsset(idx: number) {
  if (idx === activeIndex) return;
  const entry = ASSETS[idx];
  if (!entry) return;
  clearActive();
  activeIndex = idx;
  // Optimistic info-panel update so the user sees feedback before the FBX
  // load finishes (cars take a few hundred ms).
  infoName.textContent = entry.name;
  infoSource.textContent = entry.source;
  infoNotes.textContent = entry.notes ?? '';
  renderSidebar();

  let obj: THREE.Object3D;
  try {
    obj = await entry.build(loader);
  } catch (err) {
    console.error('failed to load asset', entry.name, err);
    infoNotes.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (idx !== activeIndex) {
    // User picked a different one mid-load — drop the result.
    return;
  }
  scene.add(obj);
  // Pin the underglow disc just above the platform (platform.y ≈ 0).
  const disc = (obj.userData as any).underglowDisc as THREE.Mesh | undefined;
  if (disc) {
    disc.position.set(0, 0.02, 0);
    scene.add(disc);
  }
  activeAsset = obj;
}

function renderSidebar() {
  const groups = new Map<AssetEntry['category'], AssetEntry[]>();
  for (const a of ASSETS) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category)!.push(a);
  }
  const sectionTitle = (cat: AssetEntry['category']) => ({ vehicle: 'Vehicles' }[cat]);
  let html = '';
  for (const [cat, items] of groups) {
    html += `<div class="lib-section"><h2>${sectionTitle(cat)}</h2>`;
    for (const entry of items) {
      const idx = ASSETS.indexOf(entry);
      html += `
        <div class="lib-row ${idx === activeIndex ? 'active' : ''}" data-idx="${idx}">
          <span class="lib-dot" style="background:${entry.dot}"></span>
          <span>${escapeHtml(entry.name)}</span>
          <span class="lib-meta">${escapeHtml(entry.source.split('/').pop() ?? '')}</span>
        </div>`;
    }
    html += '</div>';
  }
  sidebar.innerHTML = html;
  sidebar.querySelectorAll<HTMLElement>('.lib-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx ?? '-1', 10);
      void showAsset(idx);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ---- Test-rig controls ----
//
// The library is a static showcase, but for visual verification + automated
// tests we let WASD drive each car *in place*: wheels roll forward/back, front
// wheels steer left/right. No translation — orbit controls stay free for the
// user to look around. Tests poke window.__lib to read live wheel state and
// confirm rotations match input direction.
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  keys.add(e.key.toLowerCase());
  if (e.code === 'KeyW') keys.add('w');
  if (e.code === 'KeyA') keys.add('a');
  if (e.code === 'KeyS') keys.add('s');
  if (e.code === 'KeyD') keys.add('d');
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
  if (e.code === 'KeyW') keys.delete('w');
  if (e.code === 'KeyA') keys.delete('a');
  if (e.code === 'KeyS') keys.delete('s');
  if (e.code === 'KeyD') keys.delete('d');
});
window.addEventListener('blur', () => keys.clear());

const TEST_RIG_ROLL_OMEGA  = 4.5;  // rad/s — fairly fast so wheels visibly spin
const TEST_RIG_STEER_ANGLE = 0.45; // rad (~26°) — matches homepage steer max

// Animation loop — handles per-frame hover + idle wheel roll + test-rig WASD.
const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();
  if (activeAsset) {
    tickHover(activeAsset, dt, t);
    const wheelState = (activeAsset.userData as any).carWheels as CarWheelState | undefined;
    const idleOmega = (activeAsset.userData as any).idleRollOmega as number | undefined;
    if (wheelState) {
      // WASD overrides idle rolling so tests have a deterministic input. W = forward
      // roll (matching homepage sign convention), S = reverse, A/D = steer the
      // front wheels. With no input we fall back to the idle showcase rotation.
      const fwd = (keys.has('w') || keys.has('arrowup')) ? 1 : 0;
      const rev = (keys.has('s') || keys.has('arrowdown')) ? 1 : 0;
      const left  = (keys.has('a') || keys.has('arrowleft'))  ? 1 : 0;
      const right = (keys.has('d') || keys.has('arrowright')) ? 1 : 0;
      const inputDir = fwd - rev;
      const steerDir = left - right;  // A turns left, D turns right
      const rollOmega = inputDir !== 0
        ? inputDir * TEST_RIG_ROLL_OMEGA  // signed rollAxis handles direction
        : (idleOmega ?? 0);
      const steerAngle = steerDir * TEST_RIG_STEER_ANGLE;
      tickCarWheels(wheelState, dt, { rollOmega, steerAngle });
    }
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---- Test hooks ----
//
// Exposed on `window.__lib` so Playwright (or anyone in DevTools) can read
// wheel/quaternion state without going through the WebGL pixel buffer. The
// signs of these quaternions are what verify "did A make the wheel turn left",
// independent of camera or rendering.
(window as any).__lib = {
  THREE,
  get assets() { return ASSETS.map((a) => ({ name: a.name, source: a.source })); },
  get activeIndex() { return activeIndex; },
  get activeAsset() { return activeAsset; },
  get wheelState() { return activeAsset ? (activeAsset.userData as any).carWheels as CarWheelState | undefined : undefined; },
  showAsset,
  pressKey(key: string) { keys.add(key.toLowerCase()); },
  releaseKey(key: string) { keys.delete(key.toLowerCase()); },
  clearKeys() { keys.clear(); },
};

function resize() {
  const wrap = canvas.parentElement!;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement!);
resize();

// Auto-pick the first asset on load.
renderSidebar();
void showAsset(0);
tick();
