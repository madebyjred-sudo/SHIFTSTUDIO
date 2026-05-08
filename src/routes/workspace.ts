/**
 * @file routes/workspace.ts
 * @description BFF CRUD for Shifty Studio's Workspace ("Notebook") mode.
 *
 * Ported from CL2's apps/api/src/routes/workspace.ts (proven ~6 weeks
 * in production). Scope of THIS file is CRUD only — AI primitives
 * (/transform, /architect, /turn), import/export, and citation→corpus
 * lookups are deferred to T4/T5.
 *
 * Tables (all prefixed `studio_*` to coexist with CL2 + Brandhub in the
 * shared Supabase project):
 *   studio_workspaces           — canvas containers, owned by user_id
 *   studio_workspace_nodes      — hojas / notes / cites / assets on canvas
 *   studio_workspace_citations  — pinned chunks, optionally attached to a node
 *
 * Authorization model:
 *   We use the SERVICE ROLE supabase client (bypasses RLS) and manually
 *   scope every query by user_id. This is required because Studio runs
 *   in `VITE_BYPASS_AUTH=true` mode where the request has no Supabase
 *   session for RLS to enforce against. The BFF is the auth boundary;
 *   all writes 401 if `getUserIdFromRequest` returns null.
 *
 * Endpoints (mounted under /api/workspace):
 *   GET    /                          list user's workspaces (+ node_count)
 *   POST   /                          create workspace
 *   GET    /:id                       get workspace + nodes
 *   PATCH  /:id                       update title/description/archived
 *   DELETE /:id                       hard delete (cascades to nodes)
 *   GET    /:id/nodes                 list nodes (?withContent=1 hydrates jsonb)
 *   GET    /:id/nodes/:nodeId         single node (always with content)
 *   POST   /:id/nodes                 create node (accepts optional client-gen id)
 *   PATCH  /:id/nodes/:nodeId         update geometry/content
 *   DELETE /:id/nodes/:nodeId         delete one node
 *   GET    /:id/attach-context        ordered hoja markdown for chat context
 *   POST   /citations                 save chunk to user inbox / pinned to node
 */
import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../services/supabaseAdminClient.js';
import { getUserIdFromRequest, isValidUuid } from '../services/auth.js';

export const workspaceRouter = Router();

// Allowed colors mirror the CHECK constraint in 0001_studio_workspace.sql.
const ALLOWED_COLORS = new Set(['default', 'burgundy', 'ink', 'sage', 'amber']);
// Allowed types mirror the CHECK constraint after migration 0002.
const ALLOWED_TYPES = new Set([
  'hoja', 'note', 'cite', 'expediente_ref', 'image', 'document', 'audio',
]);

// ─── Helpers ──────────────────────────────────────────────────────────

function dbReady(res: Response): boolean {
  if (!supabaseAdmin) {
    res.status(503).json({
      ok: false,
      error: 'database_unavailable',
      hint: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars not set.',
    });
    return false;
  }
  return true;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

/**
 * Verify a workspace belongs to the requesting user. Writes 404 + returns
 * false if not. Use as `if (!await ownedWorkspace(...)) return;` at the
 * top of nested-route handlers.
 */
async function ownedWorkspace(
  userId: string,
  workspaceId: string,
  res: Response
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[workspace] ownership check failed:', error.message);
    res.status(500).json({ ok: false, error: 'ownership_check_failed' });
    return false;
  }
  if (!data) {
    res.status(404).json({ ok: false, error: 'workspace_not_found' });
    return false;
  }
  return true;
}

/** Coerce arbitrary input to a finite number, or undefined. */
function num(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined;
  return Number.isFinite(v) ? v : undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════════════════════

// GET /api/workspace — list user's workspaces with node counts
workspaceRouter.get('/', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const includeArchived = req.query.archived === '1';

  try {
    let q = supabaseAdmin!
      .from('studio_workspaces')
      .select('id, title, description, archived, last_pptx, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (!includeArchived) q = q.eq('archived', false);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Batch-attach node counts in one query.
    const ids = (rows ?? []).map((r) => r.id as string);
    const countMap: Record<string, number> = {};
    if (ids.length > 0) {
      const { data: nodes, error: nErr } = await supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('workspace_id')
        .in('workspace_id', ids);
      if (nErr) throw new Error(nErr.message);
      for (const n of nodes ?? []) {
        const wid = n.workspace_id as string;
        countMap[wid] = (countMap[wid] ?? 0) + 1;
      }
    }

    const items = (rows ?? []).map((r) => ({
      ...r,
      node_count: countMap[r.id as string] ?? 0,
    }));

    res.json({ ok: true, items });
  } catch (err) {
    console.error('[workspace] list failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'list_failed' });
  }
});

// POST /api/workspace — create workspace
workspaceRouter.post('/', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { title = 'Mi espacio', description = '' } = req.body ?? {};

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspaces')
      .insert({
        user_id: userId,
        title: String(title).slice(0, 200),
        description: String(description).slice(0, 1000),
      })
      .select('id, title, description, archived, last_pptx, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);

    console.log(`[workspace] created ${data?.id} for user ${userId}`);
    res.status(201).json({ ok: true, workspace: { ...data, node_count: 0 } });
  } catch (err) {
    console.error('[workspace] create failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'create_failed' });
  }
});

// GET /api/workspace/:id — workspace meta + all nodes (hydrated)
workspaceRouter.get('/:id', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }

  try {
    const { data: ws, error: wsErr } = await supabaseAdmin!
      .from('studio_workspaces')
      .select('id, title, description, archived, last_pptx, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (wsErr) throw new Error(wsErr.message);
    if (!ws) {
      res.status(404).json({ ok: false, error: 'workspace_not_found' });
      return;
    }

    const { data: nodes, error: nErr } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select('*')
      .eq('workspace_id', id)
      .order('created_at', { ascending: true });
    if (nErr) throw new Error(nErr.message);

    res.json({ ok: true, workspace: ws, nodes: nodes ?? [] });
  } catch (err) {
    console.error('[workspace] get failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'get_failed' });
  }
});

// PATCH /api/workspace/:id — rename / set description / archive
workspaceRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }

  const allowed: Record<string, unknown> = {};
  if (typeof req.body?.title === 'string') allowed.title = req.body.title.slice(0, 200);
  if (typeof req.body?.description === 'string')
    allowed.description = req.body.description.slice(0, 1000);
  if (typeof req.body?.archived === 'boolean') allowed.archived = req.body.archived;

  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ ok: false, error: 'no_fields' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspaces')
      .update(allowed)
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, title, description, archived, last_pptx, created_at, updated_at')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ ok: false, error: 'workspace_not_found' });
      return;
    }
    res.json({ ok: true, workspace: data });
  } catch (err) {
    console.error('[workspace] update failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

// DELETE /api/workspace/:id — hard delete; FK ON DELETE CASCADE handles nodes
workspaceRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }

  try {
    const { error, count } = await supabaseAdmin!
      .from('studio_workspaces')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    if (!count) {
      res.status(404).json({ ok: false, error: 'workspace_not_found' });
      return;
    }
    console.log(`[workspace] deleted ${id} for user ${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[workspace] delete failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'delete_failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// NODES
// ═══════════════════════════════════════════════════════════════════════

// GET /api/workspace/:id/nodes — list nodes (default lean, ?withContent=1 hydrates)
workspaceRouter.get('/:id/nodes', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  const withContent = req.query.withContent === '1';
  const cols = withContent
    ? 'id, workspace_id, type, x, y, width, height, z_index, title, subtitle, color, content, created_at, updated_at'
    : 'id, workspace_id, type, x, y, width, height, z_index, title, subtitle, color, created_at, updated_at';

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select(cols)
      .eq('workspace_id', id)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, nodes: data ?? [] });
  } catch (err) {
    console.error('[workspace] nodes list failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'nodes_list_failed' });
  }
});

// GET /api/workspace/:id/nodes/:nodeId — single node, fully hydrated
workspaceRouter.get('/:id/nodes/:nodeId', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!isValidUuid(id) || !isValidUuid(nodeId)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select('*')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ ok: false, error: 'node_not_found' });
      return;
    }
    res.json({ ok: true, node: data });
  } catch (err) {
    console.error('[workspace] node get failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'node_get_failed' });
  }
});

// POST /api/workspace/:id/nodes — create node
//
// Accepts optional `id` (uuid) so the client can pre-generate and avoid
// the round-trip flicker on canvas drops. If absent, the DB default
// (gen_random_uuid()) fills it in.
workspaceRouter.post('/:id/nodes', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  const body = req.body ?? {};
  const type = typeof body.type === 'string' ? body.type : 'hoja';
  if (!ALLOWED_TYPES.has(type)) {
    res.status(400).json({ ok: false, error: 'invalid_type' });
    return;
  }
  const color = typeof body.color === 'string' ? body.color : 'default';
  if (!ALLOWED_COLORS.has(color)) {
    res.status(400).json({ ok: false, error: 'invalid_color' });
    return;
  }

  // Build insert row defensively — accept partials, fall back to DB defaults.
  const row: Record<string, unknown> = {
    workspace_id: id,
    type,
    color,
    title: typeof body.title === 'string' ? body.title.slice(0, 300) : 'Sin título',
    subtitle: typeof body.subtitle === 'string' ? body.subtitle.slice(0, 300) : '',
    content: body.content && typeof body.content === 'object' ? body.content : {},
  };
  const x = num(body.x); if (x !== undefined) row.x = x;
  const y = num(body.y); if (y !== undefined) row.y = y;
  const w = num(body.width); if (w !== undefined) row.width = w;
  const h = num(body.height); if (h !== undefined) row.height = h;
  const z = num(body.z_index); if (z !== undefined) row.z_index = z;
  if (typeof body.id === 'string' && body.id.length > 0) row.id = body.id;

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .insert(row)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, node: data });
  } catch (err) {
    console.error('[workspace] node create failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'node_create_failed' });
  }
});

// PATCH /api/workspace/:id/nodes/:nodeId — update geometry/content/meta
//
// All fields optional + idempotent (same body twice = same DB state).
// The client-side debounced auto-save (~800ms in CL2) hits this endpoint
// repeatedly during canvas drags; do not add throttling here.
workspaceRouter.patch('/:id/nodes/:nodeId', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!isValidUuid(id) || !isValidUuid(nodeId)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  const body = req.body ?? {};
  const allowed: Record<string, unknown> = {};
  if (typeof body.title === 'string') allowed.title = body.title.slice(0, 300);
  if (typeof body.subtitle === 'string') allowed.subtitle = body.subtitle.slice(0, 300);
  if (typeof body.color === 'string') {
    if (!ALLOWED_COLORS.has(body.color)) {
      res.status(400).json({ ok: false, error: 'invalid_color' });
      return;
    }
    allowed.color = body.color;
  }
  if (typeof body.type === 'string') {
    if (!ALLOWED_TYPES.has(body.type)) {
      res.status(400).json({ ok: false, error: 'invalid_type' });
      return;
    }
    allowed.type = body.type;
  }
  const x = num(body.x); if (x !== undefined) allowed.x = x;
  const y = num(body.y); if (y !== undefined) allowed.y = y;
  const w = num(body.width); if (w !== undefined) allowed.width = w;
  const h = num(body.height); if (h !== undefined) allowed.height = h;
  const z = num(body.z_index); if (z !== undefined) allowed.z_index = z;
  if (body.content !== undefined) {
    if (body.content !== null && typeof body.content !== 'object') {
      res.status(400).json({ ok: false, error: 'content_must_be_object' });
      return;
    }
    allowed.content = body.content;
  }

  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ ok: false, error: 'no_fields' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .update(allowed)
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .select('id, workspace_id, type, title, subtitle, color, x, y, width, height, z_index, content, created_at, updated_at')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ ok: false, error: 'node_not_found' });
      return;
    }
    res.json({ ok: true, node: data });
  } catch (err) {
    console.error('[workspace] node update failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'node_update_failed' });
  }
});

// DELETE /api/workspace/:id/nodes/:nodeId
workspaceRouter.delete('/:id/nodes/:nodeId', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id, nodeId } = req.params;
  if (!isValidUuid(id) || !isValidUuid(nodeId)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  try {
    const { error, count } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .delete({ count: 'exact' })
      .eq('id', nodeId)
      .eq('workspace_id', id);
    if (error) throw new Error(error.message);
    if (!count) {
      res.status(404).json({ ok: false, error: 'node_not_found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[workspace] node delete failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'node_delete_failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT + CITATIONS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/workspace/:id/attach-context — flatten workspace into chat context
//
// Used by the Studio chat composer to "attach" the current canvas to a
// turn. Returns ordered hoja markdown plus title/subtitle metadata,
// capped at ~50K chars (truncation flagged in response). Reading order
// is top-to-bottom by 200px y-bands, then left-to-right within a band.
workspaceRouter.get('/:id/attach-context', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }

  try {
    const [{ data: ws, error: wsErr }, { data: nodes, error: nErr }] = await Promise.all([
      supabaseAdmin!
        .from('studio_workspaces')
        .select('id, title, description')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle(),
      supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('id, title, subtitle, content, color, x, y')
        .eq('workspace_id', id),
    ]);

    if (wsErr) throw new Error(wsErr.message);
    if (!ws) {
      res.status(404).json({ ok: false, error: 'workspace_not_found' });
      return;
    }
    if (nErr) throw new Error(nErr.message);

    const ordered = (nodes ?? []).slice().sort((a, b) => {
      const yA = Math.floor((a.y as number) / 200);
      const yB = Math.floor((b.y as number) / 200);
      if (yA !== yB) return yA - yB;
      return (a.x as number) - (b.x as number);
    });

    const CHAR_CAP = 50_000;
    const mdParts: string[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const n of ordered) {
      const body = ((n.content as Record<string, unknown> | null)?.md as string) ?? '';
      const section =
        [
          `## ${n.title}`,
          (n.subtitle as string | undefined) ? `_${n.subtitle}_` : null,
          body.trim() || null,
          '---',
        ]
          .filter(Boolean)
          .join('\n') + '\n';

      if (totalChars + section.length > CHAR_CAP) {
        truncated = true;
        break;
      }
      mdParts.push(section);
      totalChars += section.length;
    }

    const full_md = mdParts.join('\n');
    const includedCount = mdParts.length;

    res.json({
      ok: true,
      workspace: { id: ws.id, title: ws.title, description: ws.description ?? '' },
      titles: ordered.slice(0, includedCount).map((n) => ({
        id: n.id,
        title: n.title,
        subtitle: (n.subtitle as string | undefined) ?? '',
        color: n.color,
      })),
      full_md,
      total_chars: totalChars,
      hoja_count: includedCount,
      truncated,
    });
  } catch (err) {
    console.error('[workspace] attach-context failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'attach_context_failed' });
  }
});

// POST /api/workspace/citations — save chunk to user's inbox (or pin to node)
//
// Upserts on (user_id, chunk_id) — saving the same chunk twice updates
// the existing row's note/excerpt. Pass `node_id` to pin to a hoja, or
// omit for the unattached inbox.
workspaceRouter.post('/citations', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const body = req.body ?? {};
  const { chunk_id, source_label, excerpt, note, node_id } = body;
  if (!chunk_id || typeof chunk_id !== 'string') {
    res.status(400).json({ ok: false, error: 'chunk_id_required' });
    return;
  }

  // Normalize node_id: accept string only; treat null/undefined as "no pin".
  const pinNodeId: string | null =
    node_id === null || node_id === undefined
      ? null
      : typeof node_id === 'string'
        ? node_id
        : null;

  // CRITICAL: when pinning to a node, verify the node belongs to the calling
  // user (via its parent workspace). The DB FK only checks the node EXISTS,
  // not that its workspace.user_id matches — without this check, user A
  // could pin a citation to user B's node UUID (cross-tenant pollution).
  // Return 400 (NOT 404) on failure so we don't leak whether the UUID
  // exists for another user.
  if (pinNodeId !== null) {
    if (!isValidUuid(pinNodeId)) {
      res.status(400).json({ ok: false, error: 'invalid_node_id' });
      return;
    }
    try {
      // Two-step lookup: fetch the node's workspace_id, then verify that
      // workspace belongs to the caller. Equivalent to a JOIN but uses
      // only existing supabase-js patterns already in this file.
      const { data: nodeRow, error: nodeErr } = await supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('id, workspace_id')
        .eq('id', pinNodeId)
        .maybeSingle();
      if (nodeErr) throw new Error(nodeErr.message);
      if (!nodeRow) {
        res.status(400).json({ ok: false, error: 'invalid_node_id' });
        return;
      }
      const { data: wsRow, error: wsErr } = await supabaseAdmin!
        .from('studio_workspaces')
        .select('id')
        .eq('id', nodeRow.workspace_id as string)
        .eq('user_id', userId)
        .maybeSingle();
      if (wsErr) throw new Error(wsErr.message);
      if (!wsRow) {
        res.status(400).json({ ok: false, error: 'invalid_node_id' });
        return;
      }
    } catch (err) {
      console.error(
        '[workspace] citation node ownership check failed:',
        (err as Error).message
      );
      res.status(500).json({ ok: false, error: 'citation_save_failed' });
      return;
    }
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_citations')
      .upsert(
        {
          user_id: userId,
          chunk_id,
          source_label: typeof source_label === 'string' ? source_label : null,
          excerpt: typeof excerpt === 'string' ? excerpt : null,
          note: typeof note === 'string' ? note : '',
          node_id: pinNodeId,
        },
        { onConflict: 'user_id,chunk_id', ignoreDuplicates: false }
      )
      .select('id, chunk_id, source_label, excerpt, note, node_id, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, citation: data });
  } catch (err) {
    console.error('[workspace] citation save failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'citation_save_failed' });
  }
});
