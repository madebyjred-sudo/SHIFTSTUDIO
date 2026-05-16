/**
 * @file useGraphArchitectChat.ts
 * @description Wave-D (2026-05-16) — conversational graph editing.
 *
 * The user talks to Shifty in plain text ("Brief para Garnier sobre el
 * nuevo champú", "cambiá Catalina por Diego", "borrá el último") and
 * the architect at `POST /v1/graph/generate` decides whether to ship a
 * new graph (`mode: 'graph'`) or ask a clarification question
 * (`mode: 'chat'`). This hook owns:
 *
 *   • the conversational history (persisted per-workspace in
 *     localStorage, capped at 30 messages to bound payload + storage),
 *   • the request lifecycle (thinking / error states),
 *   • the side-effect of applying a returned graph via the V2 store's
 *     `applyGraphWithDiff` so the user sees the added/modified/removed
 *     animations.
 *
 * Both the sidebar (`GraphChatSidebar`) and the in-canvas command bar
 * (`GraphCommandBar`) share this hook — the command bar appends in the
 * background while the sidebar renders the full transcript, but the
 * underlying state is one source.
 *
 * The `tenant_id` is hardcoded to `'shift'` for the MVP; the multi-tenant
 * surface for CL2 / Centinela is tracked separately.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStoreV2 } from '../store/useGraphStoreV2';
import {
  generateGraph,
  type GenerateGraphRequest,
} from '../services/graphApi';

export type ArchitectRole = 'user' | 'assistant';

export interface ArchitectMessage {
  id: string;
  role: ArchitectRole;
  content: string;
  /** Set on assistant turns when the architect returned mode='graph'. */
  mode?: 'graph' | 'chat';
  /** Snapshot of the graph attached to an assistant 'graph' turn so
   *  the user can re-apply a previous state via the sidebar. Optional —
   *  not every turn carries one (clarification questions don't). */
  graphSnapshot?: { nodes: unknown[]; edges: unknown[] } | null;
  createdAt: number;
}

/** Maximum messages kept in history. Bounds the architect request body
 *  size + the localStorage write. The architect itself only sees the
 *  last `CHAT_HISTORY_TAIL` (12) per spec. */
const HISTORY_CAP = 30;
const CHAT_HISTORY_TAIL = 12;

/** TODO(multi-tenant): when CL2 / Centinela onboard, derive this from
 *  the active app context. For MVP the gateway only routes Shift. */
const DEFAULT_TENANT_ID = 'shift';

const STORAGE_KEY_PREFIX = 'studio_graph_architect_chat_';

function storageKeyFor(workspaceId: string | null): string {
  return `${STORAGE_KEY_PREFIX}${workspaceId ?? '__no_workspace__'}`;
}

function loadMessages(workspaceId: string | null): ArchitectMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKeyFor(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ArchitectMessage =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as { id?: unknown }).id === 'string' &&
        typeof (m as { content?: unknown }).content === 'string' &&
        ((m as { role?: unknown }).role === 'user' ||
          (m as { role?: unknown }).role === 'assistant'),
    );
  } catch {
    return [];
  }
}

function saveMessages(workspaceId: string | null, messages: ArchitectMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    const capped =
      messages.length > HISTORY_CAP
        ? messages.slice(messages.length - HISTORY_CAP)
        : messages;
    window.localStorage.setItem(
      storageKeyFor(workspaceId),
      JSON.stringify(capped),
    );
  } catch (e) {
    // Quota / private mode — degrade silently. The architect chat is
    // still functional in-session, just won't survive refresh.
    console.warn('[useGraphArchitectChat] persist failed:', e);
  }
}

function clearStoredMessages(workspaceId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKeyFor(workspaceId));
  } catch {
    /* ignore */
  }
}

export interface UseGraphArchitectChatResult {
  messages: ArchitectMessage[];
  isThinking: boolean;
  error: string | null;
  /** Send a user message to the architect. Returns the assistant turn
   *  on success, or `null` on failure (error state is set). */
  sendMessage: (text: string) => Promise<ArchitectMessage | null>;
  /** Clear the entire history (in-memory + persisted) for the active
   *  workspace. Doesn't touch the graph on the canvas. */
  resetHistory: () => void;
  /** Restore the graph snapshot attached to an assistant turn. Useful
   *  when the user navigated through several iterations and wants to
   *  jump back. No-op if the message has no snapshot. */
  reapplyGraph: (messageId: string) => void;
  /** Dismiss the current error banner. */
  clearError: () => void;
}

/**
 * Conversational graph editing hook. Mount it once per canvas surface —
 * both the sidebar and the command bar share the same instance via the
 * V2 store's workspaceId scope (every consumer that reads the same
 * workspaceId reads the same localStorage cache + sees the same
 * applyGraphWithDiff calls).
 *
 * The hook intentionally does NOT share state across surfaces via React
 * context — the architect chat is small enough that re-rendering both
 * the sidebar and the command bar from the same hook instance would be
 * wasteful when they're rarely both visible. Instead, the storage layer
 * + the V2 store keep them in sync (a graph update from the command bar
 * lands on the canvas; reopening the sidebar re-hydrates from
 * localStorage and shows the turn).
 */
export function useGraphArchitectChat(): UseGraphArchitectChatResult {
  const workspaceId = useGraphStoreV2((s) => s.workspaceId);
  const applyGraphWithDiff = useGraphStoreV2((s) => s.applyGraphWithDiff);

  // Lazy initializer so the first render shows the persisted history
  // without flicker. workspaceId-change re-hydration is handled below.
  const [messages, setMessages] = useState<ArchitectMessage[]>(() =>
    loadMessages(workspaceId),
  );
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track whether we already ran the initial hydration so the
  // workspaceId-effect doesn't double-load on first mount.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      return;
    }
    setMessages(loadMessages(workspaceId));
    setError(null);
    setIsThinking(false);
  }, [workspaceId]);

  // Persist on every mutation. Cheap (localStorage is sync but small).
  useEffect(() => {
    saveMessages(workspaceId, messages);
  }, [workspaceId, messages]);

  const sendMessage = useCallback(
    async (text: string): Promise<ArchitectMessage | null> => {
      const trimmed = text.trim();
      if (!trimmed || isThinking) return null;
      setError(null);

      const userMsg: ArchitectMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };
      // Build the request BEFORE committing the user message so we use
      // the previous tail of history for the architect's context — the
      // user's current turn is sent as `user_message`, not duplicated
      // in `chat_history`.
      const tailHistory = messages.slice(-CHAT_HISTORY_TAIL).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      setMessages((prev) => [...prev, userMsg]);
      setIsThinking(true);

      // Read live graph state at send time so subsequent edits don't
      // sneak in between debounce and request.
      const live = useGraphStoreV2.getState();
      const currentGraph =
        live.nodes.length > 0
          ? {
              nodes: live.nodes as unknown as Record<string, unknown>[],
              edges: live.edges as unknown as Record<string, unknown>[],
            }
          : null;

      const payload: GenerateGraphRequest = {
        user_message: trimmed,
        current_graph: currentGraph,
        chat_history: tailHistory,
        tenant_id: DEFAULT_TENANT_ID,
        model: 'claude-sonnet-4-6',
      };

      try {
        const response = await generateGraph(payload);

        let assistantContent = '';
        let mode: 'graph' | 'chat' = 'chat';
        let graphSnapshot: ArchitectMessage['graphSnapshot'] = null;

        if (response.mode === 'graph' && response.graph) {
          mode = 'graph';
          // Apply on canvas with diff animation.
          applyGraphWithDiff({
            nodes: response.graph.nodes,
            edges: response.graph.edges as never,
          });
          graphSnapshot = {
            nodes: response.graph.nodes,
            edges: response.graph.edges,
          };
          assistantContent =
            response.narrative ??
            `Generé ${response.graph.nodes.length} nodos.`;
        } else {
          mode = 'chat';
          assistantContent =
            response.message ??
            response.narrative ??
            'No tengo respuesta — probá reformular.';
        }

        const assistantMsg: ArchitectMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: assistantContent,
          mode,
          graphSnapshot,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        return assistantMsg;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useGraphArchitectChat] generateGraph failed:', msg);
        setError(
          'No pude generar el grafo. Verificá la conexión con el gateway y probá de nuevo.',
        );
        return null;
      } finally {
        setIsThinking(false);
      }
    },
    [messages, isThinking, applyGraphWithDiff],
  );

  const resetHistory = useCallback(() => {
    setMessages([]);
    clearStoredMessages(workspaceId);
    setError(null);
  }, [workspaceId]);

  const reapplyGraph = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (!msg?.graphSnapshot) return;
      applyGraphWithDiff({
        nodes: msg.graphSnapshot.nodes as never[],
        edges: msg.graphSnapshot.edges as never[],
      });
    },
    [messages, applyGraphWithDiff],
  );

  const clearError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      messages,
      isThinking,
      error,
      sendMessage,
      resetHistory,
      reapplyGraph,
      clearError,
    }),
    [messages, isThinking, error, sendMessage, resetHistory, reapplyGraph, clearError],
  );
}
