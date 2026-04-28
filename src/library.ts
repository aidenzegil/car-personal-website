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
  addUnderglow,
  makeThrusterTrail, tickThrusters,
  polishCarMaterials,
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
    notes: "Designersoup Low Poly Car Pack — DeLorean homage. Flight effects added: hover, spin, neon underglow, particle thruster trail.",
    async build(loader) {
      const car = await loader.loadAsync('/models/docLorean.fbx');
      // FBX from this pack ships at ~100x scale; bring it down to match the pad.
      car.scale.setScalar(0.01);
      polishCarMaterials(car);

      const group = new THREE.Group();
      group.name = 'docLorean-flying';
      group.add(car);
      addUnderglow(group);

      const trail = makeThrusterTrail();
      trail.position.set(0, 0.05, -0.85);
      trail.rotation.x = Math.PI / 2;
      group.add(trail);

      attachHover(group, { liftHeight: 0.9, bobAmplitude: 0.07, spinSpeed: 0.25 });
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
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060912);
scene.fog = new THREE.Fog(0x060912, 8, 22);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(3.2, 2.0, 4.4);

// Lighting: cool key + warm fill + ambient. Reads "showroom at night."
const key = new THREE.DirectionalLight(0xc0e4ff, 1.6);
key.position.set(5, 7, 4);
const fill = new THREE.DirectionalLight(0xff7eb6, 0.8);
fill.position.set(-4, 2, -3);
const ambient = new THREE.AmbientLight(0x4a5878, 0.45);
scene.add(key, fill, ambient);

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
    tickThrusters(activeAsset, dt, t);
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
