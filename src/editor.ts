// World editor — drag library assets onto the home page map.
//
// Layout: same daylight crossy-roads world as the home page (tiles +
// foliage + sky + lighting), MINUS car/pet/plane/edge-fall. The
// sidebar lists placeable assets; clicking one starts a placement
// session: a ghost of the asset follows the cursor projected onto
// the floor, WASD scales/rotates, click commits, Esc cancels.
//
// The trashcan toggle puts the editor into removal mode — clicking
// any placed asset deletes it.
//
// All placements persist to localStorage under EDITOR_KEY. The home
// page reads the same store on load and adds those assets into its
// own scene so the world the player drives through reflects every
// edit the user has made.

import * as THREE from 'three';
import {
  PLACEABLES, PlaceableDef, Placement, findPlaceable, loadPlaceable,
  loadStoredPlacements, saveStoredPlacements,
} from './shared/placeables';

const CATEGORY_ORDER = ['aircraft', 'electronics', 'tree', 'foliage', 'flower', 'mushroom', 'rock', 'prop'] as const;
const CATEGORY_TITLE: Record<PlaceableDef['category'], string> = {
  aircraft: 'Aircraft',
  electronics: 'Electronics',
  tree: 'Trees',
  foliage: 'Foliage',
  flower: 'Flowers',
  mushroom: 'Mushrooms',
  rock: 'Rocks',
  prop: 'Misc Props',
};

// ---- Scene boilerplate (mirror of main.ts world setup, minus the
//      car / pet / plane / edge-fall systems) ----

const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
const sidebar = document.getElementById('sidebar') as HTMLElement;
const trashBtn = document.getElementById('trash-btn') as HTMLButtonElement;
const modeLine = document.getElementById('mode-line') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const SKY_COLOR = 0xb8e2f5;
const VOID_COLOR = 0xb8e2f5;
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.FogExp2(SKY_COLOR, 0.0055);

const VOID_PLANE_Y = 0;
const VOID_DENSITY = 0.08;
function applyVerticalVoid(mat: THREE.Material) {
  if ((mat as any).__voidApplied) return;
  (mat as any).__voidApplied = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(mat, shader, r);
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

const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 600);
const camOffset = new THREE.Vector3(18, 22, 24);
camera.position.set(camOffset.x, camOffset.y, camOffset.z);
camera.lookAt(0, 0.6, 0);

// ---- Floor tiles ----

const FLOOR_TILE_SIZE = 12;
const FLOOR_TILE_HEIGHT = 18;
const FLOOR_TILE_COUNT = 27;
const FLOOR_TILE_TOTAL = FLOOR_TILE_COUNT * FLOOR_TILE_COUNT;
const FLOOR_TILE_HALF  = (FLOOR_TILE_COUNT - 1) * 0.5;
const floorTileGeom = new THREE.BoxGeometry(FLOOR_TILE_SIZE, FLOOR_TILE_HEIGHT, FLOOR_TILE_SIZE);
floorTileGeom.translate(0, -FLOOR_TILE_HEIGHT / 2, 0);
{
  const pos = floorTileGeom.attributes.position!;
  const nrm = floorTileGeom.attributes.normal!;
  const buf = new Float32Array(pos.count * 3);
  const topGreen = new THREE.Color(0x6db93a);
  const sideTop  = new THREE.Color(0x9b6d3e);
  const sideBot  = new THREE.Color(0x4a3320);
  const botFace  = new THREE.Color(0x1f1410);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    let r: number, g: number, b: number;
    if (ny > 0.5) { r = topGreen.r; g = topGreen.g; b = topGreen.b; }
    else if (ny < -0.5) { r = botFace.r; g = botFace.g; b = botFace.b; }
    else {
      const y = pos.getY(i);
      const t = (y + FLOOR_TILE_HEIGHT) / FLOOR_TILE_HEIGHT;
      tmp.copy(sideBot).lerp(sideTop, t);
      r = tmp.r; g = tmp.g; b = tmp.b;
    }
    buf[i * 3 + 0] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
  }
  floorTileGeom.setAttribute('color', new THREE.BufferAttribute(buf, 3));
}

const floorTileMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.95,
  emissive: new THREE.Color(0x111315), emissiveIntensity: 0.4,
});
applyVerticalVoid(floorTileMat);
const floorTiles = new THREE.InstancedMesh(floorTileGeom, floorTileMat, FLOOR_TILE_TOTAL);
floorTiles.receiveShadow = true;
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

const groundBackdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(3200, 3200),
  new THREE.MeshBasicMaterial({ color: VOID_COLOR, fog: false }),
);
groundBackdrop.rotation.x = -Math.PI / 2;
groundBackdrop.position.y = -120;
scene.add(groundBackdrop);

// ---- Lighting ----
const key = new THREE.DirectionalLight(0xfff4dc, 1.6);
key.position.set(40, 80, 30);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc8ff, 0.45);
rim.position.set(-30, 40, -50);
scene.add(rim);
const hemi = new THREE.HemisphereLight(0xb8e2f5, 0x3a2a18, 0.55);
scene.add(hemi);

// ---- Intro buildup wave ----

const INTRO_DROP = 80;
const INTRO_MAX_DELAY = 1.6;
const INTRO_FALLOFF_R = 320;
const INTRO_RISE_NEAR = 0.93;
const INTRO_RISE_FAR  = 0.23;
function staggerDelay(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return Math.pow(t, 0.2) * INTRO_MAX_DELAY;
}
function staggerRiseDuration(d: number): number {
  const t = Math.min(d / INTRO_FALLOFF_R, 1);
  return INTRO_RISE_NEAR + (INTRO_RISE_FAR - INTRO_RISE_NEAR) * t;
}
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

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

let introStartTime = -1;
let introDone = false;

function tickIntro(t: number) {
  if (introDone) return;
  if (introStartTime < 0) introStartTime = t;
  const elapsed = t - introStartTime;
  let allLanded = true;
  for (let i = 0; i < FLOOR_TILE_TOTAL; i++) {
    const localT = (elapsed - floorTileDelays[i]!) / floorTileDurations[i]!;
    let y: number;
    if (localT <= 0) { y = -INTRO_DROP; allLanded = false; }
    else if (localT < 1) { y = -(1 - easeOutCubic(localT)) * INTRO_DROP; allLanded = false; }
    else { y = 0; }
    const { x, z } = tilePos(i);
    _floorMtx.makeTranslation(x, y, z);
    floorTiles.setMatrixAt(i, _floorMtx);
  }
  floorTiles.instanceMatrix.needsUpdate = true;

  // Placed assets ride the same wave: tile-relative Y based on the
  // tile they're standing on.
  for (const inst of placedInstances) {
    const tIdx = tileIdxFor(inst.placement.x, inst.placement.z);
    if (tIdx < 0) continue;
    const localT = (elapsed - floorTileDelays[tIdx]!) / floorTileDurations[tIdx]!;
    let y: number;
    if (localT <= 0) { y = -INTRO_DROP; allLanded = false; }
    else if (localT < 1) { y = -(1 - easeOutCubic(localT)) * INTRO_DROP; allLanded = false; }
    else { y = 0; }
    inst.object.position.y = y + inst.groundOffsetY;
  }

  if (allLanded) introDone = true;
}

function tileIdxFor(x: number, z: number): number {
  const ix = Math.round(x / FLOOR_TILE_SIZE + FLOOR_TILE_HALF);
  const iz = Math.round(z / FLOOR_TILE_SIZE + FLOOR_TILE_HALF);
  if (ix < 0 || ix >= FLOOR_TILE_COUNT || iz < 0 || iz >= FLOOR_TILE_COUNT) return -1;
  return ix * FLOOR_TILE_COUNT + iz;
}

// ---- Placed asset registry ----
//
// `placedInstances` holds the live scene objects + their placement
// metadata. `placements` holds the JSON-serializable list saved to
// localStorage. The two are kept in lockstep — each commit pushes
// to both, each remove splices both.

interface PlacedInstance {
  placement: Placement;
  object: THREE.Object3D;
  /** Y offset applied so the asset's bbox.min sits on the floor. */
  groundOffsetY: number;
}
const placedInstances: PlacedInstance[] = [];
let placements: Placement[] = loadStoredPlacements();

async function spawnPlacement(p: Placement): Promise<PlacedInstance | null> {
  const def = findPlaceable(p.assetId);
  if (!def) return null;
  const obj = await loadPlaceable(def);
  obj.scale.multiplyScalar(p.scale);
  obj.rotation.y = p.rotY;
  applyVoidToTree(obj);
  obj.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).castShadow = true;
  });
  const box = new THREE.Box3().setFromObject(obj);
  const groundOffsetY = -box.min.y;
  obj.position.set(p.x, groundOffsetY, p.z);
  // Stamp the assetId on the object so trash-mode raycasts can map
  // a click target back to its placement record.
  obj.userData.placementId = p.assetId;
  obj.userData.placement = p;
  scene.add(obj);
  return { placement: p, object: obj, groundOffsetY };
}

function persist() {
  placements = placedInstances.map((i) => i.placement);
  saveStoredPlacements(placements);
}

// Boot: spawn anything the user previously saved.
async function bootPlacements() {
  for (const p of placements) {
    const inst = await spawnPlacement(p);
    if (inst) placedInstances.push(inst);
  }
}
void bootPlacements();

// ---- Sidebar ----

function renderSidebar() {
  const groups = new Map<PlaceableDef['category'], PlaceableDef[]>();
  for (const a of PLACEABLES) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category)!.push(a);
  }
  let html = '';
  for (const cat of CATEGORY_ORDER) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;
    html += `<div class="lib-section"><h2>${CATEGORY_TITLE[cat]}</h2>`;
    for (const def of items) {
      html += `
        <div class="lib-row" data-id="${def.id}">
          <span class="lib-dot" style="background:${def.dot}"></span>
          <span>${escapeHtml(def.label)}</span>
          <span class="lib-meta">${escapeHtml(def.source.split('/').pop() ?? '')}</span>
        </div>`;
    }
    html += '</div>';
  }
  sidebar.innerHTML = html;
  sidebar.querySelectorAll<HTMLElement>('.lib-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (id) startPlacement(id);
    });
  });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
renderSidebar();

// ---- Placement session ----

interface PlacementSession {
  def: PlaceableDef;
  ghost: THREE.Object3D;
  /** Uniform scale applied by loadPlaceable to make the asset's
   *  natural max-dim match def.targetSize. ghost.scale = naturalScale
   *  × session.scale, so multiplying around an explicit baseline
   *  keeps the math stable as the user grows/shrinks the ghost. */
  naturalScale: number;
  scale: number;
  rotY: number;
}
let session: PlacementSession | null = null;
let trashMode = false;

const SCALE_RATE = 1.6;       // 60% per second
const SCALE_MIN = 0.25;
const SCALE_MAX = 4.0;
const ROT_RATE = Math.PI;     // 180° per second

const cursor = { x: 0, z: 0, valid: false };
const _pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Raycaster();
const _mouseNDC = new THREE.Vector2();
const _hitPoint = new THREE.Vector3();

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_mouseNDC, camera);
  if (_ray.ray.intersectPlane(_pickPlane, _hitPoint)) {
    cursor.x = _hitPoint.x;
    cursor.z = _hitPoint.z;
    cursor.valid = true;
  } else {
    cursor.valid = false;
  }
});

async function startPlacement(assetId: string) {
  const def = findPlaceable(assetId);
  if (!def) return;
  cancelPlacement();
  setTrashMode(false);
  const ghost = await loadPlaceable(def);
  applyVoidToTree(ghost);
  // Make the ghost translucent so the user sees the eventual size +
  // orientation without it looking solid.
  ghost.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (m && 'transparent' in m) {
      m.transparent = true;
      m.opacity = 0.55;
      m.depthWrite = false;
    }
  });
  const box = new THREE.Box3().setFromObject(ghost);
  void box;
  const naturalScale = ghost.scale.x; // loadPlaceable applies a uniform multiplier
  ghost.position.set(0, 0, 0);
  scene.add(ghost);
  session = { def, ghost, naturalScale, scale: 1, rotY: 0 };
  applyGhostTransform();
  setMode(`Placing <strong>${def.label}</strong>. Click to drop, Esc to cancel.`);
  sidebar.querySelectorAll('.lib-row').forEach((r) => r.classList.remove('active'));
  sidebar.querySelector(`.lib-row[data-id="${assetId}"]`)?.classList.add('active');
}

function cancelPlacement() {
  if (!session) return;
  scene.remove(session.ghost);
  session.ghost.traverse((node) => {
    const m = (node as THREE.Mesh).geometry;
    m?.dispose?.();
    const mat = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose?.());
    else mat?.dispose?.();
  });
  session = null;
  setMode('<strong>Idle.</strong> Click an asset to start placing.');
  sidebar.querySelectorAll('.lib-row.active').forEach((r) => r.classList.remove('active'));
}

async function commitPlacement() {
  if (!session) return;
  const placement: Placement = {
    assetId: session.def.id,
    x: cursor.x,
    z: cursor.z,
    scale: session.scale,
    rotY: session.rotY,
  };
  // Discard the ghost; spawn a fresh non-translucent instance.
  scene.remove(session.ghost);
  const def = session.def;
  session = null;
  const inst = await spawnPlacement(placement);
  if (inst) {
    placedInstances.push(inst);
    persist();
  }
  setMode(`Placed <strong>${def.label}</strong>. Click another asset to keep going, or pick the same one again.`);
  sidebar.querySelectorAll('.lib-row.active').forEach((r) => r.classList.remove('active'));
}

canvas.addEventListener('click', (e) => {
  // Trash mode: try to remove a placed asset under the cursor.
  if (trashMode) {
    const rect = canvas.getBoundingClientRect();
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_mouseNDC, camera);
    const targets = placedInstances.map((i) => i.object);
    const hits = _ray.intersectObjects(targets, true);
    if (hits.length > 0) {
      // Walk up to find the placed root object.
      let node: THREE.Object3D | null = hits[0]!.object;
      while (node && !node.userData.placement) node = node.parent;
      if (node) {
        const idx = placedInstances.findIndex((i) => i.object === node);
        if (idx >= 0) {
          scene.remove(placedInstances[idx]!.object);
          placedInstances.splice(idx, 1);
          persist();
          setMode('Removed. Click another asset to delete, or toggle 🗑 off.');
        }
      }
    }
    return;
  }

  if (session && cursor.valid) void commitPlacement();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cancelPlacement();
    setTrashMode(false);
  }
});

function setTrashMode(v: boolean) {
  trashMode = v;
  trashBtn.classList.toggle('active', v);
  if (v) {
    cancelPlacement();
    setMode('<strong>Trash mode.</strong> Click a placed asset to remove it. Esc to exit.');
  } else if (!session) {
    setMode('<strong>Idle.</strong> Click an asset to start placing.');
  }
}
trashBtn.addEventListener('click', () => setTrashMode(!trashMode));

function setMode(html: string) { modeLine.innerHTML = html; }

// ---- WSAD scaling/rotation while placing ----

const keys = new Set<string>();
window.addEventListener('keydown', (e) => { keys.add(e.code); });
window.addEventListener('keyup',   (e) => { keys.delete(e.code); });
window.addEventListener('blur',    () => keys.clear());

function tickPlacement(dt: number) {
  if (!session) return;
  session.ghost.visible = cursor.valid;
  if (keys.has('KeyW')) session.scale = Math.min(SCALE_MAX, session.scale * Math.pow(SCALE_RATE, dt));
  if (keys.has('KeyS')) session.scale = Math.max(SCALE_MIN, session.scale * Math.pow(1 / SCALE_RATE, dt));
  if (keys.has('KeyA')) session.rotY += ROT_RATE * dt;
  if (keys.has('KeyD')) session.rotY -= ROT_RATE * dt;
  applyGhostTransform();
}
const _ghostBox = new THREE.Box3();
function applyGhostTransform() {
  if (!session) return;
  session.ghost.scale.setScalar(session.naturalScale * session.scale);
  session.ghost.rotation.y = session.rotY;
  // Recompute groundOffset so the asset's bbox bottom hits y=0
  // regardless of current scale.
  _ghostBox.setFromObject(session.ghost);
  const offset = -_ghostBox.min.y;
  if (cursor.valid) {
    session.ghost.position.set(cursor.x, offset, cursor.z);
  }
}

// ---- Render loop ----

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();
  tickIntro(t);
  tickPlacement(dt);
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
tick();

// ---- Page-transition slide-in (mirror of library/home) ----
{
  try {
    const from = sessionStorage.getItem('nav-from');
    if (from === 'library') document.body.classList.add('nav-from-library');
    else if (from === 'home') document.body.classList.add('nav-from-home');
    sessionStorage.removeItem('nav-from');
  } catch { /* ignore */ }

  const app = document.getElementById('app');
  // Title-bar nav links — slide editor out before navigating.
  document.querySelectorAll<HTMLAnchorElement>('#title-bar a').forEach((link) => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (!href || !app) return;
      e.preventDefault();
      // Direction: if going to /library.html, slide RIGHT (library
      // is to the right in our nav model). Going to / (home),
      // slide LEFT.
      const slidingRight = href.endsWith('library.html');
      app.classList.add(slidingRight ? 'is-leaving-right' : 'is-leaving-left');
      try { sessionStorage.setItem('nav-from', 'editor'); } catch { /* ignore */ }
      const go = () => { window.location.href = href; };
      app.addEventListener('transitionend', go, { once: true });
      setTimeout(go, 450);
    });
  });
}
