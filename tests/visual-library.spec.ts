import { test, Page } from '@playwright/test';

// Library-based visual probe — orbit camera sits close to each car on the
// platform, so screenshots actually show the body and wheels. We capture:
//   - idle:     stationary car
//   - rolling:  W held, wheels mid-spin
//   - steering: D held, front wheels yawed
// Saved to test-results/library-shots/<car>-<state>.png.

const CARS = [
  'docLorean (Flying)',
  'Beatall',
  'Landyroamer',
  'Toyoyo Highlight',
  'Tristar Racer',
];

async function gotoLibraryAndPick(page: Page, name: string) {
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.evaluate((target) => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === target);
    if (idx < 0) throw new Error(`asset not found: ${target}`);
    return lib.showAsset(idx);
  }, name);
  await page.waitForFunction((target) => {
    const lib = (window as any).__lib;
    return lib.activeAsset && lib.assets[lib.activeIndex]?.name === target;
  }, name, { timeout: 15_000 });
  // Give the platform/orbit camera time to settle and a couple of frames
  // for materials to fully bake.
  await page.waitForTimeout(400);
}

for (const name of CARS) {
  test(`library visual: ${name}`, async ({ page }) => {
    const slug = name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoLibraryAndPick(page, name);

    await page.screenshot({ path: `test-results/library-shots/${slug}-idle.png` });

    await page.evaluate(() => (window as any).__lib.pressKey('w'));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/library-shots/${slug}-rolling.png` });
    await page.evaluate(() => (window as any).__lib.releaseKey('w'));

    await page.evaluate(() => (window as any).__lib.pressKey('d'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/library-shots/${slug}-steer-d.png` });
    await page.evaluate(() => (window as any).__lib.releaseKey('d'));

    await page.evaluate(() => (window as any).__lib.pressKey('a'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/library-shots/${slug}-steer-a.png` });
    await page.evaluate(() => (window as any).__lib.releaseKey('a'));
  });
}
