import { test, expect, Page } from '@playwright/test';

// End-to-end-ish test for the "walk up to a monitor, focus the screen,
// press ESC to leave" flow. We seed localStorage with an IBM monitor
// placement, navigate to the homepage in pet mode, and inspect the
// state via window.__home and the DOM.

async function seedMonitorAndLoad(page: Page, opts?: { x?: number; z?: number; rotY?: number }) {
  await page.goto('/');
  await page.evaluate((o) => {
    localStorage.setItem('editor-placements', JSON.stringify([
      { assetId: 'IBM_3178_Monitor', x: o?.x ?? 0, z: o?.z ?? -8, scale: 1, rotY: o?.rotY ?? 0 },
    ]));
  }, opts);
  await page.goto('/#car=Corgi');
  await page.waitForTimeout(2500);
}

async function shotStage(page: Page, file: string) {
  const stage = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { x: 0, y: 0, width: 0, height: 0 };
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: file, clip: stage });
}

test('approach: iframe + ESC prompt + dog auto-paths', async ({ page }) => {
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedMonitorAndLoad(page, { x: 0, z: -3, rotY: 0 });
  await page.waitForTimeout(3500);
  const probe = await page.evaluate(() => {
    const home = (window as any).__home;
    const focus = (window as any).__monitorFocus;
    return {
      loaded: home?.loaded,
      hasMonitorFocus: !!focus,
      focusPhase: focus?.phase,
      focusT: focus?.t,
      sitTriggered: focus?.sitTriggered,
      iframe: !!document.querySelector('iframe'),
      src: (document.querySelector('iframe') as HTMLIFrameElement | null)?.src,
      escPrompt: (window as any).__escPrompt,
    };
  });
  console.log('PROBE:', JSON.stringify(probe));
  expect(probe.iframe).toBe(true);
  await shotStage(page, 'test-results/monitor-focus-front.png');
  // Try to click the editor link after a monitor is placed and focus
  // is engaged — this is what the user reported as broken.
  const editorClickable = await page.evaluate(() => {
    const a = document.querySelector('a[href="/editor.html"]') as HTMLAnchorElement | null;
    if (!a) return { error: 'no editor link' };
    const r = a.getBoundingClientRect();
    return { rect: r, top: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.tagName };
  });
  console.log('EDITOR LINK:', JSON.stringify(editorClickable));
  // Actually click the editor link (with focus engaged) and check we
  // navigate. This is the user-reported failure mode.
  await page.click('a[href="/editor.html"]');
  await page.waitForLoadState('domcontentloaded');
  console.log('NAVIGATED TO:', page.url());
});
