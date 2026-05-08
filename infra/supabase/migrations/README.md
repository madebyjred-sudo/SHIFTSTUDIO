# Shifty Studio — Supabase migrations

SQL migrations for Shifty Studio's Workspace ("Notebook") mode. Apply against
the shared Supabase project `lqrrtyqhlpupmjzydbck` (also hosts Brandhub and
will eventually host CL2). All Studio-owned tables are prefixed `studio_`
to avoid collisions with sibling apps.

## Files

Apply in numeric order. Each file is idempotent (`CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `ON CONFLICT … DO UPDATE`, guarded `pg_policies`
checks), so reruns are safe.

| #    | File                                       | What it does                                                                     |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| 0001 | `0001_studio_workspace.sql`                | Creates `studio_workspaces`, `studio_workspace_nodes`, `studio_workspace_citations` + RLS + `updated_at` triggers |
| 0002 | `0002_studio_workspace_asset_types.sql`    | Extends node types (`image`, `document`, `audio`) and provisions the `studio-workspace-assets` storage bucket + RLS |
| 0003 | `0003_studio_workspace_pptx_cache.sql`     | Adds `last_pptx jsonb` column on `studio_workspaces` for Gamma export cache       |

## Tables created

- **`studio_workspaces`** — canvas container, one per project. Owner-only RLS.
- **`studio_workspace_nodes`** — individual nodes/hojas on the canvas (text, citations, imported images/docs/audio). Inherits owner check via parent workspace.
- **`studio_workspace_citations`** — chunks/snippets pinned from chat or external sources, optionally attached to a node. Owner-only RLS.

Plus:

- Function `studio_touch_updated_at()` — generic trigger fn for `updated_at`.
- Triggers `studio_ws_touch`, `studio_wsn_touch` — call the fn on UPDATE.
- Storage bucket `studio-workspace-assets` (public read, owner-prefixed write).

## How to apply

### Option A — psql against the Supabase Postgres URL

```bash
# Set the Postgres connection string from Supabase → Project Settings → Database
export SUPABASE_DB_URL="postgresql://postgres.<project-ref>:<password>@<host>:6543/postgres"

# Apply in order
psql "$SUPABASE_DB_URL" -f 0001_studio_workspace.sql
psql "$SUPABASE_DB_URL" -f 0002_studio_workspace_asset_types.sql
psql "$SUPABASE_DB_URL" -f 0003_studio_workspace_pptx_cache.sql
```

### Option B — Supabase Studio SQL editor

1. Open the Supabase dashboard for project `lqrrtyqhlpupmjzydbck`.
2. Go to **SQL Editor → New query**.
3. Paste the contents of `0001_studio_workspace.sql`, run it.
4. Repeat for `0002_…` then `0003_…`, in that order.

After each file, verify in the **Table Editor** that the new tables / columns
appear and that RLS is enabled (shield icon next to the table name).

### Option C — Supabase CLI

If the repo is later wired to `supabase db push`, the CLI will pick up these
files from `infra/supabase/migrations/` automatically. Filenames are already
in the `NNNN_name.sql` shape the CLI expects.

## Idempotency

Every statement that can be is guarded:

- `create table if not exists`
- `create index if not exists`
- `drop policy if exists` immediately followed by `create policy`
- `drop trigger if exists` immediately followed by `create trigger`
- `create or replace function` for the trigger fn
- `insert … on conflict (id) do update` for the storage bucket row
- `if not exists` lookups against `pg_policies` for storage RLS

You can rerun any migration without producing duplicates or errors. The one
exception is the `alter table … drop/add constraint` pattern in 0002 — that
is idempotent by design (drop-then-add) but does briefly leave the table
without the type check inside a single statement run.

## Rollback

Each file ends with a commented `-- DOWN ROLLBACK` block listing the exact
DROP statements needed. To roll back:

1. **Run DOWN sections in reverse order** (0003 first, then 0002, then 0001).
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
