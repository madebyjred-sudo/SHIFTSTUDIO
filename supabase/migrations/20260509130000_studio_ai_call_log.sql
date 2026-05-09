-- ════════════════════════════════════════════════════════════════════
-- 20260509130000_studio_ai_call_log.sql
-- ════════════════════════════════════════════════════════════════════
-- studio_ai_call_log
-- Per-LLM-call audit trail for cost attribution. Writes happen
-- fire-and-forget from callOpenRouter; failure to write should NEVER
-- block the user-facing response.
--
-- Phase 3.B — Studio-side cost telemetry, independent of Cerebro
-- Change 3 (which will eventually ship `cerebro_llm_calls`). Both can
-- be reconciled later as a cross-check; for now this answers
-- "how much did Studio spend this week" + "which user is expensive"
-- with pure Studio-owned data.
--
-- Useful queries:
--   per-user/month:    SELECT user_id, sum(cost_usd_total) FROM studio_ai_call_log
--                      WHERE created_at > now() - interval '30 days'
--                      GROUP BY user_id ORDER BY 2 DESC;
--   per-trace cost:    SELECT trace_label, count(*), avg(latency_ms),
--                      sum(cost_usd_total) FROM studio_ai_call_log
--                      WHERE created_at > now() - interval '7 days'
--                      GROUP BY trace_label;

create table if not exists studio_ai_call_log (
  id            uuid primary key default gen_random_uuid(),
  call_id       text,                          -- from Cerebro response
  created_at    timestamptz not null default now(),
  user_id       uuid,                          -- from req auth (nullable for anon-bypass dev)
  workspace_id  uuid,                          -- when call is workspace-scoped
  tenant_id     text,                          -- 'shift' | etc.
  app_id        text default 'studio',
  trace_label   text,                          -- 'studio.workspace.turn.chat' | etc.
  model         text not null,
  -- usage breakdown (from Cerebro response.usage)
  input_tokens                   integer,
  output_tokens                  integer,
  total_tokens                   integer,
  cache_creation_input_tokens    integer,
  cache_read_input_tokens        integer,
  -- pricing snapshot (computed at call time)
  cost_usd_input                 numeric(10, 6),
  cost_usd_output                numeric(10, 6),
  cost_usd_total                 numeric(10, 6),
  -- timing
  latency_ms                     integer,
  -- error tracking
  status                         text not null default 'ok',  -- 'ok' | 'error' | 'timeout'
  error_code                     text,
  error_message                  text
);

create index if not exists studio_ai_call_log_user_created
  on studio_ai_call_log(user_id, created_at desc) where user_id is not null;

create index if not exists studio_ai_call_log_trace_created
  on studio_ai_call_log(trace_label, created_at desc);

create index if not exists studio_ai_call_log_workspace
  on studio_ai_call_log(workspace_id, created_at desc) where workspace_id is not null;

-- Optional RLS: only service-role writes; admin reads via service-role too.
-- No end-user direct access. Skipping policies; service-role bypass is fine here.

alter table studio_ai_call_log enable row level security;

-- DOWN ROLLBACK:
-- drop index if exists studio_ai_call_log_workspace;
-- drop index if exists studio_ai_call_log_trace_created;
-- drop index if exists studio_ai_call_log_user_created;
-- drop table if exists studio_ai_call_log;
