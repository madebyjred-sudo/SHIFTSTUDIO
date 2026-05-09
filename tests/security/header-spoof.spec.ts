/**
 * Security invariants — verify P0 hotfix invariants are still in place.
 *
 * These tests would have CAUGHT the original C1 vulnerability where any
 * caller could set `x-user-id` and impersonate another user. After the
 * 2026-05-09 hotfix, x-user-id is:
 *   • Rejected in production by NODE_ENV gate
 *   • Removed from CORS Access-Control-Allow-Headers in production
 *
 * Regression-test: if any future change re-enables that header path,
 * this test fails immediately.
 */
import { test, expect } from '@playwright/test';

const PROD = 'https://shiftstudio.vercel.app';
const VICTIM_UUID = '00000000-0000-0000-0000-000000000999';

test.describe('Security: header-spoof invariants', () => {
  test('x-user-id header IS NOT honored in production', async ({ request }) => {
    // Spoofing attempt: craft a request as if we were 'victim' user.
    // Pre-hotfix this returned the victim's data. Post-hotfix → 401.
    const res = await request.get(`${PROD}/api/workspace`, {
      headers: { 'x-user-id': VICTIM_UUID },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('auth_required');
  });

  test('CORS preflight does NOT advertise x-user-id in production', async ({ request }) => {
    const res = await request.fetch(`${PROD}/api/workspace`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-user-id',
      },
    });
    const allowHeaders = res.headers()['access-control-allow-headers'] || '';
    // Production should ONLY allow Content-Type, Authorization, x-tenant-id.
    // x-user-id MUST be absent.
    expect(allowHeaders.toLowerCase()).not.toContain('x-user-id');
    expect(allowHeaders.toLowerCase()).toContain('authorization');
    expect(allowHeaders.toLowerCase()).toContain('x-tenant-id');
  });

  test('invalid Bearer JWT returns 401 (no fallthrough to header trust)', async ({ request }) => {
    // Pre-hotfix: invalid Bearer fell through to x-user-id branch.
    // Post-hotfix: invalid Bearer is hard-401, no fallthrough.
    const res = await request.get(`${PROD}/api/workspace`, {
      headers: {
        Authorization: 'Bearer invalid.jwt.token',
        'x-user-id': VICTIM_UUID,
      },
    });
    expect(res.status()).toBe(401);
  });

  test('CORS preflight from arbitrary origin gets restricted methods only', async ({ request }) => {
    const res = await request.fetch(`${PROD}/api/workspace`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    const allowMethods = res.headers()['access-control-allow-methods'] || '';
    // Should be the documented set, not wildcard.
    expect(allowMethods).toContain('GET');
    expect(allowMethods).toContain('POST');
    expect(allowMethods).not.toContain('TRACE');
    expect(allowMethods).not.toContain('CONNECT');
  });
});
