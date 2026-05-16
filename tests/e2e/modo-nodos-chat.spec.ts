/**
 * E2E — modo nodos: chat-driven graph construction and iteration.
 *
 * Four sub-flows:
 *   1. Chat-driven graph construction — Cmd+/ → mock POST /v1/graph/generate
 *      → graph applied on canvas with .shifty-diff-added nodes (≤7 nodes).
 *   2. Chat iteration — pre-seed with specialist "catalina", mock responds
 *      with agent_id changed to "diego" → .shifty-diff-modified visible.
 *   3. AwN clarification — mock returns mode:'chat' → message visible in
 *      sidebar, canvas node count unchanged.
 *   4. Hard limit enforcement — mock declines 15 specialists → decline
 *      message visible, canvas unchanged.
 *
 * Required env:
 *   E2E_TEST_EMAIL       — Supabase user
 *   E2E_TEST_PASSWORD    — password
 *   PLAYWRIGHT_BASE_URL  — preview / prod URL
 */
import { test, expect } from '@playwright/test';
import {
  login,
  createWorkspace,
  enableStoreHook,
  waitForStoreExposed,
  openModoNodos,
} from './helpers/auth';
import { mockGenerateGraph } from './helpers/graphMock';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

// ─── Shared graph seed ────────────────────────────────────────────────

/** Inject the minimal specialist-catalina graph via the store hook. */
async function seedCatalinaGraph(page: import('@playwright/test').Page): Promise<void> {
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
        id: 'ctx-seed',
        type: 'context',
        position: { x: 0, y: 0 },
        data: { label: 'Contexto', status: 'IDLE' },
        selectable: true,
        draggable: true,
      },
      {
        id: 'catalina',
        type: 'specialist',
        position: { x: 280, y: 0 },
        data: {
          label: 'Catalina',
          status: 'IDLE',
          agent_id: 'catalina',
          agent: 'Catalina - Creative',
          prompt: 'Hace la estrategia creativa',
        },
        selectable: true,
        draggable: true,
      },
    ]);
    store.setEdges([
      { id: 'e1', source: 'ctx-seed', target: 'catalina', type: 'animated' },
    ]);
  });
}

/** Count ReactFlow node wrappers on the canvas. */
async function countCanvasNodes(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('.react-flow__node').count();
}

// ─── Describe ──────────────────────────────────────────────────────────

test.describe('E2E: modo nodos chat', () => {
  test.beforeAll(() => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run');
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'PLAYWRIGHT_BASE_URL not set');
  });

  test.setTimeout(90_000);

  // ── 1. Chat-driven graph construction ──────────────────────────────

  test('chat-driven graph construction applies DAG with diff-added nodes', async ({ page }) => {
    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Mock the generate endpoint before the user sends the message.
    await mockGenerateGraph(page, {
      mode: 'graph',
      narrative: 'Armé un brief creativo para Garnier.',
      graph: {
        nodes: [
          { id: 'ctx-g', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Brief Garnier', status: 'IDLE' } },
          { id: 'copy-g', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Copywriter', status: 'IDLE', agent_id: 'copy', agent: 'Copy', prompt: '' } },
          { id: 'art-g', type: 'specialist', position: { x: 260, y: 180 }, data: { label: 'Art Director', status: 'IDLE', agent_id: 'art', agent: 'Art', prompt: '' } },
          { id: 'strat-g', type: 'specialist', position: { x: 260, y: 360 }, data: { label: 'Estrategia', status: 'IDLE', agent_id: 'strat', agent: 'Strat', prompt: '' } },
          { id: 'export-g', type: 'export', position: { x: 520, y: 180 }, data: { label: 'Exportar', status: 'IDLE', format: 'docx' } },
        ],
        edges: [
          { id: 'e1', source: 'ctx-g', target: 'copy-g' },
          { id: 'e2', source: 'ctx-g', target: 'art-g' },
          { id: 'e3', source: 'ctx-g', target: 'strat-g' },
          { id: 'e4', source: 'copy-g', target: 'export-g' },
          { id: 'e5', source: 'art-g', target: 'export-g' },
          { id: 'e6', source: 'strat-g', target: 'export-g' },
        ],
      },
    });

    // Open the sidebar via the toggle button (mirrors Cmd+/ shortcut).
    await page.getByTestId('graph-chat-toggle').click();
    await expect(page.getByTestId('graph-chat-sidebar')).toBeVisible({ timeout: 5_000 });

    // Type and send the message.
    await page.getByTestId('graph-chat-input').fill('Brief para Garnier');
    await page.getByTestId('graph-chat-send').click();

    // Wait for diff-added nodes to appear (the hook applies the graph
    // and annotates nodes with the CSS class during the current paint cycle).
    await expect.poll(
      async () => page.locator('.shifty-diff-added').count(),
      { timeout: 15_000, message: 'Expected .shifty-diff-added nodes to appear after graph response' },
    ).toBeGreaterThan(0);

    // Assert total node count is within the ≤7 contract.
    const nodeCount = await countCanvasNodes(page);
    expect(nodeCount).toBeLessThanOrEqual(7);
  });

  // ── 2. Chat iteration: swap specialist ─────────────────────────────

  test('chat iteration swaps specialist and shows diff-modified', async ({ page }) => {
    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Pre-seed with "catalina" specialist
    await seedCatalinaGraph(page);

    // Mock response that swaps agent_id to "diego"
    await mockGenerateGraph(page, {
      mode: 'graph',
      narrative: 'Cambié Catalina por Diego.',
      graph: {
        nodes: [
          { id: 'ctx-seed', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Contexto', status: 'IDLE' } },
          {
            id: 'catalina',
            type: 'specialist',
            position: { x: 280, y: 0 },
            data: {
              label: 'Diego',
              status: 'IDLE',
              agent_id: 'diego',
              agent: 'Diego - Creative',
              prompt: 'Hace la estrategia creativa',
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'ctx-seed', target: 'catalina' },
        ],
      },
    });

    // Open sidebar and send the swap instruction
    await page.getByTestId('graph-chat-toggle').click();
    await expect(page.getByTestId('graph-chat-sidebar')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('graph-chat-input').fill('cambiá Catalina por Diego');
    await page.getByTestId('graph-chat-send').click();

    // Expect the modified node class to appear
    await expect.poll(
      async () => page.locator('.shifty-diff-modified').count(),
      { timeout: 15_000, message: 'Expected .shifty-diff-modified node after specialist swap' },
    ).toBeGreaterThan(0);

    // Verify the store reflects agent_id === 'diego'
    const nodeData = await page.evaluate(() => {
      const w = window as unknown as {
        __studioGraphStore?: {
          getState: () => { nodes: Array<{ id: string; data?: Record<string, unknown> }> };
        };
      };
      const store = w.__studioGraphStore?.getState();
      const node = store?.nodes.find((n) => n.id === 'catalina');
      return node?.data;
    });

    expect((nodeData as Record<string, unknown> | undefined)?.agent_id).toBe('diego');
  });

  // ── 3. AwN clarification: mode:'chat' does not mutate canvas ───────

  test('AwN clarification response leaves canvas unchanged', async ({ page }) => {
    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Seed an initial graph so we have a baseline node count
    await seedCatalinaGraph(page);
    const baselineCount = await countCanvasNodes(page);

    // Mock a clarification response (mode: 'chat', no graph)
    await mockGenerateGraph(page, {
      mode: 'chat',
      message: '¿Para qué marca y qué objetivo tiene la campaña?',
    });

    // Open sidebar and send an ambiguous prompt
    await page.getByTestId('graph-chat-toggle').click();
    await expect(page.getByTestId('graph-chat-sidebar')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('graph-chat-input').fill('hazme una campaña');
    await page.getByTestId('graph-chat-send').click();

    // The clarification message should appear in the sidebar
    await expect.poll(
      async () => {
        const msgs = await page.getByTestId('graph-chat-message-assistant').all();
        for (const m of msgs) {
          const txt = await m.textContent();
          if (txt?.includes('¿Para qué marca')) return true;
        }
        return false;
      },
      { timeout: 15_000, message: 'Expected clarification message to appear in sidebar' },
    ).toBe(true);

    // Canvas node count must remain unchanged
    const afterCount = await countCanvasNodes(page);
    expect(afterCount).toBe(baselineCount);
  });

  // ── 4. Hard limit enforcement ───────────────────────────────────────

  test('hard limit response declines and leaves canvas unchanged', async ({ page }) => {
    await login(page);
    await createWorkspace(page);
    await openModoNodos(page);
    await enableStoreHook(page);
    await page.getByTestId('topdock-mode-nodos').click().catch(() => undefined);
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 10_000 });
    await waitForStoreExposed(page);

    // Seed an initial graph for baseline count
    await seedCatalinaGraph(page);
    const baselineCount = await countCanvasNodes(page);

    // Mock a decline response
    await mockGenerateGraph(page, {
      mode: 'chat',
      message: 'Excede límite 5 agentes — el máximo por grafo es 5 specialists.',
    });

    // Open sidebar and send an oversized request
    await page.getByTestId('graph-chat-toggle').click();
    await expect(page.getByTestId('graph-chat-sidebar')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('graph-chat-input').fill('armá 15 specialists');
    await page.getByTestId('graph-chat-send').click();

    // Decline message should appear
    await expect.poll(
      async () => {
        const msgs = await page.getByTestId('graph-chat-message-assistant').all();
        for (const m of msgs) {
          const txt = await m.textContent();
          if (txt?.includes('Excede límite 5 agentes')) return true;
        }
        return false;
      },
      { timeout: 15_000, message: 'Expected decline message to appear in sidebar' },
    ).toBe(true);

    // Canvas must be unchanged
    const afterCount = await countCanvasNodes(page);
    expect(afterCount).toBe(baselineCount);
  });
});
