import { test } from '@playwright/test';

test('iter: editor roads', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('editor-placements');
    localStorage.removeItem('editor-tombstones');
  });
  await page.goto('/editor.html');
  await page.waitForSelector('.lib-row');
  await page.waitForTimeout(2500);

  const canvas = page.locator('#editor-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  // Place a few road pieces in a row to verify chunk-lock alignment.
  // Click the road row in the sidebar then click on the canvas to drop.
  async function place(label: string, dx: number, dz: number) {
    await page.locator('#sidebar').getByText(label, { exact: true }).click();
    await page.mouse.move(box.x + box.width * 0.5 + dx, box.y + box.height * 0.5 + dz);
    await page.waitForTimeout(150);
    await page.mouse.click(box.x + box.width * 0.5 + dx, box.y + box.height * 0.5 + dz);
    await page.waitForTimeout(300);
  }
  await place('Road, Straight', 0, 0);
  await place('Road, Straight', 0, 80);
  await place('Road, T-junction', 0, 160);
  await place('Road, 4-way', 80, 0);
  await place('Road, Curve', 80, 80);
  // Crop tight on the road cluster area for a legible screenshot.
  await page.screenshot({
    path: 'test-results/iter/editor-roads.png',
    clip: { x: 280, y: 120, width: 720, height: 540 },
  });
});
