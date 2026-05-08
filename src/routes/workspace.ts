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
import {
  callOpenRouter,
  streamOpenRouter,
  type OpenRouterMessage,
} from '../services/openRouterDirect.js';
import { firePeajeIngest } from '../services/peajeClient.js';
import { getApprovedRag } from '../services/puntoMedioClient.js';

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

// ═══════════════════════════════════════════════════════════════════════
// AI PRIMITIVES — transform / architect / turn
// ═══════════════════════════════════════════════════════════════════════
//
// Architecture invariant: these endpoints BYPASS Cerebro entirely and
// call OpenRouter directly via openRouterDirect.ts. Cerebro is touched
// only for:
//   - getApprovedRag (read, in /turn intent=chat scope_system_prompt)
//   - firePeajeIngest (write, fire-and-forget at end of /turn chat)
//
// Studio is NOT legislative — all system prompts are neutral
// creative/strategic-assistant phrasing. No SIL corpus, no reglamento,
// no expediente. Ported from CL2 with that scaffolding stripped.

// ─── Transform ───────────────────────────────────────────────────────

type TransformAction = 'rewrite' | 'expand' | 'shorten' | 'summarize' | 'polish' | 'custom';

const TRANSFORM_SYSTEMS: Record<TransformAction, string> = {
  rewrite: `You are a senior creative writing assistant. Rewrite the following fragment preserving its meaning, while sharpening the prose. Keep proper nouns, dates, and numbers exactly as given. Return ONLY the rewritten text — no preamble, no explanation.`,
  expand: `You are a strategic writing assistant. Expand the following fragment by adding relevant context, examples, or implications. Keep tone consistent with the original. Return ONLY the expanded text (with the original integrated naturally) — no preamble, no explanation.`,
  shorten: `You are a senior editor. Shorten the following fragment while preserving its key claims and proper nouns. Aim for ~50% of the original length. Return ONLY the shortened text — no preamble, no explanation.`,
  summarize: `You are a strategic writing assistant. Summarize the following fragment in 2-3 sentences, keeping the essential facts (numbers, dates, named entities). Return ONLY the summary — no preamble, no explanation.`,
  polish: `You are a senior copy editor. Polish the following fragment — fix grammar, tighten phrasing, improve flow — without altering its meaning or voice. Return ONLY the polished text — no preamble, no explanation.`,
  custom: '', // filled at runtime from the caller's instruction
};

// POST /api/workspace/:id/transform
//   body: { selection: string, action: TransformAction, instruction?: string, tone?: string }
//   returns: { ok, text, action, model, ms }
//
// One-shot text transform on a user-highlighted fragment inside a hoja.
// Uses TRANSFORM_MODEL by default; switches to TRANSFORM_EXPAND_MODEL
// (heavier model, more reasoning headroom) when action=expand.
workspaceRouter.post('/:id/transform', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  const selection = String(req.body?.selection ?? '').trim();
  const action = String(req.body?.action ?? 'rewrite') as TransformAction;
  const instruction = String(req.body?.instruction ?? '').trim();
  const tone = String(req.body?.tone ?? '').trim();

  if (!selection) {
    res.status(400).json({ ok: false, error: 'selection_required' });
    return;
  }
  if (selection.length > 4000) {
    res.status(400).json({ ok: false, error: 'selection_too_long' });
    return;
  }
  if (!(action in TRANSFORM_SYSTEMS)) {
    res.status(400).json({ ok: false, error: 'invalid_action' });
    return;
  }
  if (action === 'custom' && !instruction) {
    res.status(400).json({ ok: false, error: 'instruction_required' });
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    res.status(500).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }

  // Env vars (all have defaults so deploys never block on config):
  //   TRANSFORM_MODEL        — default model for rewrite/shorten/summarize/polish/custom
  //   TRANSFORM_EXPAND_MODEL — heavier model for `expand` (more reasoning needed)
  const model =
    action === 'expand'
      ? (process.env.TRANSFORM_EXPAND_MODEL ?? 'anthropic/claude-sonnet-4')
      : (process.env.TRANSFORM_MODEL ?? 'google/gemini-2.5-flash');

  // Build system prompt. For 'custom', the user's instruction IS the prompt.
  let systemPrompt = TRANSFORM_SYSTEMS[action];
  if (action === 'custom') {
    systemPrompt = `You are a creative writing assistant. ${instruction}. Return ONLY the resulting text — no preamble, no explanation.`;
  }
  if (tone) {
    systemPrompt += ` Tone: ${tone}.`;
  }

  try {
    const t0 = Date.now();
    const text = await callOpenRouter({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: selection },
      ],
      max_tokens: 1500,
      temperature: action === 'expand' ? 0.6 : 0.3,
      timeoutMs: 30_000,
    });

    if (!text) {
      res.status(502).json({ ok: false, error: 'transform_empty_response' });
      return;
    }

    const ms = Date.now() - t0;
    console.log(
      `[workspace] transform ok action=${action} model=${model} in_chars=${selection.length} out_chars=${text.length} ms=${ms}`,
    );
    res.json({ ok: true, text, action, model, ms });
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[workspace] transform failed:', msg);
    if (msg.startsWith('openrouter_')) {
      res.status(502).json({ ok: false, error: 'transform_upstream_error', detail: msg.slice(0, 200) });
    } else {
      res.status(500).json({ ok: false, error: msg });
    }
  }
});

// ─── Architect ───────────────────────────────────────────────────────

const ARCHITECT_SYSTEM = `You are a strategic creative assistant. Given a user's brief about a creative or strategic topic — a campaign, a product positioning, a research question, an essay, a pitch — you produce a structured BRIEF as multiple markdown pages (each page = one "hoja").

You respond ONLY with a valid JSON object matching this exact schema:

{
  "hojas": [
    {
      "title":      "string — descriptive title, max 80 chars",
      "subtitle":   "string — 1-line subtitle (may be empty)",
      "content_md": "string — markdown body, REQUIRED 300-700 words of substantive content",
      "color":      "default" | "burgundy" | "ink" | "sage" | "amber"
    }
  ],
  "summary": "string — 1-2 sentences explaining the layout"
}

TYPICAL STRUCTURE (adapt to the topic):
1. Executive Summary (color "burgundy") — what it is, the angle, why it matters
2. Context & Background — relevant history, framing, prior art
3. Core Analysis — the substantive content / argument / breakdown
4. Implications or Tensions — trade-offs, risks, audiences, counterpoints
5. Stakeholders or Voices — who cares, what each wants
6. Conclusion & Next Steps — synthesis and concrete moves

STRICT RULES:
1. Generate between 3 and 7 hojas based on complexity. Vary colors.
2. The FIRST hoja is always an Executive Summary in burgundy.
3. EACH HOJA must have a non-empty content_md with 300-700 words of real content.
   A brief without body content is useless.
4. Valid markdown: ## subsections, **bold**, lists with -, blank lines between paragraphs.
5. Do NOT use backticks or \`\`\`json wrapping. Just the raw JSON object.
6. If the request is vague, generate a plausible analysis grounded in the topic mentioned. Mark unverified data as "[verify]".`;

interface ArchitectResult {
  nodes: Record<string, unknown>[];
  summary: string;
  ms: number;
}

/**
 * Run the architect — call OpenRouter in JSON mode, parse the hojas,
 * insert them atomically into studio_workspace_nodes, and return the
 * created rows. Re-used by /turn intent=build.
 *
 * Layout: 4-column grid placed below any existing nodes (next free Y).
 * Card geometry mirrors CL2 sizing rounded to Studio's frontend snap
 * (360 × 280 with 40px gutter — denser than CL2's 660 × 440 because
 *  Studio's canvas viewport is narrower).
 */
async function runArchitect(workspaceId: string, prompt: string): Promise<ArchitectResult> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('openrouter_not_configured');
  }
  if (!supabaseAdmin) {
    throw new Error('database_unavailable');
  }

  // Pull existing canvas content as context — keeps Atlas from
  // duplicating hojas the user already authored. Cap at 6 nodes × 4K
  // each (24K total).
  const ARCHITECT_CONTEXT_PER_HOJA = 4_000;
  const { data: existingHojas } = await supabaseAdmin
    .from('studio_workspace_nodes')
    .select('title, subtitle, content, type')
    .eq('workspace_id', workspaceId)
    .in('type', ['hoja', 'note', 'document'])
    .order('updated_at', { ascending: false })
    .limit(6);

  const canvasContextBlocks = (existingHojas ?? [])
    .map((n) => {
      const c = (n.content ?? {}) as Record<string, unknown>;
      const md = typeof c.md === 'string' ? c.md.trim() : '';
      const extracted = typeof c.extracted_text === 'string' ? c.extracted_text.trim() : '';
      const body = md || extracted;
      if (!body) return null;
      const trimmed =
        body.length > ARCHITECT_CONTEXT_PER_HOJA
          ? body.slice(0, ARCHITECT_CONTEXT_PER_HOJA) + '\n[…]'
          : body;
      const subtitle = (n as { subtitle?: string }).subtitle;
      const tag = n.type === 'document' ? 'Document' : 'Hoja';
      const header = subtitle ? `"${n.title}" — ${subtitle}` : `"${n.title}"`;
      return `[${tag} already on canvas] ${header}:\n${trimmed}`;
    })
    .filter((s): s is string => Boolean(s));
  const canvasContext =
    canvasContextBlocks.length > 0
      ? '\n\nTHE CANVAS ALREADY CONTAINS THE FOLLOWING (do not duplicate — extend, complement, or reference):\n\n' +
        canvasContextBlocks.join('\n\n---\n\n')
      : '';

  // Compute next free Y so multiple architect runs stack vertically.
  const { data: existing } = await supabaseAdmin
    .from('studio_workspace_nodes')
    .select('y, height')
    .eq('workspace_id', workspaceId);
  const maxBottom = (existing ?? []).reduce(
    (m, n) => Math.max(m, ((n.y as number) ?? 0) + ((n.height as number) ?? 0)),
    0,
  );

  // Call OpenRouter in JSON mode.
  const t0 = Date.now();
  const model = process.env.ARCHITECT_MODEL ?? 'google/gemini-2.5-flash';
  const raw = await callOpenRouter({
    model,
    messages: [
      { role: 'system', content: ARCHITECT_SYSTEM + canvasContext },
      { role: 'user', content: prompt },
    ],
    max_tokens: 16_000,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    timeoutMs: 60_000,
  });

  let parsed: { hojas?: Array<Record<string, unknown>>; summary?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: extract JSON from a code fence if the model misbehaved.
    const m = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (!m) throw new Error('architect_invalid_json');
    parsed = JSON.parse(m[1]);
  }

  if (!Array.isArray(parsed.hojas) || parsed.hojas.length === 0) {
    throw new Error('architect_empty_response');
  }
  // Spec floor: at least 3 hojas. Pad by re-prompting? No — surface as
  // upstream error so caller can retry. Cheaper than a second LLM round.
  if (parsed.hojas.length < 3) {
    throw new Error('architect_below_minimum');
  }

  // Diagnostic logging — same heuristic as CL2 (avg <200 chars/hoja
  // is a smell that the model returned skeletons).
  const contentLens = parsed.hojas.map((h) => String(h.content_md ?? '').length);
  const avgLen = contentLens.reduce((s, n) => s + n, 0) / contentLens.length;
  if (avgLen < 200) {
    console.warn(
      `[architect] LOW CONTENT — avg=${avgLen.toFixed(0)} chars/hoja, count=${parsed.hojas.length}`,
    );
  } else {
    console.log(
      `[architect] ok — ${parsed.hojas.length} hojas, avg ${avgLen.toFixed(0)} chars/body`,
    );
  }

  // Layout: 4-column grid, 360×280 with 40px gutter, 80px left margin.
  const NODE_W = 360;
  const NODE_H = 280;
  const GAP = 40;
  const COLS = 4;
  const VALID_COLORS = new Set(['default', 'burgundy', 'ink', 'sage', 'amber']);
  const yOffset = maxBottom > 0 ? maxBottom + GAP : 80;

  const rows = parsed.hojas.slice(0, 7).map((h, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const colorRaw = String(h.color ?? 'default');
    return {
      workspace_id: workspaceId,
      type: 'hoja',
      title: String(h.title ?? 'Untitled').slice(0, 200),
      subtitle: String(h.subtitle ?? '').slice(0, 200),
      content: { md: String(h.content_md ?? '') },
      color: VALID_COLORS.has(colorRaw) ? colorRaw : 'default',
      x: col * (NODE_W + GAP) + 80,
      y: yOffset + row * (NODE_H + GAP),
      width: NODE_W,
      height: NODE_H,
    };
  });

  const { data: created, error: insErr } = await supabaseAdmin
    .from('studio_workspace_nodes')
    .insert(rows)
    .select('*');
  if (insErr) throw new Error(insErr.message);

  // Bump workspace updated_at so the listing refresh picks up the change.
  try {
    await supabaseAdmin
      .from('studio_workspaces')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', workspaceId);
  } catch {
    /* non-critical */
  }

  return {
    nodes: (created ?? []) as Record<string, unknown>[],
    summary: String(parsed.summary ?? ''),
    ms: Date.now() - t0,
  };
}

// POST /api/workspace/:id/architect
//   body: { prompt: string }
//   returns: { ok, intent: 'build', nodes, summary, model, ms }
workspaceRouter.post('/:id/architect', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ ok: false, error: 'prompt_required' });
    return;
  }
  if (prompt.length > 4000) {
    res.status(400).json({ ok: false, error: 'prompt_too_long' });
    return;
  }

  try {
    const result = await runArchitect(id, prompt);
    const model = process.env.ARCHITECT_MODEL ?? 'google/gemini-2.5-flash';
    console.log(
      `[workspace] architect ok ws=${id} hojas=${result.nodes.length} ms=${result.ms}`,
    );
    res.json({
      ok: true,
      intent: 'build',
      nodes: result.nodes,
      summary: result.summary,
      model,
      ms: result.ms,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[workspace] architect failed:', msg);
    if (msg.startsWith('openrouter_')) {
      res.status(502).json({ ok: false, error: 'architect_upstream_error', detail: msg.slice(0, 200) });
    } else {
      res.status(500).json({ ok: false, error: msg });
    }
  }
});

// ─── Turn — unified smart turn ───────────────────────────────────────

// Workspace AI model defaults (env overrides):
//   TURN_CLASSIFIER_MODEL — short, JSON-only, low-cost
//   TURN_CHAT_MODEL       — user-facing streaming
//   TURN_EDIT_MODEL       — non-streamed node update
const TURN_CLASSIFIER_MODEL = process.env.TURN_CLASSIFIER_MODEL ?? 'google/gemini-2.5-flash';
const TURN_CHAT_MODEL = process.env.TURN_CHAT_MODEL ?? 'anthropic/claude-sonnet-4';
const TURN_EDIT_MODEL = process.env.TURN_EDIT_MODEL ?? 'google/gemini-2.5-flash';

type TurnIntent = 'chat' | 'build' | 'edit_selected' | 'edit_by_match';

// POST /api/workspace/:id/turn
//   body: {
//     query: string,
//     selected_node_id?: string,
//     deep_insight?: boolean,
//     mode?: 'auto' | 'manual',
//     forced_intent?: TurnIntent,
//     hoja_titles?: Array<{id, title, subtitle?}>,
//     history?: Array<{role: 'user'|'assistant', content: string}>,
//     agent_id?: 'lexa' | 'atlas',
//     message_id?: string,         // optional caller-supplied; we recompute fallback
//     upstream_model?: string,     // optional caller hint; we recompute fallback
//   }
//
// Step 1: classify intent (skip if agent_id provided OR mode=manual+forced_intent).
// Step 2: dispatch — chat (SSE stream), build (runArchitect), edit_selected,
//                    edit_by_match.
//
// At the end of the chat path we fire peaje ingest fire-and-forget with
// the assembled streamed text. message_id and upstream_model fallbacks
// are computed here at the call site (per T2 review action item) — never
// trusted from the caller body.
workspaceRouter.post('/:id/turn', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;
  if (!process.env.OPENROUTER_API_KEY) {
    res.status(500).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }

  const query: string = String(req.body?.query ?? '').trim();
  const mode: string = String(req.body?.mode ?? 'auto');
  const forcedIntent = req.body?.forced_intent as TurnIntent | undefined;
  const selectedNodeId = req.body?.selected_node_id as string | undefined;
  const hojaTitles = (req.body?.hoja_titles ?? []) as Array<{
    id: string;
    title: string;
    subtitle?: string;
  }>;
  const deepInsight: boolean = Boolean(req.body?.deep_insight);
  const requestedAgentId = (req.body?.agent_id as string | undefined)?.toLowerCase();
  // Studio rebrand: keep names but neutralize personas.
  //   Lexa  → conversational creative/strategic assistant (chat)
  //   Atlas → constructor (build / edit_selected)
  const agentId: 'lexa' | 'atlas' =
    requestedAgentId === 'atlas' ? 'atlas'
    : requestedAgentId === 'lexa' ? 'lexa'
    : 'lexa';
  const history = (Array.isArray(req.body?.history) ? req.body.history : []) as Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  if (!query) {
    res.status(400).json({ ok: false, error: 'query_required' });
    return;
  }
  if (query.length > 4000) {
    res.status(400).json({ ok: false, error: 'query_too_long' });
    return;
  }

  // Tenant id for peaje + RAG. Header overrideable; default 'shift'.
  const tenantHeader = req.headers['x-tenant-id'];
  const tenantId =
    typeof tenantHeader === 'string' && tenantHeader.length > 0
      ? tenantHeader
      : Array.isArray(tenantHeader) && tenantHeader[0]
        ? tenantHeader[0]
        : 'shift';

  // ── Step 1: determine intent ─────────────────────────────────────
  let intent: TurnIntent;
  let classifierConfidence = 1.0;
  let classifierTargetNodeId: string | null = null;

  if (requestedAgentId) {
    intent = agentId === 'lexa' ? 'chat' : selectedNodeId ? 'edit_selected' : 'build';
    classifierTargetNodeId = selectedNodeId ?? null;
    console.log(`[workspace/turn] agent_picker agent=${agentId} intent=${intent}`);
  } else if (mode === 'manual' && forcedIntent) {
    intent = forcedIntent;
  } else {
    // Auto-classify via OpenRouter (JSON mode, low temp).
    const classifierSystem = `You are an intent classifier for Shifty Studio's workspace.
Given the user's message and the workspace context, return ONLY a JSON object matching:
{ "intent": "chat" | "build" | "edit_selected" | "edit_by_match", "target_node_id": "<hoja id or null>", "confidence": 0.0-1.0 }

Decision rules:
- "chat" = a question or informational dialogue (what is, explain, how does)
- "build" = a request to assemble a new multi-page brief ("build me", "create hojas about", "draft a deck on", "generate an analysis")
- "edit_selected" = "improve this", "rewrite", "expand", "fix" + a node is currently selected
- "edit_by_match" = a reference to a hoja by title ("update the timeline", "expand the executive summary") — set target_node_id to the best-matching hoja id

If confidence < 0.7, return intent="chat" anyway.
Do NOT include prose. Return only the JSON object.`;

    const classifierUser = [
      `Message: "${query}"`,
      selectedNodeId ? `Currently selected node: ${selectedNodeId}` : 'No node selected.',
      hojaTitles.length > 0
        ? `Hojas in this workspace:\n${hojaTitles
            .map(
              (h) =>
                `- id="${h.id}" title="${h.title}"${h.subtitle ? ` subtitle="${h.subtitle}"` : ''}`,
            )
            .join('\n')}`
        : 'No hojas yet.',
    ].join('\n');

    try {
      const clfRaw = await callOpenRouter({
        model: TURN_CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: classifierSystem },
          { role: 'user', content: classifierUser },
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        timeoutMs: 15_000,
      });
      const clfParsed = JSON.parse(clfRaw || '{}') as {
        intent?: TurnIntent;
        target_node_id?: string | null;
        confidence?: number;
      };
      classifierConfidence =
        typeof clfParsed.confidence === 'number' ? clfParsed.confidence : 1.0;
      classifierTargetNodeId = clfParsed.target_node_id ?? null;
      intent =
        classifierConfidence >= 0.7 && clfParsed.intent ? clfParsed.intent : 'chat';
      console.log(
        `[workspace/turn] classifier intent=${intent} conf=${classifierConfidence.toFixed(2)} target=${classifierTargetNodeId}`,
      );
    } catch (clfErr) {
      console.warn('[workspace/turn] classifier failed:', (clfErr as Error).message);
      intent = 'chat';
    }
  }

  // ── Step 2: dispatch ────────────────────────────────────────────

  // ── chat: SSE-stream a direct OpenRouter call ──
  if (intent === 'chat') {
    // Pull workspace metadata + selected hoja + asset / hoja blocks
    // in parallel — same shape as CL2 but pointing at studio_* tables.
    const [
      { data: ws },
      { data: selNode },
      { data: assetNodes },
      { data: hojaNodes },
    ] = await Promise.all([
      supabaseAdmin!
        .from('studio_workspaces')
        .select('title, description')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle(),
      selectedNodeId
        ? supabaseAdmin!
            .from('studio_workspace_nodes')
            .select('title, content, type')
            .eq('id', selectedNodeId)
            .eq('workspace_id', id)
            .maybeSingle()
        : Promise.resolve({ data: null as Record<string, unknown> | null }),
      supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('id, title, content, type')
        .eq('workspace_id', id)
        .in('type', ['document'])
        .order('updated_at', { ascending: false })
        .limit(3),
      supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('id, title, subtitle, content, type')
        .eq('workspace_id', id)
        .in('type', ['hoja', 'note'])
        .order('updated_at', { ascending: false })
        .limit(8),
    ]);

    const nodeBody = (node: Record<string, unknown> | null): string | null => {
      if (!node) return null;
      const c = node.content as Record<string, unknown> | undefined;
      if (!c) return null;
      const md = typeof c.md === 'string' ? c.md.trim() : '';
      const extracted = typeof c.extracted_text === 'string' ? c.extracted_text.trim() : '';
      const body = md || extracted;
      return body.length > 0 ? body : null;
    };

    const selBody = nodeBody(selNode as Record<string, unknown> | null);
    const ASSET_CONTEXT_PER_DOC = 8_000;
    const assetBlocks = (assetNodes ?? [])
      .filter((n) => n.id !== selectedNodeId)
      .map((n) => {
        const body = nodeBody(n as Record<string, unknown>);
        if (!body) return null;
        const trimmed =
          body.length > ASSET_CONTEXT_PER_DOC
            ? body.slice(0, ASSET_CONTEXT_PER_DOC) + '\n[…]'
            : body;
        return `[Document on canvas] "${n.title}":\n${trimmed}`;
      })
      .filter((s): s is string => Boolean(s));

    const HOJA_CONTEXT_PER_DOC = 5_000;
    const hojaBlocks = (hojaNodes ?? [])
      .filter((n) => n.id !== selectedNodeId)
      .map((n) => {
        const body = nodeBody(n as Record<string, unknown>);
        if (!body) return null;
        const trimmed =
          body.length > HOJA_CONTEXT_PER_DOC
            ? body.slice(0, HOJA_CONTEXT_PER_DOC) + '\n[…]'
            : body;
        const subtitle = (n as { subtitle?: string }).subtitle;
        const header = subtitle ? `"${n.title}" — ${subtitle}` : `"${n.title}"`;
        return `[Hoja on canvas] ${header}:\n${trimmed}`;
      })
      .filter((s): s is string => Boolean(s));

    const hasAnyCanvasContent = !!selBody || assetBlocks.length > 0 || hojaBlocks.length > 0;
    const canvasReadingRules = hasAnyCanvasContent
      ? [
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          'WORKSPACE CONTEXT — READING RULES',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          'In this turn you are being given DIRECTLY the contents of the',
          "hojas and documents the user placed on their canvas. These are",
          'NOT search results — there are no tools to call.',
          '',
          'You will see three block types:',
          '  [Selected hoja]      the focused hoja — prioritize it',
          '  [Hoja on canvas]     other hojas the user authored',
          '  [Document on canvas] PDFs/DOCXs the user imported',
          '',
          '• You CAN and SHOULD read all those blocks. Do NOT say "paste it',
          '  here" or "I cannot see the content" — it is literally below.',
          '• Cite a block by its quoted title (e.g. according to "Q3 brief"…)',
          '• If the user asks for analysis: summary, key points, comparisons',
          '  between hojas — do it. You have permission to extrapolate and',
          '  give a professional opinion on the provided text.',
          '• If the request requires combining multiple blocks, do it in one',
          "  pass — don't ask the user to repaste anything.",
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ].join('\n')
      : '';

    // Pull approved RAG from Punto Medio. Soft-fail: if null, just skip.
    let ragBlock = '';
    try {
      const rag = await getApprovedRag(tenantId);
      if (rag && rag.combined_rag && rag.combined_rag.trim().length > 0) {
        ragBlock = `[Punto Medio — directrices del tenant]\n${rag.combined_rag.trim()}`;
      }
    } catch {
      // already soft-failed inside getApprovedRag, but be defensive.
    }

    // Studio agent persona — neutral, no legal framing.
    const agentPersona =
      agentId === 'atlas'
        ? `You are Atlas, a constructor-style strategic assistant for Shifty Studio. You build and refine structured artifacts. In a chat turn, give a concise, useful answer; if the user wants to construct something, suggest they switch to build mode.`
        : `You are Lexa, a thoughtful creative and strategic assistant for Shifty Studio. You help the user think through ideas, draft text, and reason about the content on their canvas. Be concise, specific, and direct.`;

    const scopeSystemPrompt = [
      ragBlock,
      agentPersona,
      ws ? `[Current workspace] "${ws.title}"${ws.description ? ` — ${ws.description}` : ''}` : '',
      canvasReadingRules,
      selNode
        ? `[Selected hoja] "${(selNode as Record<string, unknown>).title}":\n${selBody ?? '(no textual content — may be an image, audio, or unindexed document)'}`
        : '',
      ...hojaBlocks,
      ...assetBlocks,
      hojaTitles.length > hojaBlocks.length + (selNode ? 1 : 0)
        ? `[Additional hojas in workspace, not included above] ${hojaTitles
            .filter(
              (h) =>
                h.id !== selectedNodeId &&
                !hojaBlocks.some((b) => b.includes(`"${h.title}"`)),
            )
            .map((h) => `"${h.title}"`)
            .join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Open SSE response.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(
      `event: meta\ndata: ${JSON.stringify({
        intent: 'chat',
        intent_confidence: classifierConfidence,
        agent_id: agentId,
        deep_insight: deepInsight,
      })}\n\n`,
    );

    // Build OpenRouter messages: system + history + current user query.
    const orMessages: OpenRouterMessage[] = [
      { role: 'system', content: scopeSystemPrompt },
      ...history.map<OpenRouterMessage>((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: query },
    ];

    let assembled = '';
    let tokensForwarded = 0;
    try {
      await streamOpenRouter({
        model: TURN_CHAT_MODEL,
        messages: orMessages,
        temperature: 0.5,
        max_tokens: 4_000,
        timeoutMs: 90_000,
        onChunk: (text) => {
          assembled += text;
          tokensForwarded++;
          // Frontend's streamWorkspaceTurn parser expects {type, payload}
          // envelopes — match that contract for drop-in compatibility
          // with the CL2-style chat parser the Studio canvas uses.
          res.write(`data: ${JSON.stringify({ type: 'token', payload: text })}\n\n`);
        },
      });
      console.log(
        `[workspace/turn] chat ok tokens=${tokensForwarded} model=${TURN_CHAT_MODEL} ws=${id}`,
      );
    } catch (streamErr) {
      const msg = (streamErr as Error).message;
      console.warn('[workspace/turn] chat stream failed:', msg);
      res.write(
        `data: ${JSON.stringify({
          type: 'token',
          payload: `\n\n_[error: ${msg}]_`,
        })}\n\n`,
      );
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();

    // ── Peaje ingest (fire-and-forget) ──
    // Compute message_id and upstream_model fallbacks at THIS call site
    // (per T2 review action item) — never trust caller-provided values
    // for these fields.
    const message_id =
      `studio-${tenantId}-${id}-${Date.now()}`;
    const upstream_model = TURN_CHAT_MODEL;

    void firePeajeIngest({
      app_id: 'studio',
      tenantId,
      sessionId: id, // workspace id IS the session for peaje purposes
      agentId,
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: query },
      ],
      response: assembled,
      message_id,
      upstream_model,
    });

    return;
  }

  // ── build: delegate to runArchitect ──
  if (intent === 'build') {
    try {
      const result = await runArchitect(id, query);
      const model = process.env.ARCHITECT_MODEL ?? 'google/gemini-2.5-flash';
      res.json({
        ok: true,
        intent: 'build',
        nodes: result.nodes,
        summary: result.summary,
        model,
        ms: result.ms,
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('[workspace/turn] build failed:', msg);
      if (msg.startsWith('openrouter_')) {
        res
          .status(502)
          .json({ ok: false, intent: 'build', error: 'architect_upstream_error', detail: msg.slice(0, 200) });
      } else {
        res.status(500).json({ ok: false, intent: 'build', error: msg });
      }
    }
    return;
  }

  // ── edit_selected ──
  if (intent === 'edit_selected') {
    if (!selectedNodeId) {
      res.status(400).json({
        ok: false,
        error: 'selected_node_id_required_for_edit_selected',
      });
      return;
    }
    if (!isValidUuid(selectedNodeId)) {
      res.status(400).json({ ok: false, error: 'invalid_node_id' });
      return;
    }

    const { data: node, error: nodeErr } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select('id, title, content')
      .eq('id', selectedNodeId)
      .eq('workspace_id', id)
      .maybeSingle();
    if (nodeErr || !node) {
      res.status(404).json({ ok: false, error: 'node_not_found' });
      return;
    }

    const currentMd =
      ((node as Record<string, unknown>).content as Record<string, unknown> | undefined)?.md as string ?? '';
    const editSystem = `You are a creative and strategic editor. ${query}. Return ONLY the resulting markdown text — no preamble.`;

    try {
      const t0 = Date.now();
      const newText = await callOpenRouter({
        model: TURN_EDIT_MODEL,
        messages: [
          { role: 'system', content: editSystem },
          { role: 'user', content: currentMd },
        ],
        max_tokens: 1500,
        temperature: 0.3,
        timeoutMs: 30_000,
      });

      await supabaseAdmin!
        .from('studio_workspace_nodes')
        .update({ content: { md: newText } })
        .eq('id', selectedNodeId)
        .eq('workspace_id', id);

      res.json({
        ok: true,
        intent: 'edit_selected',
        node_id: selectedNodeId,
        new_content: newText,
        model: TURN_EDIT_MODEL,
        ms: Date.now() - t0,
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('[workspace/turn] edit_selected failed:', msg);
      if (msg.startsWith('openrouter_')) {
        res
          .status(502)
          .json({ ok: false, intent: 'edit_selected', error: 'edit_upstream_error', detail: msg.slice(0, 200) });
      } else {
        res.status(500).json({ ok: false, intent: 'edit_selected', error: msg });
      }
    }
    return;
  }

  // ── edit_by_match ──
  if (intent === 'edit_by_match') {
    const targetId = classifierTargetNodeId ?? hojaTitles[0]?.id ?? null;
    if (!targetId) {
      res.status(400).json({ ok: false, error: 'no_target_node_resolved' });
      return;
    }
    if (!isValidUuid(targetId)) {
      res.status(400).json({ ok: false, error: 'invalid_target_node_id' });
      return;
    }

    const { data: node, error: nodeErr } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select('id, title, content')
      .eq('id', targetId)
      .eq('workspace_id', id)
      .maybeSingle();
    if (nodeErr || !node) {
      res.status(404).json({ ok: false, error: 'target_node_not_found' });
      return;
    }

    const currentMd =
      ((node as Record<string, unknown>).content as Record<string, unknown> | undefined)?.md as string ?? '';
    const editSystem = `You are a creative and strategic editor. ${query}. Return ONLY the resulting markdown text — no preamble.`;

    try {
      const t0 = Date.now();
      const newText = await callOpenRouter({
        model: TURN_EDIT_MODEL,
        messages: [
          { role: 'system', content: editSystem },
          { role: 'user', content: currentMd },
        ],
        max_tokens: 1500,
        temperature: 0.3,
        timeoutMs: 30_000,
      });

      await supabaseAdmin!
        .from('studio_workspace_nodes')
        .update({ content: { md: newText } })
        .eq('id', targetId)
        .eq('workspace_id', id);

      res.json({
        ok: true,
        intent: 'edit_by_match',
        node_id: targetId,
        new_content: newText,
        target_match_confidence: classifierConfidence,
        model: TURN_EDIT_MODEL,
        ms: Date.now() - t0,
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('[workspace/turn] edit_by_match failed:', msg);
      if (msg.startsWith('openrouter_')) {
        res
          .status(502)
          .json({ ok: false, intent: 'edit_by_match', error: 'edit_upstream_error', detail: msg.slice(0, 200) });
      } else {
        res.status(500).json({ ok: false, intent: 'edit_by_match', error: msg });
      }
    }
    return;
  }

  // Should never reach here.
  res.status(400).json({ ok: false, error: 'unhandled_intent', intent });
});
