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

## CI integration

`.github/workflows/ci.yml` runs four jobs:

- **typecheck** — `tsc --noEmit` on workspace surface (gates everything below)
- **smoke** — `npm run test:smoke` against production
- **security** — `npm run test:security` (P0 hotfix invariants)
- **build** — `npm run build` + bundle-size report
- **e2e** — runs `tests/e2e/` against the Vercel preview URL on every PR
  (gated on `typecheck` + `build`, skipped on push-to-main)

### E2E job — required GitHub secrets

The `e2e` job uses
[`patrickedqvist/wait-for-vercel-preview`](https://github.com/patrickedqvist/wait-for-vercel-preview)
to discover the preview URL once Vercel finishes deploying, then runs
`tests/e2e/login-and-create-workspace.spec.ts` against it.

Two repo secrets are required for the spec to actually exercise the login
flow (the spec auto-skips if either is missing — see
`test.skip(!EMAIL || !PASSWORD, ...)`):

| Secret               | Value                                              |
|----------------------|----------------------------------------------------|
| `E2E_TEST_EMAIL`     | Email of a managed Supabase auth user (`studio-test@shiftpn.com`) |
| `E2E_TEST_PASSWORD`  | That user's password                               |

Set both in **GitHub → repo → Settings → Secrets and variables → Actions**.

Create / rotate the test user from the Supabase Auth dashboard
(`Authentication → Users → Add user`) — keep the credentials only in the
GitHub secrets store and a 1Password / vault entry, never in the repo.
