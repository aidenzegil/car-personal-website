import { test } from '@playwright/test';

test('iter: home corgi 8-dir', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/index.html#car=Corgi');
  await page.waitForFunction(() => (window as any).__home?.loaded === true, { timeout: 15_000 });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: 'test-results/iter/corgi-home-idle.png' });
  // Run W
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/iter/corgi-home-W.png' });
  await page.keyboard.up('w');
  // Run S
  await page.keyboard.down('s');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/iter/corgi-home-S.png' });
  await page.keyboard.up('s');
});
