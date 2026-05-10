-- ════════════════════════════════════════════════════════════════════
-- 20260510000001_studio_workspace_graphs.sql
-- ════════════════════════════════════════════════════════════════════
-- APPLY MANUALLY — Supabase CLI link not available in the agent environment.
-- This file lives in the canonical CLI directory so once `supabase link`
-- runs, `supabase db push --linked` will pick it up automatically. Until
-- then, apply via SQL editor or psql; see README.md.
--
-- Mirror of infra/supabase/migrations/0010_studio_workspace_graphs.sql
-- in the Supabase CLI canonical location. Keep the two in sync.
--
-- studio_workspace_graphs — persistence for the "modo nodos" canvas.
-- ONE row per workspace, holding nodes + edges + viewport as opaque
-- JSONB. RLS via parent-workspace owner subquery. Trigger reuses
-- `studio_touch_updated_at()` defined in 0001.

create table if not exists studio_workspace_graphs (
  workspace_id uuid primary key
               references studio_workspaces(id) on delete cascade,
  nodes        jsonb not null default '[]'::jsonb,
  edges        jsonb not null default '[]'::jsonb,
  viewport     jsonb,
  updated_at   timestamptz not null default now()
);

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

drop trigger if exists studio_wsg_touch on studio_workspace_graphs;
create trigger studio_wsg_touch before update on studio_workspace_graphs
  for each row execute function studio_touch_updated_at();
