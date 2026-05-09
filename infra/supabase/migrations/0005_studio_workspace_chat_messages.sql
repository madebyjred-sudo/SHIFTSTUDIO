-- 20260509000001_studio_workspace_chat_messages.sql
--
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

-- DOWN:
-- drop table if exists public.studio_workspace_chat_messages cascade;
