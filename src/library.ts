// Asset Library — browse and preview the 3D assets used in this project.
//
// Mirrors the pattern from farmer-game's library.ts: one Three.js scene with
// orbit controls, a sidebar listing every asset, click-to-load. Built so
// adding a new asset is a single entry in ASSETS — load logic, hover, and
// info-panel content are derived from there.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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

type AssetCategory =
  | 'vehicle' | 'aircraft' | 'character'
  | 'tree' | 'foliage' | 'flower' | 'mushroom' | 'rock' | 'prop';

interface AssetEntry {
  category: AssetCategory;
  name: string;
  source: string;
  /** Color dot in the sidebar — keeps categories visually distinct. */
  dot: string;
  /** Build the renderable Object3D + per-asset extras (lights, etc.).
   *  Module-scope loaders (`loader`, `objLoader`) are used directly. */
  build(): Promise<THREE.Object3D>;
  notes?: string;
}

// Sidebar order + titles. Vehicles first, then nature props in
// roughly canopy → ground order so a reader skimming the list reads
// big things at the top, ground-level props at the bottom.
const CATEGORY_ORDER: AssetCategory[] = [
  'vehicle', 'aircraft', 'character',
  'tree', 'foliage', 'flower', 'mushroom', 'rock', 'prop',
];
const CATEGORY_TITLE: Record<AssetCategory, string> = {
  vehicle: 'Vehicles',
  aircraft: 'Aircraft',
  character: 'Characters',
  tree: 'Trees',
  foliage: 'Foliage',
  flower: 'Flowers',
  mushroom: 'Mushrooms',
  rock: 'Rocks',
  prop: 'Misc Props',
};

// Per-category target max-dimension (in world units) used by
// `buildNatureProp` when normalizing a freshly loaded OBJ. The pack
// ships at wildly inconsistent real-world scales (flowers ~0.1, trees
// ~5), so a single normalization made flowers tree-sized. Per-category
// targets keep relative sizing readable on the showcase platform.
const NATURE_TARGET_SIZE: Partial<Record<AssetCategory, number>> = {
  tree: 3.0,
  foliage: 1.6,
  flower: 0.6,
  mushroom: 0.8,
  rock: 1.6,
  prop: 1.0,
};

// All Designersoup low-poly cars share a single palette texture inside their
// .fbm sidecar, so the polish helper only ever needs one path per car.
const SHARED_PALETTE = '387359c5580f06c08c266126b3b46db47e48ba44.png';
const palettePathFor = (fbm: string) => `/models/${fbm}/${SHARED_PALETTE}`;

/** Build a ground-car: sit it flat on the platform, roll its wheels slowly
 *  for showroom flair, no hover. Wheel roll state lives on userData so the
 *  shared tick loop can advance it. */
async function buildWheeledCar(
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
    async build() {
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
    async build() {
      return buildWheeledCar({
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
    async build() {
      return buildWheeledCar({
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
    async build() {
      return buildWheeledCar({
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
    async build() {
      return buildWheeledCar({
        source: '/models/Tristar Racer.fbx',
        fbm: 'Tristar Racer.fbm',
        groupName: 'tristar-racer',
        strategyKey: 'Tristar',
      });
    },
  },
  // ---- Aircraft (glTF/GLB) ----
  {
    category: 'aircraft',
    name: 'Plane',
    source: '/models/aircraft/plane.glb',
    dot: '#a78bfa',
    notes: 'Toon-shaded propeller plane. .glb authored in Blender; baked HeliceAction clip is what spins the prop. Hovers above the platform with a slight bob.',
    async build() {
      return buildAircraft({
        source: '/models/aircraft/plane.glb',
        groupName: 'plane',
        hover: true,
      });
    },
  },
  // ---- Characters ----
  {
    category: 'character',
    name: 'Corgi',
    source: '/models/corgi/CorgiCorgi.fbx',
    dot: '#fbbf24',
    notes: 'Animated corgi (FBX). Base mesh from CorgiCorgi.fbx; 42 sibling FBX files each contain a single animation clip on the same skeleton. Use the picker below to play any of them — clips load on-demand.',
    async build() {
      return buildAnimatedFbx({
        source: '/models/corgi/CorgiCorgi.fbx',
        groupName: 'corgi',
        clips: CORGI_CLIPS.map((id) => ({
          id,
          label: humanizeCorgiClip(id),
          source: `/models/corgi/${id}.fbx`,
        })),
        defaultClipId: 'CorgiIdle',
      });
    },
  },
  // ---- Nature pack (ToonLab) ----
  //
  // OBJ + shared TexturePalette.png. Unlike the cars, the .mtl files
  // ship with a generic gray material — the actual color comes from UV
  // mapping into the palette swatch. We override the loaded materials
  // with one MeshStandardMaterial that has the palette as `map`.
  ...natureEntries(),
];

/** Generates AssetEntries for every ToonLab nature prop, grouped into
 *  the proper sub-category so the sidebar groups read as Trees /
 *  Foliage / Flowers / Mushrooms / Rocks / Misc Props. Trees here are
 *  the green variant only — the dark and yellow OBJs were trimmed
 *  off-disk per user request. */
function natureEntries(): AssetEntry[] {
  type Spec = {
    id: string;
    name: string;
    category: AssetCategory;
    dot: string;
    notes: string;
  };
  const specs: Spec[] = [
    // Trees
    { id: 'Tree1_Green', category: 'tree', name: 'Tree, Spruce A', dot: '#86efac', notes: 'Tall conifer with a single tapered crown.' },
    { id: 'Tree2_Green', category: 'tree', name: 'Tree, Spruce B', dot: '#86efac', notes: 'Layered conifer canopy — three tiers.' },
    { id: 'Tree3',       category: 'tree', name: 'Tree, Round',    dot: '#86efac', notes: 'Round-canopy hardwood. Single-color variant only.' },
    { id: 'Tree4_Green', category: 'tree', name: 'Tree, Bushy A',  dot: '#86efac', notes: 'Short bushy canopy on a stout trunk.' },
    { id: 'Tree5_Green', category: 'tree', name: 'Tree, Bushy B',  dot: '#86efac', notes: 'Cluster of round leaves, broad silhouette.' },
    { id: 'Tree6_Green', category: 'tree', name: 'Tree, Bushy C',  dot: '#86efac', notes: 'Twin-trunk bushy hardwood.' },
    // Foliage (bushes + reeds)
    { id: 'CircularBush_Green', category: 'foliage', name: 'Bush, Round',  dot: '#a3e635', notes: 'Round-canopy shrub.' },
    { id: 'CubyBush_Green',     category: 'foliage', name: 'Bush, Cuboid', dot: '#a3e635', notes: 'Boxy hedge-like shrub.' },
    { id: 'Reed',               category: 'foliage', name: 'Reeds',        dot: '#84cc16', notes: 'Bunch of cattails / reeds.' },
    // Flowers
    { id: 'Flower1', category: 'flower', name: 'Flower 1', dot: '#fb7185', notes: 'Small bloom (5-petal).' },
    { id: 'Flower2', category: 'flower', name: 'Flower 2', dot: '#fbbf24', notes: 'Small bloom (clustered).' },
    { id: 'Flower3', category: 'flower', name: 'Flower 3', dot: '#a78bfa', notes: 'Small bloom (open).' },
    { id: 'Flower4', category: 'flower', name: 'Flower 4', dot: '#22d3ee', notes: 'Small bloom (tight).' },
    { id: 'Flower5', category: 'flower', name: 'Flower 5', dot: '#f472b6', notes: 'Small bloom (drooping).' },
    // Mushrooms
    { id: 'Mushroom1', category: 'mushroom', name: 'Mushroom A', dot: '#f87171', notes: 'Toadstool with a wide cap.' },
    { id: 'Mushroom2', category: 'mushroom', name: 'Mushroom B', dot: '#f87171', notes: 'Smaller mushroom cluster.' },
    // Rocks
    { id: 'Rock1', category: 'rock', name: 'Rock A', dot: '#9ca3af', notes: 'Tall jagged rock.' },
    { id: 'Rock2', category: 'rock', name: 'Rock B', dot: '#9ca3af', notes: 'Mid-size boulder.' },
    { id: 'Rock3', category: 'rock', name: 'Rock C', dot: '#9ca3af', notes: 'Rounded river stone.' },
    { id: 'Rock4', category: 'rock', name: 'Rock D', dot: '#9ca3af', notes: 'Small flat stone.' },
    // Misc props (ground critters / water / wood)
    { id: 'Worm',    category: 'prop', name: 'Worm',    dot: '#fb923c', notes: 'Tiny worm prop. Sits flat on the platform.' },
    { id: 'Lilypad', category: 'prop', name: 'Lilypad', dot: '#34d399', notes: 'Single lilypad — for water surfaces.' },
    { id: 'Log1',    category: 'prop', name: 'Log A',   dot: '#a16207', notes: 'Short fallen log.' },
    { id: 'Log2',    category: 'prop', name: 'Log B',   dot: '#a16207', notes: 'Stack of cut logs.' },
  ];
  return specs.map((s) => ({
    category: s.category,
    name: s.name,
    source: `/models/nature/${s.id}.obj`,
    dot: s.dot,
    notes: s.notes,
    async build() { return buildNatureProp(s.id, s.category); },
  }));
}

// ---- Boot ----

// Page transition: clicking "← home" slides the library off to the left,
// then we navigate. The home page's existing intro wave is the matching
// entry — there's no need for a separate home-side animation.
{
  const app = document.getElementById('app');
  document.querySelectorAll<HTMLAnchorElement>('#title-bar a[href="/"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      if (!app) return;
      e.preventDefault();
      const href = link.getAttribute('href') ?? '/';
      // Tell the home page to play a slide-in-from-left on load (mirror
      // of this slide-out-to-left). Cleared by the home page after use.
      try { sessionStorage.setItem('nav-from', 'library'); } catch { /* ignore */ }
      app.classList.add('is-leaving');
      const go = () => { window.location.href = href; };
      app.addEventListener('transitionend', go, { once: true });
      // Safety net in case transitionend doesn't fire (off-screen nav, etc.).
      setTimeout(go, 450);
    });
  });
}

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
// 1.5× the original framing so the page opens with the car a bit further
// from the lens — feels more like an "establishing shot" than a closeup.
camera.position.set(4.8, 3.0, 6.6);

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
const objLoader = new OBJLoader();
const glbLoader = new GLTFLoader();

/** Load a glTF/GLB aircraft. We play only the prop-spin clip — any
 *  other baked clips (idle bob, fuselage wobble, etc.) get skipped so
 *  the showcase reads as a still aircraft with a spinning prop. The
 *  AnimationMixer goes onto userData so the shared tick loop can drive
 *  it via mixer.update(dt). */
async function buildAircraft(opts: {
  source: string;
  groupName: string;
  /** Name of the propeller-spin AnimationClip to play. Defaults to
   *  'HeliceAction' (the Blender Portuguese name on our plane.glb). */
  spinClipName?: string;
  /** Hover lift + bob so the plane reads as flying, not parked. */
  hover?: boolean;
}): Promise<THREE.Object3D> {
  const gltf = await glbLoader.loadAsync(opts.source);
  const root = gltf.scene;
  root.name = opts.groupName;

  if (gltf.animations?.length) {
    const mixer = new THREE.AnimationMixer(root);
    const spinName = opts.spinClipName ?? 'HeliceAction';
    const clip = gltf.animations.find((a) => a.name === spinName);
    if (clip) {
      mixer.clipAction(clip).play();
    } else {
      console.warn(`buildAircraft: no clip named "${spinName}" — prop won't spin`);
    }
    (root.userData as any).mixer = mixer;
  }

  if (opts.hover) {
    attachHover(root, { liftHeight: 0.3, bobAmplitude: 0.08, spinSpeed: 0 });
  }
  return root;
}

// ---- Animated FBX (corgi-style: many sibling clip files) ----
//
// The corgi pack ships one base FBX (skeleton + mesh) and 42 sibling
// FBX files, each containing the same skeleton with one animation clip
// baked. To play any clip we:
//   1. Load the base mesh once,
//   2. Lazy-load the chosen clip's FBX,
//   3. Pluck its single AnimationClip and run it through an
//      AnimationMixer attached to the base scene.
// The picker UI in info-panel calls back into this with a clip id.

interface AnimatedFbxClipDef {
  id: string;          // file stem (no .fbx)
  label: string;       // human-friendly label for the picker chip
  source: string;
}
interface AnimatedFbxState {
  mixer: THREE.AnimationMixer;
  clips: AnimatedFbxClipDef[];
  loaded: Map<string, THREE.AnimationClip>;
  currentAction: THREE.AnimationAction | null;
  currentId: string | null;
  /** Optional listener fired whenever currentId changes — used by the
   *  picker UI to re-highlight the active chip after async loads. */
  onChange: (() => void) | null;
  /** Start playing the named clip. Loads its FBX if not cached. */
  play(id: string): Promise<void>;
}

// Diffuse texture shipped alongside the Corgi3dsmax bundle. The FBX
// itself only references a path on the artist's filesystem, so we
// have to assign this map manually after load — same pattern as
// `polishCarMaterials({ palettePath })`.
const corgiDiffuseTex = new THREE.TextureLoader().load('/models/corgi/CorgiExample1.png');
corgiDiffuseTex.colorSpace = THREE.SRGBColorSpace;
// Toon-style palette — keep nearest filtering so the painted color
// regions don't bleed into each other when minified.
corgiDiffuseTex.magFilter = THREE.LinearFilter;
corgiDiffuseTex.minFilter = THREE.LinearMipmapLinearFilter;
corgiDiffuseTex.anisotropy = 4;

function recolorCorgiMaterials(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh & { isSkinnedMesh?: boolean };
    if (!(mesh as any).isMesh && !mesh.isSkinnedMesh) return;
    const replacement = new THREE.MeshStandardMaterial({
      map: corgiDiffuseTex,
      roughness: 0.85,
      metalness: 0.05,
    });
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
    else (m as THREE.Material | undefined)?.dispose?.();
    mesh.material = replacement;
  });
}

async function buildAnimatedFbx(opts: {
  source: string;
  groupName: string;
  clips: AnimatedFbxClipDef[];
  defaultClipId?: string;
}): Promise<THREE.Object3D> {
  const root = await loader.loadAsync(opts.source);
  root.name = opts.groupName;
  // The Mixamo / corgi-style pack ships at hundreds-of-units scale —
  // size is normalized later by the library's per-asset bbox-center
  // pass, but multiply by a sane scalar here so the AnimationMixer
  // sees realistic motion magnitudes (root motion is in source units).
  root.scale.setScalar(0.012);
  // FBX shipped without its referenced texture files — every mesh
  // slot ends up as a black silhouette unless we paint them.
  recolorCorgiMaterials(root);

  const mixer = new THREE.AnimationMixer(root);
  const loaded = new Map<string, THREE.AnimationClip>();

  // The base FBX itself often carries a default rest-pose clip; if so
  // cache it under its filename id so picking it later is a no-op.
  const baseId = opts.source.split('/').pop()!.replace(/\.fbx$/i, '');
  if (root.animations.length) loaded.set(baseId, root.animations[0]!);

  const state: AnimatedFbxState = {
    mixer,
    clips: opts.clips,
    loaded,
    currentAction: null,
    currentId: null,
    onChange: null,
    async play(id: string) {
      let clip = loaded.get(id);
      if (!clip) {
        const def = opts.clips.find((c) => c.id === id);
        if (!def) throw new Error(`unknown clip id: ${id}`);
        const animFbx = await loader.loadAsync(def.source);
        // Each animation FBX has exactly one clip in the pack. Some
        // exporters name it 'mixamo.com' or 'Take 001' — rename to the
        // file stem so the mixer keeps its slots tidy.
        const sourceClip = animFbx.animations[0];
        if (!sourceClip) throw new Error(`clip ${id} has no animations`);
        sourceClip.name = id;
        loaded.set(id, sourceClip);
        clip = sourceClip;
      }
      if (state.currentAction && state.currentId === id) return;
      const next = mixer.clipAction(clip);
      next.reset();
      next.setLoop(THREE.LoopRepeat, Infinity);
      if (state.currentAction) {
        // Crossfade existing → new clip so swaps feel continuous instead
        // of snapping. 0.25s matches typical Mixamo-pack pacing.
        next.crossFadeFrom(state.currentAction, 0.25, false);
        next.play();
      } else {
        next.play();
      }
      state.currentAction = next;
      state.currentId = id;
      state.onChange?.();
    },
  };

  (root.userData as any).mixer = mixer;
  (root.userData as any).animatedFbx = state;

  if (opts.defaultClipId) {
    // Fire-and-forget — we want the build() to resolve immediately so
    // the asset shows up + the picker UI can render. The clip will
    // start a frame or two later when its FBX finishes loading.
    void state.play(opts.defaultClipId).catch((err) => {
      console.warn(`buildAnimatedFbx: failed to play default clip "${opts.defaultClipId}":`, err);
    });
  }

  return root;
}

// Corgi clip catalog. File stems for every animation FBX in
// public/models/corgi/ (excluding the base CorgiCorgi.fbx). Order
// here drives sidebar order in the picker — group by behavior.
const CORGI_CLIPS = [
  // Idle / rest
  'CorgiIdle', 'CorgiIdleLong', 'CorgiIdleMouthClosed',
  'CorgiIdleBarking', 'CorgiIdleBarkingLong', 'CorgiIdleSniff', 'CorgiIdleDig',
  'CorgiSitIdle', 'CorgiSitIdleLong', 'CorgiSitScratch',
  'CorgiLayIdle', 'CorgiLayIdleLong', 'CorgiLayRest',
  // Locomotion
  'CorgiWalk', 'CorgiWalkSniff', 'CorgiTrot', 'CorgiRun', 'CorgiGallop', 'CorgiJump',
  // Transitions
  'CorgiIdleToSit', 'CorgiSitToIdle', 'CorgiIdleToLay', 'CorgiLayToIdle',
  'CorgiSitToLay', 'CorgiLayToSit',
  'CorgiIdleToConsume', 'CorgiConsumeToIdle',
  'CorgiIdleToAggressive', 'CorgiAggressiveToIdle',
  // Aggressive
  'CorgiAggressiveIdle', 'CorgiAggressiveBarking',
  'CorgiAggressiveAttack', 'CorgiAggressiveAttackTwo',
  'CorgiAggressiveBeingHit', 'CorgiAggressoveBeingHitTwo', 'CorgiAggressoveBeingHitThree',
  // Misc + meme
  'CorgiEat', 'CorgiDrink', 'CorgiDeath',
  'CorgiPiss', 'CorgiPoop', 'CorgiWipeAss',
];

/** Strip the `Corgi` prefix and split CamelCase into spaced words. */
function humanizeCorgiClip(id: string): string {
  return id.replace(/^Corgi/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

// Shared palette texture for the ToonLab nature pack — every prop UVs
// into this single image. NearestFilter on both axes keeps the swatches
// crisp instead of bleeding between adjacent colors during minification.
const naturePaletteTex = new THREE.TextureLoader().load('/models/nature/TexturePalette.png');
naturePaletteTex.magFilter = THREE.NearestFilter;
naturePaletteTex.minFilter = THREE.NearestFilter;
naturePaletteTex.colorSpace = THREE.SRGBColorSpace;
naturePaletteTex.generateMipmaps = false;

/** Load a nature prop, swap its generic .mtl gray material for one
 *  MeshStandardMaterial that maps the shared palette via UV coords, and
 *  scale the result so its largest dimension matches the per-category
 *  target. The library's auto-centering pass shifts the bbox center to
 *  y=1 after the scene adds it. */
async function buildNatureProp(id: string, category: AssetCategory): Promise<THREE.Object3D> {
  const obj = await objLoader.loadAsync(`/models/nature/${id}.obj`);
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const target = NATURE_TARGET_SIZE[category] ?? 1.5;
  if (maxDim > 0) obj.scale.multiplyScalar(target / maxDim);
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    mesh.material = new THREE.MeshStandardMaterial({
      map: naturePaletteTex,
      roughness: 0.85,
      metalness: 0.05,
    });
  });
  return obj;
}

let activeAsset: THREE.Object3D | null = null;
let activeIndex = -1;

function clearActive() {
  if (!activeAsset) return;
  // Detach any animation picker subscription before disposing so we
  // don't fire onChange against a stale element while the next asset
  // is mid-build.
  const animState = (activeAsset.userData as any).animatedFbx as AnimatedFbxState | undefined;
  if (animState) animState.onChange = null;
  const animPickerEl = document.getElementById('anim-picker');
  if (animPickerEl) {
    animPickerEl.classList.add('hidden');
    animPickerEl.innerHTML = '';
  }
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

// Every asset is centered at this Y after loading so swapping cars in the
// library doesn't visually jump the focal point — flying and ground cars
// alike land with their bbox center at the camera's target height.
const ASSET_CENTER_Y = 1.0;

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
    obj = await entry.build();
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

  // Vertical centering. Each car's FBX has its own bbox shape (taller
  // SUVs vs flatter sports coupes vs the lifted docLorean), and the
  // build function applied either `groundOffsetY` (ground cars) or
  // `attachHover` (docLorean) — both produce different visible centers.
  // Measure the bbox here, after the build is final, and shift the asset
  // so its center lands at ASSET_CENTER_Y. For hover-based cars we
  // mutate the hover config's baseY (since `tickHover` writes
  // `obj.position.y` absolutely each frame and would overwrite a direct
  // `position.y` change); static cars get the offset on `position.y`.
  const box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const dy = ASSET_CENTER_Y - center.y;
  const hover = (obj.userData as any).hover as { baseY: number } | undefined;
  if (hover) hover.baseY += dy;
  else obj.position.y += dy;

  // Pin the underglow disc just above the platform (platform.y ≈ 0).
  const disc = (obj.userData as any).underglowDisc as THREE.Mesh | undefined;
  if (disc) {
    disc.position.set(0, 0.02, 0);
    scene.add(disc);
  }
  activeAsset = obj;
  renderAnimPicker(obj);
}

const animPicker = document.getElementById('anim-picker') as HTMLElement;

function renderAnimPicker(obj: THREE.Object3D) {
  const state = (obj.userData as any).animatedFbx as AnimatedFbxState | undefined;
  if (!animPicker) return;
  if (!state) {
    animPicker.classList.add('hidden');
    animPicker.innerHTML = '';
    return;
  }
  // Subscribe so that when the default clip finishes its async load,
  // the chip for it lights up. Reset on every render so we don't stack
  // listeners across asset swaps.
  state.onChange = () => updatePickerActive(state);
  animPicker.classList.remove('hidden');
  animPicker.innerHTML = state.clips.map((c) => {
    const isActive = c.id === state.currentId;
    return `<button type="button" class="anim-chip${isActive ? ' active' : ''}" data-id="${c.id}">${escapeHtml(c.label)}</button>`;
  }).join('');
  animPicker.querySelectorAll<HTMLButtonElement>('.anim-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const id = chip.dataset.id;
      if (!id || activeAsset !== obj) return;
      animPicker.querySelectorAll('.anim-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active', 'loading');
      try {
        await state.play(id);
      } catch (err) {
        console.error('animation load failed', id, err);
      }
      chip.classList.remove('loading');
    });
  });
}

function updatePickerActive(state: AnimatedFbxState) {
  if (!animPicker) return;
  animPicker.querySelectorAll<HTMLButtonElement>('.anim-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.id === state.currentId);
  });
}

function renderSidebar() {
  const groups = new Map<AssetCategory, AssetEntry[]>();
  for (const a of ASSETS) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category)!.push(a);
  }
  let html = '';
  for (const cat of CATEGORY_ORDER) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;
    html += `<div class="lib-section"><h2>${CATEGORY_TITLE[cat]}</h2>`;
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
    // Animation clips baked into the asset (e.g. propeller spin on the
    // aircraft glb). Mixer is null for assets without animations.
    const mixer = (activeAsset.userData as any).mixer as THREE.AnimationMixer | undefined;
    if (mixer) mixer.update(dt);
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
