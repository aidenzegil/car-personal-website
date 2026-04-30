// Road assets — procedural geometry built to chunk-lock against the
// floor tile grid (12u × 12u). Each piece's "lane endpoints" sit at
// the midpoint of every edge it connects to, so:
//   straight ↔ straight, straight ↔ curve, straight ↔ T,
//   curve ↔ curve, etc.
// all join seamlessly when adjacent and rotated correctly.
//
// Assumed orientation (rotation.y = 0, looking down +Y):
//
//   STRAIGHT runs north-south (along Z): lanes meet north and south edges.
//   CURVE connects south edge → east edge (NE quarter arc).
//   TEE connects south, east, west (one missing arm = north).
//   CROSS connects all four.
//
// Future hook for automated traffic: each piece exposes a `lanes`
// array on userData with [{ entry: Vector3, exit: Vector3, ... }].
// AI cars walk the entry → exit curve and hand off at the next chunk.
// Built but not consumed yet — adding the data now keeps the
// geometry source of truth single-file when we plug AI in.

import * as THREE from 'three';

export const ROAD_TILE = 12;       // matches FLOOR_TILE_SIZE
export const ROAD_WIDTH = 7;       // total carriageway width
// Y stack: asphalt sits well above the deck, stripes a chunky 5cm above
// the asphalt. The naive 0.001 separation z-fights heavily at the
// camera angles we use — bump to 0.05+ for visually clean layering.
export const ROAD_LIFT      = 0.18;
const STRIPE_LIFT_LOCAL     = 0.05;  // local-space lift on top of asphalt
const ASPHALT_COLOR = 0x32363d;
const STRIPE_YELLOW = 0xfdc34c;
const STRIPE_WHITE  = 0xeae5d2;

const _asphaltMat = new THREE.MeshStandardMaterial({
  color: ASPHALT_COLOR, roughness: 0.95, metalness: 0.02,
});
const _yellowMat = new THREE.MeshStandardMaterial({
  color: STRIPE_YELLOW, roughness: 0.85, metalness: 0,
});
const _whiteMat = new THREE.MeshStandardMaterial({
  color: STRIPE_WHITE, roughness: 0.85, metalness: 0,
});

interface LaneEndpoint {
  /** Local-space entry/exit position on the tile edge. */
  pos: THREE.Vector3;
  /** Outward normal — direction traffic exits the tile. */
  dir: THREE.Vector3;
}

/** Internal helper: a flat plane oriented horizontally, lifted by
 *  `dy` so it sits above the asphalt. */
function flatPlane(w: number, h: number, mat: THREE.Material, dy: number): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(w, h);
  geom.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geom, mat);
  m.position.y = dy;
  m.receiveShadow = true;
  return m;
}

/** Center-stripe segment along Z, from -length/2 to +length/2. */
function dashedCenterLine(length: number, dash = 1.4, gap = 1.1): THREE.Group {
  const grp = new THREE.Group();
  const stripeWidth = 0.18;
  const half = length / 2;
  let z = -half + dash / 2;
  while (z + dash / 2 <= half + 0.001) {
    grp.add(flatPlane(stripeWidth, dash, _yellowMat, STRIPE_LIFT_LOCAL));
    grp.children[grp.children.length - 1]!.position.z = z;
    z += dash + gap;
  }
  return grp;
}

function edgeWhiteLines(length: number, offset: number): THREE.Group {
  const grp = new THREE.Group();
  const stripeWidth = 0.16;
  const left = flatPlane(stripeWidth, length, _whiteMat, STRIPE_LIFT_LOCAL);
  left.position.x = -offset;
  const right = flatPlane(stripeWidth, length, _whiteMat, STRIPE_LIFT_LOCAL);
  right.position.x = offset;
  grp.add(left, right);
  return grp;
}

function buildStraight(): THREE.Object3D {
  // Carriageway: 7-wide along X, 12-long along Z. Edges run the full
  // tile length so adjacent straights/intersections meet flush.
  const grp = new THREE.Group();
  grp.name = 'road-straight';
  const asphalt = flatPlane(ROAD_WIDTH, ROAD_TILE, _asphaltMat, 0);
  grp.add(asphalt);
  grp.add(edgeWhiteLines(ROAD_TILE, ROAD_WIDTH / 2 - 0.25));
  grp.add(dashedCenterLine(ROAD_TILE));
  grp.position.y = ROAD_LIFT;
  grp.userData.lanes = [
    { pos: new THREE.Vector3(0, 0,  ROAD_TILE / 2), dir: new THREE.Vector3(0, 0,  1) },
    { pos: new THREE.Vector3(0, 0, -ROAD_TILE / 2), dir: new THREE.Vector3(0, 0, -1) },
  ] satisfies LaneEndpoint[];
  return grp;
}

function buildCurve(): THREE.Object3D {
  // Quarter-circle arc connecting south edge midpoint (0, 0, +T/2)
  // to east edge midpoint (+T/2, 0, 0). The arc sweeps around the
  // NE corner of the tile (i.e. the corner at +X, -Z).
  //
  // Using RingGeometry with thetaStart/thetaLength gives us the exact
  // quarter-arc shape; we just rotate it flat and translate so the
  // arc center sits at the avoided corner.
  const grp = new THREE.Group();
  grp.name = 'road-curve';
  const inner = ROAD_TILE / 2 - ROAD_WIDTH / 2;
  const outer = ROAD_TILE / 2 + ROAD_WIDTH / 2;
  const ring = new THREE.RingGeometry(inner, outer, 32, 1, Math.PI, Math.PI / 2);
  ring.rotateX(-Math.PI / 2);
  const arc = new THREE.Mesh(ring, _asphaltMat);
  arc.receiveShadow = true;
  // RingGeometry centers around (0,0); shift so the arc curls around
  // the NE corner of the tile (+T/2 X, -T/2 Z in our top-down).
  arc.position.set(ROAD_TILE / 2, 0, ROAD_TILE / 2);
  grp.add(arc);
  // White edge lines: build two thinner concentric rings just inside
  // the inner edge and just outside the outer edge.
  const lineW = 0.16;
  const innerLine = new THREE.RingGeometry(inner + 0.25, inner + 0.25 + lineW, 24, 1, Math.PI, Math.PI / 2);
  innerLine.rotateX(-Math.PI / 2);
  const innerMesh = new THREE.Mesh(innerLine, _whiteMat);
  innerMesh.position.set(ROAD_TILE / 2, STRIPE_LIFT_LOCAL, ROAD_TILE / 2);
  const outerLine = new THREE.RingGeometry(outer - 0.25 - lineW, outer - 0.25, 24, 1, Math.PI, Math.PI / 2);
  outerLine.rotateX(-Math.PI / 2);
  const outerMesh = new THREE.Mesh(outerLine, _whiteMat);
  outerMesh.position.set(ROAD_TILE / 2, STRIPE_LIFT_LOCAL, ROAD_TILE / 2);
  grp.add(innerMesh, outerMesh);
  // Yellow center stripe — dashed along the centerline radius.
  const centerR = (inner + outer) / 2;
  const stripeRing = new THREE.RingGeometry(centerR - 0.09, centerR + 0.09, 36, 1, Math.PI, Math.PI / 2);
  stripeRing.rotateX(-Math.PI / 2);
  const stripeMesh = new THREE.Mesh(stripeRing, _yellowMat);
  stripeMesh.position.set(ROAD_TILE / 2, STRIPE_LIFT_LOCAL, ROAD_TILE / 2);
  grp.add(stripeMesh);

  grp.position.y = ROAD_LIFT;
  grp.userData.lanes = [
    { pos: new THREE.Vector3(0, 0,  ROAD_TILE / 2), dir: new THREE.Vector3(0, 0,  1) },
    { pos: new THREE.Vector3( ROAD_TILE / 2, 0, 0), dir: new THREE.Vector3( 1, 0, 0) },
  ] satisfies LaneEndpoint[];
  return grp;
}

/** Helper: an asphalt rectangle from edge to edge along one axis,
 *  combined with a center square in the middle. Used by tee + cross. */
function buildIntersectionAsphalt(arms: { n: boolean; s: boolean; e: boolean; w: boolean }): THREE.Group {
  const grp = new THREE.Group();
  // Center pad — full road-width square at origin.
  grp.add(flatPlane(ROAD_WIDTH, ROAD_WIDTH, _asphaltMat, 0));
  // Arms: each arm extends from the center pad to the corresponding
  // tile edge. Arm length = (T - W)/2 so it stops flush at the edge.
  const armLen = (ROAD_TILE - ROAD_WIDTH) / 2;
  const armOffset = ROAD_WIDTH / 2 + armLen / 2;
  if (arms.n) {
    const arm = flatPlane(ROAD_WIDTH, armLen, _asphaltMat, 0);
    arm.position.z = -armOffset;
    grp.add(arm);
  }
  if (arms.s) {
    const arm = flatPlane(ROAD_WIDTH, armLen, _asphaltMat, 0);
    arm.position.z = armOffset;
    grp.add(arm);
  }
  if (arms.e) {
    const arm = flatPlane(armLen, ROAD_WIDTH, _asphaltMat, 0);
    arm.position.x = armOffset;
    grp.add(arm);
  }
  if (arms.w) {
    const arm = flatPlane(armLen, ROAD_WIDTH, _asphaltMat, 0);
    arm.position.x = -armOffset;
    grp.add(arm);
  }
  return grp;
}

function buildTee(): THREE.Object3D {
  // T-junction: south + east + west arms (no north). Rotate to get
  // other orientations.
  const grp = new THREE.Group();
  grp.name = 'road-tee';
  grp.add(buildIntersectionAsphalt({ n: false, s: true, e: true, w: true }));
  grp.position.y = ROAD_LIFT;
  grp.userData.lanes = [
    { pos: new THREE.Vector3(0, 0,  ROAD_TILE / 2), dir: new THREE.Vector3(0, 0,  1) },
    { pos: new THREE.Vector3( ROAD_TILE / 2, 0, 0), dir: new THREE.Vector3( 1, 0, 0) },
    { pos: new THREE.Vector3(-ROAD_TILE / 2, 0, 0), dir: new THREE.Vector3(-1, 0, 0) },
  ] satisfies LaneEndpoint[];
  return grp;
}

function buildCross(): THREE.Object3D {
  const grp = new THREE.Group();
  grp.name = 'road-cross';
  grp.add(buildIntersectionAsphalt({ n: true, s: true, e: true, w: true }));
  grp.position.y = ROAD_LIFT;
  grp.userData.lanes = [
    { pos: new THREE.Vector3(0, 0,  ROAD_TILE / 2), dir: new THREE.Vector3(0, 0,  1) },
    { pos: new THREE.Vector3(0, 0, -ROAD_TILE / 2), dir: new THREE.Vector3(0, 0, -1) },
    { pos: new THREE.Vector3( ROAD_TILE / 2, 0, 0), dir: new THREE.Vector3( 1, 0, 0) },
    { pos: new THREE.Vector3(-ROAD_TILE / 2, 0, 0), dir: new THREE.Vector3(-1, 0, 0) },
  ] satisfies LaneEndpoint[];
  return grp;
}

const BUILDERS: Record<string, () => THREE.Object3D> = {
  'road-straight': buildStraight,
  'road-curve':    buildCurve,
  'road-tee':      buildTee,
  'road-cross':    buildCross,
};

/** Returns true if this `source` string is a procedural road build
 *  request (used by `loadPlaceable` to branch). */
export function isRoadSource(source: string): boolean {
  return source.startsWith('procedural:road-');
}

export function buildRoadFromSource(source: string): THREE.Object3D {
  const kind = source.slice('procedural:'.length);
  const builder = BUILDERS[kind];
  if (!builder) throw new Error(`unknown road kind: ${kind}`);
  return builder();
}
