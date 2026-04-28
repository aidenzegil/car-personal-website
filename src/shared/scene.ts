// Shared Three.js scene helpers used by both the homepage hero
// (src/main.ts) and the asset library (src/library.ts).
//
// Centralizing the flight-effects code (hover, spin, neon underglow, thruster
// trail) means polish improvements show up everywhere at once.

import * as THREE from 'three';

// ---- Material polish ----

/** Tweak FBX-imported MeshStandardMaterials so they read cleanly in our dark
 *  showroom lighting (less washed-out, slight metallic). */
export function polishCarMaterials(root: THREE.Object3D, opts: { metalness?: number; roughness?: number; envMapIntensity?: number } = {}) {
  const metalness = opts.metalness ?? 0.55;
  const roughness = opts.roughness ?? 0.35;
  const envMapIntensity = opts.envMapIntensity ?? 1.2;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const apply = (m: THREE.MeshStandardMaterial) => {
      m.metalness = metalness;
      m.roughness = roughness;
      m.envMapIntensity = envMapIntensity;
    };
    const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
    if (Array.isArray(mat)) mat.forEach(apply);
    else if (mat) apply(mat as THREE.MeshStandardMaterial);
  });
}

// ---- Hover / float ----

interface HoverConfig {
  baseY: number;
  lift: number;
  amp: number;        // bob amplitude
  spin: number;       // radians per second
  bobSpeed: number;   // angular frequency
}

/** Mark an object as "flying" — its baseY+lift becomes the hover anchor and
 *  the per-frame helper below animates the bob + Y-spin. */
export function attachHover(obj: THREE.Object3D, opts: { liftHeight?: number; baseY?: number; bobAmplitude?: number; spinSpeed?: number; bobSpeed?: number } = {}) {
  const cfg: HoverConfig = {
    baseY: opts.baseY ?? 0,
    lift: opts.liftHeight ?? 1.1,
    amp: opts.bobAmplitude ?? 0.1,
    spin: opts.spinSpeed ?? 0.2,
    bobSpeed: opts.bobSpeed ?? 1.5,
  };
  obj.position.y = cfg.baseY + cfg.lift;
  (obj.userData as any).hover = cfg;
}

/** Per-frame hover update. Call from your animation loop. */
export function tickHover(obj: THREE.Object3D, dt: number, t: number) {
  const cfg = (obj.userData as any).hover as HoverConfig | undefined;
  if (!cfg) return;
  obj.position.y = cfg.baseY + cfg.lift + Math.sin(t * cfg.bobSpeed) * cfg.amp;
  obj.rotation.y += dt * cfg.spin;
}

// ---- Underglow ----

export interface UnderglowOpts {
  frontColor?: number;
  rearColor?: number;
  intensity?: number;
  distance?: number;
  decay?: number;
  yOffset?: number;
  spread?: number;
}

/** Two warm/cool point lights kissing the underside of the vehicle. */
export function addUnderglow(target: THREE.Object3D, opts: UnderglowOpts = {}): { front: THREE.PointLight; rear: THREE.PointLight } {
  const front = new THREE.PointLight(opts.frontColor ?? 0x6dd5ff, opts.intensity ?? 1.6, opts.distance ?? 5, opts.decay ?? 2);
  const rear  = new THREE.PointLight(opts.rearColor  ?? 0xe879f9, opts.intensity ?? 1.6, opts.distance ?? 5, opts.decay ?? 2);
  const y = opts.yOffset ?? -0.4;
  const z = opts.spread ?? 0.6;
  front.position.set(0, y,  z);
  rear.position.set(0, y, -z);
  target.add(front, rear);
  return { front, rear };
}

// ---- Thruster trail (additive points) ----

export interface ThrusterParams {
  count?: number;
  length?: number;
  radius?: number;
  color?: number;
  size?: number;
  speed?: number;
}

/** Cone-ish particle thruster trail; accompany with `tickThrusters` per frame. */
export function makeThrusterTrail(opts: ThrusterParams = {}): THREE.Points {
  const count = opts.count ?? 96;
  const length = opts.length ?? 1.6;
  const radius = opts.radius ?? 0.1;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = Math.random();
    positions[i * 3 + 0] = (Math.random() - 0.5) * radius * 2;
    positions[i * 3 + 1] = -Math.random() * length;
    positions[i * 3 + 2] = (Math.random() - 0.5) * radius * 2;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('seed',     new THREE.BufferAttribute(seeds, 1));
  const mat = new THREE.PointsMaterial({
    color: opts.color ?? 0x6dd5ff,
    size: opts.size ?? 0.06,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geom, mat);
  (points.userData as any).thruster = { positions, seeds, length, speed: opts.speed ?? 1.4 };
  return points;
}

/** Per-frame thruster update; call from your animation loop. */
export function tickThrusters(obj: THREE.Object3D, _dt: number, t: number) {
  obj.traverse((node) => {
    const trail = node as any;
    if (!trail.isPoints || !trail.userData?.thruster) return;
    const { positions, seeds, length, speed } = trail.userData.thruster as {
      positions: Float32Array; seeds: Float32Array; length: number; speed: number;
    };
    const attr = (trail.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < seeds.length; i++) {
      const phase = (t * speed + seeds[i]!) % 1;
      positions[i * 3 + 1] = -phase * length;
      attr.setXYZ(i, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    attr.needsUpdate = true;
    const mat = trail.material as THREE.PointsMaterial;
    mat.opacity = 0.7 + 0.2 * Math.sin(t * 8);
  });
}
