import { test, expect, Page } from '@playwright/test';

// Library showcase tests — verify each car loads, wheels exist for ground
// cars, idle roll happens on its own, and WASD moves wheels in the expected
// direction (W = forward, A = steer left, D = steer right).
//
// We assert on quaternion/rotation state read out of `window.__lib` rather
// than on rendered pixels — that's stable across GPU drivers and tells us
// directly whether wheels rotated in the correct direction relative to the
// FBX axle frame.

const GROUND_CARS = ['Beatall', 'Landyroamer', 'Toyoyo Highlight', 'Tristar Racer'];
const ALL_CARS = ['docLorean (Flying)', ...GROUND_CARS];

async function gotoLibrary(page: Page) {
  await page.goto('/library.html');
  // Wait for the lib hooks to attach.
  await page.waitForFunction(() => (window as any).__lib !== undefined);
}

async function selectCarByName(page: Page, name: string) {
  await page.evaluate((targetName) => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === targetName);
    if (idx < 0) throw new Error(`asset not found: ${targetName}`);
    return lib.showAsset(idx);
  }, name);
  // Wait until the asset is actually mounted (FBX load is async).
  await page.waitForFunction((targetName) => {
    const lib = (window as any).__lib;
    return lib.activeAsset && lib.assets[lib.activeIndex]?.name === targetName;
  }, name, { timeout: 15_000 });
}

interface WheelSnapshot {
  name: string;
  axle: 'front' | 'rear';
  side: 'left' | 'right';
  quat: [number, number, number, number];
}

async function readWheelState(page: Page): Promise<{
  rollAngle: number;
  steerAngle: number;
  wheels: WheelSnapshot[];
} | null> {
  return page.evaluate(() => {
    const lib = (window as any).__lib;
    const ws = lib.wheelState;
    if (!ws) return null;
    return {
      rollAngle: ws.rollAngle,
      steerAngle: ws.steerAngle,
      wheels: ws.wheels.map((w: any) => ({
        name: w.obj.name,
        axle: w.axle,
        side: w.side,
        quat: [w.obj.quaternion.x, w.obj.quaternion.y, w.obj.quaternion.z, w.obj.quaternion.w],
      })),
    };
  });
}

test.describe('library', () => {
  test.beforeEach(async ({ page }) => {
    await gotoLibrary(page);
  });

  test('every car appears in the sidebar', async ({ page }) => {
    const names = await page.evaluate(() => (window as any).__lib.assets.map((a: { name: string }) => a.name));
    for (const car of ALL_CARS) {
      expect(names).toContain(car);
    }
  });

  test('each ground car finds 4 classified wheels', async ({ page }) => {
    for (const name of GROUND_CARS) {
      await selectCarByName(page, name);
      const ws = await readWheelState(page);
      expect(ws, `expected wheel state for ${name}`).not.toBeNull();
      expect(ws!.wheels.length, `wheel count for ${name}`).toBe(4);
      // All four positions must be represented exactly once.
      const positions = new Set(ws!.wheels.map((w) => `${w.axle}-${w.side}`));
      expect(positions, `unique wheel positions for ${name}`).toEqual(
        new Set(['front-left', 'front-right', 'rear-left', 'rear-right']),
      );
    }
  });

  test('idle roll advances the roll angle for ground cars', async ({ page }) => {
    await selectCarByName(page, 'Beatall');
    const before = (await readWheelState(page))!;
    await page.waitForTimeout(400);
    const after = (await readWheelState(page))!;
    expect(after.rollAngle).not.toBe(before.rollAngle);
  });

  test('docLorean is not classified as a wheeled car (hover mode)', async ({ page }) => {
    await selectCarByName(page, 'docLorean (Flying)');
    const ws = await readWheelState(page);
    expect(ws).toBeNull();
  });
});

test.describe('library wheel-roll direction', () => {
  test.beforeEach(async ({ page }) => {
    await gotoLibrary(page);
  });

  // For every ground car, holding W must drive the roll angle in the same
  // sign direction (negative — top of wheel forward in this FBX axle frame).
  // Holding S must reverse that sign.
  for (const car of GROUND_CARS) {
    test(`${car}: W rolls forward, S rolls backward`, async ({ page }) => {
      await selectCarByName(page, car);

      // W should make rollAngle decrease (more negative) — that's "forward" in
      // this axle frame. S should make it increase.
      const baseline = (await readWheelState(page))!.rollAngle;
      await page.evaluate(() => (window as any).__lib.clearKeys());

      // Press and hold W via the test hook, sample after a brief tick.
      await page.evaluate(() => (window as any).__lib.pressKey('w'));
      await page.waitForTimeout(250);
      const afterW = (await readWheelState(page))!.rollAngle;
      await page.evaluate(() => (window as any).__lib.releaseKey('w'));

      // Then S — must move the angle in the opposite direction relative to
      // the W-state rather than just "back to baseline" (idle roll keeps
      // ticking too, so we compare deltas, not absolutes).
      const beforeS = (await readWheelState(page))!.rollAngle;
      await page.evaluate(() => (window as any).__lib.pressKey('s'));
      await page.waitForTimeout(250);
      const afterS = (await readWheelState(page))!.rollAngle;
      await page.evaluate(() => (window as any).__lib.releaseKey('s'));

      const wDelta = afterW - baseline;
      const sDelta = afterS - beforeS;
      // Forward rolling now uses positive omega — each wheel's rollAxis is
      // pre-signed so positive accumulator means top-forward regardless of
      // FBX orientation. S reverses, so its delta must be opposite.
      expect(wDelta, 'W must roll forward (positive accumulator)').toBeGreaterThan(0);
      expect(sDelta, 'S must roll backward (negative accumulator)').toBeLessThan(0);
    });
  }
});

test.describe('library steer direction', () => {
  test.beforeEach(async ({ page }) => {
    await gotoLibrary(page);
  });

  for (const car of GROUND_CARS) {
    test(`${car}: A and D steer the front wheels in opposite directions`, async ({ page }) => {
      await selectCarByName(page, car);
      await page.evaluate(() => (window as any).__lib.clearKeys());

      // A first.
      await page.evaluate(() => (window as any).__lib.pressKey('a'));
      await page.waitForTimeout(120);
      const stateA = (await readWheelState(page))!;
      await page.evaluate(() => (window as any).__lib.releaseKey('a'));

      // D next.
      await page.evaluate(() => (window as any).__lib.pressKey('d'));
      await page.waitForTimeout(120);
      const stateD = (await readWheelState(page))!;
      await page.evaluate(() => (window as any).__lib.releaseKey('d'));

      // The library applies the steer angle directly via tickCarWheels —
      // its sign must flip between A and D regardless of which absolute
      // direction the wheel ends up pointing in world space.
      expect(stateA.steerAngle, 'A produces nonzero steer').not.toBe(0);
      expect(stateD.steerAngle, 'D produces nonzero steer').not.toBe(0);
      expect(Math.sign(stateA.steerAngle)).toBe(-Math.sign(stateD.steerAngle));

      // Sanity: only front wheels actually visibly diverge from rear under
      // steer. Compare quaternion components: front pair should differ from
      // rear pair when steered.
      const frontQuatY = stateD.wheels.find((w) => w.axle === 'front')!.quat[1];
      const rearQuatY = stateD.wheels.find((w) => w.axle === 'rear')!.quat[1];
      expect(Math.abs(frontQuatY - rearQuatY)).toBeGreaterThan(0.01);
    });
  }
});
