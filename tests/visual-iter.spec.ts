import { test, expect } from '@playwright/test';

test('iter: world editor place tree + persist + appears on home', async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/editor.html');
  await page.waitForSelector('.lib-row');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/iter/editor-empty.png' });

  // Click a tree row to start placement.
  await page.getByText('Tree, Spruce A', { exact: true }).click();
  // Move the cursor over the canvas + commit.
  const canvas = page.locator('#editor-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/iter/editor-placing-tree.png' });
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/iter/editor-tree-placed.png' });

  // Confirm persistence.
  const stored = await page.evaluate(() => localStorage.getItem('editor-placements'));
  expect(stored).toBeTruthy();

  // Now load the home page in the same context — the placement should appear.
  const home = await context.newPage();
  await home.setViewportSize({ width: 1280, height: 720 });
  await home.goto('/');
  await home.waitForFunction(() => (window as any).__home?.loaded === true, { timeout: 15_000 });
  await home.waitForTimeout(4500);
  await home.screenshot({ path: 'test-results/iter/home-with-edit.png' });
});
