# Tests

Three test suites, run independently or together.

```bash
npm run test:smoke      # production reachability (read-only HTTP probes)
npm run test:security   # P0 hotfix invariants (header-spoof rejection, CORS)
npm run test:e2e        # full user flow against Vercel preview
npm test                # all of the above
```

## Suites

### `tests/smoke/`

Read-only HTTP probes against `https://shiftstudio.vercel.app`. Verify
every workspace endpoint returns 401 (auth gate alive) and SPA assets
serve. Run on every push to main + nightly cron.

**No auth required**, no test user needed. Safe to run from CI.

### `tests/security/`

Regression tests for the P0 security hotfix (2026-05-09). Verifies:

- `x-user-id` header spoofing returns 401 (not victim's data)
- CORS allow-headers in production excludes `x-user-id`
- Invalid Bearer JWT returns 401 (no fallthrough to header trust)
- CORS doesn't expose dangerous methods (TRACE, CONNECT)

If any of these tests fail, **a security regression has shipped**.
Fail-loud: don't merge to main until they go green.

### `tests/e2e/`

Full user flows. Requires:

```bash
export E2E_TEST_EMAIL=studio-test@shiftpn.com
export E2E_TEST_PASSWORD='your-test-pwd'
export PLAYWRIGHT_BASE_URL=https://shiftstudio-git-<branch>-<team>.vercel.app
npm run test:e2e
```

Skips itself if env vars aren't set, so CI can run conditionally.

## Adding tests

Priority list (in risk order, per audit 2026-05-09):

1. ✅ Cross-tenant workspace fetch returns 404
2. ✅ Header-spoof rejected (security suite)
3. ⏳ Asset import — userId-prefixed object path
4. ⏳ MIME allowlist enforced
5. ⏳ /turn classifier confidence < 0.7 → falls through to chat
6. ⏳ /turn classifier malformed JSON → safe chat fallback
7. ⏳ /architect empty/under-min content → 5xx with stable code
8. ⏳ /architect JSON parser handles markdown-wrapped JSON
9. ⏳ ChatPanel storageKeyFor namespaces by workspaceId
10. ⏳ Citations endpoint — pinning to foreign node returns 404

✅ done • ⏳ pending

## CI integration (TODO)

GitHub Actions workflow `.github/workflows/ci.yml` (not shipped yet):

```yaml
on: [pull_request, push]
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx playwright install chromium --with-deps
      - run: npm run test:smoke
      - run: npm run test:security
```

Add E2E job once we have a managed test user and Vercel preview URL.
