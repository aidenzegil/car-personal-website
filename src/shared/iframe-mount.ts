// Shared CSS3D helpers for mounting iframes / arbitrary HTML on a 3D
// mesh's screen face, plus the alpha-hole punch that lets the iframe
// show through an otherwise opaque WebGL canvas.
//
// The recipe:
//   1. Create the WebGLRenderer with `alpha: true` and clear-alpha 0,
//      so non-mesh pixels stay transparent.
//   2. Create a CSS3DRenderer and layer its DOM element *behind* the
//      WebGL canvas via z-index — opaque WebGL pixels naturally hide
//      the iframe behind them; transparent ones reveal it.
//   3. Use `mountHtmlOnMesh` to attach a CSS3DObject (iframe) as a
//      child of the screen mesh. The iframe transforms with the
//      scene under any rotation/scale.
//   4. For meshes embedded in a chassis (e.g. monitor case around a
//      screen), use `makeMeshAlphaHole` on the screen mesh to punch
//      a transparent hole in the chassis so the iframe behind shows.

import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

export { CSS3DObject, CSS3DRenderer };

export interface MountedIframe {
  css: CSS3DObject;
  iframe: HTMLIFrameElement;
}

export interface MountHtmlOptions {
  /** CSS pixels per world unit. Higher = sharper iframe text but
   *  larger DOM cost. Default 80. */
  density?: number;
  /** Iframe element backgroundColor. Default `#000`. */
  backgroundColor?: string;
  /** Set the iframe's `pointerEvents`. Defaults to `auto`, but the
   *  caller often wants `none` initially and toggles it on focus. */
  pointerEvents?: 'auto' | 'none';
  /** Shrink the iframe by `inset` on each side relative to the
   *  mesh's local bbox dimensions. CSS3D can't curve an iframe to
   *  follow a CRT face — the bbox of a curved screen mesh includes
   *  bezel slope that isn't part of the visible flat area, so we
   *  inset to keep the iframe inside the screen's visible region.
   *  0.0 = bbox-sized; 0.1 = 10% smaller per side; max ~0.4. */
  inset?: number;
  /** Wrap the iframe in CRT scanlines + a subtle vignette + a slight
   *  desaturation + warm-tint filter so modern web content blends
   *  into a vintage CRT instead of looking like a sticker pasted on
   *  the screen. Costs ~zero — pure CSS. */
  crtEffect?: boolean;
}

/** Mount an iframe with `srcdoc` HTML on the front face of `mesh`.
 *  See module docstring for the compositing requirements. */
export function mountHtmlOnMesh(
  mesh: THREE.Mesh,
  html: string,
  opts?: MountHtmlOptions,
): MountedIframe {
  const iframe = makeIframe(opts);
  iframe.srcdoc = html;
  return mountIframe(mesh, iframe, opts);
}

/** Mount an iframe loading a URL. Mirrors `mountHtmlOnMesh` but
 *  lets the iframe navigate (and shows X-Frame-Options refusal pages
 *  for sites that disallow embedding — e.g. google.com). */
export function mountUrlOnMesh(
  mesh: THREE.Mesh,
  url: string,
  opts?: MountHtmlOptions,
): MountedIframe {
  const iframe = makeIframe(opts);
  iframe.src = url;
  return mountIframe(mesh, iframe, opts);
}

function makeIframe(opts?: MountHtmlOptions): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.style.border = '0';
  iframe.style.background = opts?.backgroundColor ?? '#000';
  iframe.style.pointerEvents = opts?.pointerEvents ?? 'auto';
  return iframe;
}

function mountIframe(
  mesh: THREE.Mesh,
  iframe: HTMLIFrameElement,
  opts?: MountHtmlOptions,
): MountedIframe {
  mesh.geometry.computeBoundingBox();
  const lbbox = mesh.geometry.boundingBox!;
  const lsize = new THREE.Vector3(); lbbox.getSize(lsize);
  const lcenter = new THREE.Vector3(); lbbox.getCenter(lcenter);
  const dims = [
    { axis: 0, size: lsize.x },
    { axis: 1, size: lsize.y },
    { axis: 2, size: lsize.z },
  ].sort((a, b) => a.size - b.size);
  const depthAxis = dims[0]!.axis;
  const planeAxes = dims.slice(1).sort((a, b) => b.size - a.size);
  const wAxisIdx = planeAxes[0]!.axis;
  const wLocal = planeAxes[0]!.size;
  const hLocal = planeAxes[1]!.size;

  // Front-face direction comes from summed vertex normals along the
  // depth axis — for a slab with a bowed CRT face the front side
  // dominates the sum.
  const normalAttr = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
  let normalSum = 0;
  if (normalAttr) {
    for (let i = 0; i < normalAttr.count; i++) {
      normalSum += normalAttr.getComponent(i, depthAxis);
    }
  }
  const depthSign = normalSum >= 0 ? 1 : -1;

  // Right-handed basis where ez = +screen-out direction; ey is the
  // height axis chosen so it maps to world +Y after the parent's
  // world rotation composes in (text upright regardless of GLB
  // orientation). ex = ey × ez (auto-perpendicular).
  mesh.updateWorldMatrix(true, false);
  const meshWorldRot = new THREE.Quaternion();
  mesh.matrixWorld.decompose(new THREE.Vector3(), meshWorldRot, new THREE.Vector3());
  const ez = new THREE.Vector3().setComponent(depthAxis, depthSign);
  let ex = new THREE.Vector3().setComponent(wAxisIdx, 1);
  let ey = new THREE.Vector3().crossVectors(ez, ex);
  const eyWorldY = ey.clone().applyQuaternion(meshWorldRot).y;
  if (eyWorldY < 0) {
    ex.negate();
    ey = new THREE.Vector3().crossVectors(ez, ex);
  }

  const inset = Math.max(0, Math.min(0.4, opts?.inset ?? 0));
  const wInset = wLocal * (1 - 2 * inset);
  const hInset = hLocal * (1 - 2 * inset);
  const density = opts?.density ?? 80;
  const wPx = Math.max(64, Math.round(wInset * density));
  const hPx = Math.max(64, Math.round(hInset * density));
  iframe.style.width = `${wPx}px`;
  iframe.style.height = `${hPx}px`;

  // Optional CRT vintage skin: wrap the iframe in a div with a
  // scanline overlay + a soft vignette + a global filter that pulls
  // saturation down and warms the whites. Modern web content reads
  // as "rendered through a CRT" instead of a sticker on the screen.
  // Curved corners + a barrel-distortion SVG filter sell the bowed-
  // glass illusion without actually deforming the iframe (clicks
  // still hit the flat underlying coordinates).
  let mountElement: HTMLElement = iframe;
  if (opts?.crtEffect) {
    // We previously stacked an SVG `feDisplacementMap` barrel filter
    // on top of these effects to fake CRT bowing — but the radial
    // displacement scrambled centred content (ASCII art mangled
    // beyond recognition). Curved corners + a strong vignette sell
    // the bowed look on their own without distorting pixels.
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.width = `${wPx}px`;
    wrapper.style.height = `${hPx}px`;
    wrapper.style.overflow = 'hidden';
    wrapper.style.background = '#000';
    wrapper.style.borderRadius = '52px';
    wrapper.style.filter = 'contrast(1.05) saturate(0.78) brightness(0.95) hue-rotate(-6deg)';
    wrapper.appendChild(iframe);
    // 2px-tall horizontal scanlines, multiplied for a subtle dimming
    // that doesn't crush the underlying readability.
    const scanlines = document.createElement('div');
    scanlines.style.position = 'absolute';
    scanlines.style.inset = '0';
    scanlines.style.pointerEvents = 'none';
    scanlines.style.background = 'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, rgba(255,255,255,0.02) 1px, rgba(255,255,255,0.02) 3px)';
    scanlines.style.mixBlendMode = 'multiply';
    scanlines.style.zIndex = '2';
    wrapper.appendChild(scanlines);
    // Radial vignette darkens the corners — fakes the curvature
    // falloff a real CRT had at its edges.
    const vignette = document.createElement('div');
    vignette.style.position = 'absolute';
    vignette.style.inset = '0';
    vignette.style.pointerEvents = 'none';
    vignette.style.background = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.85) 100%)';
    vignette.style.zIndex = '3';
    wrapper.appendChild(vignette);
    // Faint amber phosphor glow tint so even bright-white pages get a
    // warm cast — keep it subtle (low-alpha overlay).
    const phosphor = document.createElement('div');
    phosphor.style.position = 'absolute';
    phosphor.style.inset = '0';
    phosphor.style.pointerEvents = 'none';
    phosphor.style.background = 'rgba(255, 200, 130, 0.06)';
    phosphor.style.mixBlendMode = 'overlay';
    phosphor.style.zIndex = '4';
    wrapper.appendChild(phosphor);
    mountElement = wrapper;
  }

  const css = new CSS3DObject(mountElement);
  // Push the iframe forward to the slab's front face so it pops out
  // in front of any chassis interior geometry behind it.
  const halfDepth = lsize.getComponent(depthAxis) / 2;
  css.position.copy(lcenter).addScaledVector(ez, halfDepth);
  css.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, ez));
  // 1 world-unit = `density` CSS pixels.
  css.scale.setScalar(1 / density);
  mesh.add(css);
  return { css, iframe };
}

/** Punch a transparent (alpha=0) hole through the WebGL canvas in the
 *  shape of this mesh — pairs with a CSS3D iframe behind the canvas
 *  to expose it through the chassis. The mesh renders LAST (positive
 *  renderOrder + transparent) with `NoBlending` so its (rgba=0) frag
 *  overwrites whatever the chassis painted in that region. */
export function makeMeshAlphaHole(mesh: THREE.Mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    m.transparent = true;
    m.opacity = 0;
    m.depthWrite = false;
    m.blending = THREE.NoBlending;
  }
  mesh.renderOrder = 1;
}
