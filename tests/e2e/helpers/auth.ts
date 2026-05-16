/**
 * E2E auth helpers — shared across modo-nodos spec files.
 *
 * Mirrors the helpers in `modo-nodos-flow.spec.ts` exactly so patterns
 * stay in sync. Import here instead of duplicating inline.
 */
import { expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

/**
 * Sign in via the auth view and land on /workspaces.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/correo|email/i).fill(EMAIL!);
  await page.getByLabel(/contraseña|password/i).fill(PASSWORD!);
  await page.getByRole('button', { name: /entrar|sign in/i }).click();
  await expect(page).toHaveURL(/\/workspaces(\/.*)?$/, { timeout: 15_000 });
}

/**
 * Create a fresh workspace and return its UUID.
 */
export async function createWorkspace(page: Page): Promise<string> {
  await page.getByRole('button', { name: /workspaces/i }).first().click().catch(() => undefined);
  if (!page.url().includes('/workspaces')) {
    await page.goto('/workspaces');
  }
  const wsName = `E2E nodos ${Date.now()}`;
  const createBtn = page.getByRole('button', { name: /nuevo workspace|crear mi primer/i });
  await createBtn.click();
  await page.getByLabel(/nombre|título/i).fill(wsName);
  await page.getByRole('button', { name: /crear/i }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+/, { timeout: 15_000 });
  const match = page.url().match(/\/workspaces\/([0-9a-f-]+)/);
  if (!match) throw new Error(`Failed to parse workspace id from ${page.url()}`);
  return match[1];
}

/**
 * Append the E2E query flag to the current URL so `ShiftyNodeCanvasInner`
 * exposes its store on `window.__studioGraphStore`.
 */
export async function enableStoreHook(page: Page): Promise<void> {
  const url = new URL(page.url());
  if (url.searchParams.get('e2e') === '1') return;
  url.searchParams.set('e2e', '1');
  await page.goto(url.toString());
}

/**
 * Wait until `window.__studioGraphStore` is exposed by the canvas inner
 * component's mount effect (only happens in modo-nodos).
 */
export async function waitForStoreExposed(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __studioGraphStore?: unknown }).__studioGraphStore !==
      'undefined',
    null,
    { timeout: 10_000 },
  );
}

/**
 * Navigate to modo-nodos for a workspace and ensure the ReactFlow renderer
 * is visible. Handles the fact that the default mode may be 'workspace'.
 */
export async function openModoNodos(page: Page): Promise<void> {
  // May already be on nodos — try toggling only if the renderer isn't up.
  const rendererVisible = await page.locator('.react-flow__renderer').isVisible().catch(() => false);
  if (!rendererVisible) {
    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
  }
}
