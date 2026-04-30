import { test } from '@playwright/test';

// Full-viewport screenshots of the terminal at each section so we can
// eyeball font size, padding, and overflow on the actual monitor face.

test.describe.configure({ mode: 'serial' });

const SECTIONS = ['1', '2', '3', '4', '5', '6'];
const NAMES = ['about', 'work', 'projects', 'writing', 'milestones', 'contact'];

for (let i = 0; i < SECTIONS.length; i++) {
  test(`terminal section: ${NAMES[i]}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('editor-placements', JSON.stringify([
        { assetId: 'IBM_3178_Monitor', x: 0, z: -3, scale: 1, rotY: 0 },
      ]));
    });
    await page.goto('/#car=Corgi');
    await page.waitForFunction(() => (window as any).__home?.loaded === true, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (window as any).__monitorFocus?.phase === 'active', undefined, { timeout: 15_000 });
    // Switch to the requested section via keypress.
    const probe = await page.evaluate(() => {
      const focus = (window as any).__monitorFocus;
      const mat = focus?.monitor?.displayMesh?.material;
      return {
        phase: focus?.phase,
        hasActive: !!focus?.monitor?.active,
        materialOpacity: mat?.opacity,
        materialTransparent: mat?.transparent,
        materialBlending: mat?.blending,
        materialName: mat?.name,
        iframeInDom: !!document.querySelector('iframe'),
      };
    });
    console.log('TERMINAL PROBE:', JSON.stringify(probe));
    const ifrPeek = await page.evaluate(() => {
      const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
      if (!ifr) return null;
      return {
        srcdocHead: ifr.srcdoc.slice(0, 400),
        innerTextSample: ifr.contentDocument?.body?.innerText?.slice(0, 200),
      };
    });
    console.log('IFRAME CONTENT:', JSON.stringify(ifrPeek));
    await page.evaluate((key) => {
      const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
      if (!ifr?.contentDocument) return;
      ifr.contentDocument.dispatchEvent(new KeyboardEvent('keydown', { key }));
    }, SECTIONS[i]);
    await page.waitForTimeout(400);
    // Crop to the iframe's screen rect so we can inspect text rendering.
    const rect = await page.evaluate(() => {
      const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
      const r = ifr?.getBoundingClientRect();
      if (!r) return null;
      // Tight crop on the iframe with minimal pad so text is readable.
      return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
    });
    await page.screenshot({
      path: `test-results/terminal-${NAMES[i]}.png`,
      ...(rect ? { clip: rect } : {}),
    });
  });
}
