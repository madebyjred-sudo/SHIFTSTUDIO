-- 20260509120000_studio_workspace_chat_messages_fk_userid.sql
--
-- Adds FK from studio_workspace_chat_messages.user_id → auth.users(id) ON DELETE CASCADE.
-- Original 20260509000001 created the column without an FK, which leaves chat
-- rows orphaned when a user is deleted. Inconsistent with the cascade pattern
-- used by studio_workspaces.user_id.
--
-- Idempotent: only adds the constraint if it doesn't already exist.

do $$
begin
  -- Only add the FK if it doesn't already exist
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_workspace_chat_messages_user_id_fkey'
  ) then
    alter table studio_workspace_chat_messages
      add constraint studio_workspace_chat_messages_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- DOWN ROLLBACK:
-- alter table studio_workspace_chat_messages drop constraint studio_workspace_chat_messages_user_id_fkey;
