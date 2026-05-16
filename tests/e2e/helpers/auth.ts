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
  // Target inputs by id directly — getByLabel collides with "Show password"
  // button and "Recuperar contraseña" link added to auth view.
  await page.locator('input#email').fill(EMAIL!);
  await page.locator('input#password').fill(PASSWORD!);
  // Submit button — exact match avoids OAuth (GitHub/Google) sibling buttons.
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  // Post-login default lands on `/` (Chat home). Wait for TopDock + activate
  // Workspace mode via the data-testid tab — App.tsx's mode-aware router
  // then navigates to /workspaces (or /workspaces/:lastId).
  await expect(page.getByTestId('topdock-mode-workspace')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('topdock-mode-workspace').click();
  await expect(page).toHaveURL(/\/workspaces(\/.*)?$/, { timeout: 10_000 });
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
  // Always click the Nodos tab — the renderer may be pre-mounted off-screen
  // in Workspace mode, so visibility check can false-positive. Only skip
  // the click if the Nodos tab is already aria-pressed.
  const tab = page.getByTestId('topdock-mode-nodos');
  const pressed = await tab.getAttribute('aria-pressed').catch(() => null);
  if (pressed !== 'true') {
    await tab.click();
  }
  await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
}
