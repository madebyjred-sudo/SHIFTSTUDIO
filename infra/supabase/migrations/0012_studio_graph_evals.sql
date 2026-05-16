-- ════════════════════════════════════════════════════════════════════
-- 0012_studio_graph_evals.sql
-- ════════════════════════════════════════════════════════════════════
-- APPLY MANUALLY — paste into Supabase Studio → SQL Editor for project
-- `lqrrtyqhlpupmjzydbck`, OR run via psql against $SUPABASE_DB_URL.
--
-- ━━━ DESIGN ONLY — IMPL POST-MVP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- This migration creates the schema NOW so:
--   1. The shape is reviewable before the UI lands (Vellum-style eval
--      tables historically degrade if the schema is defined after the
--      first feedback is captured — backfills get noisy).
--   2. We can stand up the table on Supabase ahead of time and let the
--      `failure_category` enum stabilize through Wave-F/G use.
--
-- The thumbs-up/down UI on `ExportNode` (or on a post-run modal) is
-- DEFERRED until after the modo-nodos MVP demo. When we ship it, the
-- only follow-up code is a single INSERT — no schema work.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- studio_graph_evals — per-execution user feedback used to train the
-- architect and to detect failure modes in the auto-DAG flow.
--
-- Rationale (Vellum learning, 2026-Q1): without an explicit feedback
-- channel users don't trust AI-generated outputs. They quietly stop
-- using the tool. A 2-click thumb + optional reason gives us:
--   - Signal to identify "wrong agent picked", "too many steps",
--     "format mismatch" — common architect failure modes.
--   - A labeled training set for fine-tuning the architect prompt or
--     swapping models when one regresses.
--   - A "trust receipt" the user sees ("tu feedback se grabó") that
--     makes the AI feel collaborative rather than opaque.
--
-- Shape: one row per (execution_id, user_id) pair. We don't enforce a
-- uniqueness constraint — users can revise their feedback by inserting
-- a newer row; analytics queries take MAX(created_at).

create table if not exists studio_graph_evals (
  id              uuid primary key default gen_random_uuid(),
  execution_id    uuid not null,
  user_id         uuid references auth.users(id) on delete set null,
  tenant_id       text not null default 'shift',
  rating          smallint check (rating in (-1, 1)),
  feedback_text   text,
  failure_category text,
  graph_snapshot  jsonb,
  output_snapshot jsonb,
  created_at      timestamptz not null default now()
);

-- ─── Enum-ish check on failure_category ──────────────────────────────
-- Keeping this as a CHECK constraint (not a Postgres ENUM) so we can
-- add categories without an ALTER TYPE round-trip. Allowed values:
--   'agent_picked_wrong'  — architect chose the wrong specialist
--   'too_many_steps'      — DAG was over-engineered for the task
--   'bad_format'          — export format mismatched the user's intent
--   'tone_off'            — output style didn't match request
--   'hallucination'       — agent fabricated facts
--   'other'               — catch-all (paired with feedback_text)
alter table studio_graph_evals
  drop constraint if exists studio_graph_evals_category_chk;
alter table studio_graph_evals
  add  constraint studio_graph_evals_category_chk
  check (failure_category is null or failure_category in (
    'agent_picked_wrong',
    'too_many_steps',
    'bad_format',
    'tone_off',
    'hallucination',
    'other'
  ));

-- ─── RLS ─────────────────────────────────────────────────────────────
-- Users see + write their own evals. Admins (mirrors the existing
-- `status_admin_overrides` allow-list used by Status) can read all rows
-- as a training-data corpus.
--
-- NOTE: `status_admin_overrides` is owned by the Status app but lives
-- on the same Supabase project. Importing the allow-list here is the
-- least surprising way to grant cross-app admin reads. If/when Studio
-- gets its own admin model we'll swap this policy.

alter table studio_graph_evals enable row level security;

drop policy if exists "studio_graph_evals_own_read" on studio_graph_evals;
create policy "studio_graph_evals_own_read" on studio_graph_evals
  for select
  using (user_id = auth.uid());

drop policy if exists "studio_graph_evals_own_insert" on studio_graph_evals;
create policy "studio_graph_evals_own_insert" on studio_graph_evals
  for insert
  with check (user_id = auth.uid());

drop policy if exists "studio_graph_evals_admin_read" on studio_graph_evals;
create policy "studio_graph_evals_admin_read" on studio_graph_evals
  for select
  using (
    exists (
      select 1
      from status_admin_overrides sao
      where sao.user_id = auth.uid()
    )
  );

-- ─── Indexes ─────────────────────────────────────────────────────────
create index if not exists studio_graph_evals_exec_idx
  on studio_graph_evals (execution_id);

create index if not exists studio_graph_evals_tenant_idx
  on studio_graph_evals (tenant_id, created_at desc);

create index if not exists studio_graph_evals_user_idx
  on studio_graph_evals (user_id, created_at desc);

-- ─── DOWN ROLLBACK ───────────────────────────────────────────────────
-- drop index  if exists studio_graph_evals_user_idx;
-- drop index  if exists studio_graph_evals_tenant_idx;
-- drop index  if exists studio_graph_evals_exec_idx;
-- drop policy if exists "studio_graph_evals_admin_read" on studio_graph_evals;
-- drop policy if exists "studio_graph_evals_own_insert" on studio_graph_evals;
-- drop policy if exists "studio_graph_evals_own_read" on studio_graph_evals;
-- drop table  if exists studio_graph_evals;
