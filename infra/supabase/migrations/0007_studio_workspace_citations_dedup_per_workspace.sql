-- 0007_studio_workspace_citations_dedup_per_workspace.sql
--
-- Tighten dedup: a user can pin the same chunk in different workspaces.
-- The current (user_id, chunk_id) UNIQUE silently overwrites the first
-- pinning if the user re-pins the same chunk in a second workspace.
--
-- Replace with (user_id, workspace_id, chunk_id) so each workspace gets
-- its own citation row.
--
-- Step 1: add the workspace_id column (nullable; existing rows backfill
--         to NULL since we cannot retroactively associate them).
-- Step 2: drop the old (user_id, chunk_id) unique index.
-- Step 3: create the new (user_id, workspace_id, chunk_id) unique index.

-- ─── Step 1: add workspace_id column (idempotent) ──────────────────────
alter table if exists studio_workspace_citations
  add column if not exists workspace_id uuid
  references studio_workspaces(id) on delete cascade;

create index if not exists studio_workspace_citations_ws_idx
  on studio_workspace_citations (workspace_id)
  where workspace_id is not null;

-- ─── Step 2: drop existing dedup index if exists ───────────────────────
do $$
begin
  if exists (
    select 1 from pg_indexes
    where indexname = 'studio_workspace_citations_dedup'
  ) then
    drop index if exists studio_workspace_citations_dedup;
  end if;
end $$;

-- ─── Step 3: create new partial unique index on (user_id, workspace_id, chunk_id) ───
create unique index if not exists studio_workspace_citations_dedup
  on studio_workspace_citations(user_id, workspace_id, chunk_id);

-- DOWN ROLLBACK:
-- drop index if exists studio_workspace_citations_dedup;
-- create unique index studio_workspace_citations_dedup
--   on studio_workspace_citations(user_id, chunk_id);
-- drop index if exists studio_workspace_citations_ws_idx;
-- alter table studio_workspace_citations drop column if exists workspace_id;
