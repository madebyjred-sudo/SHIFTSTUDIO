/**
 * @file PptxOptionsModal.tsx
 * @description Pre-generation form for the workspace → Gamma deck export.
 *
 * Why this exists: a generic deck is fine, but most users want to tell
 * Gamma WHO it's for, WHAT it argues, and HOW to sound. Capturing that
 * up-front beats pushing it into the result modal after a 60s wait.
 *
 * Fields are deliberately sparse — every extra one raises abandon rate:
 *   • tono       — register
 *   • audiencia  — who reads it
 *   • proposito  — what argument the deck makes
 *   • marca      — brand voice / visual notes
 *   • emojis     — toggle (off by default)
 *
 * The modal owns the actual `exportWorkspace('pptx', …)` call so the
 * progress UI lives next to the form. Parent gets `(opts, result)` on
 * success and can:
 *   1. Cache `opts` for next time (pre-fill).
 *   2. Open `PptxResultModal` with the result.
 *
 * Adapted (concept + form fields) from CL2's
 *   /Users/juan/Downloads/shift-cl2/apps/web/src/components/workspace/PptxOptionsModal.tsx
 *
 * Drops CL2-specific copy: "legislativo", "fracción", "Hacendarios",
 * "dictamen minoritario", "Plan Nacional 2024". Everything is
 * neutral creative-strategic, Latin-American Spanish.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Sparkles, X } from 'lucide-react';
import {
  exportWorkspace,
  type PptxOptions,
  type PptxExportResult,
} from '@/services/workspaceApi';
import { cn } from '@/lib/utils';

// ─── Submit payload ───────────────────────────────────────────────────
//
// Phase 3.F split flow: the modal no longer waits for the full deck
// before closing. It hands the parent either:
//   - `{ status: 'pending', generationId, filename }` → parent shows
//     PptxResultModal in polling state, modal closes immediately.
//   - `{ status: 'complete', result }`               → cache hit, no
//     polling needed; parent renders the result modal as before.
export type PptxOptionsSubmit =
  | { status: 'pending'; generationId: string; filename: string }
  | { status: 'complete'; result: PptxExportResult };

// ─── Tono presets ─────────────────────────────────────────────────────

const TONOS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Por defecto (equilibrado)' },
  { value: 'ejecutivo, conciso', label: 'Ejecutivo' },
  { value: 'didáctico, accesible', label: 'Didáctico' },
  { value: 'persuasivo, argumentativo', label: 'Persuasivo' },
  { value: 'técnico, denso', label: 'Técnico' },
  { value: 'narrativo, periodístico', label: 'Narrativo' },
];

// ─── Types ────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceTitle?: string;
  /** Pre-fill from cached options (e.g. a previous submission). */
  initial?: PptxOptions;
  /**
   * Fired when the request to start the generation succeeds. Parent
   * caches opts + opens the result modal in either polling or
   * cache-hit state. Modal closes itself after this returns.
   */
  onSubmit: (opts: PptxOptions, submit: PptxOptionsSubmit) => void;
}

// ─── Component ────────────────────────────────────────────────────────

export function PptxOptionsModal({
  open, onClose, workspaceId, workspaceTitle, initial, onSubmit,
}: Props) {
  const [tono, setTono] = useState(initial?.tono ?? '');
  const [audiencia, setAudiencia] = useState(initial?.audiencia ?? '');
  const [proposito, setProposito] = useState(initial?.proposito ?? '');
  const [marca, setMarca] = useState(initial?.marca ?? '');
  const [emojis, setEmojis] = useState<boolean>(Boolean(initial?.emojis));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Reset + autofocus on open ───────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    setTono(initial?.tono ?? '');
    setAudiencia(initial?.audiencia ?? '');
    setProposito(initial?.proposito ?? '');
    setMarca(initial?.marca ?? '');
    setEmojis(Boolean(initial?.emojis));
    setError(null);
    setLoading(false);
    const t = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open, initial]);

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

  // ── Cleanup on unmount ──────────────────────────────────────────────
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── Submit ──────────────────────────────────────────────────────────
  const submit = useCallback(async (useDefaults: boolean) => {
    if (loading) return;

    const opts: PptxOptions = useDefaults
      ? {}
      : {
        tono: tono || undefined,
        audiencia: audiencia.trim() || undefined,
        proposito: proposito.trim() || undefined,
        marca: marca.trim() || undefined,
        emojis,
      };

    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    setLoading(true);
    setError(null);

    try {
      // Phase 3.F: this returns FAST. Either status='pending' (Gamma
      // started, frontend polls) or status='complete' (cache hit). No
      // multi-minute server-side block — that always 504'd on Vercel.
      const start = await exportWorkspace(workspaceId, 'pptx', {
        workspaceTitle,
        options: opts,
      });
      if (ac.signal.aborted) return;
      if (start.status === 'pending') {
        onSubmit(opts, {
          status: 'pending',
          generationId: start.generationId,
          filename: start.filename,
        });
      } else {
        onSubmit(opts, { status: 'complete', result: start.result });
      }
      onClose();
    } catch (err) {
      if (ac.signal.aborted) return;
      setError((err as Error).message ?? 'No se pudo generar la presentación.');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setLoading(false);
    }
  }, [loading, tono, audiencia, proposito, marca, emojis, workspaceId, workspaceTitle, onSubmit, onClose]);

  // ── User-cancellable abort during long generation ───────────────────
  const handleCancelGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError('Generación cancelada.');
  }, []);

  // ── Backdrop click — close only when not loading ────────────────────
  const handleBackdropClick = useCallback(() => {
    if (loading) return;
    onClose();
  }, [loading, onClose]);

  if (!open) return null;

  const node = (
    <AnimatePresence>
      <motion.div
        key="pptx-opts-bd"
        role="presentation"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={handleBackdropClick}
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      >
        <motion.div
          key="pptx-opts-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pptx-opts-title"
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
                <div id="pptx-opts-title" className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  Antes de generar la presentación
                </div>
                {workspaceTitle && (
                  <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 truncate">
                    {workspaceTitle}
                  </div>
                )}
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
          <div className="px-5 py-5 space-y-4 max-h-[68vh] overflow-y-auto">
            <p className="text-[12px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed">
              Decile a Gamma cómo querés que suene la presentación. Todo es opcional —
              si saltás esto, va con el preset equilibrado.
            </p>

            {/* Tono */}
            <div>
              <label htmlFor="pptx-tono" className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
                Tono
              </label>
              <select
                id="pptx-tono"
                ref={firstFieldRef}
                value={tono}
                onChange={(e) => setTono(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 rounded-xl bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/40 disabled:opacity-60"
              >
                {TONOS.map((t) => (
                  <option key={t.value} value={t.value} className="bg-white dark:bg-[#0c1230]">
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Audiencia */}
            <div>
              <label htmlFor="pptx-audiencia" className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
                Audiencia
                <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— para quién es</span>
              </label>
              <input
                id="pptx-audiencia"
                value={audiencia}
                onChange={(e) => setAudiencia(e.target.value)}
                disabled={loading}
                placeholder="Ej: Equipo de marketing · stakeholders ejecutivos · inversionistas"
                className="w-full px-3 py-2 rounded-xl bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/40 disabled:opacity-60"
              />
            </div>

            {/* Propósito */}
            <div>
              <label htmlFor="pptx-proposito" className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
                Propósito
                <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— qué argumenta o muestra</span>
              </label>
              <textarea
                id="pptx-proposito"
                value={proposito}
                onChange={(e) => setProposito(e.target.value)}
                disabled={loading}
                placeholder="Ej: Presentar el plan de lanzamiento Q3 · alinear al equipo en la nueva propuesta de valor · pitch para inversionistas serie A"
                rows={3}
                className="w-full px-3 py-2 rounded-xl bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/40 disabled:opacity-60"
              />
            </div>

            {/* Marca */}
            <div>
              <label htmlFor="pptx-marca" className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
                Lineamientos de marca
                <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— voz, paleta, do/don't</span>
              </label>
              <textarea
                id="pptx-marca"
                value={marca}
                onChange={(e) => setMarca(e.target.value)}
                disabled={loading}
                placeholder="Ej: voz cálida y directa · paleta sobria con un acento violeta · evitar jerga técnica · sin humor"
                rows={3}
                className="w-full px-3 py-2 rounded-xl bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/40 disabled:opacity-60"
              />
              <p className="mt-1 text-[10.5px] text-[#0e1745]/40 dark:text-white/35 leading-relaxed">
                Gamma no soporta inyección directa de logos vía API — descargá el .pptx y pegalo en la
                plantilla, o editá el deck en gamma.app después.
              </p>
            </div>

            {/* Emojis toggle */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={emojis}
                onChange={(e) => setEmojis(e.target.checked)}
                disabled={loading}
                className="w-3.5 h-3.5 accent-[#1534dc] dark:accent-[#8b5cf6] disabled:opacity-50"
              />
              <span className="text-[12px] text-[#0e1745]/70 dark:text-white/65">
                Permitir emojis e iconos en las slides
              </span>
            </label>

            {/* Loading state */}
            {loading && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-[#1534dc]/8 dark:bg-[#8b5cf6]/10 border border-[#1534dc]/15 dark:border-[#8b5cf6]/20"
              >
                <Loader2 className="w-4 h-4 text-[#1534dc] dark:text-[#8b5cf6] animate-spin" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[#0e1745] dark:text-white">
                    Encolando presentación…
                  </div>
                  <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/50">
                    Iniciando deck en Gamma · seguís el progreso en la siguiente ventana
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelGeneration}
                  aria-label="Cancelar generación"
                  className="text-[11px] font-medium text-[#0e1745]/60 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            )}

            {/* Error banner */}
            {error && !loading && (
              <div
                role="alert"
                className="rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-300/40 dark:border-rose-500/30 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300"
              >
                {error}
              </div>
            )}
          </div>

          {/* ── Footer ───────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-black/5 dark:border-white/10 bg-black/[0.015] dark:bg-white/[0.02]">
            <button
              type="button"
              onClick={() => void submit(true)}
              disabled={loading}
              aria-label="Saltar el formulario y generar con valores por defecto"
              className="text-[12px] text-[#0e1745]/60 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Saltar — usar defaults
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                aria-label="Cancelar"
                className="px-3 py-2 rounded-xl text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void submit(false)}
                disabled={loading}
                aria-label="Generar presentación con estas opciones"
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12.5px] font-semibold transition-colors',
                  'bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2]',
                  'text-white shadow-sm shadow-[#1534dc]/25 dark:shadow-[#8b5cf6]/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {loading ? 'Generando…' : 'Generar'}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(node, document.body);
}
