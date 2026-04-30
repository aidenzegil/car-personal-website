import { test } from '@playwright/test';

test('iter: library IBM 3178', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/library.html');
  await page.waitForSelector('.lib-row');
  await page.getByText('IBM 3178 Terminal', { exact: true }).first().click();
  await page.waitForTimeout(2200);
  await page.screenshot({ path: 'test-results/iter/ibm-3178.png' });
});
