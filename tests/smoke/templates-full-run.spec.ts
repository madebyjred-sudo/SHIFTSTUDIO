/**
 * SMOKE — full template runs against PRODUCTION.
 *
 * For each of the 5 built-in Cerebro templates:
 *   1. Login + create workspace + switch to nodos mode
 *   2. Open template gallery + click template card → DAG loads
 *   3. Screenshot the canvas (template view)
 *   4. Click EJECUTAR → real LLM execution against prod
 *   5. Capture SSE events (node:start, node:complete, graph:done) via
 *      EventSource patch
 *   6. Screenshot the canvas (complete view)
 *   7. Save artifacts to test-results/templates-smoke/<slug>/:
 *        - template.png      (UI before execution)
 *        - complete.png      (UI after execution)
 *        - events.json       (raw SSE events)
 *        - outputs.json      (parsed per-node + totals)
 *
 * Run:
 *   E2E_TEST_EMAIL=... E2E_TEST_PASSWORD=... \
 *   PLAYWRIGHT_BASE_URL=https://shiftstudio.vercel.app \
 *   SMOKE_TEMPLATES_FULL=true \
 *   npx playwright test tests/smoke/templates-full-run.spec.ts --workers=1
 *
 * Cost notice: this hits REAL Cerebro production = real LLM tokens billed.
 * Skipped by default — set SMOKE_TEMPLATES_FULL=true to run.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, createWorkspace, openModoNodos } from '../e2e/helpers/auth';
import fs from 'node:fs/promises';
import path from 'node:path';

const ARTIFACT_ROOT = path.resolve('test-results/templates-smoke');

/**
 * Canonical 5 built-in Cerebro template slugs. Source:
 *   shift-cerebro/studio_graph/templates.py
 */
const TEMPLATE_SLUGS = [
  'brief-creativo',
  'plan-campana',
  'analisis-performance',
  'reporte-financiero',
  'pitch-ejecutivo',
];

/** Captured SSE event shape (parsed from EventSource patch). */
interface CapturedEvent {
  type: string;
  data: unknown;
  ts: number;
}

declare global {
  interface Window {
    __sseEvents?: CapturedEvent[];
    __captureSSE?: (event: CapturedEvent) => void;
  }
}

test.describe('SMOKE: full template runs', () => {
  test.beforeAll(() => {
    test.skip(!process.env.E2E_TEST_EMAIL, 'E2E_TEST_EMAIL required');
    test.skip(!process.env.E2E_TEST_PASSWORD, 'E2E_TEST_PASSWORD required');
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'PLAYWRIGHT_BASE_URL required');
    test.skip(
      process.env.SMOKE_TEMPLATES_FULL !== 'true',
      'Set SMOKE_TEMPLATES_FULL=true to run (hits real Cerebro = real $$$).',
    );
  });

  // Each template can take up to 90s to fully execute (5 specialists × ~15s each).
  test.setTimeout(180_000);

  for (const slug of TEMPLATE_SLUGS) {
    test(`template: ${slug}`, async ({ page }) => {
      const outDir = path.join(ARTIFACT_ROOT, slug);
      await fs.mkdir(outDir, { recursive: true });

      // ─── Patch EventSource to capture SSE events ──────────────────
      // Must run before any app code loads its own EventSource.
      await page.addInitScript(() => {
        window.__sseEvents = [];
        const Original = window.EventSource;
        const PatchedES = function (
          this: EventSource,
          url: string | URL,
          opts?: EventSourceInit,
        ) {
          const es = new Original(url, opts);
          const events = [
            'node:start',
            'node:complete',
            'graph:done',
            'graph:error',
            'graph:cancelled',
            'replay:start',
            'replay:complete',
          ];
          for (const name of events) {
            es.addEventListener(name, (ev: MessageEvent) => {
              try {
                const parsed = JSON.parse(ev.data);
                window.__sseEvents!.push({
                  type: name,
                  data: parsed,
                  ts: Date.now(),
                });
              } catch {
                window.__sseEvents!.push({
                  type: name,
                  data: ev.data,
                  ts: Date.now(),
                });
              }
            });
          }
          return es;
        };
        // Preserve static + prototype shape.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (PatchedES as any).CONNECTING = Original.CONNECTING;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (PatchedES as any).OPEN = Original.OPEN;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (PatchedES as any).CLOSED = Original.CLOSED;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).EventSource = PatchedES;
      });

      // ─── Login + workspace + nodos mode ───────────────────────────
      await login(page);
      await createWorkspace(page);
      await openModoNodos(page);

      // ─── Open template gallery + click target template ────────────
      // Click the "+ TEMPLATE" trigger directly — no reload dance, no
      // dependence on first-visit auto-open localStorage logic.
      const gallery = page.getByTestId('template-gallery');
      const visible = await gallery.isVisible().catch(() => false);
      if (!visible) {
        await page.getByTestId('open-template-gallery').click();
        await expect(gallery).toBeVisible({ timeout: 10_000 });
      }

      // Click the target template card.
      await page.getByTestId(`template-card-${slug}`).click();

      // Wait for nodes to render + diff animation to settle (~1.2s).
      await expect.poll(
        async () => await page.locator('.react-flow__node').count(),
        { timeout: 15_000, message: `Template ${slug}: expected nodes to render` },
      ).toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(1500);

      // ─── Screenshot template view ─────────────────────────────────
      await page.screenshot({
        path: path.join(outDir, 'template.png'),
        fullPage: true,
      });

      // ─── Execute the graph ────────────────────────────────────────
      // The EJECUTAR button is `data-testid="graph-run-button"`.
      const runBtn = page.getByTestId('graph-run-button');
      await expect(runBtn).toBeVisible({ timeout: 5_000 });
      await runBtn.click();

      // ─── Wait for graph:done (or graph:error) ─────────────────────
      // Templates have 3-5 specialists × ~15s each → up to ~90s.
      const terminalEvent = await page.waitForFunction(
        () => {
          const evs = window.__sseEvents ?? [];
          return evs.find(
            (e) => e.type === 'graph:done' || e.type === 'graph:error',
          );
        },
        null,
        { timeout: 150_000 },
      );
      const terminal = (await terminalEvent.jsonValue()) as CapturedEvent;

      // Brief pause so the UI commits the final node colors.
      await page.waitForTimeout(2000);

      // ─── Screenshot complete view ─────────────────────────────────
      await page.screenshot({
        path: path.join(outDir, 'complete.png'),
        fullPage: true,
      });

      // ─── Dump events + parsed outputs ─────────────────────────────
      const events = (await page.evaluate(() => window.__sseEvents ?? [])) as CapturedEvent[];
      await fs.writeFile(
        path.join(outDir, 'events.json'),
        JSON.stringify(events, null, 2),
      );

      const nodeStarts = events.filter((e) => e.type === 'node:start');
      const nodeCompletes = events.filter((e) => e.type === 'node:complete');
      const doneEvent = events.find((e) => e.type === 'graph:done');
      const errorEvent = events.find((e) => e.type === 'graph:error');

      const outputs = {
        slug,
        ran_at: new Date().toISOString(),
        terminal_status: terminal.type,
        node_starts: nodeStarts.map((e) => e.data),
        node_completes: nodeCompletes.map((e) => e.data),
        graph_done: doneEvent?.data ?? null,
        graph_error: errorEvent?.data ?? null,
        wall_clock_ms: nodeStarts.length
          ? terminal.ts - nodeStarts[0].ts
          : null,
      };
      await fs.writeFile(
        path.join(outDir, 'outputs.json'),
        JSON.stringify(outputs, null, 2),
      );

      // Don't fail the test on graph:error — the report should show the
      // failure mode for visibility. Just assert SSE flowed at all.
      expect(events.length).toBeGreaterThan(0);
    });
  }
});
