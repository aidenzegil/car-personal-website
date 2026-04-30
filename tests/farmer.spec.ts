import { test, expect, Page } from '@playwright/test';

// Farmer character + animation showcase tests.
//
// The farmer asset uses the same `buildAnimatedFbx` flow as the corgi:
// one sidebar entry, a chip picker for clips, clips load lazily on swap.
// We verify two things:
// 1. The farmer mesh is textured (the FBX ships referencing a path that
//    doesn't survive web export, so a regression in the recolor step
//    would leave it as a flat black silhouette).
// 2. Each animation clip actually advances mixer.time + bone
//    quaternions when ticked, proving the mixer→skeleton wiring works.

async function gotoLibrary(page: Page) {
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
}

async function selectFarmer(page: Page) {
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === 'Farmer');
    if (idx < 0) throw new Error('Farmer entry not found in asset list');
    return lib.showAsset(idx);
  });
  await page.waitForFunction(() => {
    const lib = (window as any).__lib;
    return lib.activeAsset && lib.assets[lib.activeIndex]?.name === 'Farmer';
  }, undefined, { timeout: 20_000 });
}

async function playClip(page: Page, clipId: string) {
  await page.evaluate(async (id) => {
    const obj = (window as any).__lib.activeAsset;
    const state = obj?.userData?.animatedFbx;
    if (!state) throw new Error('farmer has no animatedFbx state');
    await state.play(id);
  }, clipId);
}

interface FarmerProbe {
  hasMixer: boolean;
  mixerTime: number;
  clipsPlaying: number;
  texturedMeshes: number;
  totalMeshes: number;
  // Concatenated [x,y,z,w] of every bone's local quaternion. The mixer
  // mutates these each tick, so an active clip moves at least one entry
  // between two snapshots.
  boneQuats: number[];
  boneCount: number;
  currentClipId: string | null;
}

async function probeFarmer(page: Page): Promise<FarmerProbe> {
  return page.evaluate(() => {
    const obj = (window as any).__lib.activeAsset;
    if (!obj) return { hasMixer: false, mixerTime: 0, clipsPlaying: 0, texturedMeshes: 0, totalMeshes: 0, boneQuats: [], boneCount: 0, currentClipId: null };
    let textured = 0, total = 0;
    const quats: number[] = [];
    let boneCount = 0;
    obj.traverse((node: any) => {
      if (node.isMesh || node.isSkinnedMesh) {
        total++;
        const mat = Array.isArray(node.material) ? node.material[0] : node.material;
        if (mat && mat.map) textured++;
      }
      if (node.isBone) {
        boneCount++;
        const q = node.quaternion;
        quats.push(q.x, q.y, q.z, q.w);
      }
    });
    const mixer = obj.userData.mixer;
    let clipsPlaying = 0;
    if (mixer) {
      // Internal three.js field — _actions is the live action list.
      const actions = mixer._actions || [];
      clipsPlaying = actions.filter((a: any) => a.isRunning && a.isRunning()).length;
    }
    return {
      hasMixer: !!mixer,
      mixerTime: mixer ? mixer.time : 0,
      clipsPlaying,
      texturedMeshes: textured,
      totalMeshes: total,
      boneQuats: quats,
      boneCount,
      currentClipId: obj.userData?.animatedFbx?.currentId ?? null,
    };
  });
}

test.describe('farmer character', () => {
  test.beforeEach(async ({ page }) => {
    await gotoLibrary(page);
    await selectFarmer(page);
    // The default clip ('idle') is loaded asynchronously after build()
    // resolves. Wait for it to actually start before any per-clip check.
    await page.waitForFunction(() => {
      const obj = (window as any).__lib.activeAsset;
      return obj?.userData?.animatedFbx?.currentId === 'idle';
    }, undefined, { timeout: 15_000 });
  });

  test('farmer mesh is textured + has bones + default idle is playing', async ({ page }) => {
    const probe = await probeFarmer(page);
    expect(probe.totalMeshes, 'farmer has at least one mesh').toBeGreaterThan(0);
    expect(probe.texturedMeshes, 'every farmer mesh has a texture map').toBe(probe.totalMeshes);
    expect(probe.boneCount, 'farmer has bones').toBeGreaterThan(0);
    expect(probe.hasMixer, 'farmer has a mixer').toBe(true);
    expect(probe.currentClipId, 'default clip is idle').toBe('idle');
    expect(probe.clipsPlaying, 'idle is running').toBeGreaterThan(0);
  });

  // Sample a few representative clips rather than all 15 — keeps the suite
  // fast while still catching regressions in the load/mixer wiring.
  for (const clipId of ['idle', 'walk', 'run', 'attack_a']) {
    test(`${clipId} clip advances mixer.time + bone transforms`, async ({ page }) => {
      await playClip(page, clipId);
      const before = await probeFarmer(page);
      expect(before.currentClipId, `current clip is ${clipId}`).toBe(clipId);
      expect(before.clipsPlaying, `${clipId} has at least one running action`).toBeGreaterThan(0);

      // Let the rAF loop tick the mixer for a beat.
      await page.waitForTimeout(600);
      const after = await probeFarmer(page);

      expect(after.mixerTime, `${clipId} mixer.time advanced`).toBeGreaterThan(before.mixerTime);
      const changed = before.boneQuats.some((v, i) => Math.abs(v - after.boneQuats[i]) > 1e-5);
      expect(changed, `${clipId} bone quaternion changed across ticks`).toBe(true);
    });
  }
});
