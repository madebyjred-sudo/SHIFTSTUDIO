-- 0001_studio_workspace.sql
--
-- Shifty Studio — Workspace ("Notebook") mode.
--
-- Production surface so users can CREATE work (not just consume) on a free
-- canvas where they co-construct artifacts with AI agents. Ported from CL2's
-- 0011_workspace.sql (proven in production ~6 weeks). Tables prefixed with
-- `studio_` to coexist safely with Brandhub + (eventually) CL2 tables in the
-- same Supabase project (lqrrtyqhlpupmjzydbck).
--
-- Three tables for the canvas model + citations carry-over:
--
--   1. studio_workspaces        — canvas container. One per project.
--                                 Archived flag for soft-delete; hard delete
--                                 cascades.
--   2. studio_workspace_nodes   — individual "hojas" (pages) positioned on
--                                 the canvas. type=hoja is the primary type;
--                                 note/expediente_ref reserved for future
--                                 phases (expediente_ref = generic external
--                                 reference for any domain). content JSONB
--                                 starts as {md:"..."} for MVP — opaque shape
--                                 so TipTap JSON swap lands with zero
--                                 migration cost.
--   3. studio_workspace_citations — chunks saved from chat or browse,
--                                 optionally pinned to a specific node.
--                                 No FK on chunk_id (allows non-corpus
--                                 citations / cross-domain references).
--
-- RLS: owner-only for all three tables. Share tokens = future phase.

-- ─── studio_workspaces ───────────────────────────────────────────────
create table if not exists studio_workspaces (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Mi espacio',
  description text not null default '',
  archived    bool not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists studio_workspaces_user_idx
  on studio_workspaces (user_id, updated_at desc);

-- ─── studio_workspace_nodes ──────────────────────────────────────────
create table if not exists studio_workspace_nodes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references studio_workspaces(id) on delete cascade,
  type         text not null default 'hoja'
               check (type in ('hoja', 'note', 'cite', 'expediente_ref')),
  -- Canvas position (ReactFlow coordinates)
  x            float not null default 0,
  y            float not null default 0,
  width        float not null default 640,
  height       float not null default 420,
  z_index      int  not null default 0,
  -- Content
  title        text not null default 'Sin título',
  subtitle     text not null default '',
  content      jsonb not null default '{}'::jsonb,
  -- Visual theme
  color        text not null default 'default'
               check (color in ('default','burgundy','ink','sage','amber')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists studio_workspace_nodes_ws_idx
  on studio_workspace_nodes (workspace_id, created_at asc);

-- ─── studio_workspace_citations ──────────────────────────────────────
create table if not exists studio_workspace_citations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Optional pin to a specific node (null = inbox / unattached)
  node_id       uuid references studio_workspace_nodes(id) on delete set null,
  chunk_id      uuid not null,       -- generic external reference; no FK so
                                     -- citations can point to any source
                                     -- (corpus chunk, asset, message, etc.)
  source_label  text,                -- e.g. "Exp. 23.456" or any label,
                                     -- denormalized for fast render
  excerpt       text,                -- snippet for fast render
  note          text,                -- user annotation
  created_at    timestamptz not null default now()
);
create index if not exists studio_workspace_citations_user_idx
  on studio_workspace_citations (user_id, created_at desc);
create unique index if not exists studio_workspace_citations_dedup
  on studio_workspace_citations (user_id, chunk_id);
-- Supports the FK ON DELETE SET NULL on node_id: without this, deleting a
-- node forces a seq scan over studio_workspace_citations to null out the FK.
create index if not exists studio_workspace_citations_node_idx
  on studio_workspace_citations (node_id)
  where node_id is not null;

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table studio_workspaces enable row level security;
drop policy if exists "studio_ws_owner" on studio_workspaces;
create policy "studio_ws_owner" on studio_workspaces
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table studio_workspace_nodes enable row level security;
drop policy if exists "studio_wsn_owner" on studio_workspace_nodes;
create policy "studio_wsn_owner" on studio_workspace_nodes
  for all using (
    auth.uid() = (select user_id from studio_workspaces where id = workspace_id)
  )
  with check (
    auth.uid() = (select user_id from studio_workspaces where id = workspace_id)
  );

alter table studio_workspace_citations enable row level security;
drop policy if exists "studio_wsc_owner" on studio_workspace_citations;
create policy "studio_wsc_owner" on studio_workspace_citations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── updated_at triggers ─────────────────────────────────────────────
-- Function name prefixed `studio_` to avoid colliding with any other
-- helper of the same purpose in the shared Supabase project.
create or replace function studio_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists studio_ws_touch on studio_workspaces;
create trigger studio_ws_touch before update on studio_workspaces
  for each row execute function studio_touch_updated_at();

drop trigger if exists studio_wsn_touch on studio_workspace_nodes;
create trigger studio_wsn_touch before update on studio_workspace_nodes
  for each row execute function studio_touch_updated_at();

-- ─── DOWN ROLLBACK ───────────────────────────────────────────────────
-- Run these (uncommented) in this order to fully roll back this migration.
-- Triggers + policies are dropped implicitly when their tables are dropped,
-- but listed here for explicitness.
--
-- drop trigger if exists studio_wsn_touch on studio_workspace_nodes;
-- drop trigger if exists studio_ws_touch on studio_workspaces;
-- drop function if exists studio_touch_updated_at();
--
-- drop policy if exists "studio_wsc_owner" on studio_workspace_citations;
-- drop policy if exists "studio_wsn_owner" on studio_workspace_nodes;
-- drop policy if exists "studio_ws_owner" on studio_workspaces;
--
-- drop index if exists studio_workspace_citations_node_idx;
-- drop index if exists studio_workspace_citations_dedup;
-- drop index if exists studio_workspace_citations_user_idx;
-- drop index if exists studio_workspace_nodes_ws_idx;
-- drop index if exists studio_workspaces_user_idx;
--
-- drop table if exists studio_workspace_citations;
-- drop table if exists studio_workspace_nodes;
-- drop table if exists studio_workspaces;
