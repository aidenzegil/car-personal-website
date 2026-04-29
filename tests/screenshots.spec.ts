import { test, Page } from '@playwright/test';

// One-off visual check: load each car, hold W for a moment so wheels are in
// motion, screenshot. These are not assertions — they save to
// test-results/screenshots/ for human inspection.

const CARS = [
  { id: 'docLorean',   label: 'docLorean' },
  { id: 'Beatall',     label: 'Beatall' },
  { id: 'Landyroamer', label: 'Landyroamer' },
  { id: 'Toyoyo',      label: 'Toyoyo' },
  { id: 'Tristar',     label: 'Tristar' },
];

async function gotoHome(page: Page, carId: string) {
  await page.goto(`/index.html#car=${encodeURIComponent(carId)}`);
  await page.waitForFunction(() => (window as any).__home?.loaded === true, { timeout: 15_000 });
}

for (const car of CARS) {
  test(`visual: ${car.label} idle and rolling`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoHome(page, car.id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screenshots/${car.label}-idle.png` });

    await page.keyboard.down('w');
    await page.waitForTimeout(900);
    await page.screenshot({ path: `test-results/screenshots/${car.label}-driving.png` });

    await page.keyboard.down('a');
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/screenshots/${car.label}-steering.png` });
    await page.keyboard.up('a');
    await page.keyboard.up('w');
  });
}
