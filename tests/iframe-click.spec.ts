import { test } from '@playwright/test';

test('iframe receives click events', async ({ page }) => {
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[browser pageerror]', err.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('editor-placements', JSON.stringify([
      { assetId: 'IBM_3178_Monitor', x: 0, z: -3, scale: 1, rotY: 0 },
    ]));
  });
  await page.goto('/#car=Corgi');
  await page.waitForFunction(() => (window as any).__home?.loaded === true, undefined, { timeout: 15_000 });
  // Wait until proximity engages (corgi spawn is in radius of the
  // placed monitor) — `__home.loaded` flips early but userPlaced
  // isn't necessarily ready yet, and the intro animation has to
  // clear before tickMonitorFocus starts checking.
  await page.waitForFunction(() => !!(window as any).__monitorFocus, undefined, { timeout: 10_000 });
  // Then let the in-phase lerp finish.
  await page.waitForFunction(() => (window as any).__monitorFocus?.phase === 'active', undefined, { timeout: 5_000 });
  // Inspect what's at the iframe's center.
  const probe = await page.evaluate(() => {
    const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
    const focus = (window as any).__monitorFocus;
    const home = (window as any).__home;
    return {
      iframe: !!ifr,
      iframePtrEvents: ifr?.style.pointerEvents,
      monitorFocusPhase: focus?.phase,
      homeLoaded: home?.loaded,
      activeCarId: home?.car?.id,
      mode: home?.car?.mode,
    };
  });
  console.log('CLICK PROBE:', JSON.stringify(probe, null, 2));
  // Now check what's at the iframe's center.
  const target = await page.evaluate(() => {
    const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
    if (!ifr) return { error: 'no iframe' };
    const r = ifr.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return {
      iframeRect: { x: r.x, y: r.y, w: r.width, h: r.height },
      topAtIframeCenter: top?.tagName,
      topId: (top as HTMLElement | null)?.id,
      topClass: (top as HTMLElement | null)?.className?.toString?.() ?? '',
      canvasPtrEvents: (document.querySelector('canvas') as HTMLElement | null)?.style.pointerEvents,
    };
  });
  console.log('CLICK TARGET:', JSON.stringify(target, null, 2));
  // Try to interact with Google's search box via the cross-origin
  // iframe. If this works, clicks/keystrokes are reaching the
  // iframe content correctly.
  const frame = page.frameLocator('iframe').first();
  try {
    await frame.locator('textarea[name="q"], input[name="q"]').first().click({ timeout: 3000 });
    await frame.locator('textarea[name="q"], input[name="q"]').first().fill('hello world');
    console.log('IFRAME INTERACT: succeeded');
  } catch (e) {
    console.log('IFRAME INTERACT: failed', (e as Error).message.slice(0, 200));
  }
  await page.screenshot({ path: 'test-results/iframe-click-after.png' });
});
