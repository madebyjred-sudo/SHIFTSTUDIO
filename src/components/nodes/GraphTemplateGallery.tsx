/**
 * @file GraphTemplateGallery.tsx
 * @description Modal gallery of starting-point DAGs for "modo nodos".
 *
 * Wave-E rationale: empty canvas is the hardest UX moment in modo
 * nodos. A user landing on the graph builder without templates stalls.
 * This modal renders 5 curated starting points; clicking one loads the
 * DAG into `useActiveGraphStore` and dismisses the modal so the user
 * can immediately edit + run.
 *
 * Triggers:
 *   1. First-visit auto-open via `localStorage`
 *      (`studio-modo-nodos-first-visit-done`).
 *   2. Manual "+ Template" button in the canvas top-right panel
 *      (always accessible).
 *
 * Data: `listTemplates()` from `services/templateApi.ts`. The endpoint
 * returns templates in sort order; if the fetch fails (Cerebro down,
 * dev env unreachable) we render an inline error with a Retry button.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  Sparkles,
  FileText,
  BarChart3,
  Presentation,
  Sheet,
  FileType,
  Loader2,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';
import type { Edge, Node } from '@xyflow/react';
import { useActiveGraphStore, type AppNode } from '../../store';
import { listTemplates, type Template } from '../../services/templateApi';
import { getLayoutedElements } from '../../utils/layoutGraph';

// ─── Visuals ──────────────────────────────────────────────────────────

/** Map template category → icon. Categories live in the SQL seed. */
const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  creativo: FileText,
  estrategia: Presentation,
  analytics: BarChart3,
  finanzas: Sheet,
  comercial: Presentation,
};

/** Default if a template has an unknown / null category. */
const DefaultCategoryIcon = FileType;

/**
 * Map of (export node format → accent gradient). Used to differentiate
 * templates visually when no thumbnail is provided. We read the export
 * format from the first export node in the DAG.
 */
const FORMAT_GRADIENTS: Record<string, string> = {
  docx: 'from-sky-400 to-indigo-500',
  pptx: 'from-violet-400 to-fuchsia-500',
  pdf: 'from-rose-400 to-orange-500',
  xlsx: 'from-emerald-400 to-teal-500',
  carousel: 'from-amber-400 to-pink-500',
};

const DEFAULT_GRADIENT = 'from-slate-400 to-slate-600';

function getFormatFromTemplate(t: Template): string | null {
  const exp = t.dag_json.nodes.find((n) => n.type === 'export');
  const f = exp?.data?.['format'];
  return typeof f === 'string' ? f.toLowerCase() : null;
}

// ─── Props ────────────────────────────────────────────────────────────

export interface GraphTemplateGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tenant whose templates to fetch. Defaults to "shift". */
  tenantId?: string;
  /**
   * Optional callback fired after a template is loaded — typically used
   * by the canvas to open the Shifty sidebar with a pre-filled prompt
   * ("Este flow hace X. ¿Lo personalizamos para tu caso?"). The
   * argument is the selected template so the caller can craft a
   * tailored message.
   */
  onTemplateApplied?: (template: Template) => void;
}

// ─── Component ────────────────────────────────────────────────────────

export function GraphTemplateGallery({
  isOpen,
  onClose,
  tenantId = 'shift',
  onTemplateApplied,
}: GraphTemplateGalleryProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setNodes = useActiveGraphStore((s) => s.setNodes);
  const setEdges = useActiveGraphStore((s) => s.setEdges);

  // ─── Fetch on open (and on retry) ───────────────────────────────────
  const fetchTemplates = useCallback(
    async (signal?: AbortSignal) => {
      setStatus('loading');
      setErrorMsg(null);
      try {
        const rows = await listTemplates(tenantId, signal);
        if (signal?.aborted) return;
        setTemplates(rows);
        setStatus('ready');
      } catch (err) {
        if (signal?.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[GraphTemplateGallery] listTemplates failed:', msg);
        setErrorMsg(msg);
        setStatus('error');
      }
    },
    [tenantId],
  );

  useEffect(() => {
    if (!isOpen) return;
    const ac = new AbortController();
    void fetchTemplates(ac.signal);
    return () => ac.abort();
  }, [isOpen, fetchTemplates]);

  // ─── Apply template → hydrate store ────────────────────────────────
  const handleApply = useCallback(
    (template: Template) => {
      // Wire DAG into store shape. ReactFlow accepts `position` directly
      // on each node; for templates that omitted positions (or for cases
      // where we want a guaranteed clean layout) run getLayoutedElements
      // so the canvas opens visually tidy.
      const rfNodes: AppNode[] = template.dag_json.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 0, y: 0 },
        data: { ...(n.data ?? {}) },
      })) as AppNode[];

      const rfEdges: Edge[] = template.dag_json.edges.map((e, i) => ({
        id: e.id || `e${i}`,
        source: e.source,
        target: e.target,
        type: 'animated',
      }));

      try {
        const laid = getLayoutedElements(rfNodes as Node[], rfEdges);
        setNodes(laid.nodes as AppNode[]);
        setEdges(rfEdges);
      } catch {
        // If layout fails (shouldn't, but defensive) just use the seed
        // positions — they're hand-tuned so the result is usable.
        setNodes(rfNodes);
        setEdges(rfEdges);
      }

      onTemplateApplied?.(template);
      onClose();
    },
    [setNodes, setEdges, onTemplateApplied, onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-gallery-title"
      data-testid="template-gallery"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[85vh] overflow-hidden bg-white dark:bg-[#1A1A1A] rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 flex items-center justify-center">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="template-gallery-title"
                className="text-lg font-semibold text-gray-900 dark:text-white"
              >
                Empezá con un template
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Elegí un flow pre-armado. Después lo personalizamos con Shifty.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar galería de templates"
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1 rounded-md transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {status === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Cargando templates…
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-300 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                  No pudimos cargar los templates.
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-md">
                  {errorMsg || 'Revisá tu conexión y volvé a intentar.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void fetchTemplates()}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Reintentar
              </button>
            </div>
          )}

          {status === 'ready' && templates.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md">
                Todavía no hay templates curados para tu tenant. Pedile a un
                admin que sume algunos en Supabase o construí tu flow desde
                cero.
              </p>
            </div>
          )}

          {status === 'ready' && templates.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {templates.map((t) => (
                <TemplateCard
                  key={t.slug}
                  template={t}
                  onApply={handleApply}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{templates.length > 0 && `${templates.length} templates · tenant ${tenantId}`}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            Empezar desde cero
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Card subcomponent ────────────────────────────────────────────────

function TemplateCard({
  template,
  onApply,
}: {
  template: Template;
  onApply: (t: Template) => void;
}) {
  const format = getFormatFromTemplate(template) ?? '';
  const gradient = FORMAT_GRADIENTS[format] ?? DEFAULT_GRADIENT;
  const Icon = CATEGORY_ICONS[template.category ?? ''] ?? DefaultCategoryIcon;
  const stepCount = template.dag_json.nodes.filter(
    (n) => n.type === 'specialist',
  ).length;

  return (
    <button
      type="button"
      onClick={() => onApply(template)}
      className="group text-left bg-white dark:bg-black/30 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-indigo-400"
      data-testid={`template-card-${template.slug}`}
    >
      {/* Thumbnail / placeholder */}
      {template.thumbnail_url ? (
        <div
          className="aspect-[16/9] bg-gray-100 dark:bg-gray-900 bg-cover bg-center"
          style={{ backgroundImage: `url(${template.thumbnail_url})` }}
          aria-hidden
        />
      ) : (
        <div
          className={`aspect-[16/9] bg-gradient-to-br ${gradient} flex items-center justify-center text-white`}
          aria-hidden
        >
          <Icon className="w-10 h-10 opacity-90" />
        </div>
      )}

      <div className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            {template.name}
          </h3>
          {format && (
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
              {format}
            </span>
          )}
        </div>
        {template.description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug line-clamp-3">
            {template.description}
          </p>
        )}
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            {stepCount} {stepCount === 1 ? 'paso' : 'pasos'}
          </span>
          <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 group-hover:underline">
            Usar template →
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── First-visit helper ───────────────────────────────────────────────

const FIRST_VISIT_KEY = 'studio-modo-nodos-first-visit-done';

/**
 * Returns true once for the first visit to modo nodos per browser
 * (per localStorage). Subsequent calls return false. Used by
 * `ShiftyNodeCanvas` to auto-open the gallery the first time the user
 * lands on the canvas; after that the gallery is opt-in via the
 * "+ Template" button.
 *
 * Safe in SSR: no-ops to `false` if `window` is undefined.
 */
export function consumeFirstVisitFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const seen = window.localStorage.getItem(FIRST_VISIT_KEY);
    if (seen === '1') return false;
    window.localStorage.setItem(FIRST_VISIT_KEY, '1');
    return true;
  } catch {
    // Quota / private-mode browsers — fail closed (don't auto-open).
    return false;
  }
}
