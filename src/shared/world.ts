// World rendering helpers shared between the home page and the editor.
//
// These keep the visual identity consistent: the floor tile shader
// (edge darken + per-tile noise + vertical void fade) and the
// procedural foliage scatter (deterministic mulberry32 per tile, so
// the home and editor agree on tree positions even though they're
// rendered by separate code paths).

import * as THREE from 'three';
import { loadTombstones, tombstoneKey } from './placeables';

// ---- Floor tile shader ----
//
// Three pieces folded into one onBeforeCompile pass so they share
// one <fog_fragment> replacement:
//   1. Edge darken: each face fades to a darker gray near its
//      perimeter. Object-local position drives the per-axis
//      distance-to-edge calculation that handles top, bottom, and
//      side faces correctly.
//   2. Per-tile static noise: gentle world-stable grain so adjacent
//      columns read as discrete blocks instead of a single sheet.
//   3. Vertical void: aggressive exponential fade to `voidColor`
//      below `voidPlaneY`. Above that plane it's a no-op.
export function applyFloorTileShader(
  mat: THREE.Material,
  opts: { tileSize: number; tileHeight: number; voidPlaneY: number; voidColor: number; voidDensity: number },
) {
  if ((mat as any).__voidApplied) return;
  (mat as any).__voidApplied = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uVoidPlaneY = { value: opts.voidPlaneY };
    shader.uniforms.uVoidColor = { value: new THREE.Color(opts.voidColor) };
    shader.uniforms.uVoidDensity = { value: opts.voidDensity };
    shader.uniforms.uTileHalfExtent = {
      value: new THREE.Vector3(opts.tileSize * 0.97 * 0.5, opts.tileHeight * 0.5, opts.tileSize * 0.97 * 0.5),
    };
    shader.uniforms.uTileCenterY = { value: -opts.tileHeight * 0.5 };
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
      `vec3 fromCenter = vTileObj - vec3(0.0, uTileCenterY, 0.0);
vec3 distEdge = uTileHalfExtent - abs(fromCenter);
float minD = min(distEdge.x, min(distEdge.y, distEdge.z));
float maxD = max(distEdge.x, max(distEdge.y, distEdge.z));
float edgeDist = (distEdge.x + distEdge.y + distEdge.z) - minD - maxD;
float edgeFactor = smoothstep(0.0, 0.35, edgeDist);
gl_FragColor.rgb *= mix(0.72, 1.0, edgeFactor);
float n = fract(sin(dot(floor(vVoidWorld.xz * 0.5), vec2(12.9898, 78.233))) * 43758.5453);
gl_FragColor.rgb *= 1.0 + (n - 0.5) * 0.05;
#include <fog_fragment>
float voidDepth = max(0.0, uVoidPlaneY - vVoidWorld.y);
float voidFactor = 1.0 - exp(-uVoidDensity * voidDepth);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uVoidColor, voidFactor);`,
    );
  };
  mat.needsUpdate = true;
}

// ---- Procedural foliage scatter ----
//
// Deterministic per-tile RNG so the home page and the editor agree
// on prop placement even when each renders the result with a
// different code path. Adding/removing entries from FOLIAGE_DEFS
// will reshuffle every world; treat this list as the canonical
// source.

export interface FoliageScatterDef {
  id: string;
  category: 'tree' | 'bush' | 'flower' | 'mushroom' | 'rock';
  /** Final-world max-dimension target before per-instance jitter. */
  targetSize: number;
  /** Horizontal collision radius. Same proportional scale as targetSize. */
  collisionRadius: number;
  /** Smoke particles to emit on collision (home only — editor ignores). */
  smokeParticles: number;
}

export const FOLIAGE_DEFS: FoliageScatterDef[] = [
  { id: 'Tree1_Green', category: 'tree', targetSize: 11, collisionRadius: 1.6, smokeParticles: 10 },
  { id: 'Tree2_Green', category: 'tree', targetSize: 12, collisionRadius: 1.7, smokeParticles: 11 },
  { id: 'Tree3',       category: 'tree', targetSize: 9,  collisionRadius: 1.4, smokeParticles: 9  },
  { id: 'Tree4_Green', category: 'tree', targetSize: 8,  collisionRadius: 1.3, smokeParticles: 8  },
  { id: 'Tree5_Green', category: 'tree', targetSize: 8,  collisionRadius: 1.3, smokeParticles: 8  },
  { id: 'Tree6_Green', category: 'tree', targetSize: 10, collisionRadius: 1.5, smokeParticles: 9  },
  { id: 'CircularBush_Green', category: 'bush', targetSize: 2.4, collisionRadius: 0.9, smokeParticles: 6 },
  { id: 'CubyBush_Green',     category: 'bush', targetSize: 2.2, collisionRadius: 0.9, smokeParticles: 6 },
  { id: 'Flower1', category: 'flower', targetSize: 0.8, collisionRadius: 0.4, smokeParticles: 3 },
  { id: 'Flower2', category: 'flower', targetSize: 0.8, collisionRadius: 0.4, smokeParticles: 3 },
  { id: 'Flower3', category: 'flower', targetSize: 0.7, collisionRadius: 0.4, smokeParticles: 3 },
  { id: 'Flower4', category: 'flower', targetSize: 0.7, collisionRadius: 0.4, smokeParticles: 3 },
  { id: 'Flower5', category: 'flower', targetSize: 0.8, collisionRadius: 0.4, smokeParticles: 3 },
  { id: 'Mushroom1', category: 'mushroom', targetSize: 1.3, collisionRadius: 0.5, smokeParticles: 4 },
  { id: 'Mushroom2', category: 'mushroom', targetSize: 1.0, collisionRadius: 0.5, smokeParticles: 4 },
  { id: 'Rock1', category: 'rock', targetSize: 2.5, collisionRadius: 1.0, smokeParticles: 7 },
  { id: 'Rock2', category: 'rock', targetSize: 2.0, collisionRadius: 0.8, smokeParticles: 6 },
  { id: 'Rock3', category: 'rock', targetSize: 1.8, collisionRadius: 0.7, smokeParticles: 5 },
  { id: 'Rock4', category: 'rock', targetSize: 1.5, collisionRadius: 0.6, smokeParticles: 5 },
];

export interface ScatterPlacement {
  defId: string;
  tileIdx: number;
  worldX: number;
  worldZ: number;
  scale: number;
  rotY: number;
}

/** Stateless per-tile PRNG so reload doesn't reshuffle. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFoliageScatter(opts: {
  tileCount: number;        // per axis
  tileSize: number;         // world units per tile
  /** World-scale multiplier — props (and clear-radius) shrink with it. */
  worldScale: number;
}): Map<string, ScatterPlacement[]> {
  const total = opts.tileCount * opts.tileCount;
  const half = (opts.tileCount - 1) * 0.5;
  const clearR = opts.tileSize * 1.5;
  const tombstones = loadTombstones();
  const map = new Map<string, ScatterPlacement[]>();
  for (let i = 0; i < total; i++) {
    const ix = Math.floor(i / opts.tileCount);
    const iz = i % opts.tileCount;
    const tx = (ix - half) * opts.tileSize;
    const tz = (iz - half) * opts.tileSize;
    if (Math.abs(tx) <= clearR && Math.abs(tz) <= clearR) continue;
    const rng = mulberry32(i + 1);
    const def = pickFoliageType(rng);
    if (!def) continue;
    // Skip anything the user trashed in the editor.
    if (tombstones.has(tombstoneKey(def.id, i))) {
      // Still consume the same RNG steps so subsequent tiles resolve
      // identically even when the user has deleted some — keeps the
      // remaining scatter stable.
      rng(); rng(); rng(); rng();
      continue;
    }
    const offsetX = (rng() - 0.5) * (opts.tileSize * 0.55);
    const offsetZ = (rng() - 0.5) * (opts.tileSize * 0.55);
    const scale   = 0.85 + rng() * 0.3;
    const rotY    = rng() * Math.PI * 2;
    const list = map.get(def.id) ?? [];
    list.push({ defId: def.id, tileIdx: i, worldX: tx + offsetX, worldZ: tz + offsetZ, scale, rotY });
    map.set(def.id, list);
  }
  // The world scale doesn't affect placement positions (those scale
  // with tile size automatically), but the consumer may want to apply
  // it to the props' targetSize when rendering.
  void opts.worldScale;
  return map;
}

function pickFoliageType(rng: () => number): FoliageScatterDef | null {
  const r = rng();
  if (r < 0.60) return null;
  const p = (r - 0.60) / 0.40;
  const trees    = FOLIAGE_DEFS.filter((d) => d.category === 'tree');
  const bushes   = FOLIAGE_DEFS.filter((d) => d.category === 'bush');
  const flowers  = FOLIAGE_DEFS.filter((d) => d.category === 'flower');
  const mushroom = FOLIAGE_DEFS.filter((d) => d.category === 'mushroom');
  const rocks    = FOLIAGE_DEFS.filter((d) => d.category === 'rock');
  const cat = p < 0.35 ? trees
            : p < 0.53 ? bushes
            : p < 0.75 ? rocks
            : p < 0.92 ? flowers
            : mushroom;
  return cat[Math.floor(rng() * cat.length)] ?? null;
}

export function findFoliageDef(id: string): FoliageScatterDef | undefined {
  return FOLIAGE_DEFS.find((d) => d.id === id);
}
