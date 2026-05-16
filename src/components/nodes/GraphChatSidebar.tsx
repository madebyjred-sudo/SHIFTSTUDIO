/**
 * @file GraphChatSidebar.tsx
 * @description Wave-D (2026-05-16) — collapsible right-side chat panel
 * for the modo-nodos canvas. The user converses with Shifty to build
 * and edit the DAG; assistant turns either apply a new graph (with the
 * animated diff handled by the V2 store) or surface a clarification
 * question.
 *
 * Visual language mirrors `workspace/ChatPanel.tsx` so the two chat
 * surfaces feel like one product — no new colours or radii, just the
 * existing `--color-shift-primary` / `#1534dc` / `#8b5cf6` accents.
 *
 * Layout:
 *   • Header — Shifty avatar, title, reset (trash) + close buttons.
 *   • Body — scroll list of user / assistant bubbles, action-style
 *     pill for "Generé N nodos" with a Re-aplicar shortcut.
 *   • Footer — TextareaAutosize input + send button.
 *
 * The sidebar is rendered absolute-positioned inside the canvas's
 * relative container (see `ShiftyNodeCanvas.tsx`); the `data-state`
 * attribute on the wrapper drives the slide-in/out transition defined
 * in `index.css`.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ArrowUp,
  Loader2,
  Sparkles,
  Trash2,
  X,
  RotateCw,
  GitBranch,
} from 'lucide-react';
import TextareaAutosize from 'react-textarea-autosize';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils';
import {
  useGraphArchitectChat,
  type ArchitectMessage,
} from '@/hooks/useGraphArchitectChat';

interface GraphChatSidebarProps {
  open: boolean;
  onClose: () => void;
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
    'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'ins',
    'span', 'div',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'svg'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
};

function renderMarkdown(md: string): string {
  try {
    const out = marked.parse(md, { async: false, breaks: true, gfm: true });
    const html = typeof out === 'string' ? out : '';
    return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
  } catch {
    return DOMPurify.sanitize(md, PURIFY_CONFIG) as unknown as string;
  }
}

export function GraphChatSidebar({ open, onClose }: GraphChatSidebarProps) {
  const {
    messages,
    isThinking,
    error,
    sendMessage,
    resetHistory,
    reapplyGraph,
    clearError,
  } = useGraphArchitectChat();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new messages or thinking state.
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open, messages.length, isThinking]);

  // ESC closes the panel. Mounted only while open so the listener
  // doesn't leak across remounts.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't steal Escape from input editing — only react when the
        // focus is outside an editable.
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendMessage(text);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleReset = useCallback(() => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        '¿Borrar la conversación con Shifty? El grafo en el canvas se conserva.',
      );
      if (!ok) return;
    }
    resetHistory();
  }, [resetHistory]);

  return (
    <aside
      className="shifty-graph-sidebar bg-white/95 dark:bg-[#0e1118]/95 border-l border-black/8 dark:border-white/8 shadow-2xl backdrop-blur-xl"
      data-state={open ? 'open' : 'closed'}
      data-testid="graph-chat-sidebar"
      aria-label="Chat con Shifty para construir el grafo"
      aria-hidden={!open}
    >
      {/* ── Header ───────────────────────────────────────── */}
      <header className="px-4 pt-4 pb-3 border-b border-black/8 dark:border-white/8 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-[#1534dc]/12 dark:bg-[#8b5cf6]/20 flex items-center justify-center shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-[#1534dc] dark:text-[#8b5cf6]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
            Shifty
          </p>
          <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 truncate">
            Construí y editá el grafo conversando
          </p>
        </div>
        <button
          type="button"
          onClick={handleReset}
          disabled={messages.length === 0}
          aria-label="Limpiar conversación"
          title="Limpiar conversación"
          className={cn(
            'shrink-0 inline-flex items-center justify-center p-1.5 rounded-md transition-colors',
            'text-[#0e1745]/55 hover:text-red-600 hover:bg-red-50/70',
            'dark:text-white/55 dark:hover:text-red-300 dark:hover:bg-red-950/30',
            'disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#0e1745]/55',
            'dark:disabled:hover:text-white/55',
          )}
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel"
          title="Cerrar"
          className="shrink-0 inline-flex items-center justify-center p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      </header>

      {/* ── Messages ───────────────────────────────────────── */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3 [scrollbar-width:thin] [scrollbar-color:rgba(0,0,0,0.18)_transparent] dark:[scrollbar-color:rgba(255,255,255,0.18)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/15 [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {messages.length === 0 && !isThinking && !error && <EmptyState />}

        {messages.map((m) => (
          <ArchitectBubble key={m.id} message={m} onReapply={reapplyGraph} />
        ))}

        {isThinking && <ThinkingBubble />}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-300/40 dark:border-red-500/30 bg-red-50/80 dark:bg-red-950/30 px-3 py-2.5 flex items-start justify-between gap-2 animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            <p className="text-[12px] text-red-600 dark:text-red-300 leading-snug">
              {error}
            </p>
            <button
              type="button"
              onClick={clearError}
              aria-label="Descartar error"
              className="text-red-600 dark:text-red-300 hover:text-red-700 dark:hover:text-red-200 shrink-0"
            >
              <span className="text-[14px] leading-none" aria-hidden>×</span>
            </button>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* ── Footer / input ────────────────────────────────── */}
      <div className="px-3 pb-3 pt-2 border-t border-black/8 dark:border-white/8">
        <div
          className={cn(
            'rounded-2xl border bg-white/85 dark:bg-white/[0.04] backdrop-blur-xl transition-colors',
            'border-black/10 dark:border-white/10',
            'focus-within:border-[#1534dc]/45 focus-within:ring-2 focus-within:ring-[#1534dc]/15 dark:focus-within:border-[#8b5cf6]/45 dark:focus-within:ring-[#8b5cf6]/20',
          )}
        >
          <TextareaAutosize
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Pedile a Shifty que construya o edite el grafo…"
            minRows={2}
            maxRows={6}
            disabled={isThinking}
            autoFocus={open}
            aria-label="Mensaje al architect del grafo"
            data-testid="graph-chat-input"
            className="w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] leading-relaxed text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <p className="text-[10.5px] text-[#0e1745]/35 dark:text-white/30 select-none">
              Cmd/Ctrl + Enter para enviar
            </p>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={isThinking}
              aria-label="Enviar mensaje"
              data-testid="graph-chat-send"
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-[12px] font-semibold transition-colors disabled:opacity-40',
                'bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2]',
              )}
            >
              <ArrowUp className="w-3.5 h-3.5" />
              Enviar
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-10 h-10 rounded-2xl bg-[#1534dc]/10 dark:bg-[#8b5cf6]/15 flex items-center justify-center mb-3">
        <GitBranch className="w-5 h-5 text-[#1534dc]/70 dark:text-[#8b5cf6]/85" aria-hidden />
      </div>
      <p className="text-[12px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed max-w-[260px]">
        Pedile a Shifty que construya un flujo. Ej:{' '}
        <span className="italic text-[#0e1745]/80 dark:text-white/75">
          "Brief para Garnier sobre el nuevo champú"
        </span>
        .
      </p>
    </div>
  );
}

const ArchitectBubble = memo(
  function ArchitectBubble({
    message,
    onReapply,
  }: {
    message: ArchitectMessage;
    onReapply: (id: string) => void;
  }) {
    const isUser = message.role === 'user';
    const html = useMemo(
      () => (isUser ? '' : renderMarkdown(message.content)),
      [message.content, isUser],
    );

    if (isUser) {
      return (
        <div
          data-testid="graph-chat-message-user"
          className="flex justify-end animate-in fade-in slide-in-from-bottom-1 duration-200"
        >
          <div className="rounded-2xl px-4 py-3 max-w-[88%] text-[13px] leading-relaxed bg-[#1534dc] dark:bg-[#8b5cf6] text-white ml-auto shadow-sm shadow-[#1534dc]/20 dark:shadow-[#8b5cf6]/20">
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      );
    }

    const isGraphTurn = message.mode === 'graph';

    return (
      <div
        data-testid="graph-chat-message-assistant"
        className="flex flex-col items-start gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-200"
      >
        <div className="rounded-2xl px-4 py-3 max-w-[88%] text-[13px] leading-relaxed bg-white/85 dark:bg-white/[0.06] text-[#0e1745] dark:text-white border border-black/5 dark:border-white/10">
          <div
            className="hoja-prose chat-md max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        {isGraphTurn && message.graphSnapshot && (
          <button
            type="button"
            onClick={() => onReapply(message.id)}
            className="ml-1 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold text-[#1534dc] dark:text-[#a892ee] bg-[#1534dc]/8 dark:bg-[#8b5cf6]/15 border border-[#1534dc]/15 dark:border-[#8b5cf6]/25 hover:bg-[#1534dc]/12 dark:hover:bg-[#8b5cf6]/20 transition-colors"
            title="Volver a aplicar este grafo al canvas"
          >
            <RotateCw className="w-3 h-3" aria-hidden />
            Re-aplicar
          </button>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.mode === next.message.mode,
);

function ThinkingBubble() {
  return (
    <div className="flex justify-start animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="rounded-2xl px-4 py-3 max-w-[88%] bg-white/85 dark:bg-white/[0.06] border border-black/5 dark:border-white/10">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 text-[#1534dc] dark:text-[#8b5cf6] animate-spin" aria-hidden />
          <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
            Shifty está pensando…
          </span>
        </span>
      </div>
    </div>
  );
}
