-- ════════════════════════════════════════════════════════════════════
-- Shifty Studio — Workspace migrations (concatenated for one-shot apply)
-- ════════════════════════════════════════════════════════════════════
--
-- Generated bundle of:
--   0001_studio_workspace.sql                                (tables + RLS + triggers)
--   0002_studio_workspace_asset_types.sql                    (asset types + storage bucket + RLS)
--   0003_studio_workspace_pptx_cache.sql                     (last_pptx jsonb column)
--   0004_raise_studio_assets_size_cap.sql                    (raise bucket cap 100MB → 500MB)
--   0005_studio_workspace_chat_messages.sql                  (chat history persistence)
--   0006_studio_workspace_chat_messages_fk_userid.sql        (FK chat_messages.user_id → auth.users)
--   0007_studio_workspace_citations_dedup_per_workspace.sql  (per-workspace citation dedup)
--   0008_studio_ai_call_log.sql                              (per-LLM-call cost + token telemetry)
--   0009_architect_advisory_lock.sql                         (advisory-lock helper for /architect concurrency)
--   0010_studio_workspace_graphs.sql                         (modo nodos graph persistence: nodes + edges + viewport)
--
-- Idempotent: every statement uses CREATE IF NOT EXISTS / DROP IF EXISTS /
-- ON CONFLICT DO NOTHING / pg_policies guards. Safe to re-run.
--
-- HOW TO APPLY (production):
--   1. Open Supabase Studio → project lqrrtyqhlpupmjzydbck.
--   2. SQL Editor → New query.
--   3. Paste the entire contents of THIS file. Run.
--   4. Verify in Table Editor: studio_workspaces, studio_workspace_nodes,
--      studio_workspace_citations, studio_workspace_chat_messages all show
--      RLS shield icons.
--   5. Storage → studio-workspace-assets bucket exists with 500MB cap,
--      public read.
--
-- ROLLBACK: see the DOWN block at the bottom of each source migration
-- (commented in the source files). Apply DOWN blocks in REVERSE order
-- (0007 → 0006 → 0005 → 0004 → 0003 → 0002 → 0001).

-- ════════════════════════════════════════════════════════════════════
-- 0001_studio_workspace.sql
-- ════════════════════════════════════════════════════════════════════

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
  x            float not null default 0,
  y            float not null default 0,
  width        float not null default 640,
  height       float not null default 420,
  z_index      int  not null default 0,
  title        text not null default 'Sin título',
  subtitle     text not null default '',
  content      jsonb not null default '{}'::jsonb,
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
  node_id       uuid references studio_workspace_nodes(id) on delete set null,
  chunk_id      uuid not null,
  source_label  text,
  excerpt       text,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists studio_workspace_citations_user_idx
  on studio_workspace_citations (user_id, created_at desc);
create unique index if not exists studio_workspace_citations_dedup
  on studio_workspace_citations (user_id, chunk_id);
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

-- ════════════════════════════════════════════════════════════════════
-- 0002_studio_workspace_asset_types.sql
-- ════════════════════════════════════════════════════════════════════

alter table studio_workspace_nodes drop constraint if exists studio_workspace_nodes_type_check;

alter table studio_workspace_nodes
  add constraint studio_workspace_nodes_type_check
  check (type in ('hoja', 'note', 'cite', 'expediente_ref', 'image', 'document', 'audio'));

-- ─── Storage bucket for imported assets ──────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'studio-workspace-assets',
  'studio-workspace-assets',
  true,
  104857600,
  array[
    'image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
    'audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain','text/markdown'
  ]
)
on conflict (id) do nothing;

-- RLS on storage.objects — guarded by pg_policies lookups (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'studio_wsa_public_read'
  ) then
    create policy "studio_wsa_public_read" on storage.objects
      for select using (bucket_id = 'studio-workspace-assets');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'studio_wsa_owner_write'
  ) then
    create policy "studio_wsa_owner_write" on storage.objects
      for insert with check (
        bucket_id = 'studio-workspace-assets'
        and auth.uid()::text = split_part(name, '/', 1)
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'studio_wsa_owner_update'
  ) then
    create policy "studio_wsa_owner_update" on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'studio-workspace-assets'
        and split_part(name, '/', 1) = auth.uid()::text
      )
      with check (
        bucket_id = 'studio-workspace-assets'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'studio_wsa_owner_delete'
  ) then
    create policy "studio_wsa_owner_delete" on storage.objects
      for delete using (
        bucket_id = 'studio-workspace-assets'
        and auth.uid()::text = split_part(name, '/', 1)
      );
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- 0003_studio_workspace_pptx_cache.sql
-- ════════════════════════════════════════════════════════════════════

alter table if exists studio_workspaces
  add column if not exists last_pptx jsonb;

comment on column studio_workspaces.last_pptx is
  'Most-recent Gamma PPTX generation for this workspace. NULL when never generated. Gamma exportUrl is signed and valid ~7 days; consumers should regenerate if older.';

-- ════════════════════════════════════════════════════════════════════
-- 0004_raise_studio_assets_size_cap.sql
-- ════════════════════════════════════════════════════════════════════
-- Raise studio-workspace-assets bucket from 100MB → 500MB.
-- Reason: users hit the silent 413 ceiling on large PDFs (CCCR proposals,
-- design briefs with embedded images). Vercel function has 60s on Pro
-- which is plenty for downloading 500MB server-side and extracting text.
update storage.buckets
   set file_size_limit = 524288000
 where id = 'studio-workspace-assets';

-- ════════════════════════════════════════════════════════════════════
-- 0005_studio_workspace_chat_messages.sql
-- ════════════════════════════════════════════════════════════════════
-- Permanent storage for ChatPanel conversations. Scoped per workspace + user.
-- Cascade-deletes when the parent workspace is deleted.
--
-- localStorage stays as a warm cache for instant render; this table is the
-- source of truth so a user can switch devices and see their chat history.
create table if not exists public.studio_workspace_chat_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.studio_workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  variant text check (variant in ('default','action') or variant is null),
  intent text check (intent in ('chat','build','edit_selected','edit_by_match') or intent is null),
  created_at timestamptz not null default now()
);

create index if not exists studio_workspace_chat_messages_ws_idx
  on public.studio_workspace_chat_messages (workspace_id, created_at);
create index if not exists studio_workspace_chat_messages_user_idx
  on public.studio_workspace_chat_messages (user_id);

-- RLS: user only reads/writes their own rows.
alter table public.studio_workspace_chat_messages enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'studio_workspace_chat_messages'
      and policyname = 'studio_chat_msgs_self'
  ) then
    create policy "studio_chat_msgs_self" on public.studio_workspace_chat_messages
      for all
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- 0006_studio_workspace_chat_messages_fk_userid.sql
-- ════════════════════════════════════════════════════════════════════
-- Adds FK from studio_workspace_chat_messages.user_id → auth.users(id) ON DELETE CASCADE.
-- Original 0005 created the column without an FK, leaving chat rows orphaned
-- on user delete. Inconsistent with the cascade pattern used by
-- studio_workspaces.user_id.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_workspace_chat_messages_user_id_fkey'
  ) then
    alter table studio_workspace_chat_messages
      add constraint studio_workspace_chat_messages_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- 0007_studio_workspace_citations_dedup_per_workspace.sql
-- ════════════════════════════════════════════════════════════════════
-- Tighten dedup: a user can pin the same chunk in different workspaces.
-- Old (user_id, chunk_id) UNIQUE silently overwrote the first pinning if
-- the user re-pinned the same chunk in a second workspace.
-- New: (user_id, workspace_id, chunk_id) so each workspace gets its own row.

-- Step 1: add workspace_id column (nullable; existing rows backfill to NULL).
alter table if exists studio_workspace_citations
  add column if not exists workspace_id uuid
  references studio_workspaces(id) on delete cascade;

create index if not exists studio_workspace_citations_ws_idx
  on studio_workspace_citations (workspace_id)
  where workspace_id is not null;

-- Step 2: drop old dedup index if exists.
do $$
begin
  if exists (
    select 1 from pg_indexes
    where indexname = 'studio_workspace_citations_dedup'
  ) then
    drop index if exists studio_workspace_citations_dedup;
  end if;
end $$;

-- Step 3: create new unique index on (user_id, workspace_id, chunk_id).
create unique index if not exists studio_workspace_citations_dedup
  on studio_workspace_citations(user_id, workspace_id, chunk_id);

-- ════════════════════════════════════════════════════════════════════
-- 0008_studio_ai_call_log.sql
-- ════════════════════════════════════════════════════════════════════
-- Per-LLM-call audit trail for cost attribution. Writes happen
-- fire-and-forget from callOpenRouter; failure to write should NEVER
-- block the user-facing response.

create table if not exists studio_ai_call_log (
  id            uuid primary key default gen_random_uuid(),
  call_id       text,
  created_at    timestamptz not null default now(),
  user_id       uuid,
  workspace_id  uuid,
  tenant_id     text,
  app_id        text default 'studio',
  trace_label   text,
  model         text not null,
  input_tokens                   integer,
  output_tokens                  integer,
  total_tokens                   integer,
  cache_creation_input_tokens    integer,
  cache_read_input_tokens        integer,
  cost_usd_input                 numeric(10, 6),
  cost_usd_output                numeric(10, 6),
  cost_usd_total                 numeric(10, 6),
  latency_ms                     integer,
  status                         text not null default 'ok',
  error_code                     text,
  error_message                  text
);

create index if not exists studio_ai_call_log_user_created
  on studio_ai_call_log(user_id, created_at desc) where user_id is not null;

create index if not exists studio_ai_call_log_trace_created
  on studio_ai_call_log(trace_label, created_at desc);

create index if not exists studio_ai_call_log_workspace
  on studio_ai_call_log(workspace_id, created_at desc) where workspace_id is not null;

alter table studio_ai_call_log enable row level security;

-- ════════════════════════════════════════════════════════════════════
-- 0009_architect_advisory_lock.sql
-- ════════════════════════════════════════════════════════════════════
-- studio_architect_insert_with_offset
-- Serializes /architect runs on the same workspace via a Postgres
-- transaction-scoped advisory lock. Folds the maxBottom read + insert
-- into one SECURITY DEFINER function so the lock survives across both
-- steps (a TS-side pg_advisory_xact_lock would release between RPC
-- round-trips and so wouldn't actually serialize anything).

create or replace function studio_architect_insert_with_offset(
  p_workspace_id uuid,
  p_rows         jsonb
)
returns setof studio_workspace_nodes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lock_key    bigint := abs(hashtextextended(p_workspace_id::text, 0));
  v_max_bottom float;
  v_offset_y   float;
  v_row        jsonb;
  v_inserted   studio_workspace_nodes%rowtype;
begin
  if not pg_try_advisory_xact_lock(lock_key) then
    raise exception 'architect_in_progress' using errcode = 'P0001';
  end if;

  select coalesce(max(n.y + coalesce(n.height, 280)), 0)
  into   v_max_bottom
  from   studio_workspace_nodes n
  where  n.workspace_id = p_workspace_id;

  if v_max_bottom > 0 then
    v_offset_y := v_max_bottom + 40;
  else
    v_offset_y := 80;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into studio_workspace_nodes (
      workspace_id, type, title, subtitle, content, color,
      x, y, width, height
    )
    values (
      p_workspace_id,
      coalesce(v_row->>'type', 'hoja'),
      coalesce(v_row->>'title', 'Sin título'),
      coalesce(v_row->>'subtitle', ''),
      coalesce((v_row->'content')::jsonb, '{}'::jsonb),
      coalesce(v_row->>'color', 'default'),
      coalesce((v_row->>'x')::float, 0),
      coalesce((v_row->>'y')::float, 0) + v_offset_y,
      coalesce((v_row->>'width')::float, 360),
      coalesce((v_row->>'height')::float, 280)
    )
    returning * into v_inserted;

    return next v_inserted;
  end loop;

  return;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- 0010_studio_workspace_graphs.sql
-- ════════════════════════════════════════════════════════════════════
-- Persistence for "modo nodos" — ReactFlow node-edge graph that lives
-- next to the workspace TipTap canvas. ONE row per workspace holds the
-- whole graph as opaque JSONB (nodes, edges, viewport). Owner-only RLS
-- via parent-workspace subquery; trigger reuses studio_touch_updated_at().

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

-- ════════════════════════════════════════════════════════════════════
-- END.  Verify in Supabase Studio → Table Editor / Storage that the
-- objects above all exist and that the shield icon (RLS) is on.
-- ════════════════════════════════════════════════════════════════════
