# Shifty Studio — Workspace Deploy Guide

Deploy guide for the Workspace ("Notebook") integration shipped in T1-T11
(branch `feat/workspace`, base commit `afab511`). Read this once before
the first production deploy; future deploys can skim the checklist.

---

## Pre-deploy checklist

Tick these in order. They map 1:1 to the audit gates that ran at T11.

- [ ] `.env.example` reviewed and the production env vars below are set
      in the Vercel dashboard (Project → Settings → Environment Variables).
- [ ] Migrations applied to Supabase project `lqrrtyqhlpupmjzydbck`
      via `infra/supabase/migrations/_apply_all_workspace.sql` (one-shot)
      or the three numbered files individually. Confirmed in Table Editor
      that `studio_workspaces`, `studio_workspace_nodes`,
      `studio_workspace_citations` exist and RLS shield is on for each.
- [ ] Storage bucket `studio-workspace-assets` exists in Supabase →
      Storage; public read is on; the four `studio_wsa_*` policies are
      visible.
- [ ] `npm run build` exits 0 locally. (Vercel will run it again, but it's
      cheaper to fail fast.)
- [ ] `npx tsc --noEmit` shows no NEW errors in the workspace surface
      (`src/routes/workspace.ts`, `src/services/{workspace*,peajeClient,
      puntoMedioClient,supabaseAdminClient,openRouterDirect,gammaApi}.ts`,
      `src/pages/Workspace*`). Pre-existing errors in `App.tsx` /
      `store/useGraphStoreV2.ts` are tracked but acceptable — see
      "Known issues" below.
- [ ] Cerebro smoke commands below all return 200.
- [ ] Vercel bridge `api/workspace/[...path].ts` is committed (without it
      the workspace 404s on the deployed site — see Vercel-vs-Express
      section).

---

## Required env vars

Set every entry in this table on Vercel (Production scope, and Preview
if you want PR previews to work end-to-end). Vars marked **(Vite)** are
embedded into the client bundle at build time — Vercel rebuilds when
you change them.

| Var                              | Required | Example value                                                  | Notes                                                                                                       |
| -------------------------------- | -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`             | yes      | `sk-or-v1-...`                                                 | Used by `transform`, `architect`, `turn`, and the legacy `/api/chat`. Without it those endpoints 503/500.    |
| `SUPABASE_URL`                   | yes      | `https://lqrrtyqhlpupmjzydbck.supabase.co`                     | Server-only.                                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`      | yes      | `eyJhbGciOi...`                                                | Server-only. NEVER set the same value to a `VITE_*` var — leaks the key into the browser bundle.            |
| `VITE_SUPABASE_URL` **(Vite)**   | yes      | `https://lqrrtyqhlpupmjzydbck.supabase.co`                     | Client anon key path. Same project, different key.                                                          |
| `VITE_SUPABASE_ANON_KEY` **(Vite)** | yes   | `eyJhbGciOi...`                                                | Anon key. RLS gates user data on the client side.                                                            |
| `SWARM_API_URL`                  | yes      | `https://shift-cerebro-production.up.railway.app`              | Cerebro Railway base URL. Fed to peajeClient + puntoMedioClient + the `/api/chat` proxy.                    |
| `CEREBRO_TENANT`                 | no       | `shift`                                                        | Default `shift`. Override only when the deploy is white-labeled.                                             |
| `CEREBRO_APP_ID`                 | no       | `studio`                                                       | Default `studio`. Multi-app v3 routing in Cerebro — do NOT change.                                          |
| `PEAJE_ENABLED`                  | no       | `true`                                                         | Kill switch. Set `false` to disable Peaje ingest without redeploy.                                          |
| `GAMMA_API_KEY`                  | yes (for pptx) | `gamma_...`                                              | Required for PPTX export. md/docx work without it.                                                          |
| `ARCHITECT_MODEL`                | no       | `google/gemini-2.5-flash`                                      | Override only to A/B test cheaper models.                                                                   |
| `TURN_CLASSIFIER_MODEL`          | no       | `google/gemini-2.5-flash`                                      | Same.                                                                                                       |
| `TURN_CHAT_MODEL`                | no       | `anthropic/claude-sonnet-4`                                    | Same.                                                                                                       |
| `TURN_EDIT_MODEL`                | no       | `google/gemini-2.5-flash`                                      | Same.                                                                                                       |
| `TRANSFORM_MODEL`                | no       | `google/gemini-2.5-flash`                                      | Same.                                                                                                       |
| `TRANSFORM_EXPAND_MODEL`         | no       | `anthropic/claude-sonnet-4`                                    | Same.                                                                                                       |
| `VITE_BYPASS_AUTH` **(Vite)**    | no       | `false`                                                        | Production MUST be `false`. Demo deploys may set `true` — also requires `STUDIO_ALLOW_ANON=true` server-side. |
| `STUDIO_ALLOW_ANON`              | no       | `false`                                                        | Production MUST be `false`. Pairs with `VITE_BYPASS_AUTH`.                                                  |
| `NODE_ENV`                       | yes      | `production`                                                   | Vercel sets it automatically on prod, but pin it explicitly so previews behave the same.                     |

---

## Apply migrations

```text
1. Open https://supabase.com/dashboard/project/lqrrtyqhlpupmjzydbck
2. SQL Editor → New query
3. Paste the entire contents of:
     infra/supabase/migrations/_apply_all_workspace.sql
4. Run. Verify in Table Editor that studio_workspaces,
   studio_workspace_nodes, studio_workspace_citations exist and have
   the RLS shield icon enabled.
5. Storage → confirm bucket "studio-workspace-assets" appears with
   public read on. The four policies (public_read, owner_write,
   owner_update, owner_delete) all start with `studio_wsa_` so they
   coexist safely with Brandhub's existing storage policies.
```

The bundled file is idempotent — re-running it is safe and a no-op on a
fully-migrated project. To roll back, follow the commented `-- DOWN
ROLLBACK` blocks in the source migrations in REVERSE order
(`0003 → 0002 → 0001`). The 0002 DOWN block has a warning: empty the
`studio-workspace-assets` bucket via the dashboard before deleting the
bucket row, or the DELETE will fail.

---

## Vercel-vs-Express path

Studio runs in two configurations and they are NOT identical:

| Path                          | Where it runs                          | What `/api/*` resolves to                                                          |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev` (`tsx server.ts`) | local machine, or any host that runs `node server.ts` (Railway/Render/Fly) | All routes mount inside `server.ts` — `/api/chat`, `/api/debate`, `/api/export`, `/api/workspace/*`. |
| Vercel (`vercel --prod`)        | serverless functions in `api/`         | Each file in `api/` becomes a function. `server.ts` is NOT executed.               |

This means:

- `/api/chat` → `api/chat.ts`
- `/api/debate` → `api/debate.ts`
- `/api/export` → `api/export.ts`
- `/api/workspace/*` → `api/workspace/[...path].ts` (the Vercel bridge —
  catch-all that mounts the Express `workspaceRouter` inside a one-shot
  Express app per cold start)

**Critical**: without `api/workspace/[...path].ts` every workspace request
404s on Vercel. The bridge is the only thing keeping the T1-T10 surface
alive in production. If you delete it, the whole Workspace mode dies on
the deployed site even though `npm run dev` keeps working.

### Streaming considerations

The `/:id/turn` endpoint returns SSE for `intent=chat`. Vercel
serverless functions cap response time at:

- **Hobby**: 10s
- **Pro**: 60s
- **Enterprise**: 900s

Long single turns may timeout. For demos that stay under a minute, Pro
is fine. For longer agentic sessions consider hosting Studio behind
`node server.ts` on Railway/Render/Fly instead — the Express path has
no such cap.

### Multipart upload caveat

`api/workspace/[...path].ts` exports `config.api.bodyParser = false`
because the workspace router uses `multer` for file uploads. Disabling
Vercel's body parser hands the raw stream to Express, which delegates
to `express.json()` for JSON bodies and `multer` for multipart. Both
work because the inner Express app re-parses based on Content-Type.

---

## Smoke test commands

Run these from any machine after deploy. Replace the studio URL with
your Vercel deployment if it's different.

```bash
# 1. Cerebro health
curl -s https://shift-cerebro-production.up.railway.app/health | head -c 200

# 2. Cerebro Peaje ingest accepts the body shape we send from Studio
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"app_id":"studio","tenantId":"shift","sessionId":"smoke","agentId":"shiftai","messages":[{"role":"user","content":"smoke"}],"response":"smoke","message_id":"smoke-1","upstream_model":"smoke"}' \
  --max-time 15 \
  https://shift-cerebro-production.up.railway.app/peaje/ingest

# 3. Cerebro Punto Medio RAG returns approved-only RAG for tenant 'shift'
curl -s --max-time 15 \
  https://shift-cerebro-production.up.railway.app/punto-medio/rag/shift | head -c 200

# 4. Studio Vercel deploy — workspace BFF responds (returns 401 unauthenticated, that's correct)
curl -s -w "\n%{http_code}\n" -X GET \
  https://<your-vercel-deploy>.vercel.app/api/workspace

# 5. Studio Vercel deploy — root SPA loads
curl -s -o /dev/null -w "%{http_code}\n" \
  https://<your-vercel-deploy>.vercel.app/
```

A 401 on (4) is **good** — it proves the bridge is wired and the auth
guard fires. A 404 means the bridge is missing or `vercel.json` is
swallowing the path.

---

## Known issues / pre-existing TS errors

These came in BEFORE T1 and are NOT regressions from the workspace
integration. They live on a separate code path (the older `Shifty Node
Canvas` graph builder) and don't break runtime — `vite build` does not
fail on them, and the workspace surface ships clean.

```text
src/App.tsx                     2 errors  — useActiveGraphStore signature
src/components/AgentStepper.tsx 2 errors  — same
src/components/animated-ai-input.tsx 3 errors — same
src/components/HITLModal.tsx    2 errors  — missing hitl props on store
src/components/nodes/*Node.tsx  6 errors  — store shape drift
src/components/ShiftyNodeCanvas.tsx 2 errors — same
src/components/top-dock.tsx     6 errors  — same
src/lib/lab-tests.ts            2 errors  — old test harness
src/lib/lab-tests-agency.ts     2 errors  — same
src/store/useGraphStoreV2.ts    8 errors  — store interface drift
                                ─────────
                                37 errors (all in graph-builder code path,
                                          0 in workspace surface)
```

To verify: `npx tsc --noEmit | grep -v "graph-builder"`. Workspace files
all clear. Track in a separate issue if the team wants to clean these
up; they don't block the demo.

### Bypass mode wiring (informational)

`src/services/workspaceApi.ts` only sends `Authorization: Bearer <jwt>`
+ `x-tenant-id` to the BFF. It does NOT send `x-user-id` even when
`VITE_BYPASS_AUTH=true`. In bypass mode the BFF therefore falls through
to `STUDIO_ALLOW_ANON` and uses the all-zero anon UUID. This is fine for
local demos but means production MUST keep both `VITE_BYPASS_AUTH` and
`STUDIO_ALLOW_ANON` set to `false` (or unset) — otherwise every user
shares the same anon workspace set. The deployed audit checklist above
already calls this out.
