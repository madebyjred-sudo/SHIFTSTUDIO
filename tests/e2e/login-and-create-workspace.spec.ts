/**
 * E2E — login + create workspace + add a hoja.
 *
 * Runs against a Vercel preview URL (or PROD if --baseURL is set).
 *
 * REQUIRES env vars (set via --env or shell):
 *   E2E_TEST_EMAIL       — email of a real Supabase auth user (e.g. studio-test@shiftpn.com)
 *   E2E_TEST_PASSWORD    — that user's password
 *   PLAYWRIGHT_BASE_URL  — preview URL or production URL
 *
 * Skips itself if the env vars aren't set so CI can run it conditionally.
 */
import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('E2E: login → create workspace → add hoja', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run');

  test('happy path', async ({ page }) => {
    // Step 1 — sign in
    await page.goto('/');
    await page.getByLabel(/correo|email/i).fill(EMAIL!);
    await page.getByLabel(/contraseña|password/i).fill(PASSWORD!);
    await page.getByRole('button', { name: /entrar|sign in/i }).click();

    // Step 2 — navigate to workspaces
    await page.getByRole('button', { name: /workspaces/i }).click();
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole('heading', { name: /mis workspaces/i })).toBeVisible();

    // Step 3 — create workspace (use timestamp to avoid name collision)
    const wsName = `E2E test ${Date.now()}`;
    const createBtn = page.getByRole('button', { name: /nuevo workspace|crear mi primer/i });
    await createBtn.click();
    // Modal opens — fill name + create
    await page.getByLabel(/nombre|título/i).fill(wsName);
    await page.getByRole('button', { name: /crear/i }).click();

    // Step 4 — should land on /workspaces/<uuid>
    await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+/);

    // Step 5 — add a hoja via the toolbar
    await page.getByRole('button', { name: /nueva hoja/i }).click();
    // The new hoja should appear on the canvas with default title
    await expect(page.getByText(/sin título/i).first()).toBeVisible();

    // Cleanup: delete workspace to avoid pollution.
    // (Skip if the page doesn't surface a delete affordance from the canvas;
    // the workspace will get manually pruned in QA.)
  });
});
