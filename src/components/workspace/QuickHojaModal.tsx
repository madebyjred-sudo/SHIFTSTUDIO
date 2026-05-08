/**
 * @file QuickHojaModal.tsx
 * @description Modal that replaces the inline architect prompt panel.
 *
 * Two agents in one surface:
 *   • Lexa  — single-hoja quick capture (1 hoja, ~5-8 word title + body)
 *   • Atlas — multi-hoja architect (3-7 related hojas in one canvas pass)
 *
 * Both routes hit `runArchitect()` so the parent only needs to handle a
 * single `onCreated(nodes)` callback. The Lexa flow injects a hint into
 * the prompt asking the architect to return ONE hoja; the Atlas flow lets
 * the architect choose its own count.
 *
 * Adapted (concept + flow) from CL2's
 *   /Users/juan/Downloads/shift-cl2/apps/web/src/components/hoja/LexaQuickHojaModal.tsx
 *
 * Drops CL2-specific copy (expediente / SIL / fracciones / Hacendarios).
 * Uses Studio's indigo + violet (light/dark) and burgundy literals — no
 * cl2-burgundy classes.
 *
 * Visual contract:
 *   • Portal-rendered into document.body, z-50.
 *   • Backdrop: bg-black/50 + backdrop-blur-sm.
 *   • Card:    bg-white dark:bg-[#0c1230], rounded-3xl, shadow-2xl.
 *   • Anim:    fade + scale via motion/react.
 *   • Esc closes (unless loading); click-outside closes (unless loading).
 *   • Focus trap: textarea autofocus on open, restored to opener on close.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Sparkles, X, Wand2, Layers } from 'lucide-react';
import { runArchitect, type WorkspaceNode } from '@/services/workspaceApi';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────

type AgentId = 'lexa' | 'atlas';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Receives the freshly-materialised server nodes. Parent inserts them. */
  onCreated: (nodes: WorkspaceNode[]) => void;
}

const MAX_LEN = 500;

// ─── Component ────────────────────────────────────────────────────────

export function QuickHojaModal({ open, onClose, workspaceId, onCreated }: Props) {
  const [agent, setAgent] = useState<AgentId>('lexa');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Reset on open + autofocus + restore focus on close ──────────────
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    setPrompt('');
    setError(null);
    setLoading(false);
    setAgent('lexa');
    const t = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      // Restore focus when modal closes
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // ── Esc to close (when not loading) ─────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, loading]);

  // ── Cleanup pending request on unmount ──────────────────────────────
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── Submit ──────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || loading) return;
    setLoading(true);
    setError(null);

    // Build a hint for Lexa to keep the response to a single hoja.
    // For Atlas we just forward the prompt — the architect picks 3-7.
    const finalPrompt = agent === 'lexa'
      ? `[modo rápido — devolvé exactamente UNA hoja, no más] ${p}`
      : p;

    // Track an AbortController so cleanup or close-mid-flight cancels.
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    try {
      const { nodes } = await runArchitect(workspaceId, finalPrompt);
      if (ac.signal.aborted) return;
      // Lexa hint sometimes returns >1 hoja anyway; if user picked Lexa,
      // trim to the first node so the contract holds.
      const out = agent === 'lexa' && nodes.length > 1 ? [nodes[0]] : nodes;
      onCreated(out);
      onClose();
    } catch (err) {
      if (ac.signal.aborted) return;
      setError((err as Error).message);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setLoading(false);
    }
  }, [prompt, loading, agent, workspaceId, onCreated, onClose]);

  // ── Backdrop click closes (when not loading) ────────────────────────
  const handleBackdropClick = useCallback(() => {
    if (loading) return;
    onClose();
  }, [loading, onClose]);

  if (!open) return null;

  const submitLabel =
    loading
      ? agent === 'lexa' ? 'Lexa está pensando…' : 'Atlas está armando…'
      : agent === 'lexa' ? 'Crear hoja' : 'Generar hojas';

  const placeholder =
    agent === 'lexa'
      ? 'Ej: Una hoja con el resumen ejecutivo de la nueva campaña Q3.'
      : 'Ej: Plan de marca para una fintech LATAM — posicionamiento, audiencia, mensaje, tono, plan de lanzamiento.';

  const charCount = prompt.length;
  const charPct = Math.min(charCount / MAX_LEN, 1);

  const node = (
    <AnimatePresence>
      <motion.div
        key="quick-hoja-bd"
        role="presentation"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={handleBackdropClick}
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      >
        <motion.div
          key="quick-hoja-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="quick-hoja-title"
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'relative w-full max-w-lg mx-4',
            'bg-white dark:bg-[#0c1230]',
            'rounded-3xl shadow-2xl',
            'border border-black/5 dark:border-white/10',
            'overflow-hidden',
          )}
        >
          {/* ── Header ───────────────────────────────────────────── */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-[#1534dc]/10 dark:bg-[#8b5cf6]/15 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-[#1534dc] dark:text-[#8b5cf6]" />
              </div>
              <div className="min-w-0">
                <div id="quick-hoja-title" className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  Nueva hoja con IA
                </div>
                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 truncate">
                  Pedile a Lexa una hoja rápida o a Atlas un set completo.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              aria-label="Cerrar modal"
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/60 dark:text-white/60 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Body ─────────────────────────────────────────────── */}
          <div className="px-5 py-4 space-y-4">
            {/* Agent picker — segmented control */}
            <div
              role="radiogroup"
              aria-label="Elegir agente"
              className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-black/3 dark:bg-white/5 border border-black/5 dark:border-white/8"
            >
              <button
                type="button"
                role="radio"
                aria-checked={agent === 'lexa'}
                aria-label="Agente Lexa — una hoja rápida"
                disabled={loading}
                onClick={() => setAgent('lexa')}
                className={cn(
                  'flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-semibold transition-all',
                  agent === 'lexa'
                    ? 'bg-white dark:bg-[#161e3d] text-[#1534dc] dark:text-[#8b5cf6] shadow-sm border border-black/5 dark:border-white/10'
                    : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                <Wand2 className="w-3.5 h-3.5" />
                Lexa · 1 hoja
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={agent === 'atlas'}
                aria-label="Agente Atlas — múltiples hojas"
                disabled={loading}
                onClick={() => setAgent('atlas')}
                className={cn(
                  'flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-semibold transition-all',
                  agent === 'atlas'
                    ? 'bg-white dark:bg-[#161e3d] text-[#1534dc] dark:text-[#8b5cf6] shadow-sm border border-black/5 dark:border-white/10'
                    : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                <Layers className="w-3.5 h-3.5" />
                Atlas · 3-7 hojas
              </button>
            </div>

            {/* Prompt textarea */}
            <div>
              <label htmlFor="quick-hoja-prompt" className="sr-only">
                Describí la hoja que querés
              </label>
              <textarea
                id="quick-hoja-prompt"
                ref={textareaRef}
                value={prompt}
                onChange={(e) => {
                  const v = e.target.value;
                  setPrompt(v.length > MAX_LEN ? v.slice(0, MAX_LEN) : v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={4}
                maxLength={MAX_LEN}
                disabled={loading}
                placeholder={placeholder}
                aria-label="Descripción de la hoja"
                className="w-full resize-none rounded-2xl bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 px-3.5 py-2.5 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/40 disabled:opacity-60 transition-colors"
              />

              {/* Char counter + hint row */}
              <div className="mt-1.5 flex items-center justify-between text-[10.5px]">
                <span className="text-[#0e1745]/40 dark:text-white/35">
                  ⌘ / Ctrl + Enter para enviar
                </span>
                <span
                  className={cn(
                    'tabular-nums',
                    charPct >= 1
                      ? 'text-rose-500'
                      : charPct >= 0.85
                      ? 'text-amber-500'
                      : 'text-[#0e1745]/40 dark:text-white/35',
                  )}
                >
                  {charCount}/{MAX_LEN}
                </span>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div
                role="alert"
                className="rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-300/40 dark:border-rose-500/30 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300"
              >
                {error}
              </div>
            )}
          </div>

          {/* ── Footer ───────────────────────────────────────────── */}
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-black/5 dark:border-white/10 bg-black/[0.015] dark:bg-white/[0.02]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              aria-label="Cancelar y cerrar"
              className="px-3 py-2 rounded-xl text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!prompt.trim() || loading}
              aria-label={submitLabel}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12.5px] font-semibold transition-colors',
                'bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2]',
                'text-white shadow-sm shadow-[#1534dc]/25 dark:shadow-[#8b5cf6]/25',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {submitLabel}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(node, document.body);
}
