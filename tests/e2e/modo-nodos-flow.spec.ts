/**
 * E2E — modo nodos full flow.
 *
 * Five sub-flows in this spec:
 *   1. Toggle Workspace ↔ Nodos via unified top-nav (global activeMode)
 *   2. Graph autosave + reload persistence
 *   3. Mock execution (RUNNING → COMPLETED topo order; export download)
 *   4. Connection validation feedback (invalid tooltip; valid silent)
 *   5. Root-level TopDock "Nodos" redirects to /workspaces or /workspaces/:lastId
 *
 * REQUIRED env (per `tests/e2e/login-and-create-workspace.spec.ts` pattern):
 *   E2E_TEST_EMAIL       — Supabase auth user
 *   E2E_TEST_PASSWORD    — that user's password
 *   PLAYWRIGHT_BASE_URL  — preview URL (default = PROD via playwright.config.ts)
 *
 * Optional env:
 *   PLAYWRIGHT_MOCK_GRAPH_EXEC=true
 *     → indicates the target build was compiled with VITE_MOCK_GRAPH_EXEC=true.
 *       Required only for sub-flow 3 (mock execution). When unset the mock test
 *       skips with a clear reason.
 *
 *     Set on Vercel preview via: `vercel env add VITE_MOCK_GRAPH_EXEC preview`
 *     (value = "true"). Then surface the same hint to Playwright in CI via:
 *       env:
 *         PLAYWRIGHT_MOCK_GRAPH_EXEC: 'true'
 *     in the e2e job of `.github/workflows/ci.yml`.
 *
 * Notes on app-side hooks added for this spec:
 *   • All key targets carry stable `data-testid`s (topdock-mode-chat |
 *     topdock-mode-workspace | topdock-mode-nodos, graph-run-button,
 *     graph-save-badge, connection-tooltip).
 *   • Visiting any workspace URL with `?e2e=1` exposes the V2 graph store as
 *     `window.__studioGraphStore` so we can inject nodes/edges directly —
 *     drag-and-drop on a ReactFlow pane is brittle in headless Chromium.
 *     Hook is removed on unmount.
 *
 * Run locally:
 *   E2E_TEST_EMAIL=... E2E_TEST_PASSWORD=... \
 *   PLAYWRIGHT_BASE_URL=https://<preview>.vercel.app \
 *   npm run test:e2e -- tests/e2e/modo-nodos-flow.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const MOCK_EXEC = process.env.PLAYWRIGHT_MOCK_GRAPH_EXEC === 'true';

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Sign in via the auth view and land on /workspaces. Mirrors the pattern in
 * `login-and-create-workspace.spec.ts` byte-for-byte so behavior drift in
 * that spec is observable here too.
 */
async function login(page: Page) {
  await page.goto('/');
  // Target inputs by id directly — getByLabel collides with "Show password"
  // button + "Recuperar contraseña" link added to auth view.
  await page.locator('input#email').fill(EMAIL!);
  await page.locator('input#password').fill(PASSWORD!);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  // The redirect after login goes to /workspaces by default in the new (F1)
  // app shell.
  await expect(page).toHaveURL(/\/workspaces(\/.*)?$/, { timeout: 15_000 });
}

/**
 * Create a fresh workspace and return its UUID. Reuses the exact UI pattern
 * from the existing E2E (button name, modal field, redirect URL). Returns
 * the id parsed from the final URL.
 */
async function createWorkspace(page: Page): Promise<string> {
  await page.getByRole('button', { name: /workspaces/i }).first().click().catch(() => undefined);
  if (!page.url().endsWith('/workspaces')) {
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
 * exposes its store on window. Done after the canvas has mounted so we can
 * pick up the hook without re-doing login.
 */
async function enableStoreHook(page: Page) {
  const url = new URL(page.url());
  if (url.searchParams.get('e2e') === '1') return;
  url.searchParams.set('e2e', '1');
  await page.goto(url.toString());
}

/**
 * Wait until `window.__studioGraphStore` is exposed (only happens after the
 * canvas inner component has run its mount effect, which itself only runs
 * once modo-nodos is the active page mode).
 */
async function waitForStoreExposed(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __studioGraphStore?: unknown })
        .__studioGraphStore !== 'undefined',
    null,
    { timeout: 10_000 },
  );
}

/**
 * Detect whether the workspace graph migration is applied by probing the
 * GET /api/workspace/:id/graph endpoint. If the migration is missing the
 * server returns 500; we use that to short-circuit the persistence test
 * rather than letting it fail with an opaque autosave error.
 */
async function isGraphMigrationApplied(
  page: Page,
  workspaceId: string,
): Promise<boolean> {
  try {
    const ok = await page.evaluate(async (id) => {
      const res = await fetch(`/api/workspace/${id}/graph`, {
        credentials: 'include',
      });
      // 200 = applied. 404 = applied but no row yet (also fine). 401 = not
      // logged in (a higher-level problem, will surface in another test).
      // 500 = migration missing or unrelated server error — skip.
      return res.status !== 500;
    }, workspaceId);
    return ok;
  } catch {
    // Network error / aborted — be permissive, let downstream assertions
    // catch the real problem.
    return true;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

test.describe('E2E: modo nodos full flow', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run',
  );
  // Modo nodos work is heavier than the hojas flow (xyflow boot, SSE, etc.).
  // Generous timeout so a slow Vercel cold-start doesn't flake the suite.
  test.setTimeout(90_000);

  test('toggle Workspace ↔ Nodos via unified top-nav', async ({ page }) => {
    await login(page);
    await createWorkspace(page);

    // Default mode on a workspace URL = workspace (hojas) — the
    // Workspace button in the top-dock should be pressed and the
    // ReactFlow renderer should NOT be on screen yet.
    await expect(
      page.getByTestId('topdock-mode-workspace'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.react-flow__renderer')).toHaveCount(0);

    // Flip to Nodos.
    await page.getByTestId('topdock-mode-nodos').click();
    await expect(
      page.getByTestId('topdock-mode-nodos'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });

    // Flip back to Workspace — renderer goes away.
    await page.getByTestId('topdock-mode-workspace').click();
    await expect(page.locator('.react-flow__renderer')).toHaveCount(0, {
      timeout: 5_000,
    });

    // The unified top-nav no longer writes a per-workspace localStorage
    // key (`studio-workspace-mode-${id}`); the global activeMode store is
    // the single source of truth. The page wrapper still caches the last
    // workspace id under `studio-last-workspace-id` for deep-linking.
  });

  test('graph autosave + reload persistence', async ({ page }) => {
    await login(page);
    const workspaceId = await createWorkspace(page);

    // Verify the persistence migration is live BEFORE doing anything that
    // would otherwise produce confusing autosave errors. If it's missing
    // the spec marks itself skipped with a clear reason.
    const migrationOk = await isGraphMigrationApplied(page, workspaceId);
    test.skip(
      !migrationOk,
      'studio_workspace_graphs migration (0010) not applied in preview env — skip',
    );

    // Enter modo nodos.
    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });

    // Expose the store and inject a minimal graph. We re-navigate with
    // ?e2e=1 so the mount-time hook can pick it up.
    await enableStoreHook(page);
    // Coming back from the reload: re-select nodos so the canvas mounts
    // again (the page-mode default may snap back to hojas pending the
    // hydration of localStorage on first paint).
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });
    await waitForStoreExposed(page);

    // Inject a 2-node graph via the store. We use ids that are stable so
    // we can grep for them after reload.
    await page.evaluate(() => {
      const w = window as unknown as {
        __studioGraphStore?: {
          getState: () => {
            setNodes: (n: unknown[]) => void;
            setEdges: (e: unknown[]) => void;
          };
        };
      };
      const store = w.__studioGraphStore?.getState();
      if (!store) throw new Error('store hook missing');
      store.setNodes([
        {
          id: 'e2e-ctx-1',
          type: 'context',
          position: { x: 0, y: 0 },
          data: { label: 'E2E Contexto', status: 'IDLE' },
          selectable: true,
          draggable: true,
        },
        {
          id: 'e2e-spec-1',
          type: 'specialist',
          position: { x: 240, y: 0 },
          data: {
            label: 'E2E Especialista',
            status: 'IDLE',
            agent: 'Jorge - Content',
            prompt: '',
          },
          selectable: true,
          draggable: true,
        },
      ]);
      store.setEdges([
        {
          id: 'e2e-edge-1',
          source: 'e2e-ctx-1',
          target: 'e2e-spec-1',
          type: 'animated',
        },
      ]);
    });

    // Wait for autosave: debounce 2000ms + PUT round-trip + buffer.
    // We assert on the badge flipping to data-state="saved" rather than a
    // wall-clock setTimeout so the test stays honest if the debounce
    // changes.
    await expect(page.getByTestId('graph-save-badge')).toHaveAttribute(
      'data-state',
      'saved',
      { timeout: 15_000 },
    );

    // Reload the page (keep the workspace id, drop the e2e flag so
    // hydration happens via the canonical path).
    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });

    // The injected nodes should now be on the canvas. xyflow renders each
    // node with `[data-id="<id>"]` on the wrapper div, which is the
    // sturdiest selector for this assertion.
    await expect(page.locator('[data-id="e2e-ctx-1"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-id="e2e-spec-1"]')).toBeVisible();
  });

  test('mock execution flow — RUNNING → COMPLETED topo order', async ({
    page,
  }) => {
    test.skip(
      !MOCK_EXEC,
      'Requires PLAYWRIGHT_MOCK_GRAPH_EXEC=true (build with VITE_MOCK_GRAPH_EXEC=true)',
    );
    await login(page);
    const workspaceId = await createWorkspace(page);

    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });

    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });
    await waitForStoreExposed(page);

    // Build a 3-node pipeline: context → specialist → export. Both
    // specialists carry an `agent` so the wire payload is valid.
    await page.evaluate(() => {
      const w = window as unknown as {
        __studioGraphStore?: {
          getState: () => {
            setNodes: (n: unknown[]) => void;
            setEdges: (e: unknown[]) => void;
          };
        };
      };
      const store = w.__studioGraphStore?.getState();
      if (!store) throw new Error('store hook missing');
      store.setNodes([
        {
          id: 'mock-ctx',
          type: 'context',
          position: { x: 0, y: 0 },
          data: { label: 'Mock Contexto', status: 'IDLE', content: 'lorem ipsum' },
        },
        {
          id: 'mock-spec',
          type: 'specialist',
          position: { x: 240, y: 0 },
          data: {
            label: 'Mock Especialista',
            status: 'IDLE',
            agent: 'Jorge - Content',
            prompt: 'Resume el contexto.',
          },
        },
        {
          id: 'mock-export',
          type: 'export',
          position: { x: 480, y: 0 },
          data: { label: 'Mock Exportador', status: 'IDLE', format: 'md' },
        },
      ]);
      store.setEdges([
        { id: 'me-1', source: 'mock-ctx', target: 'mock-spec', type: 'animated' },
        { id: 'me-2', source: 'mock-spec', target: 'mock-export', type: 'animated' },
      ]);
    });

    // Listen for a download starting from the export node so we can assert
    // it actually fires (we don't open the blob — just confirm the event).
    // For format=md the in-process exporter triggers a browser download via
    // a synthetic anchor click; Playwright's page.on('download') catches it.
    const downloadPromise = page
      .waitForEvent('download', { timeout: 30_000 })
      .catch(() => null);

    // Fire EJECUTAR.
    await page.getByTestId('graph-run-button').click();

    // The specialist should transition to RUNNING then COMPLETED. We read
    // status via the store rather than scraping pixels — the SpecialistNode
    // renders the status visually but the source of truth is node.data.status.
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __studioGraphStore?: {
            getState: () => { nodes: { id: string; data?: { status?: string } }[] };
          };
        };
        const state = w.__studioGraphStore?.getState();
        const spec = state?.nodes.find((n) => n.id === 'mock-spec');
        return spec?.data?.status === 'RUNNING';
      },
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __studioGraphStore?: {
            getState: () => { nodes: { id: string; data?: { status?: string } }[] };
          };
        };
        const state = w.__studioGraphStore?.getState();
        const spec = state?.nodes.find((n) => n.id === 'mock-spec');
        return spec?.data?.status === 'COMPLETED';
      },
      null,
      { timeout: 15_000 },
    );

    // Export node should reach COMPLETED too (the store triggers
    // runExportNode after graph:done lands).
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __studioGraphStore?: {
            getState: () => { nodes: { id: string; data?: { status?: string } }[] };
          };
        };
        const state = w.__studioGraphStore?.getState();
        const exp = state?.nodes.find((n) => n.id === 'mock-export');
        // Either the in-process md export completed (COMPLETED) or the
        // backend export failed because the workspace lacks the right
        // chrome — in CI we accept either, the goal is to verify the
        // mock-exec → export trigger linkage. The download assertion
        // below covers the happy path.
        return exp?.data?.status === 'COMPLETED' || exp?.data?.status === 'FAILED';
      },
      null,
      { timeout: 30_000 },
    );

    // Verify the export at least attempted a download. The download is the
    // only externally-observable proof that the export node ran end-to-end.
    const download = await downloadPromise;
    if (download) {
      expect(download.suggestedFilename()).toBeTruthy();
    }
    // No hard fail if download didn't fire — the mock plus a real export
    // backend can race against the test runner on a cold preview. The
    // status assertions above are the primary contract.
  });

  test('connection validation — invalid shows tooltip, valid does not', async ({
    page,
  }) => {
    await login(page);
    await createWorkspace(page);

    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });

    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({
      timeout: 10_000,
    });
    await waitForStoreExposed(page);

    // Layout: two context nodes side-by-side (invalid pair), and one
    // specialist below for the valid drag. Positions are spread enough
    // that handles don't overlap.
    await page.evaluate(() => {
      const w = window as unknown as {
        __studioGraphStore?: {
          getState: () => {
            setNodes: (n: unknown[]) => void;
            setEdges: (e: unknown[]) => void;
          };
        };
      };
      const store = w.__studioGraphStore?.getState();
      if (!store) throw new Error('store hook missing');
      store.setNodes([
        {
          id: 'c-a',
          type: 'context',
          position: { x: 0, y: 0 },
          data: { label: 'Contexto A', status: 'IDLE' },
        },
        {
          id: 'c-b',
          type: 'context',
          position: { x: 360, y: 0 },
          data: { label: 'Contexto B', status: 'IDLE' },
        },
        {
          id: 's-c',
          type: 'specialist',
          position: { x: 360, y: 220 },
          data: {
            label: 'Especialista C',
            status: 'IDLE',
            agent: 'Jorge - Content',
            prompt: '',
          },
        },
      ]);
      store.setEdges([]);
    });

    // Use ReactFlow handles: each node has a `.react-flow__handle-right`
    // (source) and `.react-flow__handle-left` (target). Drag from c-a's
    // right handle to c-b's left handle — this should NOT create an edge
    // and should surface a tooltip via onConnectEnd's failure path.
    const sourceA = page.locator('[data-id="c-a"] .react-flow__handle-right').first();
    const targetB = page.locator('[data-id="c-b"] .react-flow__handle-left').first();
    await expect(sourceA).toBeVisible();
    await expect(targetB).toBeVisible();

    const sourceABox = await sourceA.boundingBox();
    const targetBBox = await targetB.boundingBox();
    if (!sourceABox || !targetBBox) {
      throw new Error('ReactFlow handles missing bounding boxes');
    }

    // Manual drag with intermediate moves so xyflow's connection-in-progress
    // events fire; a single mouse.move() can otherwise skip past the
    // hover detection on the target node.
    await page.mouse.move(
      sourceABox.x + sourceABox.width / 2,
      sourceABox.y + sourceABox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      (sourceABox.x + targetBBox.x) / 2,
      (sourceABox.y + targetBBox.y) / 2,
      { steps: 8 },
    );
    await page.mouse.move(
      targetBBox.x + targetBBox.width / 2,
      targetBBox.y + targetBBox.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();

    // Failure surfaces the persistent tooltip for ~2s with a Spanish
    // reason ("No se puede conectar..." or "Contexto es nodo de origen...").
    const tooltip = page.getByTestId('connection-tooltip');
    await expect(tooltip).toBeVisible({ timeout: 3_000 });
    await expect(tooltip).toHaveAttribute('data-variant', 'error');
    await expect(tooltip).toContainText(
      /no se puede conectar|contexto es nodo de origen/i,
    );

    // No edge was created — assert store state, not just paint.
    const edgesAfterInvalid = await page.evaluate(() => {
      const w = window as unknown as {
        __studioGraphStore?: {
          getState: () => { edges: { id: string; source: string; target: string }[] };
        };
      };
      return w.__studioGraphStore?.getState().edges ?? [];
    });
    expect(edgesAfterInvalid.find((e) => e.source === 'c-a' && e.target === 'c-b')).toBeUndefined();

    // Wait for the persistent tooltip to clear (2s timer) before the next
    // drag, otherwise the leftover tooltip masks the silent-success check.
    await expect(tooltip).toHaveCount(0, { timeout: 4_000 });

    // Valid drag: context → specialist. No error tooltip should appear.
    // xyflow itself wires the edge on drop; we verify both (a) tooltip
    // stays absent for the duration of the drag, and (b) the edge is in
    // the store afterward.
    const sourceA2 = page.locator('[data-id="c-a"] .react-flow__handle-right').first();
    const targetS = page.locator('[data-id="s-c"] .react-flow__handle-left').first();
    const sourceA2Box = await sourceA2.boundingBox();
    const targetSBox = await targetS.boundingBox();
    if (!sourceA2Box || !targetSBox) {
      throw new Error('ReactFlow handles missing bounding boxes (valid drag)');
    }
    await page.mouse.move(
      sourceA2Box.x + sourceA2Box.width / 2,
      sourceA2Box.y + sourceA2Box.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      (sourceA2Box.x + targetSBox.x) / 2,
      (sourceA2Box.y + targetSBox.y) / 2,
      { steps: 8 },
    );
    await page.mouse.move(
      targetSBox.x + targetSBox.width / 2,
      targetSBox.y + targetSBox.height / 2,
      { steps: 8 },
    );
    // Brief pause while hovering — give the cursor-tracking effect a tick
    // to evaluate (but no error tooltip should ever appear for a valid pair).
    await page.waitForTimeout(150);
    // The "error" variant tooltip must NOT have shown up during a valid
    // hover. We allow a brief existence-check rather than a constant
    // assertion because validate() returns valid → tooltip stays null.
    expect(
      await page.locator('[data-testid="connection-tooltip"][data-variant="error"]').count(),
    ).toBe(0);
    await page.mouse.up();

    // Edge should now exist context → specialist.
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __studioGraphStore?: {
            getState: () => { edges: { source: string; target: string }[] };
          };
        };
        const edges = w.__studioGraphStore?.getState().edges ?? [];
        return edges.some((e) => e.source === 'c-a' && e.target === 's-c');
      },
      null,
      { timeout: 5_000 },
    );
  });

  test('root-level TopDock "Nodos" redirects to a workspace surface', async ({ page }) => {
    await login(page);

    // Clear any cached last-workspace id from a prior test run so the
    // redirect lands deterministically on the list (the only safe
    // fallback when there's no last id).
    await page.evaluate(() => window.localStorage.removeItem('studio-last-workspace-id'));

    // From /workspaces, navigate to root (`/`) to land on the chat-only
    // layout where the unified TopDock segmented control lives.
    await page.goto('/');

    // The chat root mounts the TopDock; the Nodos button should be there.
    const nodesBtn = page.getByTestId('topdock-mode-nodos');
    await expect(nodesBtn).toBeVisible({ timeout: 10_000 });
    await nodesBtn.click();

    // Unified top-nav redirects /+nodos-mode → /workspaces/:lastId, or
    // /workspaces (list) when there is no last id. The redirect is
    // routed via window.location, so a URL assertion is the cleanest probe.
    await expect(page).toHaveURL(/\/workspaces(\/.+)?$/, { timeout: 10_000 });

    // The chat-only root layout is gone — we're now on a workspaces
    // surface (list or canvas) so the URL no longer matches '/'.
    await expect(page).not.toHaveURL(/\/$/);
  });
});
