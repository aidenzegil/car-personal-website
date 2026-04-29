import { defineConfig, devices } from '@playwright/test';

// Single-project config: chromium-only headless (we have headed available too,
// but CI-friendly is the default). The dev server is auto-spawned via Vite —
// `reuseExistingServer` lets a developer keep `npm run dev` open in another
// terminal and have tests target it without contention.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false, // tests share a single Vite server, easier to read logs
  use: {
    // Use 5174 instead of vite's default 5173 so we don't reuse a dev server
    // pointed at a sibling worktree.
    baseURL: 'http://localhost:5174',
    headless: true,
    // WebGL needs a real GPU pipeline; chromium's swiftshader fallback is
    // good enough for our scene-state assertions, but we keep the option
    // visible here in case headed mode is wanted for debugging.
    launchOptions: {
      args: ['--use-gl=swiftshader'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
