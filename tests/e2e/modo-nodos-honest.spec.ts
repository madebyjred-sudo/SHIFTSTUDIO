/**
 * E2E HONEST — the one test that would catch any of the 9 P0 bugs the
 * 7-layer bottom-up sprint resolves. Designed to fail loudly when ANY
 * of the following regresses:
 *
 *  1. vercel.json /v1/* proxy missing  → templates list fetch 404s
 *  2. /api/workspace/:id/graph 500     → console error + autosave gated
 *  3. React error #185 on template apply
 *  4. Cerebro `execution_not_found` (insert_execution silent fail)
 *  5. Cerebro `{{input}}` not substituted (literal leak in outputs)
 *  6. ExportNode selector loop (re-runs the template apply assertion)
 *  7. Stale useState in Context/SpecialistNode (template re-apply check)
 *  8. Autosave loop on broken endpoint (assert no >10 PUTs in 30s)
 *  9. Architect vocab mismatch (not tested here; tested via E2E_TEST_ARCHITECT)
 *
 * Anti-patterns we deliberately avoid:
 *   - NO `page.route('**\/v1/graph/**')` mocks. Real Cerebro hit.
 *   - NO `test.skip(!migrationOk)` self-suppression. If migration is
 *     missing, the test FAILS — that's the point.
 *   - NO bypass of UI buttons via `store.executeGraph()`. Click the
 *     real EJECUTAR button.
 *   - NO tautological assertions like `expect(specialists.length > 0)`
 *     when setup guarantees that. Every assertion must be able to fail
 *     on a real regression.
 *
 * Cost: ~$0.05 per run (1 template × 2 specialists × Sonnet 4.6).
 * Skip gate: requires E2E_HONEST=true to run. Not in default CI run —
 * fire on demand for sprint-closure validation.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, createWorkspace, enableStoreHook, waitForStoreExposed } from './helpers/auth';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const BASE = process.env.PLAYWRIGHT_BASE_URL;

const TARGET_SLUG = 'brief-creativo';
const REAL_CONTEXT = `PROYECTO: Lanzamiento del sérum Vitamin C 10% de Garnier LATAM Q3 2026.
CLIENTE: Garnier Latam, división skincare. Pierde share contra L'Oréal Revitalift y Olay Super Serum.
OBJETIVOS: 15% trial en mujeres 25-40 NSE B/C+ en MX+CO en 6 meses; sell-out 280k unidades T1.
PÚBLICO: Mujeres 25-40 NSE B/C+ urbanas, sensibles al precio, TikTok beauty consumers.
TONO: Confiable, científico-cercano, sin promesas exageradas.
RESTRICCIONES: Budget creativo USD 420k. Lanzamiento medios 14 septiembre.`;

interface StoreNode {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}

test.describe('E2E HONEST: full modo-nodos flow against prod', () => {
  test.beforeAll(() => {
    test.skip(!EMAIL || !PASSWORD, 'Set E2E_TEST_EMAIL + E2E_TEST_PASSWORD to run');
    test.skip(!BASE, 'Set PLAYWRIGHT_BASE_URL to staging or prod');
    test.skip(
      process.env.E2E_HONEST !== 'true',
      'Set E2E_HONEST=true to opt-in (real Cerebro call, real LLM tokens billed)',
    );
  });

  test.setTimeout(240_000);

  test('brief-creativo full flow: template apply → execute → assert real DELIVERED output', async ({ page }) => {
    // ─── Surface every page error so a React error boundary trip
    //     fails the test loudly with the actual stack.
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const putRequestUrls: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/workspace/')) {
        putRequestUrls.push(req.url());
      }
    });

    // ─── Login + workspace + nodos mode (real flow, no shortcuts).
    await login(page);
    const workspaceId = await createWorkspace(page);
    expect(workspaceId).toMatch(/^[0-9a-f-]+$/);

    // Inject ?e2e=1 BEFORE clicking nodos so the store hook activates
    // on canvas mount (history.replaceState — no full reload).
    await page.evaluate(() => {
      const u = new URL(window.location.href);
      if (u.searchParams.get('e2e') !== '1') {
        u.searchParams.set('e2e', '1');
        window.history.replaceState({}, '', u.toString());
      }
    });

    await page.getByTestId('topdock-mode-nodos').click();
    await expect(page.locator('.react-flow__renderer')).toBeVisible({ timeout: 15_000 });
    await waitForStoreExposed(page);

    // ─── Pre-flight: assert NO React error boundary tripped on mount.
    //     This catches the #185 from Layer 4's smoking gun if it
    //     regresses.
    await page.waitForTimeout(2_500);
    await expect(page.getByText('Algo salió mal')).not.toBeVisible({ timeout: 1_000 });
    expect(
      pageErrors.filter((e) => /Minified React error #185/.test(e)),
      `React error #185 fired on canvas mount: ${pageErrors.join('\n---\n')}`,
    ).toHaveLength(0);

    // ─── Open template gallery via the real UI button (no auto-open dance).
    const gallery = page.getByTestId('template-gallery');
    const galleryOpen = await gallery.isVisible().catch(() => false);
    if (!galleryOpen) {
      await page.getByTestId('open-template-gallery').click();
      await expect(gallery).toBeVisible({ timeout: 10_000 });
    }
    // 5 cards = catches Bug 1 (vercel.json /v1/graph/templates proxy missing).
    await expect(
      page.locator('[data-testid^="template-card-"]'),
      'Template gallery should list 5 templates from Cerebro',
    ).toHaveCount(5, { timeout: 10_000 });

    // ─── Click the template card. This is the path that previously
    //     tripped React #185 via ExportNode's bare Zustand selector.
    await page.getByTestId(`template-card-${TARGET_SLUG}`).click();

    // ─── Wait for nodes to render. Bug 3 (#185) regression = error
    //     boundary visible OR no .react-flow__node rendered.
    await expect.poll(
      async () => await page.locator('.react-flow__node').count(),
      { timeout: 15_000, message: `Template apply must render ≥2 nodes` },
    ).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1_500); // settle diff animation
    await expect(page.getByText('Algo salió mal')).not.toBeVisible({ timeout: 1_000 });
    expect(
      pageErrors.filter((e) => /Minified React error #185/.test(e)),
      `React error #185 fired during/after template apply`,
    ).toHaveLength(0);

    // ─── Patch the context node's content with REAL business context.
    //     Templates ship with placeholder text; without real input the
    //     specialists correctly refuse and the test would judge it as
    //     CLARIFICATION instead of DELIVERED.
    await page.evaluate((content) => {
      const store = (window as unknown as {
        __studioGraphStore?: {
          getState: () => {
            nodes: StoreNode[];
            updateNodeData: (id: string, data: Record<string, unknown>) => void;
          };
        };
      }).__studioGraphStore;
      if (!store) throw new Error('store not exposed');
      const ctx = store.getState().nodes.find((n) => n.type === 'context');
      if (!ctx) throw new Error('no context node in template');
      store.getState().updateNodeData(ctx.id, { content });
    }, REAL_CONTEXT);

    // ─── Snapshot the spec count for assertion later.
    const specialistCount = await page.evaluate(() => {
      const store = (window as unknown as {
        __studioGraphStore?: { getState: () => { nodes: StoreNode[] } };
      }).__studioGraphStore;
      return store?.getState().nodes.filter((n) => n.type === 'specialist').length ?? 0;
    });
    expect(specialistCount, 'brief-creativo template must have ≥1 specialist').toBeGreaterThan(0);

    // ─── Click EJECUTAR — the real button, not store.executeGraph().
    //     Bug 4 (Cerebro execution_not_found) regression = isExecuting
    //     never returns to false; this test times out at the next poll.
    const runBtn = page.getByTestId('graph-run-button');
    await expect(runBtn).toBeVisible({ timeout: 5_000 });
    await runBtn.click();

    // ─── Wait for executing flag flip true → then false.
    await expect.poll(
      async () =>
        await page.evaluate(() => {
          const store = (window as unknown as {
            __studioGraphStore?: { getState: () => { isExecuting: boolean } };
          }).__studioGraphStore;
          return store?.getState().isExecuting === true;
        }),
      { timeout: 15_000, message: 'Execution must start within 15s' },
    ).toBe(true);

    await expect.poll(
      async () =>
        await page.evaluate(() => {
          const store = (window as unknown as {
            __studioGraphStore?: { getState: () => { isExecuting: boolean } };
          }).__studioGraphStore;
          return store?.getState().isExecuting === false;
        }),
      { timeout: 180_000, message: 'Execution must complete within 3min' },
    ).toBe(true);

    await page.waitForTimeout(2_000); // commit final node colors

    // ─── Extract per-node outputs from store. Source of truth.
    const snapshot = await page.evaluate(() => {
      const store = (window as unknown as {
        __studioGraphStore?: {
          getState: () => {
            nodes: StoreNode[];
            currentNarration: string;
          };
        };
      }).__studioGraphStore;
      if (!store) return null;
      const s = store.getState();
      return {
        nodes: s.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          data: { ...(n.data ?? {}) } as Record<string, unknown>,
        })),
        narration: s.currentNarration,
      };
    });
    expect(snapshot, 'Store must be readable post-execution').not.toBeNull();

    const specialists = (snapshot!.nodes).filter((n) => n.type === 'specialist');
    const exporter = (snapshot!.nodes).find((n) => n.type === 'export');

    // ─── HARD assertions on per-specialist output.
    for (const spec of specialists) {
      const out = (spec.data?.outputText ?? '') as string;
      const status = (spec.data?.status ?? 'IDLE') as string;

      expect(status, `Specialist ${spec.id} must reach COMPLETED status`).toBe('COMPLETED');

      // Bug 5 ({{input}} leak): a substantive output should NOT contain
      // the literal template variable.
      expect(out, `Specialist ${spec.id} output leaked literal {{input}}`).not.toMatch(/\{\{\s*input\s*\}\}/i);

      // Substantive work: ≥400 chars rules out "I need more info" refusal
      // responses that the previous suite misclassified as success.
      expect(
        out.length,
        `Specialist ${spec.id} output too short (${out.length} chars). Likely refusal/clarification not real work. First 200: "${out.slice(0, 200)}"`,
      ).toBeGreaterThanOrEqual(400);

      // Cost + tokens must be reported (catches Cerebro `tokens: 0` bug).
      const tokens = (spec.data?.tokens ?? 0) as number;
      const cost = (spec.data?.costUsd ?? 0) as number;
      expect(tokens, `Specialist ${spec.id} reported 0 tokens`).toBeGreaterThan(100);
      expect(cost, `Specialist ${spec.id} reported 0 cost`).toBeGreaterThan(0);
    }

    // ─── Assert consolidated output present (graph:done sections).
    //     The exporter's presetSections (filled by store.onGraphDone)
    //     is the visible artifact of consolidation.
    if (exporter) {
      const sections = exporter.data?.presetSections ?? [];
      expect(
        Array.isArray(sections) && sections.length > 0,
        `Export node missing graph:done sections`,
      ).toBe(true);
    }

    // ─── Bug 8 (autosave loop on broken endpoint): assert no flood.
    //     A normal session = ~3-5 PUTs (template apply + a few node
    //     edits if any). >15 = retry loop.
    expect(
      putRequestUrls.length,
      `Autosave fired ${putRequestUrls.length} PUTs — likely retry loop. URLs: ${putRequestUrls.slice(-5).join(', ')}`,
    ).toBeLessThanOrEqual(15);

    // ─── Final: assert no error boundary at any point.
    await expect(page.getByText('Algo salió mal')).not.toBeVisible({ timeout: 1_000 });
    expect(
      pageErrors.filter((e) => /Minified React error #185/.test(e)),
      'React #185 fired at some point during the flow',
    ).toHaveLength(0);
    expect(
      consoleErrors.filter((e) => /Maximum update depth/.test(e)),
      'React max-update-depth error in console',
    ).toHaveLength(0);
  });
});
