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

/**
 * Phase 3.F split-flow result of `exportWorkspace(id, 'pptx', …)`.
 *
 * The server kicks off the Gamma generation and returns immediately; the
 * caller then polls via `pollPptxStatus`. The cache short-circuit is
 * preserved — when the workspace's last_pptx is fresh enough to reuse,
 * the response comes back already-complete with the deck URLs filled in.
 */
export type PptxStartResult =
  | {
      status: 'complete';
      result: PptxExportResult;
    }
  | {
      status: 'pending';
      generationId: string;
      filename: string;
      pollingUrl: string;
    };

/**
 * One status check on a pending pptx generation. Mirrors the server
 * shape of GET /:id/export/pptx-status.
 */
export type PptxStatusResult =
  | {
      status: 'pending';
      generationId: string;
    }
  | {
      status: 'complete';
      generationId: string;
      result: PptxExportResult;
    }
  | {
      status: 'failed';
      generationId: string;
      error: string;
    };

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

/**
 * Progress payload passed to `importAsset`'s `onProgress` callback while
 * the file uploads. Bytes mirror XHR's `loaded`/`total`; `percent` is a
 * pre-rounded 0-100 integer for convenience.
 */
export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  percent: number;
}

export async function importAsset(
  workspaceId: string,
  file: File,
  opts: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    /**
     * AbortSignal — when aborted, cancels the in-flight XHR upload and
     * rejects with `Error('Upload aborted')`. The post-upload finalize
     * call is not abortable today (server-side text extraction races
     * with abort and the orphan blob is cleaned up by the BFF anyway).
     */
    signal?: AbortSignal;
    /**
     * Fired on each XHR progress event during the storage PUT. Browsers
     * without `lengthComputable` progress events skip these callbacks;
     * the UI should fall back to a 0% / 100% binary state in that case.
     */
    onProgress?: (p: UploadProgress) => void;
  } = {},
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

  // Bucket caps at 500MB. Reject larger files locally with a clear message
  // before attempting the upload (otherwise supabase-js hangs silently).
  const MAX_BYTES = 500 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    throw new ApiError(
      `Archivo demasiado grande (${(file.size / 1024 / 1024).toFixed(1)}MB). Máximo: 500MB.`,
      413,
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
  // applies to Vercel function invocations; the storage REST API has its
  // own 500MB cap (handled above).
  //
  // Two-step flow (replaces the old `supabase.storage.upload(path, file)`):
  //   1. Ask Supabase for a signed upload URL — RLS still gates this, so
  //      the user's session JWT must allow `insert` on the target path.
  //   2. PUT the file via XHR so we can wire `xhr.upload.onprogress`
  //      (the supabase-js fetch wrapper does not surface progress events).
  //
  // Surfacing the storage error verbatim is critical — silent supabase-js
  // hangs were the "no funciona" symptom for large files pre-Phase 2.
  console.log(
    `[importAsset] uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB, ${file.type}) → ${path}`,
  );
  const t0 = Date.now();

  // Step 1 — signed URL (token baked into the query string).
  const { data: signedUrlData, error: signErr } = await supabase.storage
    .from(STUDIO_ASSETS_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signedUrlData) {
    console.error('[importAsset] createSignedUploadUrl failed:', signErr);
    const msg = signErr?.message ?? 'unknown';
    const detail = /row level security|policy/i.test(msg)
      ? 'Permisos de Supabase Storage denegaron la subida — sesión inválida o ruta fuera de tu carpeta.'
      : msg;
    throw new ApiError(`Falla al crear URL de subida: ${detail}`, 500);
  }

  // Step 2 — XHR PUT with progress events. We resolve on a 2xx response
  // and reject on every other terminal state (network error, abort, non-2xx).
  // Falls through gracefully when `lengthComputable` is false: no progress
  // callbacks fire, the caller sees 0% the whole way, then 100% on resolve.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrlData.signedUrl);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && opts.onProgress) {
        const percent = Math.min(
          100,
          Math.max(0, Math.round((e.loaded / e.total) * 100)),
        );
        opts.onProgress({
          bytesUploaded: e.loaded,
          bytesTotal: e.total,
          percent,
        });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // Force a 100% tick on success — useful for progress bars that
        // never see lengthComputable=true and would otherwise stick at 0.
        if (opts.onProgress) {
          opts.onProgress({
            bytesUploaded: file.size,
            bytesTotal: file.size,
            percent: 100,
          });
        }
        resolve();
      } else {
        reject(new Error(`Falla al subir (${xhr.status}): ${xhr.statusText || 'upload failed'}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    // Wire AbortSignal → xhr.abort. Honor a signal that's already aborted
    // by tearing down before the request even hits the wire.
    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        return;
      }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  }).catch((err) => {
    console.error('[importAsset] storage upload failed:', err);
    throw new ApiError(
      err instanceof Error ? err.message : 'Falla al subir el archivo',
      500,
    );
  });
  console.log(`[importAsset] upload ok in ${Date.now() - t0}ms, finalizing…`);

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
 * - pptx → server kicks off the Gamma generation and returns immediately.
 *   See `PptxStartResult` — caller either gets a cached `complete` deck
 *   right away, or a `pending` generationId to poll via `pollPptxStatus`.
 *   Phase 3.F split: the previous "block until done" shape always 504'd
 *   on Vercel because Gamma takes longer than the function maxDuration.
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
): Promise<PptxStartResult>;
export async function exportWorkspace(
  workspaceId: string,
  format: 'md' | 'docx' | 'pptx',
  opts: { workspaceTitle?: string; force?: boolean; options?: PptxOptions } = {},
): Promise<PptxStartResult | { format: 'md' | 'docx' }> {
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
    const json = await handleJson<
      | {
          ok: boolean;
          status: 'complete';
          generationId: string;
          gammaUrl: string;
          exportUrl: string;
          filename: string;
          cached: boolean;
          generatedAt: string;
        }
      | {
          ok: boolean;
          status: 'pending';
          generationId: string;
          filename: string;
          pollingUrl: string;
        }
    >(res);
    if (json.status === 'complete') {
      return {
        status: 'complete',
        result: {
          format: 'pptx',
          generationId: json.generationId,
          gammaUrl: json.gammaUrl,
          exportUrl: json.exportUrl,
          filename: json.filename,
          cached: json.cached,
          generatedAt: json.generatedAt,
        },
      };
    }
    return {
      status: 'pending',
      generationId: json.generationId,
      filename: json.filename,
      pollingUrl: json.pollingUrl,
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

/**
 * Single status hit on a pending pptx generation.
 *
 * Lower-level than `pollPptxStatus` — exposed for callers that want their
 * own polling loop (tests, debugging tools, future server-sent events
 * variant). UI code should use `pollPptxStatus`.
 */
export async function getPptxStatus(
  workspaceId: string,
  generationId: string,
  signal?: AbortSignal,
): Promise<PptxStatusResult> {
  const url = `/api/workspace/${workspaceId}/export/pptx-status?generation_id=${encodeURIComponent(generationId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: await authedHeaders(),
    signal,
  });
  const json = await handleJson<
    | { ok: boolean; status: 'pending'; generationId: string }
    | {
        ok: boolean;
        status: 'complete';
        generationId: string;
        gammaUrl: string;
        exportUrl: string;
        filename: string;
        cached: boolean;
        generatedAt: string;
      }
    | { ok: boolean; status: 'failed'; generationId: string; error: string }
  >(res);

  if (json.status === 'complete') {
    return {
      status: 'complete',
      generationId: json.generationId,
      result: {
        format: 'pptx',
        generationId: json.generationId,
        gammaUrl: json.gammaUrl,
        exportUrl: json.exportUrl,
        filename: json.filename,
        cached: json.cached,
        generatedAt: json.generatedAt,
      },
    };
  }
  if (json.status === 'failed') {
    return {
      status: 'failed',
      generationId: json.generationId,
      error: json.error,
    };
  }
  return {
    status: 'pending',
    generationId: json.generationId,
  };
}

/**
 * Poll the pptx status endpoint until the deck completes, fails, or
 * the timeout fires.
 *
 * Defaults match Gamma's recommended cadence: 5s between hits, 5min cap
 * (the same ceiling the legacy server-side `pollUntilComplete` used).
 *
 * onProgress fires once per tick with the elapsed milliseconds since
 * the call started — wire it to a "Generando deck… 23s" indicator.
 *
 * The signal is honored: aborting it rejects the returned promise with
 * a DOMException('AbortError') and stops further polling. Modal cancel
 * buttons should pass their AbortController.signal here.
 *
 * Resolves with the completed PptxExportResult.
 * Rejects on:
 *   - status: 'failed' from the server (Error message = upstream error)
 *   - timeout (Error('pptx_poll_timeout'))
 *   - abort (DOMException('AbortError'))
 *   - any HTTP error from getPptxStatus (re-thrown)
 */
export async function pollPptxStatus(
  workspaceId: string,
  generationId: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (elapsedMs: number) => void;
  } = {},
): Promise<PptxExportResult> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const startedAt = Date.now();

  // Tiny initial delay — give Gamma a beat to commit the row before the
  // first GET. Mirrors the 1s sleep the legacy server-side poll used.
  await sleepWithAbort(1_000, opts.signal);

  while (true) {
    const elapsed = Date.now() - startedAt;
    opts.onProgress?.(elapsed);

    if (opts.signal?.aborted) {
      throw new DOMException('pollPptxStatus aborted', 'AbortError');
    }
    if (elapsed > timeoutMs) {
      throw new Error('pptx_poll_timeout');
    }

    const tick = await getPptxStatus(workspaceId, generationId, opts.signal);
    if (tick.status === 'complete') {
      return tick.result;
    }
    if (tick.status === 'failed') {
      throw new Error(tick.error || 'pptx_failed');
    }

    await sleepWithAbort(intervalMs, opts.signal);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException('aborted', 'AbortError'));
    };
    function cleanup() {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

// ─── Chat message persistence ─────────────────────────────────────────
//
// Server-side persistence for ChatPanel conversations. localStorage stays
// as the warm cache for instant render; Supabase is the source of truth
// so users can switch devices and see their history.
//
// Read: GET /:id/messages → up to 500 newest, ASC (oldest first).
// Write: POST /:id/messages → returns the inserted row.
// Clear: DELETE /:id/messages → returns the deleted count.

export type ChatMessageRole = 'user' | 'assistant' | 'system';
export type ChatMessageVariant = 'default' | 'action';
export type ChatMessageIntent = 'chat' | 'build' | 'edit_selected' | 'edit_by_match';

export interface ChatMessageRow {
  id: string;
  role: ChatMessageRole;
  content: string;
  variant: ChatMessageVariant | null;
  intent: ChatMessageIntent | null;
  created_at: string;
}

export interface CreateChatMessageBody {
  role: ChatMessageRole;
  content: string;
  variant?: ChatMessageVariant | null;
  intent?: ChatMessageIntent | null;
}

export async function listChatMessages(workspaceId: string): Promise<ChatMessageRow[]> {
  const res = await fetch(`/api/workspace/${workspaceId}/messages`, {
    headers: await authedHeaders(),
  });
  const body = await handleJson<{ ok: boolean; messages: ChatMessageRow[] }>(res);
  return body.messages ?? [];
}

export async function createChatMessage(
  workspaceId: string,
  body: CreateChatMessageBody,
): Promise<ChatMessageRow> {
  const res = await fetch(`/api/workspace/${workspaceId}/messages`, {
    method: 'POST',
    headers: await authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await handleJson<{ ok: boolean; message: ChatMessageRow }>(res);
  return json.message;
}

export async function clearChatMessages(workspaceId: string): Promise<number> {
  const res = await fetch(`/api/workspace/${workspaceId}/messages`, {
    method: 'DELETE',
    headers: await authedHeaders(),
  });
  const body = await handleJson<{ ok: boolean; deleted?: number }>(res);
  return body.deleted ?? 0;
}
