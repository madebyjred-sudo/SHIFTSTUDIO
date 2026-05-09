-- ════════════════════════════════════════════════════════════════════
-- 0009_architect_advisory_lock.sql
-- ════════════════════════════════════════════════════════════════════
-- studio_architect_insert_with_offset
-- Serializes /architect runs on the same workspace via a Postgres
-- transaction-scoped advisory lock. Without it, two concurrent runs
-- (e.g. two browser tabs hitting POST /api/workspace/:id/architect on
-- the same workspace) both read the same `max(y + height)` value before
-- either insert lands, then insert at the same Y → overlapping hojas.
--
-- The TS-side `runArchitect` previously did:
--   1. SELECT y, height FROM studio_workspace_nodes WHERE workspace_id = $1
--   2. compute maxBottom in JS
--   3. INSERT new rows at maxBottom + GAP
-- These three steps live in separate supabase-js RPC round-trips, so
-- there is no transaction enclosing them. A pg_advisory_xact_lock taken
-- in step (1) wouldn't survive into step (3). The fix is to fold all
-- three steps into a single SECURITY DEFINER function that holds the
-- xact-lock until commit.
--
-- Lock key derivation: hashtextextended(uuid::text, 0) → bigint. UUIDs
-- compress into the int8 keyspace with overwhelmingly low collision
-- probability; the worst-case impact of a collision is that two
-- unrelated workspaces serialize their architect runs against each
-- other for the duration of one insert, which is harmless.
--
-- Caller contract: the function raises SQLSTATE P0001 with message
-- 'architect_in_progress' when another run is holding the lock. The
-- /architect endpoint translates this to HTTP 409, and QuickHojaModal
-- shows a Spanish hint to retry in a few seconds.

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
  -- hashtextextended returns int8; abs() guards the (vanishingly rare)
  -- INT8_MIN edge so we always get a non-negative key.
  lock_key    bigint := abs(hashtextextended(p_workspace_id::text, 0));
  v_max_bottom float;
  v_offset_y   float;
  v_row        jsonb;
  v_inserted   studio_workspace_nodes%rowtype;
begin
  -- Acquire xact-scoped advisory lock; auto-released on COMMIT/ROLLBACK
  -- of the implicit function transaction. If another session holds it,
  -- bail out fast — the caller decides whether to retry or surface 409.
  if not pg_try_advisory_xact_lock(lock_key) then
    raise exception 'architect_in_progress' using errcode = 'P0001';
  end if;

  -- Compute next free Y, mirroring the previous TS logic exactly:
  --   maxBottom = max(y + coalesce(height, NODE_H))
  -- The coalesce on height is defensive — the column has a NOT NULL +
  -- default, but historical rows imported via other paths might be 0.
  select coalesce(max(n.y + coalesce(n.height, 280)), 0)
  into   v_max_bottom
  from   studio_workspace_nodes n
  where  n.workspace_id = p_workspace_id;

  -- Top-margin parity with the previous TS logic:
  --   yOffset = maxBottom > 0 ? maxBottom + GAP(40) : 80
  -- so a virgin canvas gets an 80px breathing room from the top edge,
  -- while subsequent runs only get a 40px gap below the last row.
  if v_max_bottom > 0 then
    v_offset_y := v_max_bottom + 40;
  else
    v_offset_y := 80;
  end if;

  -- Insert each prepared row. The TS layer already computed (x, y) on
  -- the 4-column grid relative to a yOffset of 0; this function
  -- re-anchors by adding v_offset_y so the deck lands below existing
  -- content. Every other column is taken straight from the JSON.
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

-- DOWN ROLLBACK:
-- drop function if exists studio_architect_insert_with_offset(uuid, jsonb);
