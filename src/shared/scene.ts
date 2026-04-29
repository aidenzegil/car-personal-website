// Shared Three.js scene helpers used by both the homepage hero
// (src/main.ts) and the asset library (src/library.ts).
//
// Centralizing the flight-effects code (hover, spin, neon underglow, thruster
// trail) means polish improvements show up everywhere at once.

import * as THREE from 'three';

// ---- Material polish ----

// Cel-shading ramp: 4 hard bands. Built once and shared across all toon
// materials. NearestFilter on a tiny DataTexture is what gives the toon
// shader its discrete shadow/lit bands instead of a smooth Lambert falloff.
let _toonRamp: THREE.DataTexture | null = null;
function getToonRamp(): THREE.DataTexture {
  if (_toonRamp) return _toonRamp;
  // 3-band ramp: shadow, mid, lit. Lit band at full white so palette colors
  // reach their full saturation under the key light. RGBA because Three.js
  // 0.163+ removed RGBFormat.
  const data = new Uint8Array([
    140, 140, 140, 255,
    205, 205, 205, 255,
    255, 255, 255, 255,
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _toonRamp = tex;
  return tex;
}

/** Convert FBX materials from the Designersoup low-poly pack into a true
 *  arcade-toon look (Mario Kart / Sky Rogue):
 *    - `gradientEmmisive.*`  → pure flat cyan MeshBasic, toneMapped:false.
 *      Neon bits never cel-shade — they always read as light sources.
 *    - `baseGradient.*`       → MeshToonMaterial keeping the artist's palette
 *      texture, so the gradient body coloring shows AND gets banded into
 *      hard cel highlights/shadows by the gradient ramp.
 *    - glass / tires          → MeshToon with their source color, so they
 *      cel-shade in the same style as the body.
 *
 *  This needs an actual key+fill in the scene to read — pure black-on-toon
 *  collapses to a single band. Both `library.ts` and `main.ts` set up
 *  matching lighting. */
export async function polishCarMaterials(
  root: THREE.Object3D,
  opts: { palettePath: string },
): Promise<void> {
  const ramp = getToonRamp();
  // The artist baked every per-face color into UV cells of one palette PNG.
  // We bake per-vertex colors by sampling the palette at each vertex's UV,
  // then drop the texture entirely and lean on `vertexColors`. That way
  // every face — cyan turbine, white headlight, orange tail-light, silver
  // body — keeps its real palette color even though several distinct
  // features share the same FBX material slot.
  const palette = await loadPalettePixels(opts.palettePath);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const hasUV = !!geom.attributes.uv;
    if (hasUV) bakeVertexColorsFromPalette(geom, palette);
    const orig = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const replaced = orig.map((m) => {
      if (!m) return m;
      const src = m as THREE.MeshPhongMaterial;
      const name = src.name ?? '';
      const isArtistEmissive = /em[mi]+iss?ive/i.test(name);
      const isGlass = /glass/i.test(name);
      const isFlatBlack = /flatblack|^black(?!glass)/i.test(name);
      const isBody = /baseGradient/i.test(name);

      if (isArtistEmissive) {
        // Flat unlit, per-vertex colored from palette. toneMapped:false so
        // the bright cyan/white/orange cells render at full intensity.
        return new THREE.MeshBasicMaterial({
          name,
          color: 0xffffff,
          vertexColors: hasUV,
          toneMapped: false,
          transparent: src.transparent,
          side: src.side,
        });
      }
      if (isGlass) {
        // The asset's blackGlass material UV-samples pitch-black palette
        // cells, leaving side windows as void-like holes. Force a dark
        // cool blue-grey so windows read as tinted glass against the body.
        return new THREE.MeshToonMaterial({
          name,
          gradientMap: ramp,
          color: 0x2a3550,
          transparent: src.transparent,
          side: src.side,
        });
      }
      if (isFlatBlack) {
        // Undercarriage / chassis trim. The palette cell is near-black,
        // which after toon banding renders as void. Lift to a cool dark
        // grey so the bottom reads as painted metal, not a hole.
        return new THREE.MeshToonMaterial({
          name,
          gradientMap: ramp,
          color: 0x3a3f4a,
          transparent: src.transparent,
          side: src.side,
        });
      }
      if (isBody) {
        // Tint the silver palette cool light-blue. MeshToon multiplies
        // `color` with vertex colors, so this shifts the silver body
        // toward a Back-to-the-Future-meets-cyberpunk light blue while
        // letting the small palette accents (red engine block, etc.)
        // come through.
        return new THREE.MeshToonMaterial({
          name,
          gradientMap: ramp,
          vertexColors: hasUV,
          color: new THREE.Color(0xc6dcf2),
          transparent: src.transparent,
          side: src.side,
        });
      }
      // Tires + anything else. Cel-shaded toon, per-vertex colored from
      // palette. Untextured slots fall back to src.color floored so the
      // toon ramp's shadow band has something to multiply.
      let fallback: THREE.Color | null = null;
      if (!hasUV) {
        const c = (src.color ?? new THREE.Color(0x222222)).clone();
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        if (hsl.l < 0.18) c.setHSL(hsl.h, hsl.s, 0.22);
        fallback = c;
      }
      const toon = new THREE.MeshToonMaterial({
        name,
        gradientMap: ramp,
        vertexColors: hasUV,
        color: fallback ?? new THREE.Color(0xffffff),
        transparent: src.transparent,
        side: src.side,
      });
      return toon;
    });
    if (Array.isArray(mesh.material)) {
      mesh.material = replaced as THREE.Material[];
    } else {
      mesh.material = replaced[0] as THREE.Material;
    }
  });
}

/** Bake per-vertex colors by sampling the palette PNG at each vertex's UV.
 *  Three.js's `vertexColors` then routes those colors into both lit (toon)
 *  and unlit (basic) materials, so every face keeps its artist-chosen tint
 *  even when many features share one FBX material slot.
 *
 *  Palette pixels come from canvas.getImageData() in sRGB encoding. Vertex
 *  color attributes are interpreted as linear by Three.js, so we convert
 *  sRGB→linear via THREE.Color.setRGB(_, _, _, SRGBColorSpace) before
 *  storing — otherwise the bright cyan / orange cells render desaturated. */
function bakeVertexColorsFromPalette(geom: THREE.BufferGeometry, palette: PaletteData): void {
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  if (!uv) return;
  const n = uv.count;
  const colors = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    const px = Math.max(0, Math.min(palette.w - 1, Math.floor(u * palette.w)));
    const py = Math.max(0, Math.min(palette.h - 1, Math.floor((1 - v) * palette.h)));
    const o = (py * palette.w + px) * 4;
    c.setRGB(palette.data[o]! / 255, palette.data[o + 1]! / 255, palette.data[o + 2]! / 255, THREE.SRGBColorSpace);
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

interface PaletteData {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

let _palettePromise: Promise<PaletteData> | null = null;
function loadPalettePixels(path: string): Promise<PaletteData> {
  if (_palettePromise) return _palettePromise;
  _palettePromise = new Promise<PaletteData>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no 2d ctx'));
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height);
      resolve({ data: px.data, w: img.width, h: img.height });
    };
    img.onerror = () => reject(new Error('palette image load failed: ' + path));
    img.src = path;
  });
  return _palettePromise;
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

// ---- docLorean feature lights ----

/** Pin small cyan PointLights to the artist's emissive features on the
 *  Designersoup docLorean: each wheel turbine hub + the rear thruster strip.
 *  Lights are added as children of `group` so they ride the hover bob.
 *  Tight distance + sharp decay so the cyan paints the platform under each
 *  feature without bleeding up onto the body and tinting the silver. */
export function addDocLoreanFeatureLights(group: THREE.Object3D, car: THREE.Object3D, opts: { intensity?: number; distance?: number; decay?: number } = {}) {
  // Tight + sharp: paint a small cyan halo on the platform under each
  // turbine without bleeding up onto the toon-shaded body (which would
  // tint the whole car cyan).
  const intensity = opts.intensity ?? 0.5;
  const distance = opts.distance ?? 0.7;
  const decay = opts.decay ?? 2.6;
  // Make sure scaled transforms have propagated through the FBX hierarchy
  // before we read world-space bounds.
  car.updateMatrixWorld(true);
  for (const n of ['lFWheel', 'rFWheel', 'lRWheel', 'rRWheel']) {
    const wheel = car.getObjectByName(n);
    if (!wheel) continue;
    const bb = new THREE.Box3().setFromObject(wheel);
    const c = new THREE.Vector3();
    bb.getCenter(c);
    const pl = new THREE.PointLight(0x00e7ff, intensity, distance, decay);
    pl.position.set(c.x, bb.min.y - 0.08, c.z);
    group.add(pl);
  }
  const body = car.getObjectByName('deLoreonBody');
  if (body) {
    const bb = new THREE.Box3().setFromObject(body);
    const rearLight = new THREE.PointLight(0x00e7ff, intensity * 0.9, distance + 0.1, decay);
    rearLight.position.set(bb.min.x - 0.25, (bb.min.y + bb.max.y) * 0.55, (bb.min.z + bb.max.z) * 0.5);
    group.add(rearLight);
  }
}

/** Re-parent sibling meshes that visually attach each wheel to the car body
 *  (struts, axles, vertical connectors) to the wheel itself, so they ride
 *  along when the wheel pod tilts. We pick siblings by XZ-proximity to the
 *  wheel center — anything whose horizontal center sits inside the wheel's
 *  footprint is treated as wheel hardware. `Object3D.attach` preserves the
 *  world transform on re-parent, so geometry doesn't visibly jump. */
export function attachWheelHardware(root: THREE.Object3D, wheelNames: string[]): void {
  root.updateMatrixWorld(true);
  for (const name of wheelNames) {
    const wheel = root.getObjectByName(name);
    if (!wheel || !wheel.parent) continue;
    const wbb = new THREE.Box3().setFromObject(wheel);
    if (wbb.isEmpty()) continue;
    const wc = new THREE.Vector3(); wbb.getCenter(wc);
    const ws = new THREE.Vector3(); wbb.getSize(ws);
    const radius = Math.max(ws.x, ws.z) * 0.55;
    // Snapshot siblings before mutating — `attach` removes from the parent's
    // children list mid-iteration, which would otherwise skip entries.
    for (const sib of wheel.parent.children.slice()) {
      if (sib === wheel) continue;
      const sbb = new THREE.Box3().setFromObject(sib);
      if (sbb.isEmpty()) continue;
      const sc = new THREE.Vector3(); sbb.getCenter(sc);
      const dx = sc.x - wc.x;
      const dz = sc.z - wc.z;
      if (Math.hypot(dx, dz) < radius) {
        wheel.attach(sib);
      }
    }
  }
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

/** Two warm/cool point lights kissing the underside of the vehicle. Parents
 *  to `target` so they follow the car. Pair with `createUnderglowDisc` for
 *  the *visible* glow on the ground (lights alone barely register against
 *  metallic paint in our showroom lighting). */
export function addUnderglow(target: THREE.Object3D, opts: UnderglowOpts = {}): { front: THREE.PointLight; rear: THREE.PointLight } {
  const frontColor = opts.frontColor ?? 0x6dd5ff;
  const rearColor  = opts.rearColor  ?? 0xe879f9;
  const front = new THREE.PointLight(frontColor, (opts.intensity ?? 1.6) * 1.4, opts.distance ?? 6, opts.decay ?? 2);
  const rear  = new THREE.PointLight(rearColor,  (opts.intensity ?? 1.6) * 1.4, opts.distance ?? 6, opts.decay ?? 2);
  const y = opts.yOffset ?? -0.35;
  const z = opts.spread ?? 0.6;
  front.position.set(0, y,  z);
  rear.position.set(0, y, -z);
  target.add(front, rear);
  return { front, rear };
}

/** Big additive cyan→magenta glow ellipse to lay on the ground beneath the
 *  car. Caller is responsible for adding it to the scene and updating its
 *  position so it tracks the car's X/Z (Y stays at ground level). */
export function createUnderglowDisc(opts: { frontColor?: number; rearColor?: number; width?: number; depth?: number } = {}): THREE.Mesh {
  const frontColor = opts.frontColor ?? 0x6dd5ff;
  const rearColor  = opts.rearColor  ?? 0xe879f9;
  const w = opts.width ?? 3.2;
  const d = opts.depth ?? 1.7;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      map: makeUnderglowTexture(frontColor, rearColor),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2; // draw above ground but below the car body
  return mesh;
}

/** Procedural cyan→magenta gradient texture for the underglow disc. Drawn
 *  to a canvas so we don't ship an external PNG. */
function makeUnderglowTexture(frontColor: number, rearColor: number): THREE.CanvasTexture {
  const w = 256, h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // Fill with subtle base so the radial gradient blends rather than cutting.
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, w, h);
  // Radial gradient elongated horizontally — cyan ahead-of-center, magenta
  // behind. We bake both halves into one texture so the disc only needs
  // one mesh.
  const c1 = `#${frontColor.toString(16).padStart(6, '0')}`;
  const c2 = `#${rearColor.toString(16).padStart(6, '0')}`;
  // Front half (right side of canvas, since we'll align disc length along Z)
  const g1 = ctx.createRadialGradient(w * 0.7, h / 2, 0, w * 0.7, h / 2, w * 0.55);
  g1.addColorStop(0, c1);
  g1.addColorStop(0.4, c1 + 'aa');
  g1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, w, h);
  const g2 = ctx.createRadialGradient(w * 0.3, h / 2, 0, w * 0.3, h / 2, w * 0.55);
  g2.addColorStop(0, c2);
  g2.addColorStop(0.4, c2 + 'aa');
  g2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
