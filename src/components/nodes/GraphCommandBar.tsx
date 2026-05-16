/**
 * @file GraphCommandBar.tsx
 * @description Wave-D (2026-05-16) — compact in-canvas command input
 * for quick graph edits without opening the full chat sidebar.
 *
 * Behaviour:
 *   • Always-on input pinned bottom-center of the canvas.
 *   • Enter submits to the shared `useGraphArchitectChat` hook; the
 *     response lands in the sidebar history in the background.
 *   • Successful 'graph' turn surfaces a toast with a "Ver chat
 *     completo" link that opens the sidebar.
 *   • 'chat' turn (clarification question) auto-opens the sidebar so
 *     the user can see + answer the question.
 *   • Cmd+K focuses the input from anywhere on the canvas.
 *
 * The component owns its own input state but routes side-effects
 * through props so the parent canvas controls the sidebar visibility
 * (only one source of truth for that).
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { useGraphArchitectChat } from '@/hooks/useGraphArchitectChat';
import { cn } from '@/lib/utils';

export interface GraphCommandBarHandle {
  focus: () => void;
}

interface GraphCommandBarProps {
  /** Open the sidebar when the architect needs a clarification, when
   *  the user clicks the toast link, or when the response carries a
   *  long narrative the user might want to read in full. */
  onRequestOpenSidebar: () => void;
}

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

export const GraphCommandBar = forwardRef<
  GraphCommandBarHandle,
  GraphCommandBarProps
>(function GraphCommandBar({ onRequestOpenSidebar }, ref) {
  const { sendMessage, isThinking, error, clearError } = useGraphArchitectChat();
  const [input, setInput] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }),
    [],
  );

  // Auto-dismiss the toast after 4s. Replaced every time a new toast
  // shows up so the latest message always gets the full 4s.
  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [toast]);

  // Surface architect errors as a toast (the sidebar shows them too,
  // but the command bar user might never open the sidebar). Clear the
  // hook's error state once we've shown the toast so it doesn't
  // re-trigger on every render.
  useEffect(() => {
    if (!error) return;
    setToast({ id: Date.now(), kind: 'error', message: error });
    clearError();
  }, [error, clearError]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    const result = await sendMessage(text);
    if (!result) return; // Error path handled by the error effect above.
    if (result.mode === 'graph') {
      setToast({
        id: Date.now(),
        kind: 'success',
        message: 'Graph actualizado.',
      });
    } else {
      // Clarification question — open the sidebar so the user can read
      // and respond. The question is already in the history; the
      // sidebar will scroll to it on open.
      onRequestOpenSidebar();
    }
  }, [input, isThinking, sendMessage, onRequestOpenSidebar]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      } else if (e.key === 'Escape') {
        inputRef.current?.blur();
      }
    },
    [handleSubmit],
  );

  return (
    <>
      {/* ── Toast ──────────────────────────────────────────── */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'fixed left-1/2 -translate-x-1/2 z-40 px-4 py-2.5 rounded-xl shadow-lg backdrop-blur-xl border flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200',
            // Stacked above the command bar (command bar is at bottom: 24px + ~52px height).
            'bottom-[92px]',
            toast.kind === 'success'
              ? 'bg-emerald-50/95 dark:bg-emerald-950/70 border-emerald-200/70 dark:border-emerald-700/40 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50/95 dark:bg-red-950/70 border-red-200/70 dark:border-red-700/40 text-red-700 dark:text-red-200',
          )}
        >
          <p className="text-[12px] font-semibold whitespace-nowrap">{toast.message}</p>
          {toast.kind === 'success' && (
            <button
              type="button"
              onClick={() => {
                setToast(null);
                onRequestOpenSidebar();
              }}
              className="text-[11px] font-semibold underline underline-offset-2 text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100"
            >
              Ver chat completo
            </button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Descartar"
            className="opacity-60 hover:opacity-100"
          >
            <X className="w-3 h-3" aria-hidden />
          </button>
        </div>
      )}

      {/* ── Bar ────────────────────────────────────────────── */}
      <div
        className="shifty-graph-command-bar"
        // Stop wheel + pointer events from reaching ReactFlow so
        // scrolling the document while focused on the input doesn't
        // zoom the canvas.
        onWheelCapture={(e) => e.stopPropagation()}
      >
        <div
          className={cn(
            'rounded-2xl border bg-white/95 dark:bg-[#0e1118]/95 backdrop-blur-xl shadow-xl transition-colors',
            'border-black/10 dark:border-white/10',
            'focus-within:border-[#1534dc]/45 focus-within:ring-2 focus-within:ring-[#1534dc]/15 dark:focus-within:border-[#8b5cf6]/45 dark:focus-within:ring-[#8b5cf6]/20',
            'flex items-center gap-2 px-3 py-2',
          )}
        >
          <Sparkles
            className="w-3.5 h-3.5 text-[#1534dc] dark:text-[#8b5cf6] shrink-0"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="agregá un step de revisión / borrá el último / cambiá Catalina por Diego…"
            disabled={isThinking}
            aria-label="Comando rápido para el grafo"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] leading-relaxed text-[#0e1745] dark:text-white placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none disabled:opacity-60"
          />
          <kbd
            className="hidden sm:inline-flex shrink-0 px-1.5 py-0.5 rounded text-[9.5px] font-mono font-semibold text-[#0e1745]/45 dark:text-white/40 bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10"
            aria-hidden
          >
            ⌘K
          </kbd>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isThinking || !input.trim()}
            aria-label="Enviar comando"
            className={cn(
              'shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg text-white transition-colors disabled:opacity-40',
              'bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2]',
            )}
          >
            {isThinking ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowRight className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
    </>
  );
});
