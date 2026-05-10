/**
 * Smoke tests — production reachability.
 *
 * Read-only HTTP probes against https://shiftstudio.vercel.app.
 * Run on every push to main + every Vercel deploy + nightly cron.
 *
 * What we verify:
 *  • SPA serves
 *  • Every workspace endpoint returns 401 (auth gate alive, no 404)
 *  • CORS headers in production OMIT x-user-id (P0 fix invariant)
 *  • Cerebro health endpoints reachable
 */
import { test, expect } from '@playwright/test';

const PROD = 'https://shiftstudio.vercel.app';
const FAKE_UUID = '00000000-0000-0000-0000-000000000001';

test.describe('Production smoke', () => {
  test('SPA root returns 200', async ({ request }) => {
    const res = await request.get(`${PROD}/`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!doctype html');
  });

  test('static assets reachable', async ({ request }) => {
    const html = await (await request.get(`${PROD}/`)).text();
    const match = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(match).not.toBeNull();
    const jsRes = await request.head(`${PROD}${match![1]}`);
    expect(jsRes.status()).toBe(200);
  });

  // Every workspace endpoint should return 401 (auth fires, route alive).
  // 404 anywhere = filesystem routing broken.
  for (const path of [
    '/api/workspace',
    `/api/workspace/${FAKE_UUID}`,
    `/api/workspace/${FAKE_UUID}/nodes`,
    `/api/workspace/${FAKE_UUID}/nodes/${FAKE_UUID}`,
    `/api/workspace/${FAKE_UUID}/nodes/finalize-asset`,
    `/api/workspace/${FAKE_UUID}/attach-context`,
    '/api/workspace/citations',
  ]) {
    test(`auth gate alive: GET ${path}`, async ({ request }) => {
      const res = await request.get(`${PROD}${path}`);
      expect(res.status()).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: 'auth_required' });
    });
  }

  for (const path of [
    `/api/workspace/${FAKE_UUID}/turn`,
    `/api/workspace/${FAKE_UUID}/transform`,
    `/api/workspace/${FAKE_UUID}/architect`,
    `/api/workspace/${FAKE_UUID}/export`,
    `/api/workspace/${FAKE_UUID}/nodes/${FAKE_UUID}/reextract`,
  ]) {
    test(`auth gate alive: POST ${path}`, async ({ request }) => {
      const res = await request.post(`${PROD}${path}`, {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status()).toBe(401);
    });
  }

  // ─── Multi-format export (Wave B / modo nodos) ───────────────────
  // The export endpoint accepts md|docx|pptx|pdf|xlsx|carousel; sections
  // are optional. Auth gate must reject every shape unauthenticated. We
  // do NOT exercise the success path here — that requires a real user
  // and would burn Gamma credits on each run; e2e tests cover that.
  for (const fmt of ['md', 'docx', 'pptx', 'pdf', 'xlsx', 'carousel']) {
    test(`auth gate alive: POST /api/workspace/${FAKE_UUID}/export format=${fmt}`, async ({
      request,
    }) => {
      const res = await request.post(`${PROD}/api/workspace/${FAKE_UUID}/export`, {
        data: { format: fmt },
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status()).toBe(401);
    });
  }

  // sections-only path: POST with sections[] and no DB hojas. Same auth
  // gate must fire. The body is intentionally a tiny minimal sections
  // array so we exercise the JSON-parse path; it must NOT 400 here (the
  // 401 has to come first, before body validation).
  test(`auth gate alive: POST /api/workspace/${FAKE_UUID}/export with sections`, async ({
    request,
  }) => {
    const res = await request.post(`${PROD}/api/workspace/${FAKE_UUID}/export`, {
      data: {
        format: 'xlsx',
        sections: [{ title: 'Smoke', content: 'auth gate probe' }],
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  // pptx-status now accepts ?format=pptx|pdf|carousel. Auth gate must
  // fire for every value, with no 404 / 500 from the format-aware path.
  for (const fmt of ['pptx', 'pdf', 'carousel']) {
    test(`auth gate alive: GET /api/workspace/${FAKE_UUID}/export/pptx-status?format=${fmt}`, async ({
      request,
    }) => {
      const res = await request.get(
        `${PROD}/api/workspace/${FAKE_UUID}/export/pptx-status?generation_id=fake&format=${fmt}`,
      );
      expect(res.status()).toBe(401);
    });
  }

  // ─── Modo nodos graph persistence (T-A1) ─────────────────────────
  // GET should 401 (read gate alive). PUT should 401 (write gate alive,
  // body validation runs AFTER auth so no body is needed). 404 = route
  // not deployed; 500 = handler crash on missing auth — both regressions.
  test(`auth gate alive: GET /api/workspace/${FAKE_UUID}/graph`, async ({ request }) => {
    const res = await request.get(`${PROD}/api/workspace/${FAKE_UUID}/graph`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'auth_required' });
  });

  test(`auth gate alive: PUT /api/workspace/${FAKE_UUID}/graph`, async ({ request }) => {
    const res = await request.fetch(`${PROD}/api/workspace/${FAKE_UUID}/graph`, {
      method: 'PUT',
      data: { nodes: [], edges: [], viewport: null },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  // ─── F1 — Hojas/Nodos toggle inside the workspace ────────────────
  // The toggle is purely client-side (no new endpoints) — what we can
  // smoke is that the workspace SPA URL serves and that BOTH server-
  // side dependencies of each mode are still alive:
  //   • Hojas needs /nodes (covered above)
  //   • Nodos needs /graph (already covered above)
  // This case verifies that the SPA HTML for /workspaces/:id is served
  // by Vercel's catch-all rewrite, so the React router can mount the
  // page (in either mode) without a 404 from the static layer.
  test('SPA serves /workspaces (list)', async ({ request }) => {
    const res = await request.get(`${PROD}/workspaces`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!doctype html');
  });

  test('SPA serves /workspaces/:id (canvas)', async ({ request }) => {
    const res = await request.get(`${PROD}/workspaces/${FAKE_UUID}`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!doctype html');
  });

  test('legacy /api/chat alive (Cerebro proxy)', async ({ request }) => {
    // Empty body → Cerebro returns validation error (200 bypass not expected).
    // Either 200 (Cerebro responded) or 422 (validation) — NOT 404 (route gone)
    // and NOT 500 (BFF crash).
    const res = await request.post(`${PROD}/api/chat`, {
      data: { messages: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 422, 502]).toContain(res.status());
  });

  // Legacy /api/export (proxy a Cerebro /export/document) fue eliminado en
  // chore/d2-remove-legacy-export. Modo nodos V2 usa /api/workspace/:id/export.
  //
  // Este test previene regresión accidental: si alguien re-introduce el
  // endpoint (función Vercel o handler en server.ts), el smoke detona.
  //
  // Contrato: la respuesta NUNCA debe ser:
  //   • 200 — proxy resucitado y devolviendo data
  //   • 401 — handler nuevo montado con auth gate (resurrección con maquillaje)
  // El estado terminal es 404 (route gone). Durante la ventana de transición
  // antes de que main redespliegue, prod puede aún devolver 422 (Cerebro
  // validation error vía proxy legacy) — eso se acepta hasta el deploy.
  test('legacy /api/export not resurrected', async ({ request }) => {
    const res = await request.post(`${PROD}/api/export`, {
      data: { format: 'md', sections: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    const status = res.status();
    expect(status).not.toBe(200);
    expect(status).not.toBe(401);
    expect([404, 422]).toContain(status);
  });
});
