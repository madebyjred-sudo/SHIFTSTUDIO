# Shifty Studio — Supabase migrations

SQL migrations for Shifty Studio's Workspace ("Notebook") mode. Apply against
the shared Supabase project `lqrrtyqhlpupmjzydbck` (also hosts Brandhub and
will eventually host CL2). All Studio-owned tables are prefixed `studio_`
to avoid collisions with sibling apps.

## Two mirrored locations

This repo holds the migrations in two places:

- **`supabase/migrations/`** — Supabase CLI canonical location with
  `YYYYMMDDhhmmss_*.sql` timestamp prefixes. Picked up by
  `supabase db push --linked`. **This is the source of truth.**
- **`infra/supabase/migrations/`** — documentation mirror with sequential
  `NNNN_*.sql` prefixes. Easier to read in order; used by the
  `_apply_all_workspace.sql` bundle for one-shot manual applies via the
  Supabase SQL editor.

When adding a new migration, place it in **both** locations and regenerate
`infra/supabase/migrations/_apply_all_workspace.sql` to include the new
file appended at the end.

## Files

Apply in numeric order. Each file is idempotent (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ON CONFLICT … DO UPDATE`, guarded `pg_policies`
checks), so reruns are safe.

| #    | File                                                       | What it does                                                                                                       |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0001 | `0001_studio_workspace.sql`                                | Creates `studio_workspaces`, `studio_workspace_nodes`, `studio_workspace_citations` + RLS + `updated_at` triggers  |
| 0002 | `0002_studio_workspace_asset_types.sql`                    | Extends node types (`image`, `document`, `audio`) and provisions the `studio-workspace-assets` storage bucket + RLS |
| 0003 | `0003_studio_workspace_pptx_cache.sql`                     | Adds `last_pptx jsonb` column on `studio_workspaces` for Gamma export cache                                        |
| 0004 | `0004_raise_studio_assets_size_cap.sql`                    | Raises bucket cap 100MB → 500MB so large PDFs no longer 413                                                         |
| 0005 | `0005_studio_workspace_chat_messages.sql`                  | Creates `studio_workspace_chat_messages` for permanent chat history (per workspace + user)                          |
| 0006 | `0006_studio_workspace_chat_messages_fk_userid.sql`        | Adds missing FK `studio_workspace_chat_messages.user_id → auth.users(id) ON DELETE CASCADE`                         |
| 0007 | `0007_studio_workspace_citations_dedup_per_workspace.sql`  | Adds `workspace_id` column and tightens citation dedup to `(user_id, workspace_id, chunk_id)`                       |
| 0008 | `0008_studio_ai_call_log.sql`                              | Creates `studio_ai_call_log` for per-LLM-call cost + token telemetry (Phase 3.B Studio-side cost attribution)        |
| 0009 | `0009_architect_advisory_lock.sql`                         | Adds `studio_architect_insert_with_offset()` — advisory-lock helper that serializes concurrent `/architect` runs on the same workspace |
| 0010 | `0010_studio_workspace_graphs.sql`                         | Creates `studio_workspace_graphs` for "modo nodos" persistence (ReactFlow nodes + edges + viewport, one blob per workspace, owner-only RLS) |

## Tables created

- **`studio_workspaces`** — canvas container, one per project. Owner-only RLS.
- **`studio_workspace_nodes`** — individual nodes/hojas on the canvas (text, citations, imported images/docs/audio). Inherits owner check via parent workspace.
- **`studio_workspace_citations`** — chunks/snippets pinned from chat or external sources, optionally attached to a node and a workspace. Owner-only RLS.
- **`studio_workspace_chat_messages`** — persistent chat history per workspace + user. Owner-only RLS.
- **`studio_ai_call_log`** — per-LLM-call telemetry (model, tokens, cost, latency, status) written fire-and-forget from `callOpenRouter`. Service-role only; no end-user direct access.
- **`studio_workspace_graphs`** — ReactFlow / @xyflow node-edge graph for "modo nodos", one row per workspace. JSONB columns for `nodes`, `edges`, `viewport`. Owner-only RLS via parent workspace subquery.

Plus:

- Function `studio_touch_updated_at()` — generic trigger fn for `updated_at`.
- Function `studio_architect_insert_with_offset(uuid, jsonb)` — SECURITY DEFINER helper called by `runArchitect` to insert a deck of hojas under a transaction-scoped advisory lock, preventing concurrent /architect runs from racing on the max-Y read.
- Triggers `studio_ws_touch`, `studio_wsn_touch` — call the fn on UPDATE.
- Storage bucket `studio-workspace-assets` (public read, owner-prefixed write, 500MB cap).

## How to apply

### Option A — Supabase CLI (recommended)

The `supabase/migrations/` directory is the canonical CLI source. Once linked,
push pending migrations with:

```bash
supabase db push --linked
```

### Option B — psql against the Supabase Postgres URL

```bash
# Set the Postgres connection string from Supabase → Project Settings → Database
export SUPABASE_DB_URL="postgresql://postgres.<project-ref>:<password>@<host>:6543/postgres"

# Apply in order
psql "$SUPABASE_DB_URL" -f 0001_studio_workspace.sql
psql "$SUPABASE_DB_URL" -f 0002_studio_workspace_asset_types.sql
psql "$SUPABASE_DB_URL" -f 0003_studio_workspace_pptx_cache.sql
psql "$SUPABASE_DB_URL" -f 0004_raise_studio_assets_size_cap.sql
psql "$SUPABASE_DB_URL" -f 0005_studio_workspace_chat_messages.sql
psql "$SUPABASE_DB_URL" -f 0006_studio_workspace_chat_messages_fk_userid.sql
psql "$SUPABASE_DB_URL" -f 0007_studio_workspace_citations_dedup_per_workspace.sql
psql "$SUPABASE_DB_URL" -f 0008_studio_ai_call_log.sql
psql "$SUPABASE_DB_URL" -f 0009_architect_advisory_lock.sql
psql "$SUPABASE_DB_URL" -f 0010_studio_workspace_graphs.sql
```

### Option C — Supabase Studio SQL editor (one-shot)

1. Open the Supabase dashboard for project `lqrrtyqhlpupmjzydbck`.
2. Go to **SQL Editor → New query**.
3. Paste the entire contents of `_apply_all_workspace.sql`, run it.

After applying, verify in the **Table Editor** that the new tables / columns
appear and that RLS is enabled (shield icon next to the table name).

## Idempotency

Every statement that can be is guarded:

- `create table if not exists`
- `create index if not exists`
- `drop policy if exists` immediately followed by `create policy`
- `drop trigger if exists` immediately followed by `create trigger`
- `create or replace function` for the trigger fn
- `insert … on conflict (id) do nothing` for the storage bucket row
- `if not exists` lookups against `pg_policies` for storage RLS
- `if not exists` lookups against `pg_constraint` for FK adds
- `if exists` lookups against `pg_indexes` for index swaps

You can rerun any migration without producing duplicates or errors.

## Rollback

Each file ends with a commented `-- DOWN ROLLBACK` block listing the exact
DROP statements needed. To roll back:

1. **Run DOWN sections in reverse order** (0010 first, then 0009 → 0008 →
   0007 → 0006 → 0005 → 0004 → 0003 → 0002 → 0001).
2. Uncomment the statements inside the `-- DOWN ROLLBACK` block of the file
   you want to revert.
3. Execute via psql or the Supabase SQL editor.

The DOWN block in `0002` includes a warning: dropping the
`studio-workspace-assets` storage bucket fails if any objects remain. Empty
the bucket via Supabase Studio → Storage UI (or `supabase storage rm`) before
running the bucket `DELETE`.

The DOWN block in `0002` also restores the pre-asset-types CHECK constraint
on `studio_workspace_nodes.type`, so rolling back 0002 alone leaves 0001 in
a consistent state.

## Notes

- **RLS model**: per-`user_id` ownership. `auth.uid() = user_id` everywhere.
  Nodes inherit the check via a subquery against the parent workspace.
  Same shape as CL2's proven model; share tokens and team workspaces are a
  later phase.
- **Auth provider**: same Supabase Auth instance as Brandhub. When Studio
  flips out of bypass mode, existing users will Just Work.
- **Provenance**: ports of CL2 migrations `0011_workspace.sql`,
  `0014_workspace_asset_types.sql`, `0020_workspace_pptx_cache.sql`. CL2's
  `0013_podcasts_hoja_sources.sql` was deliberately skipped (CL2-specific
  legislative podcasts, not relevant to Studio).
