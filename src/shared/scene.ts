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

// ---- Afterburner (volumetric additive cone) ----
//
// Replaces the older particle-points thruster with a proper afterburner: two
// crossed cones with vertex-color gradients, additive blending, base->tip
// fade, and an outer halo cone for the warm bloom edge. Length and intensity
// can be modulated at runtime via setAfterburnerThrottle() so a boost pulse
// reads instantly as a stronger flame.

export interface AfterburnerOpts {
  /** Radius of the engine bell at the car. */
  radius?: number;
  /** Default length when throttle = 1. */
  length?: number;
  /** Hot inner core color. */
  coreColor?: number;
  /** Outer halo color. */
  haloColor?: number;
}

interface AfterburnerState {
  baseLength: number;
  baseRadius: number;
  throttle: number;       // 0..1, drives length + intensity
  baseCoreColor: THREE.Color;
  baseHaloColor: THREE.Color;
  boostCoreColor: THREE.Color;
  boostHaloColor: THREE.Color;
  // Tracked for per-frame flicker, kept here so each instance gets its own seed.
  seed: number;
}

/** Build a flame group; attach it to the car at the engine exit, oriented
 *  so its +Z axis points BACKWARD relative to the car. The helpers below
 *  expect the group's local -Z to be the flame direction. */
export function makeAfterburner(opts: AfterburnerOpts = {}): THREE.Group {
  const radius = opts.radius ?? 0.18;
  const length = opts.length ?? 1.3;
  const core = new THREE.Color(opts.coreColor ?? 0xbfeeff);
  const halo = new THREE.Color(opts.haloColor ?? 0x6dd5ff);

  const group = new THREE.Group();
  group.name = 'afterburner';

  // Two crossed cones for volume regardless of viewing angle.
  for (let i = 0; i < 2; i++) {
    const cone = makeFadeCone(radius, length, 24, core, halo, /*isOuter=*/ false);
    cone.rotation.y = i === 0 ? 0 : Math.PI / 2;
    group.add(cone);
  }

  // Outer halo cone — wider, dimmer, gives the bloom-y edge.
  const halo2 = makeFadeCone(radius * 1.7, length * 1.05, 28, halo, halo.clone().multiplyScalar(0.4), /*isOuter=*/ true);
  group.add(halo2);

  // Hot disc at the bell — sells the engine attachment point.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 1.05, 28),
    new THREE.MeshBasicMaterial({
      color: core,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  disc.rotation.y = Math.PI / 2; // face along Z
  disc.position.z = -0.001;
  group.add(disc);

  const state: AfterburnerState = {
    baseLength: length,
    baseRadius: radius,
    throttle: 1,
    baseCoreColor: core.clone(),
    baseHaloColor: halo.clone(),
    boostCoreColor: new THREE.Color(0xffffff),
    boostHaloColor: new THREE.Color(0xffb547),
    seed: Math.random() * 1000,
  };
  (group.userData as any).afterburner = state;
  return group;
}

/** Build one cone segment. Vertex colors fade base -> tip so additive
 *  blending naturally produces a flame gradient. */
function makeFadeCone(
  radius: number,
  height: number,
  segments: number,
  baseColor: THREE.Color,
  tipColor: THREE.Color,
  isOuter: boolean,
): THREE.Mesh {
  const geo = new THREE.ConeGeometry(radius, height, segments, 1, true);
  // Cone is built with tip at +Y/2 and open base at -Y/2 (radius). Rotate so
  // tip points along +Z (i.e., behind the car when added with +Z = backward).
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, height / 2);

  // Per-vertex colors: tip-end vertices fade to transparent (alpha via color),
  // base-end vertices stay hot. Additive blending hides "transparent" in the
  // dark color contribution.
  const colors = new Float32Array(geo.attributes.position!.count * 3);
  const pos = geo.attributes.position! as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, z / height)); // 0 at base, 1 at tip
    const c = baseColor.clone().lerp(tipColor, t);
    // Fade the tip aggressively for a tapered look.
    const fade = Math.pow(1 - t, 2.0);
    colors[i * 3 + 0] = c.r * fade;
    colors[i * 3 + 1] = c.g * fade;
    colors[i * 3 + 2] = c.b * fade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    opacity: isOuter ? 0.55 : 0.95,
  });
  return new THREE.Mesh(geo, mat);
}

/**
 * Throttle 0..1 controls flame length + intensity continuously. Push past 1
 * (e.g. 1.6) for a boost pulse — the cone stretches, brightens, and shifts
 * toward `boostColor`. The actual visual update happens in `tickAfterburners`.
 */
export function setAfterburnerThrottle(group: THREE.Object3D, throttle: number) {
  const state = (group.userData as any).afterburner as AfterburnerState | undefined;
  if (!state) return;
  state.throttle = throttle;
}

/** Per-frame afterburner update — flicker, boost-color blend, length scale. */
export function tickAfterburners(root: THREE.Object3D, _dt: number, t: number) {
  root.traverse((node) => {
    const state = (node.userData as any).afterburner as AfterburnerState | undefined;
    if (!state) return;
    // High-frequency flicker (3% jitter) + low-frequency breathing.
    const flicker = 0.97 + Math.sin((t + state.seed) * 38) * 0.03;
    const breathe = 0.92 + Math.sin((t + state.seed) * 4) * 0.08;
    const scaleZ = state.throttle * flicker;
    const scaleR = Math.min(1.6, 0.85 + state.throttle * 0.25) * breathe;
    node.scale.set(scaleR, scaleR, scaleZ);

    // Color blend toward boost as throttle exceeds 1.
    const overdrive = Math.max(0, state.throttle - 1) / 0.8; // 0 at throttle=1, ~1 at throttle=1.8
    const blend = Math.min(1, overdrive);
    node.traverse((child) => {
      const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (!m || !(m as any).isMeshBasicMaterial) return;
      // Only the disc uses a flat color — restyle that one. The cones keep
      // their vertex colors and we lean on opacity for boost intensity.
      if (m.vertexColors === false) {
        const c = state.baseCoreColor.clone().lerp(state.boostCoreColor, blend);
        m.color.copy(c);
        m.opacity = (0.7 + blend * 0.3) * Math.min(1, state.throttle);
      } else {
        m.opacity = (m.opacity > 0.9 ? 0.95 : 0.55) * Math.min(1.2, state.throttle);
      }
    });
  });
}
