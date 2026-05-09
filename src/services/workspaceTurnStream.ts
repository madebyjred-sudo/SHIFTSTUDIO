/**
 * @file workspaceTurnStream.ts
 * @description Dual-mode streaming client for `POST /api/workspace/:id/turn`.
 *
 * The BFF endpoint resolves the user's intent server-side and replies in one
 * of two ways:
 *
 *   1. SSE (`Content-Type: text/event-stream`) — when the intent is `chat`.
 *      First event MAY be `event: meta` carrying intent metadata. Subsequent
 *      events are OpenAI-compatible chunks (`data: {choices:[{delta:{content}}]}`),
 *      terminated by `data: [DONE]`.
 *   2. JSON (`Content-Type: application/json`) — when the intent is one of
 *      `build` / `edit_selected` / `edit_by_match`. The body is the action
 *      envelope; the parent handles node mutations.
 *
 * This module abstracts both paths behind a single onChunk pump and surfaces
 * intent metadata via onIntent. Auth uses the same Supabase JWT pattern as
 * `workspaceApi`. A 401 dispatches `workspace:unauthorized` on `window` so
 * the global App listener can clear the session and re-mount AuthView.
 *
 * Ported from /Users/juan/Downloads/shift-cl2/apps/web/src/services/chatStream.ts
 * (workspace-turn subset only — generic /api/chat/stream not relevant here).
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

  const contentType = res.headers.get('content-type') ?? '';

  // ── JSON mode (build / edit_* / chat-as-of-2026-05-08) ───────────
  // Chat used to be SSE but Vercel buffers SSE on Hobby/Pro tiers and
  // failures truncated to empty responses. Now /turn returns JSON for
  // every intent. We special-case 'chat' here: the JSON envelope has a
  // `text` field which we forward as a single token chunk so the chat
  // panel renders it as one bubble (no token-by-token UX, but reliable).
  if (!contentType.includes('text/event-stream')) {
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
    return;
  }

  // ── SSE mode (chat) ───────────────────────────────────────────────
  if (!res.body) {
    args.onChunk({ type: 'error', payload: 'No response body for SSE stream' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let metaFired = false;
  let aborted = false;

  // Bridge AbortSignal → reader.cancel(). The fetch call already honors
  // signal at the network layer, but mid-stream we need to release the
  // reader explicitly so the loop exits cleanly.
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => null);
  };
  args.signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (aborted) return;
        args.onChunk({ type: 'error', payload: (err as Error).message ?? 'Stream read error' });
        return;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank line (\n\n).
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        if (aborted) return;
        const lines = evt.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;

        const eventLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
        const payload = dataLine ? dataLine.slice(5).trim() : '';

        if (!payload) continue;

        // ── Named meta event — intent routing info ────────────────
        if (eventName === 'meta' && !metaFired) {
          metaFired = true;
          try {
            const meta = JSON.parse(payload) as {
              intent?: string;
              intent_confidence?: number;
              target_node_id?: string | null;
            };
            args.onIntent?.({
              intent: meta.intent ?? 'chat',
              intent_confidence: meta.intent_confidence,
              target_node_id: meta.target_node_id,
            });
          } catch {
            // ignore malformed meta
          }
          continue;
        }

        // ── DONE sentinel ─────────────────────────────────────────
        if (payload === '[DONE]') {
          args.onChunk({ type: 'done' });
          args.onDone?.();
          return;
        }

        // ── OpenAI-compatible delta chunk ─────────────────────────
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            delta?: { text?: string };
            type?: string;
            payload?: unknown;
          };

          const tokenText =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.delta?.text ??
            '';
          if (tokenText) {
            args.onChunk({ type: 'token', payload: tokenText });
            continue;
          }

          // The server may also emit structured chunks { type: 'done' | 'error' }.
          if (parsed.type === 'done') {
            args.onChunk({ type: 'done' });
            args.onDone?.();
            return;
          }
          if (parsed.type === 'error') {
            const msg = typeof parsed.payload === 'string' ? parsed.payload : 'Error de servidor';
            args.onChunk({ type: 'error', payload: msg });
            return;
          }
        } catch {
          // ignore malformed payload
        }
      }
    }

    // Stream closed without an explicit [DONE] sentinel — finalize.
    args.onChunk({ type: 'done' });
    args.onDone?.();
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
  }
}
