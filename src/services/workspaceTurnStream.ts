/**
 * @file workspaceTurnStream.ts
 * @description JSON client for `POST /api/workspace/:id/turn`.
 *
 * The BFF endpoint resolves the user's intent server-side and always replies
 * with `application/json`. Chat replies have `{ text }` which we forward as
 * a single token chunk so the chat panel renders one bubble; build/edit
 * replies are forwarded as a `workspace_action` chunk for node mutations.
 *
 * Used to be dual-mode (SSE for chat). SSE was removed 2026-05-08 because
 * Vercel Hobby/Pro tiers buffer event-stream responses and chat replies
 * truncated to empty bodies. JSON-only since.
 *
 * Auth uses the same Supabase JWT pattern as `workspaceApi`. A 401
 * dispatches `workspace:unauthorized` on `window` so the global App
 * listener can clear the session and re-mount AuthView.
 */
import { supabase } from './supabaseClient';
import type { WorkspaceNode } from './workspaceApi';

// ─── Types ────────────────────────────────────────────────────────────

export type WorkspaceIntent =
  | 'chat'
  | 'build'
  | 'edit_selected'
  | 'edit_by_match';

/** JSON envelope returned for non-chat intents. */
export interface WorkspaceActionPayload {
  intent: 'build' | 'edit_selected' | 'edit_by_match';
  ok?: boolean;
  /** Populated when intent='build'. The new server rows. */
  nodes?: WorkspaceNode[];
  /** Populated when intent='edit_selected' or 'edit_by_match'. */
  node_id?: string;
  /** Markdown content the server wants merged into the target node. */
  new_content?: string;
  /** edit_by_match-only: how confident the matcher was. */
  target_match_confidence?: number;
  [key: string]: unknown;
}

export type StreamChunk =
  | { type: 'token'; payload: string }
  | { type: 'workspace_action'; payload: WorkspaceActionPayload }
  | { type: 'done' }
  | { type: 'error'; payload: string };

export interface IntentMeta {
  intent: WorkspaceIntent | string;
  intent_confidence?: number;
  target_node_id?: string | null;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HojaTitle {
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface StreamWorkspaceTurnArgs {
  workspaceId: string;
  query: string;
  /** Studio's workspace agent picker exposes Lexa (chat) + Atlas (constructor).
   *  The backend derives intent from agent + selection state when this is set. */
  agentId?: 'lexa' | 'atlas';
  selectedNodeId?: string | null;
  hojaTitles?: HojaTitle[];
  deepInsight?: boolean;
  history?: ChatHistoryMessage[];
  signal?: AbortSignal;
  onChunk: (chunk: StreamChunk) => void;
  onIntent?: (meta: IntentMeta) => void;
  onDone?: () => void;
}

// ─── Auth helper ──────────────────────────────────────────────────────

async function getAuthToken(): Promise<string | undefined> {
  if (!supabase) return undefined;
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token;
  } catch {
    return undefined;
  }
}

function dispatchUnauthorized(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('workspace:unauthorized'));
  }
}

// ─── Main entry ───────────────────────────────────────────────────────

export async function streamWorkspaceTurn(args: StreamWorkspaceTurnArgs): Promise<void> {
  const token = await getAuthToken();

  let res: Response;
  try {
    // agent_id is forwarded only when the caller explicitly passed one.
    // Default behavior is to OMIT it so the BFF's classifier picks the
    // intent from the prompt + selection state. The Workspace ChatPanel
    // no longer exposes an agent picker; this branch keeps the field
    // available for any future caller that still wants to force routing.
    const body: Record<string, unknown> = {
      query: args.query,
      selected_node_id: args.selectedNodeId ?? null,
      hoja_titles: args.hojaTitles ?? [],
      deep_insight: args.deepInsight ?? false,
      history: args.history ?? [],
    };
    if (args.agentId) body.agent_id = args.agentId;

    res = await fetch(`/api/workspace/${args.workspaceId}/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'shift',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (err) {
    // Network error or AbortController cancellation. Swallow aborts; surface others.
    if ((err as { name?: string })?.name === 'AbortError') return;
    args.onChunk({ type: 'error', payload: (err as Error).message ?? 'Network error' });
    return;
  }

  if (res.status === 401) {
    dispatchUnauthorized();
    args.onChunk({ type: 'error', payload: 'No autorizado. Iniciá sesión otra vez.' });
    return;
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string; message?: string };
      detail = body.detail ?? body.error ?? body.message ?? detail;
    } catch {
      // ignore
    }
    args.onChunk({ type: 'error', payload: detail });
    return;
  }

  // JSON envelope — `text` for chat intent, otherwise a workspace_action.
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const intent = (body.intent as string) ?? 'build';
    args.onIntent?.({
      intent,
      intent_confidence: body.intent_confidence as number | undefined,
      target_node_id: (body.target_node_id ?? body.node_id) as string | null | undefined,
    });
    if (intent === 'chat' && typeof body.text === 'string') {
      args.onChunk({ type: 'token', payload: body.text });
    } else {
      args.onChunk({
        type: 'workspace_action',
        payload: body as WorkspaceActionPayload,
      });
    }
    args.onChunk({ type: 'done' });
    args.onDone?.();
  } catch (err) {
    args.onChunk({ type: 'error', payload: (err as Error).message ?? 'Invalid JSON envelope' });
  }
}
