/**
 * @file PptxResultModal.tsx
 * @description Surfaces a generated Gamma deck without auto-downloading.
 *
 * UX rationale:
 *   Auto-clicking an <a> after a 30-60s async block is treated as a popup
 *   (the user's click context is gone) and silently blocked by Chrome /
 *   Safari. So we show the deck as two explicit, hand-on-the-button CTAs:
 *
 *     1. "Abrir en Gamma"  → opens the editable deck in a new tab
 *     2. "Descargar .pptx" → triggers the download (preserving click context)
 *
 *   Plus:
 *     • Cached indicator and "generated X ago" footer.
 *     • "Generar de nuevo" link → calls onRegenerate (parent re-opens the
 *       options modal pre-filled with the previous values).
 *
 * ──────────────────────────────────────────────────────────────────────
 * Phase 3.F — Vercel-safe polling
 * ──────────────────────────────────────────────────────────────────────
 * The server can no longer block until Gamma finishes (Vercel 60s cap).
 * The modal now accepts EITHER:
 *   • a finished `result`         (cache hit, legacy compat)
 *   • a `generationId`            (poll until complete)
 *
 * In polling mode the modal owns the AbortController, polls every 5s,
 * shows an elapsed timer ("Generando deck… 23s"), and renders the
 * result UI when the deck completes. Cancel aborts the poll.
 *
 * Adapted (concept + copy) from CL2's
 *   /Users/juan/Downloads/shift-cl2/apps/web/src/components/workspace/PptxResultModal.tsx
 *
 * Drops CL2 burgundy class tokens; uses Studio's literal #1534dc / #8b5cf6
 * accents.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  Clock,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  pollPptxStatus,
  type PptxExportResult,
} from '@/services/workspaceApi';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Cache-hit result (already complete). Mutually exclusive with
   * `generationId`. When set, the modal renders the result UI directly
   * with no polling.
   */
  result: PptxExportResult | null;
  /**
   * Pending generation kicked off by PptxOptionsModal. When set, the
   * modal polls /:id/export/pptx-status until completion or failure.
   * Pass `null` (or omit) when there's nothing to poll.
   */
  generationId?: string | null;
  /** Required when `generationId` is set — used in the polling URL. */
  workspaceId?: string;
  /** Optional placeholder filename shown in the polling header. */
  filename?: string;
  /** Re-opens PptxOptionsModal with the previous values pre-filled. */
  onRegenerate: () => void;
  workspaceTitle?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatGeneratedAgo(generatedAt: string | undefined, now: number): string | null {
  if (!generatedAt) return null;
  const ms = now - new Date(generatedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return 'hace un momento';
  if (min === 1) return 'hace 1 minuto';
  if (min < 60) return `hace ${min} minutos`;
  const hr = Math.round(min / 60);
  if (hr === 1) return 'hace 1 hora';
  if (hr < 24) return `hace ${hr} horas`;
  const days = Math.round(hr / 24);
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

// ─── Component ────────────────────────────────────────────────────────

export function PptxResultModal({
  open,
  onClose,
  result,
  generationId,
  workspaceId,
  filename,
  onRegenerate,
  workspaceTitle,
}: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  // Tick once a minute so "hace X minutos" stays fresh while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // ── Poll state ──────────────────────────────────────────────────────
  // The modal accepts either a completed `result` or a pending
  // `generationId`. When we poll, the resolved result lives here.
  const [pollResult, setPollResult] = useState<PptxExportResult | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const polling = Boolean(generationId) && !pollResult && !pollError && !result;

  // Whichever path resolved last is the "live" result the body renders.
  const liveResult = result ?? pollResult;

  // Reset poll state every time a new generationId comes in (or modal opens).
  useEffect(() => {
    if (!open) return;
    setPollResult(null);
    setPollError(null);
    setElapsedMs(0);
  }, [open, generationId]);

  // Poll the status endpoint until complete/failed/timeout/abort.
  useEffect(() => {
    // Only poll when we have a generationId, no result yet, and the
    // modal is open. Same workspaceId guard — without it we can't form
    // the polling URL.
    if (!open) return;
    if (!generationId || !workspaceId) return;
    if (result) return; // cache-hit short-circuit

    const ac = new AbortController();
    pollAbortRef.current?.abort();
    pollAbortRef.current = ac;

    pollPptxStatus(workspaceId, generationId, {
      signal: ac.signal,
      onProgress: (ms) => setElapsedMs(ms),
    })
      .then((r) => {
        if (ac.signal.aborted) return;
        setPollResult(r);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // Map common failure modes to user-readable copy.
        const e = err as Error;
        if (e.name === 'AbortError') return;
        if (e.message === 'pptx_poll_timeout') {
          setPollError(
            'La generación tomó más de 5 minutos. Probá generar de nuevo o revisá tu cuenta de Gamma.',
          );
          return;
        }
        setPollError(e.message || 'No se pudo generar la presentación.');
      });

    return () => {
      ac.abort();
      if (pollAbortRef.current === ac) pollAbortRef.current = null;
    };
  }, [open, generationId, workspaceId, result]);

  // ── Autofocus + restore on close ────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    const t = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // ── Esc closes ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // handleClose is stable enough — it only references refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Aborts any in-flight poll before closing.
  const handleClose = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    onClose();
  }, [onClose]);

  const handleBackdropClick = useCallback(() => handleClose(), [handleClose]);

  // Cancel polling but keep the modal open (lets the user click "Generar
  // de nuevo" or close on their own terms).
  const handleCancelPoll = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setPollError('Generación cancelada.');
  }, []);

  // Don't render the modal at all when there's nothing to show.
  // (open=true but no result/generationId/error means parent is in a
  // weird state; bail safely.)
  if (!open) return null;
  if (!liveResult && !generationId && !pollError) return null;

  const generatedAgo = liveResult ? formatGeneratedAgo(liveResult.generatedAt, now) : null;
  const headerSubtitle = workspaceTitle ?? liveResult?.filename ?? filename ?? '';

  const node = (
    <AnimatePresence>
      <motion.div
        key="pptx-result-bd"
        role="presentation"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={handleBackdropClick}
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      >
        <motion.div
          key="pptx-result-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pptx-result-title"
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
                <div id="pptx-result-title" className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
                  {liveResult
                    ? 'Presentación lista'
                    : pollError
                    ? 'No pudimos generar el deck'
                    : 'Generando presentación…'}
                </div>
                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 truncate">
                  {headerSubtitle}
                </div>
              </div>
            </div>
            <button
              type="button"
              ref={closeButtonRef}
              onClick={handleClose}
              aria-label="Cerrar modal"
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/60 dark:text-white/60"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Body ─────────────────────────────────────────────── */}
          <div className="px-5 py-5 space-y-3.5">
            {/* ── Polling state ─────────────────────────────────── */}
            {polling && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-3 px-4 py-4 rounded-2xl bg-[#1534dc]/8 dark:bg-[#8b5cf6]/10 border border-[#1534dc]/15 dark:border-[#8b5cf6]/20"
              >
                <Loader2 className="w-5 h-5 text-[#1534dc] dark:text-[#8b5cf6] animate-spin flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                    Generando deck…&nbsp;
                    <span className="text-[#1534dc] dark:text-[#8b5cf6] tabular-nums">
                      {formatElapsed(elapsedMs)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 mt-0.5">
                    Gamma diseña y exporta. Suele tomar 1–3 minutos.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelPoll}
                  aria-label="Cancelar generación"
                  className="text-[11px] font-medium text-[#0e1745]/60 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors flex-shrink-0"
                >
                  Cancelar
                </button>
              </div>
            )}

            {/* ── Failure state ─────────────────────────────────── */}
            {pollError && !liveResult && (
              <div
                role="alert"
                className="flex items-start gap-3 px-4 py-3.5 rounded-2xl bg-rose-50 dark:bg-rose-900/15 border border-rose-300/40 dark:border-rose-500/30"
              >
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium text-rose-700 dark:text-rose-200">
                    {pollError}
                  </div>
                  <button
                    type="button"
                    onClick={onRegenerate}
                    className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-rose-700 dark:text-rose-300 hover:opacity-80 transition-opacity"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Reintentar
                  </button>
                </div>
              </div>
            )}

            {/* ── Result state — Gamma + download CTAs ─────────── */}
            {liveResult && (
              <>
                {/* Primary CTA — open in Gamma (editable, shareable) */}
                <a
                  href={liveResult.gammaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Abrir presentación en Gamma en una pestaña nueva"
                  className="block group rounded-2xl border border-black/8 dark:border-white/10 hover:border-[#1534dc]/40 dark:hover:border-[#8b5cf6]/40 hover:shadow-[0_8px_25px_rgba(21,52,220,0.10)] dark:hover:shadow-[0_8px_25px_rgba(139,92,246,0.18)] bg-gradient-to-br from-[#1534dc]/5 to-transparent dark:from-[#8b5cf6]/12 dark:to-transparent p-4 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                        Abrir en Gamma
                      </div>
                      <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">
                        Editá, compartí o exportá desde gamma.app
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-[#1534dc] dark:text-[#8b5cf6] flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </a>

                {/* Secondary — direct .pptx download */}
                <a
                  href={liveResult.exportUrl}
                  download={liveResult.filename}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Descargar ${liveResult.filename}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-black/[0.03] dark:bg-white/5 hover:bg-black/[0.06] dark:hover:bg-white/8 transition-colors border border-black/5 dark:border-white/8"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Download className="w-4 h-4 text-[#0e1745]/60 dark:text-white/60 flex-shrink-0" />
                    <span className="text-[12.5px] text-[#0e1745]/85 dark:text-white/85 font-medium truncate">
                      Descargar {liveResult.filename}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#0e1745]/40 dark:text-white/40 flex-shrink-0">.pptx</span>
                </a>

                {/* Footer row — freshness + regenerate */}
                <div className="pt-2 flex items-center justify-between text-[11px] gap-3">
                  <div className="flex items-center gap-1.5 text-[#0e1745]/55 dark:text-white/55 min-w-0">
                    <Clock className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">
                      {liveResult.cached
                        ? `Generado ${generatedAgo ?? 'hace un momento'} (en caché)`
                        : `Generado ${generatedAgo ?? 'hace un momento'}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={onRegenerate}
                    aria-label="Volver a generar la presentación"
                    className="flex items-center gap-1 text-[#1534dc] dark:text-[#8b5cf6] hover:opacity-80 transition-opacity flex-shrink-0 font-medium"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Generar de nuevo
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── Footer ───────────────────────────────────────────── */}
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-black/5 dark:border-white/10 bg-black/[0.015] dark:bg-white/[0.02]">
            <button
              type="button"
              onClick={handleClose}
              aria-label="Cerrar"
              className="px-3 py-2 rounded-xl text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 transition-colors"
            >
              Cerrar
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(node, document.body);
}
