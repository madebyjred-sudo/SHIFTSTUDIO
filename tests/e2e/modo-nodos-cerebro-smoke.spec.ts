/**
 * E2E — modo nodos: Cerebro server-side smoke tests.
 *
 * Uses Playwright's `request` API (no browser page) to hit Cerebro
 * production directly. Verifies the three graph endpoints are live and
 * return the expected shapes.
 *
 *   1. GET /v1/graph/templates → 200, templates.length === 5
 *   2. POST /v1/graph/execute with valid body → 200, status:"started" + sse_url
 *   3. POST /v1/graph/execute with enable_memory:true but missing realm/user_id → 422
 *
 * REQUIRED env to run (both must be set):
 *   E2E_REAL_NETWORK=true
 *   CEREBRO_API_KEY  OR  skip
 *
 * The tests are skipped entirely unless E2E_REAL_NETWORK=true, so they
 * never run in CI without explicit opt-in. They do NOT use a browser.
 */
import { test, expect } from '@playwright/test';

const CEREBRO_BASE = 'https://shift-cerebro-production.up.railway.app';
const CEREBRO_API_KEY = process.env.CEREBRO_API_KEY;
const E2E_REAL_NETWORK = process.env.E2E_REAL_NETWORK === 'true';

// Shared auth headers (if API key is available)
function authHeaders(): Record<string, string> {
  if (CEREBRO_API_KEY) {
    return { Authorization: `Bearer ${CEREBRO_API_KEY}` };
  }
  return {};
}

test.describe('E2E: Cerebro smoke (server-side)', () => {
  test.beforeAll(() => {
    test.skip(
      !E2E_REAL_NETWORK,
      'E2E_REAL_NETWORK not set — server-side smoke skipped',
    );
  });

  test.setTimeout(30_000);

  // ── 1. Templates endpoint ───────────────────────────────────────────

  test('GET /v1/graph/templates returns 200 with templates.length === 5', async ({ request }) => {
    const res = await request.get(`${CEREBRO_BASE}/v1/graph/templates`, {
      params: { tenant_id: 'shift' },
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    // The endpoint may wrap the array in { templates: [...] } or return
    // the array directly — handle both shapes.
    const templates: unknown[] = Array.isArray(body) ? body : (body?.templates ?? []);
    expect(templates).toHaveLength(5);
  });

  // ── 2. Execute endpoint — valid body ────────────────────────────────

  test('POST /v1/graph/execute with valid body returns 200 + status:"started" + sse_url', async ({ request }) => {
    const nodes = [
      {
        id: 'ctx-smoke',
        type: 'context',
        position: { x: 0, y: 0 },
        data: { label: 'Smoke context', status: 'IDLE' },
      },
      {
        id: 'spec-smoke',
        type: 'specialist',
        position: { x: 260, y: 0 },
        data: {
          label: 'Smoke specialist',
          status: 'IDLE',
          agent_id: 'shiftai',
          agent: 'ShiftAI',
          prompt: 'Escribí una oración de prueba de smoke.',
        },
      },
      {
        id: 'exp-smoke',
        type: 'export',
        position: { x: 520, y: 0 },
        data: { label: 'Exportar', status: 'IDLE', format: 'docx' },
      },
    ];

    const edges = [
      { id: 'e1', source: 'ctx-smoke', target: 'spec-smoke' },
      { id: 'e2', source: 'spec-smoke', target: 'exp-smoke' },
    ];

    const res = await request.post(`${CEREBRO_BASE}/v1/graph/execute`, {
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'shift',
        ...authHeaders(),
      },
      data: {
        app_id: 'shiftai',
        workspace_id: 'e2e-smoke-workspace',
        nodes,
        edges,
        realm: 'shift',
        user_id: 'test@e2e.shift.com',
        enable_memory: true,
      },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    // Accept snake_case or camelCase — Cerebro returns snake_case
    const status = body?.status ?? body?.state;
    expect(status).toBe('started');

    const sseUrl = body?.sse_url ?? body?.sseUrl;
    expect(typeof sseUrl).toBe('string');
    expect((sseUrl as string).length).toBeGreaterThan(0);
  });

  // ── 3. Execute endpoint — memory without realm/user_id → 422 ───────

  test('POST /v1/graph/execute with enable_memory:true but no realm/user_id returns 422', async ({ request }) => {
    const res = await request.post(`${CEREBRO_BASE}/v1/graph/execute`, {
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'shift',
        ...authHeaders(),
      },
      data: {
        app_id: 'shiftai',
        workspace_id: 'e2e-smoke-workspace',
        nodes: [
          {
            id: 'ctx-422',
            type: 'context',
            data: { label: 'Context', status: 'IDLE' },
          },
          {
            id: 'spec-422',
            type: 'specialist',
            data: { label: 'Specialist', status: 'IDLE', agent_id: 'shiftai', prompt: 'test' },
          },
          {
            id: 'exp-422',
            type: 'export',
            data: { label: 'Export', status: 'IDLE', format: 'docx' },
          },
        ],
        edges: [
          { id: 'e1', source: 'ctx-422', target: 'spec-422' },
          { id: 'e2', source: 'spec-422', target: 'exp-422' },
        ],
        // enable_memory: true but NO realm / user_id supplied
        enable_memory: true,
      },
    });

    // Cerebro should reject with 422 Unprocessable Entity when
    // enable_memory is true but the required realm + user_id are absent.
    expect(res.status()).toBe(422);
  });
});
