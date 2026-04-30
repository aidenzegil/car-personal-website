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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  PLACEABLES, PlaceableDef, Placement, findPlaceable, loadPlaceable,
  loadStoredPlacements, saveStoredPlacements,
  loadTombstones, saveTombstones, tombstoneKey,
} from './shared/placeables';
import {
  applyFloorTileShader,
  generateFoliageScatter,
  findFoliageDef,
} from './shared/world';

const CATEGORY_ORDER = ['road', 'aircraft', 'electronics', 'tree', 'foliage', 'flower', 'mushroom', 'rock', 'prop'] as const;
const CATEGORY_TITLE: Record<PlaceableDef['category'], string> = {
  road: 'Roads',
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

// OrbitControls — drag to rotate, right-drag to pan, scroll to zoom.
// Limited so the user can't tip below the deck or fly into orbit.
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.6, 0);
controls.minDistance = 6;
controls.maxDistance = 200;
controls.maxPolarAngle = Math.PI * 0.49;
controls.screenSpacePanning = false;

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
applyFloorTileShader(floorTileMat, {
  tileSize: FLOOR_TILE_SIZE,
  tileHeight: FLOOR_TILE_HEIGHT,
  voidPlaneY: VOID_PLANE_Y,
  voidColor: VOID_COLOR,
  voidDensity: VOID_DENSITY,
});
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
  // Roads (and other chunk-locked pieces) come pre-positioned with
  // their own Y lift so they sit flush on the deck — preserve that
  // builder Y instead of overwriting via .set, which would put the
  // asphalt at y=0 and z-fight the tile tops. Other assets use the
  // bbox-min auto-ground.
  let groundOffsetY: number;
  if (def.snapToGrid) {
    groundOffsetY = obj.position.y;
    obj.position.x = p.x;
    obj.position.z = p.z;
  } else {
    const box = new THREE.Box3().setFromObject(obj);
    groundOffsetY = -box.min.y;
    obj.position.set(p.x, groundOffsetY, p.z);
  }
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

// ---- Procedural foliage scatter (read-only, mirrors home page) ----
//
// Rendered as static InstancedMesh per prop type — these are NOT
// removable via the trashcan. Their purpose is to give the user a
// reference for where existing trees/bushes/rocks live so they can
// place new things relative to them.
// Live scatter registry — one entry per rendered InstancedMesh, keyed
// to the scatter placements so trash-mode raycast can resolve a click
// back to a `defId:tileIdx` tombstone key.
interface ScatterGroup {
  mesh: THREE.InstancedMesh;
  defId: string;
  /** placements[i] corresponds to the InstancedMesh's instance i. */
  placements: { tileIdx: number }[];
}
const scatterGroups: ScatterGroup[] = [];
const _zeroMtx = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3());

async function buildScatter() {
  const map = generateFoliageScatter({
    tileCount: FLOOR_TILE_COUNT,
    tileSize: FLOOR_TILE_SIZE,
    worldScale: 1,
  });
  const _mtx = new THREE.Matrix4();
  const _vec = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _scl = new THREE.Vector3();
  await Promise.all([...map.entries()].map(async ([defId, list]) => {
    if (list.length === 0) return;
    const fdef = findFoliageDef(defId);
    if (!fdef) return;
    // Reuse the placeable loader (same OBJ, palette texture). Then
    // turn the loaded object into one InstancedMesh per prop.
    const placeable = findPlaceable(defId);
    if (!placeable) return;
    const proto = await loadPlaceable(placeable);
    let firstMesh: THREE.Mesh | null = null;
    proto.traverse((node) => { if (!firstMesh && (node as any).isMesh) firstMesh = node as THREE.Mesh; });
    if (!firstMesh) return;
    const mNode: THREE.Mesh = firstMesh;
    // proto is already scaled so its max dim ≈ placeable.targetSize.
    // Override that to use FOLIAGE_DEFS targetSize so scatter sizes
    // match the home page exactly.
    const baseBox = new THREE.Box3().setFromBufferAttribute(mNode.geometry.attributes.position as THREE.BufferAttribute);
    const baseSize = baseBox.getSize(new THREE.Vector3());
    const baseMaxDim = Math.max(baseSize.x, baseSize.y, baseSize.z);
    const baseScale = baseMaxDim > 0 ? fdef.targetSize / baseMaxDim : 1;
    const groundOffsetY = -baseBox.min.y * baseScale;
    // Build the InstancedMesh.
    const inst = new THREE.InstancedMesh(mNode.geometry, mNode.material as THREE.Material, list.length);
    inst.castShadow = true;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      _euler.set(0, p.rotY, 0);
      _quat.setFromEuler(_euler);
      _scl.setScalar(baseScale * p.scale);
      _vec.set(p.worldX, groundOffsetY, p.worldZ);
      _mtx.compose(_vec, _quat, _scl);
      inst.setMatrixAt(i, _mtx);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    scene.add(inst);
    scatterGroups.push({ mesh: inst, defId, placements: list.map((p) => ({ tileIdx: p.tileIdx })) });
  }));
}
void buildScatter();

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
  /** Set when the session was opened by clicking an EXISTING asset
   *  ("move" mode). On commit we discard the original; on cancel we
   *  restore it so the world stays consistent if the user backs out. */
  movingFrom?: MoveSource;
}

type MoveSource =
  | { kind: 'user'; instanceIdx: number; placement: Placement; obj: THREE.Object3D }
  | { kind: 'scatter'; group: ScatterGroup; instanceId: number; matrix: THREE.Matrix4; tombstone: string };
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

/** Clone a material so we can mutate transparency/opacity on the
 *  ghost without affecting the shared (sometimes module-scope) source. */
function makeGhostMaterial(orig: THREE.Material): THREE.Material {
  const clone = orig.clone();
  if ('transparent' in clone) (clone as any).transparent = true;
  if ('opacity' in clone) (clone as any).opacity = 0.55;
  if ('depthWrite' in clone) (clone as any).depthWrite = false;
  return clone;
}

async function startPlacement(
  assetId: string,
  opts: { initialScale?: number; initialRotY?: number; movingFrom?: MoveSource } = {},
) {
  const def = findPlaceable(assetId);
  if (!def) return;
  cancelPlacement();
  setTrashMode(false);
  const ghost = await loadPlaceable(def);
  applyVoidToTree(ghost);
  // Make the ghost translucent so the user sees the eventual size +
  // orientation without it looking solid. Clone materials first —
  // procedural assets like roads share module-scope material
  // singletons, and mutating them in place would leave every spawned
  // copy translucent forever.
  ghost.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const orig = mesh.material;
    if (Array.isArray(orig)) {
      mesh.material = orig.map((m) => makeGhostMaterial(m));
    } else if (orig) {
      mesh.material = makeGhostMaterial(orig);
    }
  });
  const naturalScale = ghost.scale.x;
  ghost.position.set(0, 0, 0);
  scene.add(ghost);
  session = {
    def, ghost, naturalScale,
    scale: opts.initialScale ?? 1,
    rotY: opts.initialRotY ?? 0,
    movingFrom: opts.movingFrom,
  };
  applyGhostTransform();
  setMode(opts.movingFrom
    ? `Moving <strong>${def.label}</strong>. Click to drop, Esc to cancel.`
    : `Placing <strong>${def.label}</strong>. Click to drop, Esc to cancel.`);
  sidebar.querySelectorAll('.lib-row').forEach((r) => r.classList.remove('active'));
  sidebar.querySelector(`.lib-row[data-id="${assetId}"]`)?.classList.add('active');
}

function cancelPlacement() {
  if (!session) return;
  // Restore moved-from origin if this was a move session — the
  // original was hidden but not deleted, so cancel just unhides.
  if (session.movingFrom) {
    const src = session.movingFrom;
    if (src.kind === 'user') {
      src.obj.visible = true;
    } else {
      src.group.mesh.setMatrixAt(src.instanceId, src.matrix);
      src.group.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  scene.remove(session.ghost);
  session.ghost.traverse((node) => {
    const m = (node as THREE.Mesh).geometry;
    m?.dispose?.();
    const mat = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose?.());
    else mat?.dispose?.();
  });
  session = null;
  setMode('<strong>Idle.</strong> Click an asset to place, or click an existing one to move it.');
  sidebar.querySelectorAll('.lib-row.active').forEach((r) => r.classList.remove('active'));
}

async function commitPlacement() {
  if (!session) return;
  // Snap to tile centers when this is a chunk-locked piece so the
  // committed placement matches the ghost preview the user saw.
  let cx = cursor.x;
  let cz = cursor.z;
  if (session.def.snapToGrid) {
    cx = Math.round(cx / TILE_SIZE_LOCAL) * TILE_SIZE_LOCAL;
    cz = Math.round(cz / TILE_SIZE_LOCAL) * TILE_SIZE_LOCAL;
  }
  const placement: Placement = {
    assetId: session.def.id,
    x: cx,
    z: cz,
    scale: session.scale,
    rotY: session.rotY,
  };
  // If this was a "move" session, finalize the original's removal:
  //   - user placement: drop it from placedInstances + scene
  //   - scatter instance: tombstone it (the matrix is already zero'd)
  const src = session.movingFrom;
  if (src) {
    if (src.kind === 'user') {
      const idx = placedInstances.findIndex((i) => i === placedInstances[src.instanceIdx] || i.object === src.obj);
      const real = idx >= 0 ? idx : placedInstances.findIndex((i) => i.object === src.obj);
      if (real >= 0) {
        scene.remove(placedInstances[real]!.object);
        placedInstances.splice(real, 1);
      }
    } else {
      const tombstones = loadTombstones();
      tombstones.add(src.tombstone);
      saveTombstones(tombstones);
    }
  }
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
  // Trash mode: try to remove an asset under the cursor — either a
  // user placement OR a procedural scatter instance (which gets
  // tombstoned so it stays gone across reloads).
  if (trashMode) {
    const rect = canvas.getBoundingClientRect();
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_mouseNDC, camera);

    // 1. User placements first — they're "on top" semantically.
    const userTargets = placedInstances.map((i) => i.object);
    const userHits = _ray.intersectObjects(userTargets, true);
    if (userHits.length > 0) {
      let node: THREE.Object3D | null = userHits[0]!.object;
      while (node && !node.userData.placement) node = node.parent;
      if (node) {
        const idx = placedInstances.findIndex((i) => i.object === node);
        if (idx >= 0) {
          scene.remove(placedInstances[idx]!.object);
          placedInstances.splice(idx, 1);
          persist();
          setMode('Removed. Click another asset to delete, or toggle 🗑 off.');
          return;
        }
      }
    }

    // 2. Procedural scatter — InstancedMesh raycast returns instanceId.
    const scatterMeshes = scatterGroups.map((g) => g.mesh);
    const scatterHits = _ray.intersectObjects(scatterMeshes, false);
    if (scatterHits.length > 0) {
      const hit = scatterHits[0]!;
      const grp = scatterGroups.find((g) => g.mesh === hit.object);
      if (grp && hit.instanceId !== undefined) {
        const placement = grp.placements[hit.instanceId];
        if (placement) {
          const tombstones = loadTombstones();
          tombstones.add(tombstoneKey(grp.defId, placement.tileIdx));
          saveTombstones(tombstones);
          // Hide the deleted instance immediately by zeroing its matrix.
          grp.mesh.setMatrixAt(hit.instanceId, _zeroMtx);
          grp.mesh.instanceMatrix.needsUpdate = true;
          setMode('Removed. Click another asset to delete, or toggle 🗑 off.');
          return;
        }
      }
    }
    return;
  }

  if (session && cursor.valid) {
    void commitPlacement();
    return;
  }

  // Idle click: try to pick up an existing asset for "move" mode.
  // User placements first (they're in front semantically); then
  // procedural scatter. The original is hidden during the session
  // so cancel can restore it.
  const rect = canvas.getBoundingClientRect();
  _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_mouseNDC, camera);

  const userTargets = placedInstances.map((i) => i.object);
  const userHits = _ray.intersectObjects(userTargets, true);
  if (userHits.length > 0) {
    let node: THREE.Object3D | null = userHits[0]!.object;
    while (node && !node.userData.placement) node = node.parent;
    if (node) {
      const idx = placedInstances.findIndex((i) => i.object === node);
      if (idx >= 0) {
        const inst = placedInstances[idx]!;
        const p = inst.placement;
        inst.object.visible = false;
        void startPlacement(p.assetId, {
          initialScale: p.scale,
          initialRotY: p.rotY,
          movingFrom: { kind: 'user', instanceIdx: idx, placement: p, obj: inst.object },
        });
        return;
      }
    }
  }

  const scatterMeshes = scatterGroups.map((g) => g.mesh);
  const scatterHits = _ray.intersectObjects(scatterMeshes, false);
  if (scatterHits.length > 0) {
    const hit = scatterHits[0]!;
    const grp = scatterGroups.find((g) => g.mesh === hit.object);
    if (grp && hit.instanceId !== undefined) {
      const placement = grp.placements[hit.instanceId];
      if (placement) {
        const savedMtx = new THREE.Matrix4();
        grp.mesh.getMatrixAt(hit.instanceId, savedMtx);
        // Hide the instance; cancel restores it from `savedMtx`.
        grp.mesh.setMatrixAt(hit.instanceId, _zeroMtx);
        grp.mesh.instanceMatrix.needsUpdate = true;
        void startPlacement(grp.defId, {
          movingFrom: {
            kind: 'scatter',
            group: grp,
            instanceId: hit.instanceId,
            matrix: savedMtx,
            tombstone: tombstoneKey(grp.defId, placement.tileIdx),
          },
        });
        return;
      }
    }
  }
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
  // Roads are chunk-locked: ignore scale + rotate by 90° on each
  // discrete A/D press, not continuously.
  if (session.def.snapToGrid) {
    if (keys.has('KeyA') && !lastFrameKeys.has('KeyA')) session.rotY += Math.PI / 2;
    if (keys.has('KeyD') && !lastFrameKeys.has('KeyD')) session.rotY -= Math.PI / 2;
  } else {
    if (keys.has('KeyW')) session.scale = Math.min(SCALE_MAX, session.scale * Math.pow(SCALE_RATE, dt));
    if (keys.has('KeyS')) session.scale = Math.max(SCALE_MIN, session.scale * Math.pow(1 / SCALE_RATE, dt));
    if (keys.has('KeyA')) session.rotY += ROT_RATE * dt;
    if (keys.has('KeyD')) session.rotY -= ROT_RATE * dt;
  }
  lastFrameKeys.clear();
  for (const k of keys) lastFrameKeys.add(k);
  applyGhostTransform();
}
const lastFrameKeys = new Set<string>();
const _ghostBox = new THREE.Box3();
const TILE_SIZE_LOCAL = 12;
function applyGhostTransform() {
  if (!session) return;
  session.ghost.scale.setScalar(session.naturalScale * session.scale);
  session.ghost.rotation.y = session.rotY;
  if (cursor.valid) {
    let x = cursor.x;
    let z = cursor.z;
    if (session.def.snapToGrid) {
      x = Math.round(x / TILE_SIZE_LOCAL) * TILE_SIZE_LOCAL;
      z = Math.round(z / TILE_SIZE_LOCAL) * TILE_SIZE_LOCAL;
      // Preserve the builder's internal Y lift (e.g. ROAD_LIFT) so
      // the asphalt doesn't z-fight the floor tile tops.
      session.ghost.position.x = x;
      session.ghost.position.z = z;
    } else {
      _ghostBox.setFromObject(session.ghost);
      session.ghost.position.set(x, -_ghostBox.min.y, z);
    }
  }
}

// ---- Render loop ----

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();
  tickIntro(t);
  tickPlacement(dt);
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
