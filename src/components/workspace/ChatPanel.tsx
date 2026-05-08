/**
 * @file ChatPanel.tsx
 * @description Workspace-scoped chat sidebar.
 *
 * Replaces the T6 placeholder (`<AnimatedAiInput compact />`) with a proper
 * streaming chat panel wired to `POST /api/workspace/:id/turn`. Handles the
 * full intent surface:
 *
 *   • chat          → SSE stream into an assistant bubble.
 *   • build         → JSON envelope with `nodes[]`.
 *   • edit_selected → JSON envelope with `node_id` + `new_content`.
 *   • edit_by_match → same shape; server matched the target by title.
 *
 * Single-input flow (no agent picker): the BFF's classifier picks the
 * intent server-side from the user's prompt + selection state, so the
 * client just sends the query and renders whatever the server returns.
 *
 * The parent (WorkspaceCanvasPage) receives non-chat envelopes via
 * `onWorkspaceAction` and is responsible for inserting / patching nodes on
 * the canvas. This panel only owns the chat surface.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ArrowUp, BookOpen, Loader2, Sparkles, StopCircle,
} from 'lucide-react';
import { marked } from 'marked';
import { cn } from '@/lib/utils';
import {
  streamWorkspaceTurn,
  type HojaTitle,
  type IntentMeta,
  type WorkspaceActionPayload,
} from '@/services/workspaceTurnStream';

// ─── Types ────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Synthetic system messages (e.g. "Se crearon 4 hojas") render with a different style. */
  variant?: 'default' | 'action';
  createdAt: number;
}

const HISTORY_CAP = 30;

interface ChatPanelProps {
  workspaceId: string;
  workspaceTitle?: string;
  selectedNodeId?: string | null;
  hojaTitles: HojaTitle[];
  /** Called when the server returns a non-chat envelope. Parent mutates canvas. */
  onWorkspaceAction: (action: WorkspaceActionPayload) => void;
  /** Optional: lets the user push a chat answer to a new node. T9 modal will replace this. */
  onCreateNodeFromAssistant?: (text: string) => void;
}

// ─── Markdown renderer (memo-ed, async:false for sync return) ─────────

function renderMarkdown(md: string): string {
  try {
    const out = marked.parse(md, { async: false, breaks: true, gfm: true });
    return typeof out === 'string' ? out : '';
  } catch {
    return md;
  }
}

// ─── Component ────────────────────────────────────────────────────────

export function ChatPanel({
  workspaceId,
  workspaceTitle,
  selectedNodeId,
  hojaTitles,
  onWorkspaceAction,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingIntent, setStreamingIntent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // ── Cleanup on unmount: abort + clear timers ──────────────────────
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingTimers.current.forEach((t) => clearTimeout(t));
    pendingTimers.current.clear();
  }, []);

  // ── Smooth scroll-to-bottom on new content ────────────────────────
  useEffect(() => {
    const el = messagesEndRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  // ── Auto-grow textarea (max ~6 lines ≈ 144px) ─────────────────────
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`;
  }, [input]);

  // ── Selected hoja chip data ───────────────────────────────────────
  const selectedHoja = useMemo(() => {
    if (!selectedNodeId) return null;
    return hojaTitles.find((h) => h.id === selectedNodeId) ?? null;
  }, [selectedNodeId, hojaTitles]);

  // ── Build history payload (cap at last HISTORY_CAP messages) ──────
  const buildHistory = useCallback(() => {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.variant !== 'action')
      .slice(-HISTORY_CAP)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }, [messages]);

  // ── Send turn ─────────────────────────────────────────────────────
  // No agent_id: backend classifier auto-routes. Less surface area for
  // non-power users, fewer brand-confusion liabilities.
  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };

    const history = buildHistory();
    const ac = new AbortController();
    abortRef.current = ac;

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamingText('');
    setStreamingIntent(null);
    setError(null);
    streamingTextRef.current = '';

    let actionConsumed = false;

    await streamWorkspaceTurn({
      workspaceId,
      query: trimmed,
      // agentId omitted on purpose — server classifier picks the intent.
      selectedNodeId: selectedNodeId ?? null,
      hojaTitles,
      deepInsight: false,
      history,
      signal: ac.signal,
      onIntent: (meta: IntentMeta) => {
        setStreamingIntent(meta.intent ?? null);
      },
      onChunk: (chunk) => {
        if (chunk.type === 'token') {
          streamingTextRef.current += chunk.payload;
          setStreamingText(streamingTextRef.current);
        } else if (chunk.type === 'workspace_action') {
          actionConsumed = true;
          const payload = chunk.payload;
          // Hand off canvas mutation to the parent.
          try {
            onWorkspaceAction(payload);
          } catch (err) {
            // Parent shouldn't throw, but be defensive.
            setError((err as Error).message ?? 'Error aplicando la acción');
          }
          // Synthetic confirmation message.
          const confirmation = buildActionConfirmation(payload, hojaTitles);
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              content: confirmation,
              variant: 'action',
              createdAt: Date.now(),
            },
          ]);
        } else if (chunk.type === 'error') {
          setError(chunk.payload);
        } else if (chunk.type === 'done') {
          // Flush any streamed text into a message.
          if (!actionConsumed && streamingTextRef.current.trim()) {
            const text = streamingTextRef.current;
            setMessages((prev) => [
              ...prev,
              {
                id: `a-${Date.now()}`,
                role: 'assistant',
                content: text,
                createdAt: Date.now(),
              },
            ]);
          }
        }
      },
    });

    // Whatever happened, finalize the streaming UI state.
    streamingTextRef.current = '';
    setStreamingText('');
    setStreaming(false);
    setStreamingIntent(null);
    if (abortRef.current === ac) abortRef.current = null;
  }, [
    input, streaming, buildHistory, workspaceId, selectedNodeId, hojaTitles, onWorkspaceAction,
  ]);

  // ── Stop streaming ────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Persist whatever we have so it isn't lost.
    if (streamingTextRef.current.trim()) {
      const text = streamingTextRef.current;
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: text,
          createdAt: Date.now(),
        },
      ]);
    }
    streamingTextRef.current = '';
    setStreamingText('');
    setStreaming(false);
    setStreamingIntent(null);
  }, []);

  // ── Keyboard: Cmd/Ctrl+Enter to send, Enter alone = newline ──────
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  // ── Render ────────────────────────────────────────────────────────
  // When the server signals a `build` intent, the response is one
  // JSON envelope (no streaming tokens), so we show a short loader
  // instead of the bouncing-dots streaming bubble.
  const isBuildingNodes = streaming && streamingIntent === 'build';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="px-4 pt-4 pb-3 border-b border-black/8 dark:border-white/8">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#1534dc]/12 dark:bg-[#8b5cf6]/20 flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-[#1534dc] dark:text-[#8b5cf6]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
              {workspaceTitle ?? 'Workspace'}
            </p>
            <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 truncate">
              Conversa, analiza y construye hojas
            </p>
          </div>
        </div>

        {/* ── Selected hoja chip ──────────────────────────────── */}
        {selectedHoja ? (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-[#1534dc]/8 dark:bg-[#8b5cf6]/12 border border-[#1534dc]/15 dark:border-[#8b5cf6]/20 animate-in fade-in slide-in-from-top-1 duration-200">
            <BookOpen className="w-3 h-3 text-[#1534dc] dark:text-[#8b5cf6] shrink-0" aria-hidden />
            <p className="text-[11px] font-medium text-[#1534dc] dark:text-[#a892ee] truncate">
              Hoja seleccionada: "{selectedHoja.title || 'Sin título'}"
            </p>
          </div>
        ) : null}
      </header>

      {/* ── Messages list ──────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3"
      >
        {messages.length === 0 && !streaming && !error && (
          <EmptyState />
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {/* Streaming bubble */}
        {streaming && (
          <StreamingBubble
            text={streamingText}
            isBuildingNodes={isBuildingNodes && !streamingText}
          />
        )}

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-300/40 dark:border-red-500/30 bg-red-50/80 dark:bg-red-950/30 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-1 duration-200 flex items-start justify-between gap-2"
          >
            <p className="text-[12px] text-red-600 dark:text-red-300 leading-snug">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Descartar error"
              className="text-red-600 dark:text-red-300 hover:text-red-700 dark:hover:text-red-200 shrink-0"
            >
              <span className="text-[14px] leading-none" aria-hidden>×</span>
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input ──────────────────────────────────────────────── */}
      <div className="px-3 pb-3 pt-2 border-t border-black/8 dark:border-white/8">
        <div
          className={cn(
            'rounded-2xl border bg-white/85 dark:bg-white/[0.04] backdrop-blur-xl transition-colors',
            'border-black/10 dark:border-white/10',
            'focus-within:border-[#1534dc]/45 focus-within:ring-2 focus-within:ring-[#1534dc]/15 dark:focus-within:border-[#8b5cf6]/45 dark:focus-within:ring-[#8b5cf6]/20',
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedHoja
              ? `Conversá sobre "${selectedHoja.title}" o pedí una nueva hoja…`
              : 'Conversá sobre tu workspace o pedí una nueva hoja…'}
            rows={2}
            disabled={streaming}
            aria-label="Mensaje al chat del workspace"
            className="w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] leading-relaxed text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none disabled:opacity-60 max-h-[144px]"
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <p className="text-[10.5px] text-[#0e1745]/35 dark:text-white/30 select-none">
              Cmd/Ctrl + Enter para enviar
            </p>
            <div className="flex items-center gap-1.5">
              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  aria-label="Detener respuesta"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-[12px] font-semibold hover:bg-red-600 transition-colors"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  Detener
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  aria-label="Enviar mensaje"
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-[12px] font-semibold transition-colors disabled:opacity-40',
                    'bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2]',
                  )}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                  Enviar
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-10 h-10 rounded-2xl bg-[#1534dc]/10 dark:bg-[#8b5cf6]/15 flex items-center justify-center mb-3">
        <Sparkles className="w-5 h-5 text-[#1534dc]/70 dark:text-[#8b5cf6]/85" aria-hidden />
      </div>
      <p className="text-[12px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed max-w-[260px]">
        Pedí un análisis sobre la hoja seleccionada, o describí un set de hojas para que se generen en el canvas.
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isAction = message.variant === 'action';

  if (isAction) {
    return (
      <div className="flex justify-center animate-in fade-in slide-in-from-bottom-1 duration-200">
        <div className="rounded-full bg-[#1534dc]/8 dark:bg-[#8b5cf6]/15 border border-[#1534dc]/15 dark:border-[#8b5cf6]/25 px-3 py-1">
          <p className="text-[11px] font-medium text-[#1534dc] dark:text-[#a892ee]">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex animate-in fade-in slide-in-from-bottom-1 duration-200', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'rounded-2xl px-4 py-3 max-w-[88%] text-[13px] leading-relaxed',
          isUser
            ? 'bg-[#1534dc] dark:bg-[#8b5cf6] text-white ml-auto shadow-sm shadow-[#1534dc]/20 dark:shadow-[#8b5cf6]/20'
            : 'bg-white/85 dark:bg-white/[0.06] text-[#0e1745] dark:text-white border border-black/5 dark:border-white/10',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div
            className="hoja-prose chat-md max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
      </div>
    </div>
  );
}

function StreamingBubble({
  text,
  isBuildingNodes,
}: {
  text: string;
  isBuildingNodes: boolean;
}) {
  // Build mode: server returns a single JSON envelope (no token stream),
  // so we render a neutral phase loader instead of bouncing dots.
  if (isBuildingNodes) {
    return (
      <div className="flex justify-start animate-in fade-in slide-in-from-bottom-1 duration-200">
        <div className="rounded-2xl px-4 py-3 max-w-[88%] bg-white/85 dark:bg-white/[0.06] border border-black/5 dark:border-white/10">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 text-[#1534dc] dark:text-[#8b5cf6] animate-spin" aria-hidden />
            <p className="text-[12px] font-medium text-[#0e1745]/70 dark:text-white/70">Trabajando en eso…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div
        className={cn(
          'rounded-2xl px-4 py-3 max-w-[88%] text-[13px] leading-relaxed',
          'bg-white/85 dark:bg-white/[0.06] text-[#0e1745] dark:text-white border border-black/5 dark:border-white/10',
          !text && 'animate-pulse',
        )}
      >
        {text ? (
          <div
            className="hoja-prose chat-md max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        ) : (
          <span className="inline-flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-[#1534dc] dark:bg-[#8b5cf6] animate-bounce"
                style={{ animationDelay: `${i * 0.15}s` }}
                aria-hidden
              />
            ))}
            <span className="ml-2 text-[11px] text-[#0e1745]/55 dark:text-white/55">
              Pensando…
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildActionConfirmation(
  action: WorkspaceActionPayload,
  hojaTitles: HojaTitle[],
): string {
  if (action.intent === 'build') {
    const n = action.nodes?.length ?? 0;
    if (n <= 0) return 'No se crearon hojas en este turno.';
    if (n === 1) return 'Se creó 1 hoja en el canvas.';
    return `Se crearon ${n} hojas en el canvas.`;
  }
  if (action.intent === 'edit_selected' || action.intent === 'edit_by_match') {
    const target = hojaTitles.find((h) => h.id === action.node_id);
    const title = target?.title?.trim() || 'la hoja';
    return `Se actualizó "${title}".`;
  }
  return 'Acción aplicada.';
}
