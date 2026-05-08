/**
 * @file workspaceApi.ts
 * @description Typed fetch wrapper for the Studio Workspace BFF.
 *
 * All endpoints live under `/api/workspace/...` (Express + Vercel proxy
 * on the same origin). Auth is by Supabase JWT in the `Authorization:
 * Bearer` header — the server's getUserIdFromRequest also accepts an
 * `x-user-id` dev header, but we prefer the JWT path in production.
 *
 * Tenant scoping rides on `x-tenant-id`, defaulting to "shift" (the
 * default tenant configured in TopDock + chat-context). Adjust if a
 * future workspace ever needs cross-tenant routing.
 *
 * Ported (concept) from CL2's apps/web/src/services/workspaceApi.ts; the
 * shape is adapted to Studio's table set (studio_workspaces / nodes) and
 * to Studio's shipping endpoints (T1-T5) — namely the new node import
 * route, the architect+turn endpoints, and the markdown/docx/pptx
 * exporter.
 */
import { supabase } from './supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────

export type NodeColor = 'default' | 'burgundy' | 'ink' | 'sage' | 'amber';
export type NodeType =
  | 'hoja'
  | 'note'
  | 'cite'
  | 'expediente_ref'
  | 'image'
  | 'audio'
  | 'document';

export interface WorkspaceRow {
  id: string;
  title: string;
  description: string;
  archived: boolean;
  node_count: number;
  last_pptx?: unknown;
  created_at: string;
  updated_at: string;
}

export interface AssetContent {
  url?: string;
  path?: string;
  filename?: string;
  size?: number;
  mime?: string;
  extracted_text?: string;
}

export interface HojaContent {
  md?: string;
}

export interface WorkspaceNode {
  id: string;
  workspace_id: string;
  type: NodeType;
  title: string;
  subtitle: string;
  color: NodeColor;
  content: HojaContent | AssetContent | Record<string, unknown> | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index?: number;
  created_at: string;
  updated_at: string;
}

export interface PptxOptions {
  /** "ejecutivo, seco" / "didáctico" / "persuasivo" / "técnico". */
  tono?: string;
  /** "Equipo de marketing" / "Stakeholders ejecutivos" / etc. */
  audiencia?: string;
  /** Free text — what the user wants the deck to argue or showcase. */
  proposito?: string;
  /** Brand voice / visual notes. */
  marca?: string;
  /** Emojis si/no. Defaults false. */
  emojis?: boolean;
}

export interface PptxExportResult {
  format: 'pptx';
  generationId: string;
  gammaUrl: string;
  exportUrl: string;
  filename: string;
  cached: boolean;
  generatedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────

/** Read a fresh JWT every call; tokens may rotate during a long session. */
async function getAuthHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    // fall through — server will 401 if auth is required
  }
  return {};
}

const DEFAULT_TENANT = 'shift';

async function authedHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const auth = await getAuthHeader();
  return {
    'x-tenant-id': DEFAULT_TENANT,
    ...auth,
    ...extra,
  };
}

class ApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function handleJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON; fall through
  }
  if (!res.ok) {
    // 401 → broadcast so App.tsx can clear the auth session and force a
    // re-auth via AuthView. Fixes the "silent 401" failure mode where a
    // stale JWT keeps the UI mounted while every save quietly fails.
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('workspace:unauthorized'));
    }
    const b = (body ?? {}) as { error?: string; detail?: string; code?: string; message?: string };
    const msg = b.detail ?? b.error ?? b.message ?? `HTTP ${res.status}`;
    throw new ApiError(String(msg), res.status, b.code ?? b.error);
  }
  return body as T;
}

// ─── Workspaces ───────────────────────────────────────────────────────

export async function listWorkspaces(opts: { archived?: boolean } = {}): Promise<WorkspaceRow[]> {
  const qs = opts.archived ? '?archived=1' : '';
  const res = await fetch(`/api/workspace${qs}`, {
    headers: await authedHeaders(),
  });
  const body = await handleJson<{ ok: boolean; items: WorkspaceRow[] }>(res);
  return body.items ?? [];
}

export async function createWorkspace(
  body: { title?: string; description?: string } = {},
): Promise<WorkspaceRow> {
  const res = await fetch('/api/workspace', {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await handleJson<{ ok: boolean; workspace: WorkspaceRow }>(res);
  return json.workspace;
}

export async function getWorkspace(id: string): Promise<{ workspace: WorkspaceRow; nodes: WorkspaceNode[] }> {
  const res = await fetch(`/api/workspace/${id}`, {
    headers: await authedHeaders(),
  });
  return handleJson<{ workspace: WorkspaceRow; nodes: WorkspaceNode[] }>(res).then((b) => b);
}

export async function updateWorkspace(
  id: string,
  patch: { title?: string; description?: string; archived?: boolean },
): Promise<WorkspaceRow> {
  const res = await fetch(`/api/workspace/${id}`, {
    method: 'PATCH',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  const json = await handleJson<{ ok: boolean; workspace: WorkspaceRow }>(res);
  return json.workspace;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspace/${id}`, {
    method: 'DELETE',
    headers: await authedHeaders(),
  });
  await handleJson<{ ok: boolean }>(res);
}

// ─── Nodes ────────────────────────────────────────────────────────────

export async function listNodes(
  workspaceId: string,
  opts: { withContent?: boolean } = {},
): Promise<WorkspaceNode[]> {
  const qs = opts.withContent ? '?withContent=1' : '';
  const res = await fetch(`/api/workspace/${workspaceId}/nodes${qs}`, {
    headers: await authedHeaders(),
  });
  const body = await handleJson<{ ok: boolean; nodes: WorkspaceNode[] }>(res);
  return body.nodes ?? [];
}

export async function getNode(workspaceId: string, nodeId: string): Promise<WorkspaceNode> {
  const res = await fetch(`/api/workspace/${workspaceId}/nodes/${nodeId}`, {
    headers: await authedHeaders(),
  });
  const body = await handleJson<{ ok: boolean; node: WorkspaceNode }>(res);
  return body.node;
}

export interface CreateNodeBody {
  id?: string;
  type?: NodeType;
  title?: string;
  subtitle?: string;
  color?: NodeColor;
  content?: Record<string, unknown>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  z_index?: number;
}

export async function createNode(workspaceId: string, body: CreateNodeBody): Promise<WorkspaceNode> {
  const res = await fetch(`/api/workspace/${workspaceId}/nodes`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await handleJson<{ ok: boolean; node: WorkspaceNode }>(res);
  return json.node;
}

export type UpdateNodePatch = Partial<
  Pick<WorkspaceNode, 'title' | 'subtitle' | 'color' | 'type' | 'x' | 'y' | 'width' | 'height' | 'z_index'>
> & { content?: Record<string, unknown> | null };

export async function updateNode(
  workspaceId: string,
  nodeId: string,
  patch: UpdateNodePatch,
): Promise<WorkspaceNode> {
  const res = await fetch(`/api/workspace/${workspaceId}/nodes/${nodeId}`, {
    method: 'PATCH',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  const json = await handleJson<{ ok: boolean; node: WorkspaceNode }>(res);
  return json.node;
}

export async function deleteNode(workspaceId: string, nodeId: string): Promise<void> {
  const res = await fetch(`/api/workspace/${workspaceId}/nodes/${nodeId}`, {
    method: 'DELETE',
    headers: await authedHeaders(),
  });
  await handleJson<{ ok: boolean }>(res);
}

// ─── Asset import (direct-to-storage) ─────────────────────────────────
//
// Why not multipart-to-BFF?
//   Vercel serverless functions reject request bodies > 4.5MB. The previous
//   POST /:id/nodes/import flow worked locally but silently failed on real
//   user uploads (PDFs, audio, hi-res images routinely exceed that cap).
//
// Direct-to-storage flow:
//   1. Upload file straight to Supabase Storage with the user's session JWT.
//      RLS policy on `studio-workspace-assets` allows owner_write on paths
//      prefixed `${auth.uid()}/...`. The bytes never traverse Vercel.
//   2. POST /:id/nodes/finalize-asset with metadata only ({path, mime, ...}).
//      Server-side, the BFF downloads the object service-to-service from
//      Supabase, extracts text, and inserts the node row.
//
// MIME allowlist mirrors the server's ASSET_TYPE_ALLOWLIST in
// src/routes/workspace.ts — keep both in sync.
const ASSET_MIME_ALLOWLIST: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

const STUDIO_ASSETS_BUCKET = 'studio-workspace-assets';

export async function importAsset(
  workspaceId: string,
  file: File,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
): Promise<WorkspaceNode> {
  if (!supabase) {
    throw new ApiError('supabase_unavailable', 503);
  }

  // Identify the user — the storage path must be `${userId}/${workspaceId}/...`
  // to satisfy the bucket's RLS policy. supabase-js attaches the session JWT
  // automatically on the upload, so the storage server can verify ownership.
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('workspace:unauthorized'));
    }
    throw new ApiError('not_authenticated', 401);
  }

  // Cheap client-side mime validation — fail fast before paying for the upload.
  if (!ASSET_MIME_ALLOWLIST.includes(file.type)) {
    throw new ApiError(
      `Tipo de archivo no soportado: ${file.type || 'unknown'}`,
      415,
    );
  }

  // Stable object path. UUID prefix prevents collisions on identical
  // filenames; the safe-name pass strips characters that confuse Supabase
  // Storage's URL signing.
  const objectId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const safeName = (file.name || 'file').replace(/[^\w.\-]/g, '_').slice(0, 200);
  const path = `${userId}/${workspaceId}/${objectId}-${safeName}`;

  // Direct upload — bypasses Vercel entirely. The 4.5MB body limit only
  // applies to Vercel function invocations; supabase-js posts straight to
  // the Storage REST API.
  const { error: upErr } = await supabase.storage
    .from(STUDIO_ASSETS_BUCKET)
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
  if (upErr) {
    throw new ApiError(`Falla al subir: ${upErr.message}`, 500);
  }

  // Tell the BFF to finalize: download server-side, extract text, insert row.
  const res = await fetch(`/api/workspace/${workspaceId}/nodes/finalize-asset`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      path,
      mime: file.type,
      filename: file.name,
      size: file.size,
      ...(typeof opts.x === 'number' ? { x: opts.x } : {}),
      ...(typeof opts.y === 'number' ? { y: opts.y } : {}),
      ...(typeof opts.width === 'number' ? { width: opts.width } : {}),
      ...(typeof opts.height === 'number' ? { height: opts.height } : {}),
    }),
  });

  // If finalize fails, the orphan blob will sit in Storage until manual
  // cleanup. We could best-effort delete here, but the server already
  // does that on insert failure for the common case (it has service-role
  // write access; the browser only has the user's JWT). Leaving the
  // browser-side cleanup off for now keeps the failure path simple.
  const json = await handleJson<{ ok: boolean; node: WorkspaceNode }>(res);
  return json.node;
}

// ─── Attach context (chat scope helper) ───────────────────────────────

export async function attachContext(workspaceId: string): Promise<{
  nodes: Array<{ id: string; title: string; subtitle?: string; md: string }>;
}> {
  const res = await fetch(`/api/workspace/${workspaceId}/attach-context`, {
    headers: await authedHeaders(),
  });
  return handleJson<{
    ok: boolean;
    nodes: Array<{ id: string; title: string; subtitle?: string; md: string }>;
  }>(res).then((b) => ({ nodes: b.nodes ?? [] }));
}

// ─── Export (md/docx/pptx) ────────────────────────────────────────────

/**
 * Export a workspace.
 *
 * - md/docx → server returns a binary blob; we trigger a download and
 *   resolve to `{ format }`. The caller doesn't need a return value but
 *   we return one for telemetry hooks.
 * - pptx → server returns a JSON envelope with the Gamma generation
 *   metadata. The caller is expected to open `gammaUrl`/`exportUrl` in a
 *   new tab (or render a result modal). Fully typed via PptxExportResult.
 */
export async function exportWorkspace(
  workspaceId: string,
  format: 'md',
  opts?: { workspaceTitle?: string },
): Promise<{ format: 'md' }>;
export async function exportWorkspace(
  workspaceId: string,
  format: 'docx',
  opts?: { workspaceTitle?: string },
): Promise<{ format: 'docx' }>;
export async function exportWorkspace(
  workspaceId: string,
  format: 'pptx',
  opts?: { workspaceTitle?: string; force?: boolean; options?: PptxOptions },
): Promise<PptxExportResult>;
export async function exportWorkspace(
  workspaceId: string,
  format: 'md' | 'docx' | 'pptx',
  opts: { workspaceTitle?: string; force?: boolean; options?: PptxOptions } = {},
): Promise<PptxExportResult | { format: 'md' | 'docx' }> {
  const body: Record<string, unknown> = { format };
  if (format === 'pptx') {
    if (opts.force) body.force = true;
    if (opts.options) body.options = opts.options;
  }

  const res = await fetch(`/api/workspace/${workspaceId}/export`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (format === 'pptx') {
    const json = await handleJson<{ ok: boolean } & PptxExportResult>(res);
    return {
      format: 'pptx',
      generationId: json.generationId,
      gammaUrl: json.gammaUrl,
      exportUrl: json.exportUrl,
      filename: json.filename,
      cached: json.cached,
      generatedAt: json.generatedAt,
    };
  }

  // md / docx — binary blob download
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('workspace:unauthorized'));
    }
    // Try parsing JSON error envelope first; fall back to text.
    let msg = `HTTP ${res.status}`;
    try {
      const json = (await res.clone().json()) as { error?: string; detail?: string };
      msg = json.detail ?? json.error ?? msg;
    } catch {
      // ignore
    }
    throw new ApiError(msg, res.status);
  }

  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const safeTitle = (opts.workspaceTitle ?? 'workspace').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'workspace';
  const m = cd.match(/filename="?([^";]+)"?/i);
  const fallbackExt = format === 'docx' ? 'docx' : 'md';
  const filename = m?.[1] ?? `${safeTitle}.${fallbackExt}`;
  triggerBlobDownload(blob, filename);
  return { format };
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── AI primitives ────────────────────────────────────────────────────

export async function transformText(
  workspaceId: string,
  body: { text: string; instruction?: string; mode?: string },
): Promise<{ text: string }> {
  const res = await fetch(`/api/workspace/${workspaceId}/transform`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return handleJson<{ ok: boolean; text: string }>(res).then((b) => ({ text: b.text ?? '' }));
}

export async function runArchitect(
  workspaceId: string,
  prompt: string,
): Promise<{ nodes: WorkspaceNode[] }> {
  const res = await fetch(`/api/workspace/${workspaceId}/architect`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt }),
  });
  const json = await handleJson<{ ok: boolean; nodes?: WorkspaceNode[] }>(res);
  return { nodes: json.nodes ?? [] };
}

export interface TurnRequest {
  message: string;
  selected_node_id?: string | null;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface TurnResponse {
  reply?: string;
  intent?: string;
  node_id?: string;
  new_content?: { md?: string };
  nodes?: WorkspaceNode[];
}

export async function runTurn(workspaceId: string, body: TurnRequest): Promise<TurnResponse> {
  const res = await fetch(`/api/workspace/${workspaceId}/turn`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await handleJson<{ ok: boolean } & TurnResponse>(res);
  return json;
}
