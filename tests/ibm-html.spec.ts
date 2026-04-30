import { test, expect, Page } from '@playwright/test';

// Smoke tests for the HTML-on-mesh CSS3D layer. We assert that an
// iframe ends up in the DOM and is positioned at the IBM 3178's
// screen face — and dump screenshots for visual verification of the
// alpha-hole compositing.

async function loadAsset(page: Page, name: string) {
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.evaluate((n) => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === n);
    if (idx < 0) throw new Error(`asset not found: ${n}`);
    return lib.showAsset(idx);
  }, name);
  await page.waitForFunction((n) => {
    const lib = (window as any).__lib;
    return lib.activeAsset && lib.assets[lib.activeIndex]?.name === n;
  }, name, { timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function shotStage(page: Page, file: string) {
  const stage = await page.evaluate(() => {
    const wrap = document.querySelector('canvas')!.parentElement!;
    const r = wrap.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: file, clip: stage });
}

test('display html: iframe mounts on screen face', async ({ page }) => {
  await loadAsset(page, 'IBM 3178 Display (HTML)');
  const present = await page.evaluate(() => {
    const lib = (window as any).__lib;
    let css: any = null;
    lib.activeAsset.traverse((n: any) => { if (n.isCSS3DObject) css = n; });
    return {
      hasIframe: !!document.querySelector('iframe'),
      hasCss: !!css,
      contentText: (document.querySelector('iframe') as HTMLIFrameElement | null)?.contentDocument?.body?.innerText,
    };
  });
  expect(present.hasIframe).toBe(true);
  expect(present.hasCss).toBe(true);
  expect(present.contentText).toContain('SHALL WE PLAY A GAME');
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    lib.controls.target.set(0, 1, 0);
    lib.camera.position.set(0, 1, 4);
    lib.camera.lookAt(0, 1, 0);
    lib.controls.update?.();
  });
  await page.waitForTimeout(300);
  await shotStage(page, 'test-results/ibm-html-display.png');
});

test('monitor html: iframe shows through chassis screen', async ({ page }) => {
  await loadAsset(page, 'IBM 3178 Monitor (HTML)');
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    lib.controls.target.set(0, 1, 0);
    lib.camera.position.set(0.5, 1.2, 3.5);
    lib.camera.lookAt(0, 1, 0);
    lib.controls.update?.();
  });
  await page.waitForTimeout(400);
  await shotStage(page, 'test-results/ibm-monitor-html-front.png');
});

test('monitor html: iframe stays aligned at angle', async ({ page }) => {
  await loadAsset(page, 'IBM 3178 Monitor (HTML)');
  await page.evaluate(() => {
    const lib = (window as any).__lib;
    lib.controls.target.set(0, 1, 0);
    lib.camera.position.set(2.5, 1.6, 3.0);
    lib.camera.lookAt(0, 1, 0);
    lib.controls.update?.();
  });
  await page.waitForTimeout(400);
  await shotStage(page, 'test-results/ibm-monitor-html-angle.png');
});
