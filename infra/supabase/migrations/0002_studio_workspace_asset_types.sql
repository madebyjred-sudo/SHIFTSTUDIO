-- 0002_studio_workspace_asset_types.sql
--
-- Extends studio_workspace_nodes.type to allow imported asset types (image,
-- document, audio). Used by POST /api/workspace/:id/nodes/import.
--
-- For these types, content shape is:
--   { url: string, filename: string, size: number, mime: string,
--     thumbnail_url?: string, duration_seconds?: number, pages?: number }
--
-- Idempotent: re-running drops + recreates the constraint.
--
-- Ported from CL2's 0014_workspace_asset_types.sql. Storage bucket renamed
-- from `workspace-assets` to `studio-workspace-assets` to coexist with CL2
-- in the same Supabase project. Storage policies renamed `studio_wsa_*`.

alter table studio_workspace_nodes drop constraint if exists studio_workspace_nodes_type_check;

alter table studio_workspace_nodes
  add constraint studio_workspace_nodes_type_check
  check (type in ('hoja', 'note', 'cite', 'expediente_ref', 'image', 'document', 'audio'));

-- ─── Storage bucket for imported assets ──────────────────────────────
-- Auto-created on first use by the import endpoint via the service-role
-- client (storage.createBucket). This block is here for ops visibility
-- and to make a re-deploy reproducible — running it twice is safe.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'studio-workspace-assets',
  'studio-workspace-assets',
  true,                      -- public read; writes still gated by RLS
  104857600,                 -- 100MB cap per file
  array[
    'image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
    'audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain','text/markdown'
  ]
)
-- ON CONFLICT DO NOTHING preserves any operator-side bucket config changes
-- (e.g. someone raised the size cap via Supabase dashboard). The first apply
-- creates with these defaults; subsequent applies leave the bucket alone.
on conflict (id) do nothing;

-- RLS on storage.objects: a user can read anything in studio-workspace-assets
-- (bucket is public for browser <img>/<audio> tags), but can only INSERT
-- under their own user_id prefix path.
do $$
begin
  -- Read policy (everyone, since bucket is public)
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'studio_wsa_public_read'
  ) then
    create policy "studio_wsa_public_read" on storage.objects
      for select using (bucket_id = 'studio-workspace-assets');
  end if;

  -- Write policy: authenticated users only, path must start with their uid
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

  -- Update policy: same path-prefix gate. Required for metadata changes,
  -- signed-url issuance flows that update objects, and upsert overwrites —
  -- without it those operations silently fail under RLS.
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

  -- Delete policy: same path-prefix gate
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

-- ─── DOWN ROLLBACK ───────────────────────────────────────────────────
-- Run these (uncommented) in this order to fully roll back this migration.
-- WARNING: dropping the storage bucket will refuse if it still contains
-- objects. Empty it first via the Supabase Studio Storage UI or with
-- `supabase storage rm` before running the bucket DELETE.
--
-- drop policy if exists "studio_wsa_owner_delete" on storage.objects;
-- drop policy if exists "studio_wsa_owner_update" on storage.objects;
-- drop policy if exists "studio_wsa_owner_write"  on storage.objects;
-- drop policy if exists "studio_wsa_public_read"  on storage.objects;
--
-- delete from storage.buckets where id = 'studio-workspace-assets';
--
-- alter table studio_workspace_nodes drop constraint if exists studio_workspace_nodes_type_check;
-- -- Restore original (pre-asset-types) constraint from migration 0001:
-- alter table studio_workspace_nodes
--   add constraint studio_workspace_nodes_type_check
--   check (type in ('hoja', 'note', 'cite', 'expediente_ref'));
