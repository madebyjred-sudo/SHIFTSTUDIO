-- ════════════════════════════════════════════════════════════════════
-- 0010_studio_workspace_graphs.sql
-- ════════════════════════════════════════════════════════════════════
-- APPLY MANUALLY — Supabase CLI is not linked to project lqrrtyqhlpupmjzydbck
-- in this environment, and `npx supabase db push` requires the link. To
-- apply this migration, paste it into Supabase Studio → SQL Editor for
-- project `lqrrtyqhlpupmjzydbck`, OR run via psql against
-- $SUPABASE_DB_URL (see infra/supabase/migrations/README.md → Option B).
--
-- studio_workspace_graphs — persistence for the "modo nodos" canvas.
--
-- Studio has two distinct canvases:
--
--   1. WORKSPACE canvas (existing, do NOT touch)
--      TipTap "hojas" rendered at (x, y) on a free canvas. Persisted via
--      `studio_workspace_nodes` (one row per hoja). Drag-to-position +
--      autosave already works; this is a separate orthogonal feature.
--
--   2. NODES MODE / GRAPH (this migration)
--      ReactFlow / @xyflow/react node-edge graph that lives next to the
--      workspace inside the same `studio_workspaces` container. Today the
--      graph state is in-memory only (zustand stores `useGraphStore` /
--      `useGraphStoreV2`); a refresh = total loss. This table adds
--      durable per-workspace storage so the graph survives reloads.
--
-- Shape choice: ONE row per workspace, holding `nodes` + `edges` +
-- `viewport` as opaque JSONB blobs. The graph is small (typical ≤ 100
-- nodes), is read/written as a unit by the BFF (full GET, full PUT
-- upsert), and never queried by inner shape — so a denormalized blob is
-- the right fit. If we later need per-node indexing (e.g. cross-graph
-- search) we'd add a sibling normalized table; the JSONB column stays
-- as the operational copy.
--
-- The body cap is enforced by the BFF (5MB Express body limit), so no
-- DB-side `length()` check; the migration keeps the schema permissive.

create table if not exists studio_workspace_graphs (
  workspace_id uuid primary key
               references studio_workspaces(id) on delete cascade,
  nodes        jsonb not null default '[]'::jsonb,
  edges        jsonb not null default '[]'::jsonb,
  viewport     jsonb,                            -- nullable (no saved camera yet)
  updated_at   timestamptz not null default now()
);

-- ─── RLS ─────────────────────────────────────────────────────────────
-- Owner-only via subquery against the parent workspace, mirroring the
-- shape used by `studio_wsn_owner` on `studio_workspace_nodes`. Both
-- USING (read) and WITH CHECK (write) gates verify the parent workspace
-- belongs to auth.uid(); the BFF additionally calls `getUserIdFromRequest`
-- + `ownedWorkspace`, so writes go through two independent ownership
-- gates (defense in depth).

alter table studio_workspace_graphs enable row level security;

drop policy if exists "studio_wsg_owner" on studio_workspace_graphs;
create policy "studio_wsg_owner" on studio_workspace_graphs
  for all
  using (
    auth.uid() = (select user_id from studio_workspaces where id = workspace_id)
  )
  with check (
    auth.uid() = (select user_id from studio_workspaces where id = workspace_id)
  );

-- ─── updated_at trigger ──────────────────────────────────────────────
-- Reuses the generic `studio_touch_updated_at()` function created in
-- 0001. Trigger name is migration-scoped so multiple sibling tables can
-- coexist without colliding.
drop trigger if exists studio_wsg_touch on studio_workspace_graphs;
create trigger studio_wsg_touch before update on studio_workspace_graphs
  for each row execute function studio_touch_updated_at();

-- ─── DOWN ROLLBACK ───────────────────────────────────────────────────
-- drop trigger if exists studio_wsg_touch on studio_workspace_graphs;
-- drop policy if exists "studio_wsg_owner" on studio_workspace_graphs;
-- drop table if exists studio_workspace_graphs;
