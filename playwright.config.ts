/**
 * Playwright config for Shifty Studio E2E + smoke tests.
 *
 * Strategy:
 *   • E2E (`tests/e2e/`)    — full user flows against Vercel preview.
 *   • Smoke (`tests/smoke/`)— production reachability checks (read-only).
 *   • Security (`tests/security/`) — verify P0 hotfix invariants
 *     (header-spoof rejected, CORS clean, etc.) on prod.
 *
 * Usage:
 *   npm run test:smoke              — run smoke against PROD (https://shiftstudio.vercel.app)
 *   npm run test:e2e -- --baseURL=<preview-url>
 *                                   — run E2E against a Vercel preview
 *   npm run test:security           — run security invariants against PROD
 *
 * CI:
 *   GitHub Actions calls test:smoke + test:security on every push to main.
 *   E2E runs on PR after Vercel posts the preview URL.
 */
import { defineConfig, devices } from '@playwright/test';

const PROD_URL = 'https://shiftstudio.vercel.app';

export default defineConfig({
  testDir: './tests',
  // Match only files under specific subdirs to keep test types isolated.
  testMatch: ['**/*.spec.ts'],
  // Stop at first failure in CI; allow continue locally for full visibility.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Single worker keeps log output readable; bump to 4 for CI speed.
  workers: process.env.CI ? 4 : 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || PROD_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Phase 3+: add 'webkit' and 'firefox' once Chromium-only tests are stable.
  ],
});
