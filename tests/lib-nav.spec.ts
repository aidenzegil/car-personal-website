import { test } from '@playwright/test';

test('library home link is clickable', async ({ page }) => {
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.waitForTimeout(800);
  // Element at the home link's center.
  const probe = await page.evaluate(() => {
    const a = document.querySelector('#title-bar a[href="/"]') as HTMLAnchorElement | null;
    if (!a) return { error: 'no link' };
    const r = a.getBoundingClientRect();
    return { rect: r, top: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.tagName, topClass: (document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) as HTMLElement | null)?.className };
  });
  console.log('HOME LINK PROBE:', JSON.stringify(probe));
});

test('library home link clickable on IBM monitor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === 'IBM 3178 Monitor (HTML)');
    return lib.showAsset(idx);
  });
  await page.waitForTimeout(800);
  const probe = await page.evaluate(() => {
    const a = document.querySelector('#title-bar a[href="/"]') as HTMLAnchorElement | null;
    if (!a) return { error: 'no link' };
    const r = a.getBoundingClientRect();
    return { rect: r, top: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.tagName };
  });
  console.log('HOME LINK PROBE (IBM):', JSON.stringify(probe));
});

test('switching away from IBM monitor disposes the iframe', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === 'IBM 3178 Monitor (HTML)');
    return lib.showAsset(idx);
  });
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => document.querySelectorAll('iframe').length);
  // Switch to a non-monitor asset.
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === 'Plane');
    return lib.showAsset(idx);
  });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelectorAll('iframe').length);
  console.log('IFRAME COUNT:', { before, after });
  if (before === 0) throw new Error('expected an iframe before swap');
  if (after !== 0) throw new Error('iframe persisted after swap');
});
