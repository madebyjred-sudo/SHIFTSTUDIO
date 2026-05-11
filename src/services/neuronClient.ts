/**
 * @file neuronClient.ts
 * @description Typed fetch wrapper for the neuron BFF proxy.
 *
 * All endpoints live under `/api/neuron/...` (same-origin, no CORS).
 * Auth is by Supabase JWT in the `Authorization: Bearer` header — the
 * BFF resolves the user's email from the JWT and forwards to Cerebro
 * with the shared internal token. See src/routes/neuron-proxy.ts.
 *
 * The error shape mirrors the BFF/Cerebro contract:
 *   - 401 unauthenticated → user needs to re-auth
 *   - 400 path_required / invalid_body → client bug
 *   - 404 not_found (delete/get) → file gone or never existed
 *   - 502 upstream_unavailable → Cerebro down
 * Callers should surface the status code so the UI can pick the right
 * empty/error state.
 */
import { supabase } from './supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────

export interface NeuronFile {
  path: string;
  size_bytes: number;
  updated_at: string;
}

export interface NeuronQuota {
  used_bytes: number;
  max_bytes: number;
  file_count: number;
  max_files: number;
}

export interface NeuronListResponse {
  files: NeuronFile[];
  quota: NeuronQuota;
}

export interface NeuronFileContent {
  path: string;
  content: string;
  size_bytes: number;
  updated_at: string;
}

export interface NeuronHistoryEntry {
  command: string;
  agent_id?: string;
  app_id?: string;
  call_id?: string;
  path?: string;
  diff_excerpt?: string;
  created_at: string;
}

export interface NeuronHistoryResponse {
  entries: NeuronHistoryEntry[];
}

// ─── Internals ────────────────────────────────────────────────────────

/**
 * Fetch wrapper that injects the Supabase Bearer token. If supabase is
 * null (anon / bypass-auth dev mode) we still issue the call — the BFF
 * will respond 401 and the caller surfaces it.
 */
async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  let token: string | undefined;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  }
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(input, { ...init, headers });
}

/**
 * Build a typed error that preserves the HTTP status so callers can
 * branch on 401 vs 502 vs validation. We deliberately do NOT throw
 * generic `Error("save_failed")` — the UI needs to distinguish
 * "Cerebro is down, retry in a moment" from "you got logged out".
 */
export class NeuronApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'NeuronApiError';
  }
}

async function parseOrThrow<T>(r: Response, op: string): Promise<T> {
  if (r.ok) {
    return (await r.json()) as T;
  }
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* ignore — non-JSON error body */
  }
  throw new NeuronApiError(`${op}_failed_${r.status}`, r.status, body);
}

// ─── Public API ───────────────────────────────────────────────────────

export async function listNeuronFiles(): Promise<NeuronListResponse> {
  const r = await authedFetch('/api/neuron');
  return parseOrThrow<NeuronListResponse>(r, 'list');
}

export async function getNeuronFile(path: string): Promise<NeuronFileContent> {
  const r = await authedFetch(`/api/neuron/file?path=${encodeURIComponent(path)}`);
  return parseOrThrow<NeuronFileContent>(r, 'get');
}

export async function saveNeuronFile(
  path: string,
  content: string,
): Promise<{ ok: boolean }> {
  const r = await authedFetch('/api/neuron/file', {
    method: 'PATCH',
    body: JSON.stringify({ path, content }),
  });
  return parseOrThrow<{ ok: boolean }>(r, 'save');
}

export async function deleteNeuronFile(
  path: string,
): Promise<{ ok: boolean }> {
  const r = await authedFetch(
    `/api/neuron/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
  return parseOrThrow<{ ok: boolean }>(r, 'delete');
}

export async function getNeuronHistory(
  limit = 50,
): Promise<NeuronHistoryResponse> {
  const r = await authedFetch(`/api/neuron/history?limit=${limit}`);
  return parseOrThrow<NeuronHistoryResponse>(r, 'history');
}
