import { test } from '@playwright/test';

test('home loads with no placements', async ({ page }) => {
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[browser pageerror]', err.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('editor-placements'));
  await page.goto('/');
  await page.waitForTimeout(2500);
  const probe = await page.evaluate(() => ({
    homeLoaded: (window as any).__home?.loaded,
    iframes: document.querySelectorAll('iframe').length,
    libLink: !!document.querySelector('a[href="/library.html"]'),
    edLink: !!document.querySelector('a[href="/editor.html"]'),
  }));
  console.log('PROBE:', JSON.stringify(probe));
  await page.screenshot({ path: 'test-results/home-default.png' });
});
