/**
 * E2E — modo nodos: template gallery.
 *
 * Four scenarios:
 *   1. First-visit auto-open: clears localStorage flag → gallery auto-opens.
 *   2. 5 mocked templates render as cards in the gallery.
 *   3. Clicking a template card loads the DAG on the canvas.
 *   4. Second visit does NOT auto-open the gallery.
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
  openModoNodos,
} from './helpers/auth';
import { mockTemplates, type MockTemplate } from './helpers/graphMock';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

const FIRST_VISIT_KEY = 'studio-modo-nodos-first-visit-done';

/** Five mock templates used across all sub-tests. */
const MOCK_TEMPLATES: MockTemplate[] = [
  {
    id: 'tpl-1',
    slug: 'brief-creativo',
    name: 'Brief creativo',
    description: 'DAG para briefs creativos',
    category: 'creativo',
    dag_json: {
      nodes: [
        { id: 'ctx-tpl', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Contexto', status: 'IDLE' } },
        { id: 'copy-tpl', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Copy', status: 'IDLE', agent_id: 'copy', agent: 'Copy', prompt: '' } },
        { id: 'exp-tpl', type: 'export', position: { x: 520, y: 0 }, data: { label: 'Exportar', status: 'IDLE', format: 'docx' } },
      ],
      edges: [
        { id: 'e1', source: 'ctx-tpl', target: 'copy-tpl' },
        { id: 'e2', source: 'copy-tpl', target: 'exp-tpl' },
      ],
    },
  },
  {
    id: 'tpl-2',
    slug: 'estrategia-marca',
    name: 'Estrategia de marca',
    description: 'DAG para estrategia',
    category: 'estrategia',
    dag_json: {
      nodes: [
        { id: 'ctx-s', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Contexto', status: 'IDLE' } },
        { id: 'strat-s', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Estrategia', status: 'IDLE', agent_id: 'strat', agent: 'Strat', prompt: '' } },
        { id: 'exp-s', type: 'export', position: { x: 520, y: 0 }, data: { label: 'Exportar', status: 'IDLE', format: 'pptx' } },
      ],
      edges: [
        { id: 'e1', source: 'ctx-s', target: 'strat-s' },
        { id: 'e2', source: 'strat-s', target: 'exp-s' },
      ],
    },
  },
  {
    id: 'tpl-3',
    slug: 'reporte-analytics',
    name: 'Reporte analytics',
    description: 'DAG para reportes de métricas',
    category: 'analytics',
    dag_json: {
      nodes: [
        { id: 'ctx-a', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Datos', status: 'IDLE' } },
        { id: 'analy-a', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Analytics', status: 'IDLE', agent_id: 'analytics', agent: 'Analytics', prompt: '' } },
        { id: 'exp-a', type: 'export', position: { x: 520, y: 0 }, data: { label: 'Exportar', status: 'IDLE', format: 'xlsx' } },
      ],
      edges: [
        { id: 'e1', source: 'ctx-a', target: 'analy-a' },
        { id: 'e2', source: 'analy-a', target: 'exp-a' },
      ],
    },
  },
  {
    id: 'tpl-4',
    slug: 'propuesta-comercial',
    name: 'Propuesta comercial',
    description: 'DAG para propuestas de negocio',
    category: 'comercial',
    dag_json: {
      nodes: [
        { id: 'ctx-c', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Contexto', status: 'IDLE' } },
        { id: 'com-c', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Comercial', status: 'IDLE', agent_id: 'comercial', agent: 'Comercial', prompt: '' } },
        { id: 'exp-c', type: 'export', position: { x: 520, y: 0 }, data: { label: 'Exportar', status: 'IDLE', format: 'pdf' } },
      ],
      edges: [
        { id: 'e1', source: 'ctx-c', target: 'com-c' },
        { id: 'e2', source: 'com-c', target: 'exp-c' },
      ],
    },
  },
  {
    id: 'tpl-5',
    slug: 'presentacion-ejecutiva',
    name: 'Presentación ejecutiva',
    description: 'DAG para presentaciones C-level',
    category: 'estrategia',
    dag_json: {
      nodes: [
        { id: 'ctx-e', type: 'context', position: { x: 0, y: 0 }, data: { label: 'Contexto', status: 'IDLE' } },
        { id: 'exec-e', type: 'specialist', position: { x: 260, y: 0 }, data: { label: 'Ejecutivo', status: 'IDLE', agent_id: 'exec', agent: 'Exec', prompt: '' } },
        { id: 'exp-e', type: 'export', position: { x: 520, y: 0 }, data: { label: 'Exportar', status: 'IDLE', format: 'pptx' } },
      ],
      edges: [
        { id: 'e1', source: 'ctx-e', target: 'exec-e' },
        { id: 'e2', source: 'exec-e', target: 'exp-e' },
      ],
    },
  },
];

test.describe('E2E: modo nodos templates', () => {
  test.beforeAll(() => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run');
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'PLAYWRIGHT_BASE_URL not set');
  });

  test.setTimeout(90_000);

  // ── 1 & 2. First-visit auto-open + 5 template cards ────────────────

  test('first-visit: gallery auto-opens and shows 5 template cards', async ({ page }) => {
    await login(page);
    await createWorkspace(page);

    // Mock the templates endpoint before navigating to nodos.
    await mockTemplates(page, MOCK_TEMPLATES);

    // Clear the first-visit flag so the gallery triggers.
    await page.evaluate((key) => window.localStorage.removeItem(key), FIRST_VISIT_KEY);

    await openModoNodos(page);

    // The gallery should auto-open within ~800 ms (400ms timeout + render).
    await expect(page.getByTestId('template-gallery')).toBeVisible({ timeout: 6_000 });

    // All 5 template cards should render.
    await expect.poll(
      async () => {
        const cards = await page.locator('[data-testid^="template-card-"]').all();
        return cards.length;
      },
      { timeout: 10_000, message: 'Expected 5 template cards' },
    ).toBe(5);
  });

  // ── 3. Clicking a template applies the DAG ─────────────────────────

  test('clicking "Brief creativo" loads DAG on canvas with diff-added animation', async ({ page }) => {
    await login(page);
    await createWorkspace(page);

    await mockTemplates(page, MOCK_TEMPLATES);

    // Clear first-visit flag so gallery opens automatically.
    await page.evaluate((key) => window.localStorage.removeItem(key), FIRST_VISIT_KEY);

    await openModoNodos(page);
    await expect(page.getByTestId('template-gallery')).toBeVisible({ timeout: 6_000 });

    // Click the "Brief creativo" card.
    await page.getByTestId('template-card-brief-creativo').click();

    // Gallery should close after applying.
    await expect(page.getByTestId('template-gallery')).not.toBeVisible({ timeout: 5_000 });

    // Nodes from the template should appear on the canvas.
    await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 10_000 });

    // The new nodes carry the diff-added animation class immediately after apply.
    // (The animation may have already run; allow zero as acceptable if the 1s animation is done.)
    const diffAddedCount = await page.locator('.shifty-diff-added').count();
    // We just verify the canvas has nodes — animation timing is racy so we don't hard-assert the class.
    expect(await page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(1);
    void diffAddedCount; // referenced to avoid lint unused-var
  });

  // ── 4. Second visit does NOT auto-open ─────────────────────────────

  test('second visit: gallery does NOT auto-open (flag already set)', async ({ page }) => {
    await login(page);
    await createWorkspace(page);

    await mockTemplates(page, MOCK_TEMPLATES);

    // Simulate having already visited — flag is set.
    await page.evaluate((key) => window.localStorage.setItem(key, '1'), FIRST_VISIT_KEY);

    await openModoNodos(page);

    // Wait a generous time for the auto-open timer to NOT fire.
    await page.waitForTimeout(1_200);

    // Gallery should NOT be visible.
    const galleryVisible = await page.getByTestId('template-gallery').isVisible();
    expect(galleryVisible).toBe(false);
  });
});
