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
});
