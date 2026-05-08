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
 * Adapted (concept + copy) from CL2's
 *   /Users/juan/Downloads/shift-cl2/apps/web/src/components/workspace/PptxResultModal.tsx
 *
 * Drops CL2 burgundy class tokens; uses Studio's literal #1534dc / #8b5cf6
 * accents.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, Download, ExternalLink, RefreshCw, Sparkles, X } from 'lucide-react';
import type { PptxExportResult } from '@/services/workspaceApi';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  result: PptxExportResult | null;
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

// ─── Component ────────────────────────────────────────────────────────

export function PptxResultModal({ open, onClose, result, onRegenerate, workspaceTitle }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Tick once a minute so "hace X minutos" stays fresh while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open]);

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
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleBackdropClick = useCallback(() => onClose(), [onClose]);

  if (!open || !result) return null;

  const generatedAgo = formatGeneratedAgo(result.generatedAt, now);

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
                  Presentación lista
                </div>
                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 truncate">
                  {workspaceTitle ?? result.filename}
                </div>
              </div>
            </div>
            <button
              type="button"
              ref={closeButtonRef}
              onClick={onClose}
              aria-label="Cerrar modal"
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/60 dark:text-white/60"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Body ─────────────────────────────────────────────── */}
          <div className="px-5 py-5 space-y-3.5">
            {/* Primary CTA — open in Gamma (editable, shareable) */}
            <a
              href={result.gammaUrl}
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
              href={result.exportUrl}
              download={result.filename}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Descargar ${result.filename}`}
              className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-black/[0.03] dark:bg-white/5 hover:bg-black/[0.06] dark:hover:bg-white/8 transition-colors border border-black/5 dark:border-white/8"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Download className="w-4 h-4 text-[#0e1745]/60 dark:text-white/60 flex-shrink-0" />
                <span className="text-[12.5px] text-[#0e1745]/85 dark:text-white/85 font-medium truncate">
                  Descargar {result.filename}
                </span>
              </div>
              <span className="text-[10px] text-[#0e1745]/40 dark:text-white/40 flex-shrink-0">.pptx</span>
            </a>

            {/* Footer row — freshness + regenerate */}
            <div className="pt-2 flex items-center justify-between text-[11px] gap-3">
              <div className="flex items-center gap-1.5 text-[#0e1745]/55 dark:text-white/55 min-w-0">
                <Clock className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">
                  {result.cached
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
          </div>

          {/* ── Footer ───────────────────────────────────────────── */}
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-black/5 dark:border-white/10 bg-black/[0.015] dark:bg-white/[0.02]">
            <button
              type="button"
              onClick={onClose}
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
