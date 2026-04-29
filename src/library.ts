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
} from './shared/scene';

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

const ASSETS: AssetEntry[] = [
  {
    category: 'vehicle',
    name: 'docLorean (Flying)',
    source: '/models/docLorean.fbx',
    dot: '#a78bfa',
    notes: "Designersoup Low Poly Car Pack — DeLorean homage. Headlights and taillights are real point lights cast from the car body.",
    async build(loader) {
      const car = await loader.loadAsync('/models/docLorean.fbx');
      // FBX from this pack ships at ~100x scale; bring it down to match the pad.
      car.scale.setScalar(0.01);
      await polishCarMaterials(car, { palettePath: '/models/docLorean.fbm/387359c5580f06c08c266126b3b46db47e48ba44.png' });

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

// Animation loop — handles per-frame hover + thruster particle motion.
const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();
  if (activeAsset) {
    tickHover(activeAsset, dt, t);
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

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
