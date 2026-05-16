/**
 * E2E — modo nodos: parallel branching consolidation.
 *
 * Verifies that a DAG with two parallel specialist nodes (spec-a, spec-b)
 * both feeding a single export node correctly shows the consolidation
 * preview in ExportNode ("Va a consolidar: spec-a, spec-b").
 *
 * When PLAYWRIGHT_MOCK_GRAPH_EXEC=true the test also runs the graph and
 * asserts the `graph:done` event arrives with sections.length === 2.
 *
 * Required env:
 *   E2E_TEST_EMAIL       — Supabase user
 *   E2E_TEST_PASSWORD    — password
 *   PLAYWRIGHT_BASE_URL  — preview / prod URL
 *
 * Optional:
 *   PLAYWRIGHT_MOCK_GRAPH_EXEC=true — enables the execution sub-test
 */
import { test, expect } from '@playwright/test';
import {
  login,
  createWorkspace,
  enableStoreHook,
  waitForStoreExposed,
  openModoNodos,
} from './helpers/auth';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const MOCK_EXEC = process.env.PLAYWRIGHT_MOCK_GRAPH_EXEC === 'true';

test.describe('E2E: modo nodos parallel branching', () => {
  test.beforeAll(() => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run');
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'PLAYWRIGHT_BASE_URL not set');
  });

  test.setTimeout(90_000);

  test('ExportNode preview shows "Va a consolidar: spec-a, spec-b"', async ({ page }) => {
    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);

    // Re-activate nodos after hook reload
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Inject a parallel DAG: context → spec-a + spec-b (parallel) → export
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
      if (!store) throw new Error('__studioGraphStore hook missing');

      store.setNodes([
        {
          id: 'ctx-1',
          type: 'context',
          position: { x: 0, y: 100 },
          data: { label: 'Contexto campaña', status: 'IDLE' },
          selectable: true,
          draggable: true,
        },
        {
          id: 'spec-a',
          type: 'specialist',
          position: { x: 300, y: 0 },
          data: {
            label: 'spec-a',
            status: 'IDLE',
            agent_id: 'spec-a',
            agent: 'Especialista A',
            prompt: 'Hace la parte A',
          },
          selectable: true,
          draggable: true,
        },
        {
          id: 'spec-b',
          type: 'specialist',
          position: { x: 300, y: 200 },
          data: {
            label: 'spec-b',
            status: 'IDLE',
            agent_id: 'spec-b',
            agent: 'Especialista B',
            prompt: 'Hace la parte B',
          },
          selectable: true,
          draggable: true,
        },
        {
          id: 'export-1',
          type: 'export',
          position: { x: 600, y: 100 },
          data: { label: 'Exportar', status: 'IDLE', format: 'docx' },
          selectable: true,
          draggable: true,
        },
      ]);

      store.setEdges([
        { id: 'e-ctx-a', source: 'ctx-1', target: 'spec-a', type: 'animated' },
        { id: 'e-ctx-b', source: 'ctx-1', target: 'spec-b', type: 'animated' },
        { id: 'e-a-exp', source: 'spec-a', target: 'export-1', type: 'animated' },
        { id: 'e-b-exp', source: 'spec-b', target: 'export-1', type: 'animated' },
      ]);
    });

    // The ExportNode should now display the consolidation preview
    const preview = page.getByTestId('export-preview-sources');
    await expect(preview).toBeVisible({ timeout: 8_000 });

    // Assert both sources appear — order may vary
    const text = await preview.textContent();
    expect(text).toContain('Va a consolidar:');
    expect(text).toContain('spec-a');
    expect(text).toContain('spec-b');
  });

  test('mock execution completes with sections.length === 2', async ({ page }) => {
    test.skip(!MOCK_EXEC, 'PLAYWRIGHT_MOCK_GRAPH_EXEC not set — skip mock execution sub-test');

    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);

    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Inject same parallel DAG
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
          id: 'ctx-1',
          type: 'context',
          position: { x: 0, y: 100 },
          data: { label: 'Contexto', status: 'IDLE' },
          selectable: true,
          draggable: true,
        },
        {
          id: 'spec-a',
          type: 'specialist',
          position: { x: 300, y: 0 },
          data: { label: 'spec-a', status: 'IDLE', agent_id: 'spec-a', agent: 'A', prompt: 'p' },
          selectable: true,
          draggable: true,
        },
        {
          id: 'spec-b',
          type: 'specialist',
          position: { x: 300, y: 200 },
          data: { label: 'spec-b', status: 'IDLE', agent_id: 'spec-b', agent: 'B', prompt: 'p' },
          selectable: true,
          draggable: true,
        },
        {
          id: 'export-1',
          type: 'export',
          position: { x: 600, y: 100 },
          data: { label: 'Exportar', status: 'IDLE', format: 'docx' },
          selectable: true,
          draggable: true,
        },
      ]);

      store.setEdges([
        { id: 'e-ctx-a', source: 'ctx-1', target: 'spec-a', type: 'animated' },
        { id: 'e-ctx-b', source: 'ctx-1', target: 'spec-b', type: 'animated' },
        { id: 'e-a-exp', source: 'spec-a', target: 'export-1', type: 'animated' },
        { id: 'e-b-exp', source: 'spec-b', target: 'export-1', type: 'animated' },
      ]);
    });

    // Listen for graph:done custom event dispatched by the store when
    // mock execution completes.
    const graphDonePromise = page.evaluate(
      () =>
        new Promise<{ sections: unknown[] }>((resolve) => {
          window.addEventListener(
            'graph:done',
            (e) => resolve((e as CustomEvent<{ sections: unknown[] }>).detail),
            { once: true },
          );
        }),
    );

    // Click the run button to start mock execution
    await page.getByTestId('graph-run-button').click();

    // Poll until the event resolves (mock execution is fast, but be generous)
    const result = await Promise.race([
      graphDonePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('graph:done timeout after 30s')), 30_000),
      ),
    ]);

    expect((result as { sections: unknown[] }).sections).toHaveLength(2);
  });
});
