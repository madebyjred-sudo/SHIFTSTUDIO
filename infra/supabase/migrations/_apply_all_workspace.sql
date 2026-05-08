-- ════════════════════════════════════════════════════════════════════
-- Shifty Studio — Workspace migrations (concatenated for one-shot apply)
-- ════════════════════════════════════════════════════════════════════
--
-- Generated bundle of:
--   0001_studio_workspace.sql            (tables + RLS + triggers)
--   0002_studio_workspace_asset_types.sql (asset types + storage bucket + RLS)
--   0003_studio_workspace_pptx_cache.sql (last_pptx jsonb column)
--
-- Idempotent: every statement uses CREATE IF NOT EXISTS / DROP IF EXISTS /
-- ON CONFLICT DO NOTHING / pg_policies guards. Safe to re-run.
--
-- HOW TO APPLY (production):
--   1. Open Supabase Studio → project lqrrtyqhlpupmjzydbck.
--   2. SQL Editor → New query.
--   3. Paste the entire contents of THIS file. Run.
--   4. Verify in Table Editor: studio_workspaces, studio_workspace_nodes,
--      studio_workspace_citations all show RLS shield icons.
--   5. Storage → studio-workspace-assets bucket exists, public read.
--
-- ROLLBACK: see the DOWN block at the bottom of each source migration
-- (commented in the source files). Apply DOWN blocks in REVERSE order
-- (0003, then 0002, then 0001).

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
-- END.  Verify in Supabase Studio → Table Editor / Storage that the
-- objects above all exist and that the shield icon (RLS) is on.
-- ════════════════════════════════════════════════════════════════════
