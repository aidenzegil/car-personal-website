// Asset Library — browse and preview the 3D assets used in this project.
//
// Mirrors the pattern from farmer-game's library.ts: one Three.js scene with
// orbit controls, a sidebar listing every asset, click-to-load. Built so
// adding a new asset is a single entry in ASSETS — load logic, hover, and
// info-panel content are derived from there.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

// Reusable: lift + spin so a "flying" asset reads as flying instead of static.
function attachHover(obj: THREE.Object3D, opts: { liftHeight?: number; baseY?: number; bobAmplitude?: number; spinSpeed?: number } = {}) {
  const lift = opts.liftHeight ?? 1.4;
  const baseY = opts.baseY ?? 0;
  const amp = opts.bobAmplitude ?? 0.12;
  const spin = opts.spinSpeed ?? 0.18; // radians/sec
  obj.position.y = baseY + lift;
  (obj.userData as any).hover = { baseY, lift, amp, spin };
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
      // FBX from this pack ships at ~100x scale; bring it down so it fits the
      // preview pad without needing a giant camera.
      car.scale.setScalar(0.01);
      // Brighten the materials so the dark gallery doesn't make it look flat.
      car.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!(mesh as any).isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
        const tweak = (m: THREE.MeshStandardMaterial) => {
          m.metalness = 0.55;
          m.roughness = 0.35;
          m.envMapIntensity = 1.2;
        };
        if (Array.isArray(mat)) mat.forEach(tweak); else if (mat) tweak(mat as THREE.MeshStandardMaterial);
      });

      const group = new THREE.Group();
      group.name = 'docLorean-flying';
      group.add(car);

      // Neon underglow — rectangular point lights kissing the underside.
      const glowFront = new THREE.PointLight(0x6dd5ff, 1.5, 5, 2);
      glowFront.position.set(0, -0.4, 0.6);
      const glowRear  = new THREE.PointLight(0xe879f9, 1.5, 5, 2);
      glowRear.position.set(0, -0.4, -0.6);
      group.add(glowFront, glowRear);

      // Thruster trail — a small cone of additive sparks behind the car.
      const trail = makeThrusterTrail();
      trail.position.set(0, 0.05, -0.85);
      trail.rotation.x = Math.PI / 2;
      group.add(trail);

      attachHover(group, { liftHeight: 0.9, bobAmplitude: 0.07, spinSpeed: 0.25 });
      return group;
    },
  },
];

function makeThrusterTrail(): THREE.Points {
  const N = 80;
  const positions = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    seeds[i] = Math.random();
    positions[i * 3 + 0] = (Math.random() - 0.5) * 0.18;
    positions[i * 3 + 1] = -Math.random() * 1.4;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 0.18;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('seed',     new THREE.BufferAttribute(seeds, 1));
  const mat = new THREE.PointsMaterial({
    color: 0x6dd5ff,
    size: 0.06,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geom, mat);
  (points.userData as any).thruster = { positions, seeds };
  return points;
}

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
    const hover = (activeAsset.userData as any).hover as
      | { baseY: number; lift: number; amp: number; spin: number } | undefined;
    if (hover) {
      activeAsset.position.y = hover.baseY + hover.lift + Math.sin(t * 1.6) * hover.amp;
      activeAsset.rotation.y += dt * hover.spin;
    }
    activeAsset.traverse((node) => {
      const trail = node as any;
      if (trail.isPoints && trail.userData?.thruster) {
        const { positions, seeds } = trail.userData.thruster as {
          positions: Float32Array; seeds: Float32Array;
        };
        const attr = (trail.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < seeds.length; i++) {
          // Drift particles down along Z (thruster direction); recycle when they fade.
          const phase = (t * 1.4 + seeds[i]!) % 1;
          positions[i * 3 + 1] = -phase * 1.4;
          attr.setXYZ(i, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        }
        attr.needsUpdate = true;
        const mat = trail.material as THREE.PointsMaterial;
        mat.opacity = 0.7 + 0.2 * Math.sin(t * 8);
      }
    });
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
