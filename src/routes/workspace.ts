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
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../services/supabaseAdminClient.js';
import { getUserIdFromRequest, isValidUuid } from '../services/auth.js';
import {
  callOpenRouter,
  extractJsonObject,
  type OpenRouterMessage,
} from '../services/openRouterDirect.js';
import { firePeajeIngest } from '../services/peajeClient.js';
import { getApprovedRag } from '../services/puntoMedioClient.js';
import { GammaApiError } from '../services/gammaApi.js';

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
// CHAT MESSAGES — permanent persistence of ChatPanel conversations
// ═══════════════════════════════════════════════════════════════════════
//
// localStorage keeps a warm cache for instant render; this table is the
// authoritative server-side store so users can switch devices and see
// their chat history. Scoped per workspace + user. Cascade-deletes when
// the parent workspace is deleted (FK on studio_workspaces).

const CHAT_ROLES = new Set(['user', 'assistant', 'system']);
const CHAT_VARIANTS = new Set(['default', 'action']);
const CHAT_INTENTS = new Set(['chat', 'build', 'edit_selected', 'edit_by_match']);
/** Hard cap on a single message body. Mirrors the BFF's expressive ceiling
 *  (transform/architect outputs rarely exceed ~8K) with headroom. */
const CHAT_CONTENT_MAX = 50_000;
/** Server-side fetch cap. Client renders all but typically caps display. */
const CHAT_FETCH_LIMIT = 500;

// GET /api/workspace/:id/messages — list persisted chat messages
//
// Returns up to CHAT_FETCH_LIMIT newest messages. Query orders DESC so we
// can apply the limit, then reverses so the response is ASC (oldest →
// newest) — the shape ChatPanel expects to render.
//
// TODO(infinite-scroll): if a workspace ever exceeds CHAT_FETCH_LIMIT,
// the oldest are hidden. Add a `before` cursor + paginate when this matters.
workspaceRouter.get('/:id/messages', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_chat_messages')
      .select('id, role, content, variant, intent, created_at')
      .eq('workspace_id', id)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(CHAT_FETCH_LIMIT);
    if (error) throw new Error(error.message);

    // Reverse so the response is ASC (oldest first) — matches ChatPanel's
    // bottom-anchored render order.
    const messages = (data ?? []).slice().reverse();
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('[workspace] chat messages list failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'chat_messages_list_failed' });
  }
});

// POST /api/workspace/:id/messages — append one message
//
// Body: { role, content, variant?, intent? }. Validates against the same
// CHECK constraints the migration enforces so the server returns a clean
// 400 instead of a Postgres constraint-violation 500.
workspaceRouter.post('/:id/messages', async (req: Request, res: Response) => {
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
  const role = typeof body.role === 'string' ? body.role : '';
  const content = typeof body.content === 'string' ? body.content : '';
  const variantRaw = body.variant;
  const intentRaw = body.intent;

  if (!CHAT_ROLES.has(role)) {
    res.status(400).json({ ok: false, error: 'invalid_role' });
    return;
  }
  if (!content || content.length === 0) {
    res.status(400).json({ ok: false, error: 'content_required' });
    return;
  }
  if (content.length > CHAT_CONTENT_MAX) {
    res.status(400).json({ ok: false, error: 'content_too_large' });
    return;
  }
  let variant: string | null = null;
  if (variantRaw !== undefined && variantRaw !== null) {
    if (typeof variantRaw !== 'string' || !CHAT_VARIANTS.has(variantRaw)) {
      res.status(400).json({ ok: false, error: 'invalid_variant' });
      return;
    }
    variant = variantRaw;
  }
  let intent: string | null = null;
  if (intentRaw !== undefined && intentRaw !== null) {
    if (typeof intentRaw !== 'string' || !CHAT_INTENTS.has(intentRaw)) {
      res.status(400).json({ ok: false, error: 'invalid_intent' });
      return;
    }
    intent = intentRaw;
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('studio_workspace_chat_messages')
      .insert({
        workspace_id: id,
        user_id: userId,
        role,
        content,
        variant,
        intent,
      })
      .select('id, role, content, variant, intent, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ ok: true, message: data });
  } catch (err) {
    console.error('[workspace] chat message create failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'chat_message_create_failed' });
  }
});

// DELETE /api/workspace/:id/messages — wipe entire chat history for this
// workspace + user. Returns the deleted row count for telemetry.
workspaceRouter.delete('/:id/messages', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }
  if (!(await ownedWorkspace(userId, id, res))) return;

  try {
    const { error, count } = await supabaseAdmin!
      .from('studio_workspace_chat_messages')
      .delete({ count: 'exact' })
      .eq('workspace_id', id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true, deleted: count ?? 0 });
  } catch (err) {
    console.error('[workspace] chat messages clear failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: 'chat_messages_clear_failed' });
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

  // Accept both shapes for back-compat:
  //   - CL2 / canonical: { selection, action, instruction?, tone? }
  //   - Studio frontend (T7 HojaSelectionMenu/HojaFormatMenu): { text, mode, instruction? }
  // Normalize at handler boundary so callers don't have to converge.
  const selection = String(req.body?.selection ?? req.body?.text ?? '').trim();
  const action = String(req.body?.action ?? req.body?.mode ?? 'rewrite') as TransformAction;
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

  // LLM calls are routed via Cerebro (`SWARM_API_URL`/v1/llm/invoke),
  // not OpenRouter directly — no per-handler key check needed here.

  // Env vars (all have defaults so deploys never block on config):
  //   TRANSFORM_MODEL        — default model for rewrite/shorten/summarize/polish/custom
  //   TRANSFORM_EXPAND_MODEL — heavier model for `expand` (more reasoning needed)
  const model =
    action === 'expand'
      ? (process.env.TRANSFORM_EXPAND_MODEL ?? 'anthropic/claude-sonnet-4.6')
      : (process.env.TRANSFORM_MODEL ?? 'anthropic/claude-sonnet-4.6');

  // Build system prompt. For 'custom', the user's instruction IS the prompt.
  let systemPrompt = TRANSFORM_SYSTEMS[action];
  if (action === 'custom') {
    systemPrompt = `You are a creative writing assistant. ${instruction}. Return ONLY the resulting text — no preamble, no explanation.`;
  }
  if (tone) {
    systemPrompt += ` Tone: ${tone}.`;
  }

  // Wire client-disconnect → upstream abort. If the user closes the tab
  // mid-call, Cerebro/OpenRouter would otherwise keep generating (paid
  // tokens). callOpenRouter's combineSignals merges this with its timeout.
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

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
      signal: abortController.signal,
      tenant: 'shift',
      trace_label: `studio.workspace.transform.${action}`,
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
async function runArchitect(
  workspaceId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<ArchitectResult> {
  // LLM calls are routed via Cerebro (`SWARM_API_URL`/v1/llm/invoke); no
  // per-call OpenRouter key check is needed here.
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

  // Call Cerebro (which routes to the architect model). Cerebro's
  // /v1/llm/invoke does not expose `response_format`, so we append a
  // strict-JSON instruction to the system prompt and parse defensively
  // via extractJsonObject below.
  const JSON_STRICT_SUFFIX =
    '\n\nReturn ONLY valid JSON matching the schema. No prose, no code fences, no preamble. Start your response with `{` and end with `}`.';
  const t0 = Date.now();
  const model = process.env.ARCHITECT_MODEL ?? 'anthropic/claude-sonnet-4.6';
  const raw = await callOpenRouter({
    model,
    messages: [
      { role: 'system', content: ARCHITECT_SYSTEM + canvasContext + JSON_STRICT_SUFFIX },
      { role: 'user', content: prompt },
    ],
    max_tokens: 8_000,
    temperature: 0.4,
    timeoutMs: 60_000,
    signal,
    tenant: 'shift',
    trace_label: 'studio.workspace.architect',
  });

  let parsed: { hojas?: Array<Record<string, unknown>>; summary?: string };
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    // Last-ditch: try the raw string as-is in case extractJsonObject
    // over-trimmed (it shouldn't, but be defensive).
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('architect_invalid_json');
    }
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

  // Wire client-disconnect → upstream abort. If the user closes the tab
  // mid-build, Cerebro/OpenRouter would otherwise keep generating (paid
  // tokens). The signal is threaded into runArchitect → callOpenRouter,
  // where combineSignals merges it with the timeout.
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const result = await runArchitect(id, prompt, abortController.signal);
    const model = process.env.ARCHITECT_MODEL ?? 'anthropic/claude-sonnet-4.6';
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
// Model defaults reviewed 2026-05-09 (revised). Studio is a premium creative
// tool — Spanish LatAm copy, design refs, strategic analysis. Sonnet 4.6 wins
// quality on prose + vision + reasoning, GA (no preview tag), 1M context.
// Cost delta vs gemini-flash-only is ~$40/mo at 100 turns/day — worth it.
// Classifier stays cheap (single JSON token decision; speed > quality there).
const TURN_CLASSIFIER_MODEL = process.env.TURN_CLASSIFIER_MODEL ?? 'google/gemini-3.1-flash-lite-preview';
const TURN_CHAT_MODEL = process.env.TURN_CHAT_MODEL ?? 'anthropic/claude-sonnet-4.6';
const TURN_EDIT_MODEL = process.env.TURN_EDIT_MODEL ?? 'anthropic/claude-sonnet-4.6';

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

  // LLM calls are routed via Cerebro (`SWARM_API_URL`/v1/llm/invoke);
  // no per-handler OPENROUTER_API_KEY check is needed.

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
  // Validate + coerce: drop any entry that isn't a clean
  // {role:'user'|'assistant', content:string}. Defends against malicious
  // role:'system' injection (would override our system prompt) and
  // non-string content (would crash the upstream JSON encode). Cap at the
  // last 10 turns as a defense-in-depth bound on context bloat.
  const safeHistory = history
    .filter(
      (m): m is { role: 'user' | 'assistant'; content: string } =>
        !!m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .slice(-10);

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
Do NOT include prose. Return only the JSON object.

Return ONLY valid JSON matching the schema. No prose, no code fences, no preamble. Start your response with \`{\` and end with \`}\`.`;

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
        timeoutMs: 15_000,
        tenant: 'shift',
        trace_label: 'studio.workspace.turn.classifier',
      });
      const clfParsed = JSON.parse(extractJsonObject(clfRaw) || '{}') as {
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

  // ── chat: one-shot JSON call routed via Cerebro ──
  if (intent === 'chat') {
    // Wire client-disconnect → upstream abort. If the user closes the
    // tab mid-stream, Cerebro/OpenRouter would otherwise keep generating
    // (paid tokens). The controller signal is threaded into
    // callOpenRouter, where combineSignals merges it with the timeout.
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

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
        .limit(5),
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

    const SEL_BODY_MAX_CHARS = 5_000;
    const selBodyRaw = nodeBody(selNode as Record<string, unknown> | null);
    const selBody =
      selBodyRaw && selBodyRaw.length > SEL_BODY_MAX_CHARS
        ? selBodyRaw.slice(0, SEL_BODY_MAX_CHARS) + '\n[…truncado por longitud]'
        : selBodyRaw;
    const ASSET_CONTEXT_PER_DOC = 5_000;
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

    const HOJA_CONTEXT_PER_DOC = 3_000;
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
    const RAG_BLOCK_MAX_CHARS = 3_000;
    let ragBlock = '';
    try {
      const rag = await getApprovedRag(tenantId);
      if (rag && rag.combined_rag && rag.combined_rag.trim().length > 0) {
        const trimmed = rag.combined_rag.trim();
        const sliced =
          trimmed.length > RAG_BLOCK_MAX_CHARS
            ? trimmed.slice(0, RAG_BLOCK_MAX_CHARS) + '\n[…]'
            : trimmed;
        ragBlock = `[Punto Medio — directrices del tenant]\n${sliced}`;
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

    // Build OpenRouter messages: system + safe history + current user query.
    const orMessages: OpenRouterMessage[] = [
      { role: 'system', content: scopeSystemPrompt },
      ...safeHistory.map<OpenRouterMessage>((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: query },
    ];

    // JSON mode (was SSE — switched 2026-05-08 because Vercel buffers SSE on
    // Hobby/Pro tiers, and SSE failures were silently truncating to empty
    // responses. With JSON we return a single envelope; specific upstream
    // errors (402 no credits, 401 invalid key, 429 rate limit) propagate
    // cleanly to the client. The frontend's streamWorkspaceTurn already
    // handles JSON-mode responses for build/edit; we surface chat the same
    // way and have the client render the assembled text as one bubble.
    let assembled = '';
    let upstreamError: { code: number; message: string } | null = null;
    try {
      assembled = await callOpenRouter({
        model: TURN_CHAT_MODEL,
        messages: orMessages,
        temperature: 0.5,
        max_tokens: 4_000,
        timeoutMs: 55_000, // < Vercel maxDuration of 60s
        signal: abortController.signal,
        tenant: 'shift',
        trace_label: 'studio.workspace.turn.chat',
      });
      console.log(
        `[workspace/turn] chat ok chars=${assembled.length} model=${TURN_CHAT_MODEL} ws=${id}`,
      );
    } catch (callErr) {
      const msg = (callErr as Error).message;
      console.warn('[workspace/turn] chat call failed:', msg);
      // Parse the OpenRouter error for a clean status code if possible.
      const codeMatch = msg.match(/openrouter[_\s]+(\d+)/i);
      const code = codeMatch ? parseInt(codeMatch[1], 10) : 502;
      upstreamError = { code, message: msg };
    }

    if (upstreamError) {
      res.status(upstreamError.code === 401 || upstreamError.code === 402 ? 402 : 502).json({
        ok: false,
        intent: 'chat',
        error: 'chat_upstream_failed',
        detail: upstreamError.message,
        // Hint for the user — common causes the diagnostic should call out.
        hint:
          upstreamError.code === 402
            ? 'OpenRouter sin créditos (en Cerebro). Recarga en https://openrouter.ai/credits.'
            : upstreamError.code === 401
              ? 'OPENROUTER_API_KEY inválida o revocada en Cerebro.'
              : upstreamError.code === 429
                ? 'Rate limit alcanzado. Espera un momento y vuelve a intentar.'
                : 'Error desde Cerebro/OpenRouter — ver detail.',
      });
      return;
    }

    res.json({
      ok: true,
      intent: 'chat',
      text: assembled,
      model: TURN_CHAT_MODEL,
      agent_id: agentId,
      intent_confidence: classifierConfidence,
    });

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
        ...safeHistory.map((m) => ({ role: m.role, content: m.content })),
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
    // Wire client-disconnect → upstream abort. Threaded into runArchitect.
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());
    try {
      const result = await runArchitect(id, query, abortController.signal);
      const model = process.env.ARCHITECT_MODEL ?? 'anthropic/claude-sonnet-4.6';
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

    // Wire client-disconnect → upstream abort. If the user closes the tab
    // mid-edit, Cerebro/OpenRouter would otherwise keep generating.
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

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
        signal: abortController.signal,
        tenant: 'shift',
        trace_label: 'studio.workspace.turn.edit_selected',
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

    // Wire client-disconnect → upstream abort. If the user closes the tab
    // mid-edit, Cerebro/OpenRouter would otherwise keep generating.
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

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
        signal: abortController.signal,
        tenant: 'shift',
        trace_label: 'studio.workspace.turn.edit_by_match',
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

// ═══════════════════════════════════════════════════════════════════════
// EXPORT — md / docx / pptx
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/export
//   body: { format: 'md' | 'docx' | 'pptx', force?: boolean, options?: PptxOptions }
//
// MD path: synthesizes the full canvas as one markdown document with TOC
// and per-hoja sections. DOCX path: parses the same markdown into a styled
// Word document via the `docx` package (inline parser handles bold,
// italic, code, links, headings, lists, blockquotes, code fences, hr).
// PPTX path: delegates to runWorkspacePptxExport which calls Gamma API.
//
// Ported from CL2's POST /api/workspace/:id/export (lines 348-911 of CL2's
// routes/workspace.ts). Renames applied:
//   - workspaces → studio_workspaces
//   - workspace_nodes → studio_workspace_nodes
//   - "_Generado por CL2_" → "_Generado por Shifty Studio_"
//   - DOCX creator/footer "CL2 — Inteligencia Legislativa" / "CL2 · " →
//     "Shifty Studio" / "Shifty Studio · "
//   - Cover-page eyebrow "INTELIGENCIA LEGISLATIVA · ASAMBLEA DE COSTA RICA"
//     dropped (Studio is neutral; cover stays clean).
//   - Stats line locale 'es-CR' → 'es-419' (Studio is Spanish LATAM).
//   - Drops the legacy "last_pptx column missing" retry — migration 0003
//     ships the column from day 1.
workspaceRouter.post('/:id/export', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const userId = await requireUser(req, res);
  if (!userId) return;
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ ok: false, error: 'invalid_uuid' });
    return;
  }

  const format = (req.body?.format ?? 'md') as string;
  if (!['md', 'docx', 'pptx'].includes(format)) {
    res.status(400).json({ ok: false, error: 'invalid_format', hint: 'md|docx|pptx' });
    return;
  }

  // Ownership gate runs first — same pattern as every other T3/T4 endpoint
  // in this file. Once `ownedWorkspace` returns true, the workspace fetch
  // below can drop its `user_id` filter (the row is already proven ours).
  if (!(await ownedWorkspace(userId, id, res))) return;

  try {
    // Fetch workspace metadata + all nodes in one round-trip.
    const [{ data: ws, error: wsErr }, { data: nodes, error: nErr }] = await Promise.all([
      supabaseAdmin!
        .from('studio_workspaces')
        .select('id, title, description, last_pptx')
        .eq('id', id)
        .maybeSingle(),
      supabaseAdmin!
        .from('studio_workspace_nodes')
        .select('id, title, subtitle, content, x, y, color, type')
        .eq('workspace_id', id),
    ]);
    if (wsErr || !ws) {
      res.status(404).json({ ok: false, error: 'workspace_not_found' });
      return;
    }
    if (nErr) throw new Error(nErr.message);

    // Reading order: top-to-bottom, then left-to-right. Snap y to row
    // bands of 200px so two hojas at slightly different y don't flip
    // randomly — visually-aligned hojas stay aligned in the doc.
    const ordered = (nodes ?? []).slice().sort((a, b) => {
      const yA = Math.floor((a.y as number) / 200);
      const yB = Math.floor((b.y as number) / 200);
      if (yA !== yB) return yA - yB;
      return (a.x as number) - (b.x as number);
    });

    const safeName =
      String(ws.title)
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_') || 'workspace';

    if (format === 'md') {
      const lines: string[] = [];
      lines.push(`# ${ws.title}`);
      if (ws.description) lines.push('', `_${ws.description}_`);
      lines.push(
        '',
        `_Generado por Shifty Studio · ${ordered.length} hoja${ordered.length === 1 ? '' : 's'}_`,
        '',
      );

      // TOC
      if (ordered.length > 1) {
        lines.push('## Contenido', '');
        ordered.forEach((n, i) => {
          lines.push(`${i + 1}. ${n.title}`);
        });
        lines.push('');
      }

      // Body
      for (const n of ordered) {
        lines.push('---', '');
        lines.push(`## ${n.title}`);
        if (n.subtitle) lines.push('', `_${n.subtitle}_`);
        const md = ((n.content as Record<string, unknown>)?.md as string) ?? '';
        if (md.trim()) lines.push('', md.trim());
        lines.push('');
      }

      const body = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
      res.send(body);
      return;
    }

    // ── PPTX via Gamma API ───────────────────────────────────────────
    // Strategy: build the SAME markdown the md format produces, but use
    // explicit "\n---\n" slide breaks (already present between hojas) so
    // Gamma respects the canvas structure 1:1.
    //
    // We block until completion (max ~5min) and return a JSON envelope
    // with the signed download URL. The client opens it in a new tab;
    // the URL is valid for ~1 week per Gamma's CDN policy.
    if (format === 'pptx') {
      const force = Boolean(req.body?.force);
      const options = (req.body?.options ?? undefined) as
        | undefined
        | {
            tono?: string;
            audiencia?: string;
            proposito?: string;
            marca?: string;
            emojis?: boolean;
          };
      const { runWorkspacePptxExport: runPptx } = await import('../services/workspacePptxExport.js');
      try {
        const result = await runPptx({ workspaceId: id, userId, force, options });
        console.log(
          `[workspace] export pptx ok workspaceId=${id} hojas=${ordered.length} generationId=${result.generationId} cached=${result.cached}`,
        );
        res.json({
          ok: true,
          format: 'pptx',
          cached: result.cached,
          generatedAt: result.generatedAt,
          filename: result.filename,
          url: result.exportUrl,
          gammaUrl: result.gammaUrl,
          generationId: result.generationId,
        });
        return;
      } catch (err) {
        if (err instanceof GammaApiError) {
          console.warn(
            `[workspace] export pptx failed workspaceId=${id} code=${err.code} error=${err.message}`,
          );
          const statusMap: Record<string, number> = {
            auth: 503,
            insufficient_credits: 402,
            forbidden: 403,
            bad_request: 400,
            rate_limited: 429,
            timeout: 504,
            failed: 502,
            no_export_url: 502,
            upstream: 502,
            network: 502,
          };
          res.status(statusMap[err.code] ?? 500).json({
            ok: false,
            error: err.code,
            detail: err.message,
          });
          return;
        }
        throw err;
      }
    }

    // ─── DOCX ─────────────────────────────────────────────────────
    let docxLib: typeof import('docx');
    try {
      docxLib = await import('docx');
    } catch {
      res
        .status(501)
        .json({ ok: false, error: 'docx_not_installed', hint: 'Run: npm install docx' });
      return;
    }
    const {
      Document,
      Packer,
      Paragraph,
      HeadingLevel,
      TextRun,
      PageBreak,
      AlignmentType,
      Footer,
      Header,
      PageNumber,
      NumberFormat,
      BorderStyle,
      ExternalHyperlink,
      LevelFormat,
      convertInchesToTwip,
    } = docxLib;

    // ─── Inline markdown parser ──────────────────────────────────
    // Walks **bold**, *italic*, `code`, [text](url) into TextRun array.
    // Order matters: code first (so backtick contents aren't reparsed),
    // then bold (** before *), then italic, then links last.
    type InlineToken = {
      type: 'text' | 'code' | 'link';
      text: string;
      url?: string;
      bold?: boolean;
      italics?: boolean;
    };
    function parseInline(input: string): InlineToken[] {
      // Use distinct sentinels for code vs links. We pick control chars
      // (U+0001 / U+0002) that are vanishingly unlikely to occur in user
      // markdown — that way bare digits in user content (e.g. "año 2024")
      // never collide with placeholder indices the way they did in the
      // original `\d+`-based scheme.
      const C_OPEN = 'C';
      const C_CLOSE = '';
      const L_OPEN = 'L';
      const L_CLOSE = '';

      // 1) Mask out code spans first so backtick contents aren't reparsed
      //    as bold/italic/links.
      const codePlaceholders: string[] = [];
      let masked = input.replace(/`([^`]+)`/g, (_, code) => {
        const idx = codePlaceholders.length;
        codePlaceholders.push(code);
        return `${C_OPEN}${idx}${C_CLOSE}`;
      });

      // 2) Mask links [text](url). Done after code so a link inside
      //    backticks stays literal.
      const linkPlaceholders: Array<{ text: string; url: string }> = [];
      masked = masked.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
        const idx = linkPlaceholders.length;
        linkPlaceholders.push({ text: t, url: u });
        return `${L_OPEN}${idx}${L_CLOSE}`;
      });

      // 3) Split on bold/italic AND on each sentinel separately. Because
      //    each placeholder has a distinct sentinel pair, the matcher
      //    can tell code from link without colliding on bare integers.
      const splitter = new RegExp(
        [
          '(\\*\\*[^*]+\\*\\*)',          // **bold**
          '(\\*[^*]+\\*)',                 // *italic*
          `(${C_OPEN}\\d+${C_CLOSE})`,    // code sentinel
          `(${L_OPEN}\\d+${L_CLOSE})`,    // link sentinel
        ].join('|'),
        'g',
      );
      const pieces = masked.split(splitter).filter((p) => p !== undefined && p !== '');

      const tokens: InlineToken[] = [];
      const codeRe = new RegExp(`^${C_OPEN}(\\d+)${C_CLOSE}$`);
      const linkRe = new RegExp(`^${L_OPEN}(\\d+)${L_CLOSE}$`);
      for (const piece of pieces) {
        const codeMatch = piece.match(codeRe);
        if (codeMatch) {
          const idx = Number(codeMatch[1]);
          const text = codePlaceholders[idx] ?? '';
          tokens.push({ type: 'code', text });
          continue;
        }
        const linkMatch = piece.match(linkRe);
        if (linkMatch) {
          const idx = Number(linkMatch[1]);
          const link = linkPlaceholders[idx];
          if (link) {
            tokens.push({ type: 'link', text: link.text, url: link.url });
          }
          continue;
        }
        if (/^\*\*[^*]+\*\*$/.test(piece)) {
          tokens.push({ type: 'text', text: piece.slice(2, -2), bold: true });
          continue;
        }
        if (/^\*[^*]+\*$/.test(piece)) {
          tokens.push({ type: 'text', text: piece.slice(1, -1), italics: true });
          continue;
        }
        if (piece) tokens.push({ type: 'text', text: piece });
      }
      return tokens;
    }

    function inlineToRuns(
      input: string,
    ): Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>> {
      const out: Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>> = [];
      for (const tk of parseInline(input)) {
        if (tk.type === 'code') {
          out.push(
            new TextRun({
              text: tk.text,
              font: { name: 'Consolas' },
              color: '6B2438',
              shading: { fill: 'F5EEEF', type: 'clear' as never, color: 'auto' },
              size: 20,
            }),
          );
        } else if (tk.type === 'link' && tk.url) {
          out.push(
            new ExternalHyperlink({
              link: tk.url,
              children: [new TextRun({ text: tk.text, color: '7A3B47', underline: {} })],
            }),
          );
        } else {
          out.push(new TextRun({ text: tk.text, bold: tk.bold, italics: tk.italics }));
        }
      }
      return out.length > 0 ? out : [new TextRun({ text: input })];
    }

    // ─── Block parser ─────────────────────────────────────────────
    function mdBlocksToParagraphs(md: string): InstanceType<typeof Paragraph>[] {
      const out: InstanceType<typeof Paragraph>[] = [];
      const lines = md.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Empty line — skip
        if (!trimmed) {
          i++;
          continue;
        }

        // Horizontal rule
        if (/^(---|___|\*\*\*)\s*$/.test(trimmed)) {
          out.push(
            new Paragraph({
              border: {
                bottom: { color: 'CCCCCC', space: 1, style: BorderStyle.SINGLE, size: 6 },
              },
            }),
          );
          i++;
          continue;
        }

        // ATX headings ###/##/#
        if (/^####\s+/.test(trimmed)) {
          out.push(
            new Paragraph({
              children: inlineToRuns(trimmed.replace(/^####\s+/, '')),
              heading: HeadingLevel.HEADING_4,
            }),
          );
          i++;
          continue;
        }
        if (/^###\s+/.test(trimmed)) {
          out.push(
            new Paragraph({
              children: inlineToRuns(trimmed.replace(/^###\s+/, '')),
              heading: HeadingLevel.HEADING_3,
            }),
          );
          i++;
          continue;
        }
        if (/^##\s+/.test(trimmed)) {
          out.push(
            new Paragraph({
              children: inlineToRuns(trimmed.replace(/^##\s+/, '')),
              heading: HeadingLevel.HEADING_2,
            }),
          );
          i++;
          continue;
        }
        if (/^#\s+/.test(trimmed)) {
          out.push(
            new Paragraph({
              children: inlineToRuns(trimmed.replace(/^#\s+/, '')),
              heading: HeadingLevel.HEADING_3,
            }),
          );
          i++;
          continue;
        }

        // Code fence
        if (/^```/.test(trimmed)) {
          const codeLines: string[] = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            codeLines.push(lines[i]);
            i++;
          }
          i++; // skip closing fence
          for (const cl of codeLines) {
            out.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: cl,
                    font: { name: 'Consolas' },
                    size: 20,
                    color: '24292E',
                  }),
                ],
                shading: { fill: 'F6F8FA', type: 'clear' as never, color: 'auto' },
                indent: { left: convertInchesToTwip(0.25) },
              }),
            );
          }
          continue;
        }

        // Block quote
        if (/^>\s+/.test(trimmed)) {
          const quoteLines: string[] = [];
          while (i < lines.length && /^>\s+/.test(lines[i].trim())) {
            quoteLines.push(lines[i].replace(/^\s*>\s+/, ''));
            i++;
          }
          out.push(
            new Paragraph({
              children: inlineToRuns(quoteLines.join(' ')),
              indent: { left: convertInchesToTwip(0.4) },
              border: {
                left: { color: '7A3B47', space: 8, style: BorderStyle.SINGLE, size: 18 },
              },
              spacing: { before: 80, after: 80 },
            }),
          );
          continue;
        }

        // Numbered list
        if (/^\d+\.\s+/.test(trimmed)) {
          while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
            const itemText = lines[i].trim().replace(/^\d+\.\s+/, '');
            out.push(
              new Paragraph({
                children: inlineToRuns(itemText),
                numbering: { reference: 'studio-numbered', level: 0 },
              }),
            );
            i++;
          }
          continue;
        }

        // Bullet list
        if (/^[-*+]\s+/.test(trimmed)) {
          while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
            const itemText = lines[i].trim().replace(/^[-*+]\s+/, '');
            out.push(
              new Paragraph({
                children: inlineToRuns(itemText),
                bullet: { level: 0 },
              }),
            );
            i++;
          }
          continue;
        }

        // Paragraph — gather contiguous non-blank, non-special lines
        const paraLines: string[] = [trimmed];
        i++;
        while (i < lines.length) {
          const l = lines[i].trim();
          if (!l) break;
          if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|---|___|\*\*\*$)/.test(l)) break;
          paraLines.push(l);
          i++;
        }
        out.push(
          new Paragraph({
            children: inlineToRuns(paraLines.join(' ')),
            spacing: { before: 60, after: 60, line: 320 },
          }),
        );
      }
      return out;
    }

    // ─── Color accent per hoja ───────────────────────────────────
    const HOJA_ACCENTS: Record<string, string> = {
      default: '7A3B47',
      burgundy: '7A3B47',
      ink: '0E1745',
      sage: '2F7A5C',
      amber: 'B57F00',
    };

    const children: InstanceType<typeof Paragraph>[] = [];

    // ─── Cover page ───────────────────────────────────────────────
    // Title — large, centered (Studio drops the CL2 legislativo eyebrow).
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: String(ws.title), size: 56, bold: true, color: '0E1745' }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 1800, after: 200 },
      }),
    );

    // Description / dek
    if (ws.description && String(ws.description).trim()) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: String(ws.description),
              italics: true,
              size: 26,
              color: '555555',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 400, line: 360 },
        }),
      );
    }

    // Divider rule
    children.push(
      new Paragraph({
        border: {
          bottom: { color: '7A3B47', space: 1, style: BorderStyle.SINGLE, size: 12 },
        },
        spacing: { before: 200, after: 200 },
        alignment: AlignmentType.CENTER,
        children: [],
      }),
    );

    // Stats line
    const dateStr = new Date().toLocaleDateString('es-419', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${ordered.length} ${ordered.length === 1 ? 'hoja' : 'hojas'} · Generado el ${dateStr}`,
            italics: true,
            size: 22,
            color: '888888',
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
    );
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Shifty Studio', size: 18, color: 'AAAAAA' })],
        alignment: AlignmentType.CENTER,
      }),
    );

    // ─── TOC ──────────────────────────────────────────────────────
    if (ordered.length > 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: 'CONTENIDO',
              size: 22,
              bold: true,
              color: '7A3B47',
              characterSpacing: 80,
            }),
          ],
          spacing: { after: 240 },
          border: {
            bottom: { color: '7A3B47', space: 6, style: BorderStyle.SINGLE, size: 6 },
          },
        }),
      );
      ordered.forEach((n, i) => {
        const num = String(i + 1).padStart(2, '0');
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${num}    `, color: '7A3B47', bold: true, size: 22 }),
              new TextRun({ text: String(n.title), size: 22, color: '0E1745' }),
              ...(n.subtitle
                ? [
                    new TextRun({
                      text: `   —   ${n.subtitle}`,
                      size: 20,
                      italics: true,
                      color: '888888',
                    }),
                  ]
                : []),
            ],
            spacing: { before: 80, after: 80 },
          }),
        );
      });
    }

    // ─── Body — one hoja per section ──────────────────────────────
    ordered.forEach((n, i) => {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      const accent = HOJA_ACCENTS[String(n.color)] ?? HOJA_ACCENTS.default;

      // Hoja number eyebrow
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `HOJA ${String(i + 1).padStart(2, '0')}`,
              size: 16,
              color: accent,
              bold: true,
              characterSpacing: 80,
            }),
          ],
          spacing: { after: 120 },
        }),
      );
      // Title
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: String(n.title), size: 40, bold: true, color: '0E1745' }),
          ],
          spacing: { after: 80 },
        }),
      );
      // Subtitle
      if (n.subtitle && String(n.subtitle).trim()) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: String(n.subtitle),
                size: 24,
                italics: true,
                color: '666666',
              }),
            ],
            spacing: { after: 240 },
          }),
        );
      } else {
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
      }
      // Accent bar
      children.push(
        new Paragraph({
          border: { bottom: { color: accent, space: 1, style: BorderStyle.SINGLE, size: 8 } },
          spacing: { after: 240 },
          children: [],
        }),
      );

      // Body
      const md = ((n.content as Record<string, unknown>)?.md as string) ?? '';
      if (md.trim()) {
        children.push(...mdBlocksToParagraphs(md));
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: '(Hoja sin contenido)', italics: true, color: 'BBBBBB' }),
            ],
          }),
        );
      }
    });

    // ─── Document with header/footer + numbering ──────────────────
    const doc = new Document({
      creator: 'Shifty Studio',
      title: String(ws.title),
      description: String(ws.description ?? ''),
      numbering: {
        config: [
          {
            reference: 'studio-numbered',
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '%1.',
                alignment: AlignmentType.START,
                style: {
                  paragraph: {
                    indent: {
                      left: convertInchesToTwip(0.5),
                      hanging: convertInchesToTwip(0.25),
                    },
                  },
                },
              },
            ],
          },
        ],
      },
      styles: {
        default: {
          document: { run: { font: { name: 'Calibri' }, size: 22 } },
        },
        paragraphStyles: [
          {
            id: 'Heading1',
            name: 'Heading 1',
            basedOn: 'Normal',
            next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 36, bold: true, color: '0E1745' },
            paragraph: { spacing: { before: 360, after: 160 } },
          },
          {
            id: 'Heading2',
            name: 'Heading 2',
            basedOn: 'Normal',
            next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 28, bold: true, color: '7A3B47' },
            paragraph: { spacing: { before: 240, after: 120 } },
          },
          {
            id: 'Heading3',
            name: 'Heading 3',
            basedOn: 'Normal',
            next: 'Normal',
            run: { font: { name: 'Calibri' }, size: 24, bold: true, color: '0E1745' },
            paragraph: { spacing: { before: 200, after: 100 } },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: convertInchesToTwip(1),
                right: convertInchesToTwip(1),
                bottom: convertInchesToTwip(1),
                left: convertInchesToTwip(1),
              },
            },
          },
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: String(ws.title),
                      size: 18,
                      color: 'AAAAAA',
                      italics: true,
                    }),
                  ],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ text: 'Shifty Studio · ', size: 16, color: 'AAAAAA' }),
                    new TextRun({
                      children: [PageNumber.CURRENT],
                      size: 16,
                      color: 'AAAAAA',
                    }),
                    new TextRun({ text: ' / ', size: 16, color: 'AAAAAA' }),
                    new TextRun({
                      children: [PageNumber.TOTAL_PAGES],
                      size: 16,
                      color: 'AAAAAA',
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    });
    // Suppress unused-var linting on optional helpers we keep in the
    // destructure to make the surface explicit.
    void NumberFormat;
    const buffer = await Packer.toBuffer(doc);

    console.log(
      `[workspace] export ok workspaceId=${id} format=${format} hojas=${ordered.length} bytes=${buffer.length}`,
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.warn('[workspace] export failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ASSET IMPORT — direct-to-storage flow (see /nodes/finalize-asset below)
// ═══════════════════════════════════════════════════════════════════════
//
// The legacy multipart `POST /:id/nodes/import` route was removed because
// Vercel serverless functions reject request bodies > 4.5MB and the bulk
// of real workspace assets (PDFs, audio, hi-res images) blow that cap.
// All imports now go through `/nodes/finalize-asset` (browser uploads to
// Supabase Storage directly with the user's JWT, then POSTs metadata).
//
// The shared helpers below — ASSET_TYPE_ALLOWLIST, STUDIO_ASSETS_BUCKET,
// extractAssetText, getPDFParse — are still used by finalize-asset.

const ASSET_TYPE_ALLOWLIST: Record<string, 'image' | 'audio' | 'document'> = {
  // images
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'image',
  // audio
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  // documents
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'text/plain': 'document',
  'text/markdown': 'document',
};

const STUDIO_ASSETS_BUCKET = 'studio-workspace-assets';

/** Cap on extracted text we persist + forward to the LLM. ~15K tokens
 *  with room to spare in a Sonnet/Opus context. Beyond this we truncate
 *  with a marker so the model knows the source was longer. */
const ASSET_EXTRACT_MAX_CHARS = 60_000;

// pdf-parse v2 ESM bridge — lazy so the import cost only hits the
// first PDF upload, not every API cold start.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _PDFParse: any | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPDFParse(): Promise<any> {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _PDFParse = (mod as any).PDFParse ?? (mod as any).default?.PDFParse;
  if (!_PDFParse) throw new Error('pdf-parse: PDFParse class not found');
  return _PDFParse;
}

/**
 * Extract plain text from an uploaded asset buffer when feasible (PDF,
 * DOCX, plain text, markdown). Returns `null` for non-textual types
 * (images, audio) — the caller persists nothing in that case.
 *
 * Why on the SERVER: the user attached a doc to the canvas; from now on
 * the chat sees this doc whenever the user asks "qué dice la hoja
 * seleccionada". Without extraction the model only saw filename+size,
 * so it'd reply "no hay contenido".
 */
/** Hard cap above which we skip parser invocation. mammoth + pdf-parse
 *  decompress in memory on top of the buffer pulled from storage; on a
 *  100MB doc that pushes us past 250-300MB resident very quickly and the
 *  parsers routinely OOM or hang. The asset still uploads — we just don't
 *  have searchable text for it. */
const ASSET_EXTRACT_MAX_BYTES = 50_000_000; // 50 MB

async function extractAssetText(buffer: Buffer, mime: string): Promise<string | null> {
  // Plain text + markdown — just decode.
  if (mime === 'text/plain' || mime === 'text/markdown') {
    return buffer.toString('utf-8').slice(0, ASSET_EXTRACT_MAX_CHARS);
  }
  // Per-format size cap. Above this we skip extraction outright — the
  // parsers (mammoth / pdf-parse) overflow before they finish.
  if (buffer.length > ASSET_EXTRACT_MAX_BYTES) {
    console.warn(
      `[workspace] asset_extract_skipped_oversize mime=${mime} bytes=${buffer.length} cap=${ASSET_EXTRACT_MAX_BYTES}`,
    );
    return null;
  }
  // PDF
  if (mime === 'application/pdf') {
    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      const txt = ((parsed.text ?? '') as string).trim();
      return txt.length > ASSET_EXTRACT_MAX_CHARS
        ? txt.slice(0, ASSET_EXTRACT_MAX_CHARS) + '\n\n[…truncado por longitud]'
        : txt;
    } finally {
      // Always release native handles, even when getText throws — otherwise
      // a broken PDF leaks the worker for the lifetime of the process.
      await parser.destroy?.().catch(() => null);
    }
  }
  // DOCX (the new MS Word format). The legacy .doc binary is not
  // supported by mammoth — those will skip extraction.
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    const txt = (value ?? '').trim();
    return txt.length > ASSET_EXTRACT_MAX_CHARS
      ? txt.slice(0, ASSET_EXTRACT_MAX_CHARS) + '\n\n[…truncado por longitud]'
      : txt;
  }
  // Images, audio, legacy .doc, etc. — nothing to extract.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// FINALIZE-ASSET — direct-to-storage upload (replaces legacy /nodes/import)
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/nodes/finalize-asset (application/json)
//   { path, mime, filename, size, x?, y?, width?, height? }
//
// Why this exists:
//   Vercel serverless functions reject request bodies > 4.5MB. The legacy
//   multipart `POST /:id/nodes/import` worked for small files but silently
//   failed on anything bigger — that's the bulk of real workspace assets
//   (PDFs, audio, hi-res images). The multipart route was removed.
//
// Flow:
//   1. Browser uploads the file directly to Supabase Storage via supabase-js
//      SDK using the user's session JWT. RLS policy gates writes by path
//      prefix `${auth.uid()}/...` so the user can only write to their own
//      tree. Bucket cap is 100MB. The bucket itself is created idempotently
//      by the supabase migration; no runtime ensure-bucket dance needed.
//   2. Browser POSTs this endpoint with `{ path, mime, filename, size, ... }`
//      — pure JSON metadata, way under the 4.5MB threshold.
//   3. We re-validate ownership (path prefix), download the object
//      server-to-server with the service-role client (no Vercel body
//      inbound), run extractAssetText, and insert the studio_workspace_nodes
//      row.
workspaceRouter.post(
  '/:id/nodes/finalize-asset',
  async (req: Request, res: Response) => {
    if (!dbReady(res)) return;
    const userId = await requireUser(req, res);
    if (!userId) return;
    const id = String(req.params.id);
    if (!isValidUuid(id)) {
      res.status(400).json({ ok: false, error: 'invalid_uuid' });
      return;
    }
    if (!(await ownedWorkspace(userId, id, res))) return;

    const body = (req.body ?? {}) as {
      path?: unknown;
      mime?: unknown;
      filename?: unknown;
      size?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };

    const path = typeof body.path === 'string' ? body.path : '';
    const mime = typeof body.mime === 'string' ? body.mime : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const size = typeof body.size === 'number' ? body.size : Number(body.size);

    if (!path || !mime || !filename || !Number.isFinite(size)) {
      res.status(400).json({
        ok: false,
        error: 'missing_required_fields',
        detail: 'path, mime, filename, size are required.',
      });
      return;
    }

    // Security gate: the storage path must be inside the user's own tree
    // for this workspace. Stops a malicious caller from finalizing an
    // object owned by someone else.
    const expectedPrefix = `${userId}/${id}/`;
    if (!path.startsWith(expectedPrefix)) {
      res.status(403).json({
        ok: false,
        error: 'path_outside_user_tree',
        detail: `path must start with "${expectedPrefix}"`,
      });
      return;
    }

    const assetType = ASSET_TYPE_ALLOWLIST[mime];
    if (!assetType) {
      res.status(415).json({
        ok: false,
        error: 'unsupported_media_type',
        detail: `MIME "${mime}" no permitido. Soportados: png/jpg/gif/webp/svg, mp3/m4a/wav/ogg/webm, pdf/docx/md/txt.`,
      });
      return;
    }

    try {
      // Download the file server-to-server. Service role bypasses RLS, so
      // even private buckets work. No Vercel body limit on the inbound
      // side — the bytes flow Supabase → Node, never through the
      // Vercel edge.
      const { data: blob, error: dlErr } = await supabaseAdmin!.storage
        .from(STUDIO_ASSETS_BUCKET)
        .download(path);
      if (dlErr || !blob) {
        res.status(404).json({
          ok: false,
          error: 'asset_not_in_storage',
          detail: dlErr?.message ?? 'object not found',
        });
        return;
      }
      const arrayBuf = await blob.arrayBuffer();
      let fileBuffer: Buffer | null = Buffer.from(arrayBuf);

      // Public URL for the canvas to render.
      const { data: urlData } = supabaseAdmin!.storage
        .from(STUDIO_ASSETS_BUCKET)
        .getPublicUrl(path);
      const publicUrl = urlData.publicUrl;

      // Position + size (type-aware defaults).
      const x = Number(body.x ?? 80);
      const y = Number(body.y ?? 80);
      const defaultDims = {
        image: { width: 480, height: 360 },
        audio: { width: 420, height: 140 },
        document: { width: 380, height: 280 },
      }[assetType];
      const width = Number(body.width ?? defaultDims.width);
      const height = Number(body.height ?? defaultDims.height);

      // Best-effort text extraction. Failure is non-fatal.
      let extractedText: string | null = null;
      try {
        extractedText = await extractAssetText(fileBuffer, mime);
      } catch (extractErr) {
        console.warn(
          `[workspace] asset_extract_failed mime=${mime} bytes=${size} error=${(extractErr as Error).message}`,
        );
      }

      // Release the buffer reference now that upload + extraction are done.
      // GC can reclaim before we serialize the response.
      fileBuffer = null;

      const safeName = filename.replace(/[^\w.\-]/g, '_').slice(0, 200);

      const { data: node, error: nErr } = await supabaseAdmin!
        .from('studio_workspace_nodes')
        .insert({
          workspace_id: id,
          type: assetType,
          x,
          y,
          width,
          height,
          title: filename || safeName,
          subtitle: `${assetType} · ${(size / 1024).toFixed(0)} KB`,
          content: {
            url: publicUrl,
            path,
            filename: filename || safeName,
            size,
            mime,
            ...(extractedText && extractedText.length > 0
              ? { extracted_text: extractedText }
              : {}),
          },
          color: 'default',
        })
        .select('*')
        .single();
      if (nErr) {
        // Clean up the orphan storage object on insert failure — best-effort.
        await supabaseAdmin!.storage
          .from(STUDIO_ASSETS_BUCKET)
          .remove([path])
          .catch(() => null);
        throw new Error(`insert: ${nErr.message}`);
      }

      console.log(
        `[workspace] finalize-asset ok workspaceId=${id} nodeId=${node.id} mime=${mime} bytes=${size} type=${assetType}`,
      );

      res.status(201).json({ ok: true, node });
    } catch (err) {
      console.warn(
        `[workspace] finalize-asset failed workspaceId=${id} mime=${mime} error=${(err as Error).message}`,
      );
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════
// REEXTRACT — re-run text extraction for an already-uploaded asset
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/workspace/:id/nodes/:nodeId/reextract
// Used to backfill nodes that were uploaded before the extractor existed.
// Pulls the object from the storage bucket, runs extractAssetText,
// persists into content.extracted_text. Idempotent.
//
// Ported from CL2 (lines 1281-1349). Tables → studio_workspace_nodes;
// bucket → studio-workspace-assets.
workspaceRouter.post(
  '/:id/nodes/:nodeId/reextract',
  async (req: Request, res: Response) => {
    if (!dbReady(res)) return;
    const userId = await requireUser(req, res);
    if (!userId) return;
    const id = String(req.params.id);
    const nodeId = String(req.params.nodeId);
    if (!isValidUuid(id)) {
      res.status(400).json({ ok: false, error: 'invalid_uuid' });
      return;
    }
    if (!isValidUuid(nodeId)) {
      res.status(400).json({ ok: false, error: 'invalid_node_id' });
      return;
    }
    if (!(await ownedWorkspace(userId, id, res))) return;

    // Pull the node + its current content. The eq('workspace_id', id) is
    // the second leg of the 2-step ownership check (ownedWorkspace already
    // confirmed user owns the workspace).
    const { data: node, error: getErr } = await supabaseAdmin!
      .from('studio_workspace_nodes')
      .select('id, type, content, title')
      .eq('id', nodeId)
      .eq('workspace_id', id)
      .maybeSingle();
    if (getErr || !node) {
      res.status(404).json({ ok: false, error: 'node_not_found' });
      return;
    }
    if (node.type !== 'document') {
      res.status(400).json({ ok: false, error: 'not_a_document' });
      return;
    }

    const c = (node.content ?? {}) as Record<string, unknown>;
    const path = typeof c.path === 'string' ? c.path : null;
    const mime = typeof c.mime === 'string' ? c.mime : null;
    if (!path || !mime) {
      res.status(400).json({ ok: false, error: 'missing_path_or_mime' });
      return;
    }

    try {
      // Download from the storage bucket directly (the service-role client
      // has read access regardless of bucket policy).
      const { data: blob, error: dlErr } = await supabaseAdmin!.storage
        .from(STUDIO_ASSETS_BUCKET)
        .download(path);
      if (dlErr || !blob) {
        res.status(502).json({ ok: false, error: 'download_failed', detail: dlErr?.message });
        return;
      }
      const arrayBuf = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const extracted = await extractAssetText(buffer, mime);
      if (!extracted) {
        res.status(415).json({ ok: false, error: 'extractor_unsupported', mime });
        return;
      }

      // Patch into content.extracted_text
      const newContent = { ...c, extracted_text: extracted };
      const { error: upErr } = await supabaseAdmin!
        .from('studio_workspace_nodes')
        .update({ content: newContent })
        .eq('id', nodeId)
        .eq('workspace_id', id);
      if (upErr) throw new Error(`update: ${upErr.message}`);

      res.json({
        ok: true,
        chars: extracted.length,
        truncated: extracted.includes('[…truncado por longitud]'),
      });
    } catch (err) {
      console.warn(
        `[workspace] reextract failed nodeId=${nodeId} error=${(err as Error).message}`,
      );
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  },
);
