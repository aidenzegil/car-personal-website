import { test, expect, Page } from '@playwright/test';

// Homepage drive-mode tests — verify each wheeled car loads via the
// `#car=<id>` picker, the rig actually moves under W, the wheels roll while
// it moves, and the docLorean stays the floating-mode default. Reads scene
// state through `window.__home`, the test bridge populated by main.ts.

const DRIVE_CARS = ['Beatall', 'Landyroamer', 'Toyoyo', 'Tristar'];

async function gotoHome(page: Page, carId?: string) {
  const url = carId ? `/index.html#car=${encodeURIComponent(carId)}` : '/index.html';
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__home?.loaded === true, { timeout: 15_000 });
}

interface HomeState {
  carId: string;
  mode: 'fly' | 'drive';
  position: { x: number; y: number; z: number };
  speed: number;
  hasWheelState: boolean;
  rollAngle: number | null;
}

async function readHomeState(page: Page): Promise<HomeState> {
  return page.evaluate(() => {
    const h = (window as any).__home;
    const pos = h.carRig.position;
    return {
      carId: h.car.id,
      mode: h.car.mode,
      position: { x: pos.x, y: pos.y, z: pos.z },
      speed: h.flightControls.forwardSpeed(),
      hasWheelState: !!h.wheelState,
      rollAngle: h.wheelState ? h.wheelState.rollAngle : null,
    };
  });
}

test.describe('homepage car picker', () => {
  test('default URL boots the docLorean in fly mode and hovers above ground', async ({ page }) => {
    await gotoHome(page);
    const s = await readHomeState(page);
    expect(s.carId).toBe('docLorean');
    expect(s.mode).toBe('fly');
    expect(s.hasWheelState).toBe(false);
    // attachHover lifts the rig — y should be well above 0.
    expect(s.position.y).toBeGreaterThan(0.3);
  });

  for (const carId of DRIVE_CARS) {
    test(`#car=${carId} loads in drive mode and rests on the ground`, async ({ page }) => {
      await gotoHome(page, carId);
      const s = await readHomeState(page);
      expect(s.carId).toBe(carId);
      expect(s.mode).toBe('drive');
      expect(s.hasWheelState).toBe(true);
      // Drive mode plants carRig at y=0 (offset baked into the FBX root, not
      // the rig). Hover would push y > 0.3.
      expect(Math.abs(s.position.y)).toBeLessThan(0.05);
    });
  }
});

test.describe('homepage drive controls', () => {
  for (const carId of DRIVE_CARS) {
    test(`${carId}: W accelerates and rolls the wheels forward`, async ({ page }) => {
      await gotoHome(page, carId);
      const before = await readHomeState(page);

      // Press W via real keyboard events so flight-controls' window listener
      // fires. The test rig only intercepts library keys; main.ts uses its
      // own listener.
      await page.keyboard.down('w');
      await page.waitForTimeout(700);
      const moving = await readHomeState(page);
      await page.keyboard.up('w');

      expect(moving.speed, 'forwardSpeed should ramp up under W').toBeGreaterThan(0.5);
      // The car translates along its forward axis (which is local -Z at yaw 0
      // because main.ts initializes flight-controls without a yaw offset).
      expect(moving.position.z, 'car should move in -Z').toBeLessThan(before.position.z - 0.2);
      // Rolling: any car that's actually moving should have advanced its
      // accumulated wheel-roll angle in the positive direction (positive
      // omega rolls top-forward thanks to per-wheel signed rollAxis).
      expect(moving.rollAngle, 'wheels rolled forward').toBeGreaterThan(before.rollAngle ?? 0);
    });

    test(`${carId}: A vs D yaw the rig in opposite directions while moving`, async ({ page }) => {
      await gotoHome(page, carId);
      // Build up speed first — at zero speed, flight-controls clamps yawRate
      // to 0 (it's proportional to speed). Hold W briefly then layer A/D.
      await page.keyboard.down('w');
      await page.waitForTimeout(500);
      const yawBefore = await page.evaluate(() => (window as any).__home.carRig.rotation.y);

      await page.keyboard.down('a');
      await page.waitForTimeout(400);
      await page.keyboard.up('a');
      const yawAfterA = await page.evaluate(() => (window as any).__home.carRig.rotation.y);

      await page.keyboard.down('d');
      await page.waitForTimeout(800);
      await page.keyboard.up('d');
      await page.keyboard.up('w');
      const yawAfterD = await page.evaluate(() => (window as any).__home.carRig.rotation.y);

      // A should swing yaw one direction, D the other. Use deltas relative to
      // the per-segment start yaw, not absolute, so the test is robust to
      // small drift while accelerating.
      const deltaA = yawAfterA - yawBefore;
      const deltaD = yawAfterD - yawAfterA;
      expect(Math.abs(deltaA), 'A produces measurable yaw').toBeGreaterThan(0.05);
      expect(Math.abs(deltaD), 'D produces measurable yaw').toBeGreaterThan(0.05);
      expect(Math.sign(deltaA)).toBe(-Math.sign(deltaD));
    });
  }
});
