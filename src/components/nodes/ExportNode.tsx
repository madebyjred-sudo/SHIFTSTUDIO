import React, { useCallback, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  RotateCw,
  Presentation,
  LayoutGrid,
  FileText,
  FileType,
  Sheet,
} from 'lucide-react';
import { useActiveGraphStore } from '../../store';
import {
  EXPORT_FORMAT_META,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_FORMAT,
  type ExportFormat,
} from '../../types/export';
import { useConnectionDrag } from '../../lib/connection-drag-context';
import { validateConnection } from '../../lib/graph-rules';

/**
 * Visual status used by ExportNode UI. Maps from the store-level status:
 *   IDLE      → 'idle'
 *   RUNNING   → 'exporting'
 *   COMPLETED → 'complete'
 *   FAILED    → 'error'
 */
type VisualStatus = 'idle' | 'exporting' | 'complete' | 'error';

const STORE_TO_VISUAL: Record<string, VisualStatus> = {
  IDLE: 'idle',
  RUNNING: 'exporting',
  COMPLETED: 'complete',
  FAILED: 'error',
};

const FORMAT_ICONS: Record<ExportFormat, React.ComponentType<{ className?: string }>> = {
  pptx: Presentation,
  carousel: LayoutGrid,
  docx: FileText,
  pdf: FileType,
  xlsx: Sheet,
};

const STATUS_COPY: Record<VisualStatus, string> = {
  idle: 'Listo para exportar',
  exporting: 'Exportando…',
  complete: 'Exportación lista',
  error: 'Error al exportar',
};

/**
 * Normalize a raw `data.format` value into a known ExportFormat.
 * Accepts lowercase ids and the legacy uppercase variants (DOCX/PPTX/PDF/XLSX).
 */
function normalizeFormat(raw: unknown): ExportFormat {
  if (typeof raw !== 'string') return DEFAULT_EXPORT_FORMAT;
  const lower = raw.toLowerCase();
  return (EXPORT_FORMATS as readonly string[]).includes(lower)
    ? (lower as ExportFormat)
    : DEFAULT_EXPORT_FORMAT;
}

export function ExportNode({ id, data }: any) {
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);

  const format: ExportFormat = useMemo(() => normalizeFormat(data?.format), [data?.format]);
  const rawStatus = (data?.status as string) || 'IDLE';
  const status: VisualStatus = STORE_TO_VISUAL[rawStatus] ?? 'idle';
  const exportUrl: string | undefined = data?.exportUrl;
  const errorMsg: string | undefined = data?.errorMsg;

  const handleFormatChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = normalizeFormat(e.target.value);
      updateNodeData(id, { format: next });
    },
    [id, updateNodeData],
  );

  const handleRetry = useCallback(() => {
    // Clear error data so the next graph run re-attempts this node.
    // The store/runner is responsible for re-executing — this only resets local state.
    updateNodeData(id, { status: 'IDLE', errorMsg: undefined });
  }, [id, updateNodeData]);

  const meta = EXPORT_FORMAT_META[format];
  const FormatIcon = FORMAT_ICONS[format];
  const isExporting = status === 'exporting';
  const isComplete = status === 'complete';
  const isError = status === 'error';

  // Ring/border tokens map to CSS vars in src/index.css. Tailwind utilities are
  // used for layout; status colors come from --color-shift-status-* tokens via
  // inline style so we never hardcode hex values.
  const ringColorVar = isExporting
    ? 'var(--color-shift-status-running)'
    : isComplete
      ? 'var(--color-shift-status-completed)'
      : isError
        ? 'var(--color-shift-status-failed)'
        : 'transparent';

  const handleColorVar = isError
    ? 'var(--color-shift-status-failed)'
    : isComplete
      ? 'var(--color-shift-status-completed)'
      : 'var(--color-shift-primary)';

  const accentVar = `var(${meta.cssVar})`;

  // ─── Connection feedback (F2) ───
  // Export is target-only. During a drag from another node, decide
  // whether the dragged source type → 'export' is valid.
  const drag = useConnectionDrag();
  const targetHandleState = useMemo<'valid' | 'invalid' | 'none'>(() => {
    if (!drag.active) return 'none';
    const { valid } = validateConnection(drag.sourceNodeType, 'export');
    return valid ? 'valid' : 'invalid';
  }, [drag.active, drag.sourceNodeType]);

  return (
    <div
      className={`bg-white dark:bg-[#1A1A1A] border shadow-sm rounded-xl w-72 overflow-hidden transition-all hover:shadow-md ${
        isExporting ? 'animate-pulse duration-1000' : ''
      }`}
      style={{
        borderColor: isError
          ? 'var(--color-shift-status-failed)'
          : isComplete
            ? 'var(--color-shift-status-completed)'
            : 'var(--color-border)',
        boxShadow:
          status !== 'idle'
            ? `0 0 0 2px var(--color-card), 0 0 0 4px ${ringColorVar}`
            : undefined,
      }}
    >
      <Handle
        id={`${id}-target`}
        type="target"
        position={Position.Top}
        className="shifty-handle w-3 h-3 border-2 border-white dark:border-[#1A1A1A]"
        style={{ background: handleColorVar }}
        data-connection-target={targetHandleState === 'none' ? undefined : targetHandleState}
        aria-describedby={drag.active ? `shifty-connection-tooltip` : undefined}
      />

      {/* Header */}
      <div
        className="px-4 py-2 flex items-center justify-between border-b"
        style={{
          background: isError
            ? 'color-mix(in srgb, var(--color-shift-status-failed) 12%, transparent)'
            : isComplete
              ? 'color-mix(in srgb, var(--color-shift-status-completed) 12%, transparent)'
              : 'color-mix(in srgb, var(--color-shift-primary) 8%, transparent)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center"
            style={{
              background: `color-mix(in srgb, ${accentVar} 18%, transparent)`,
              color: accentVar,
            }}
          >
            <Download className="w-3.5 h-3.5" />
          </div>
          <div className="font-semibold text-sm" style={{ color: 'var(--color-card-foreground)' }}>
            Exportador
          </div>
        </div>

        <div
          className="flex items-center gap-2 text-xs font-medium"
          role="status"
          aria-live="polite"
          aria-label={STATUS_COPY[status]}
          style={{ color: ringColorVar !== 'transparent' ? ringColorVar : 'var(--color-muted-foreground)' }}
        >
          {isExporting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
          {isComplete && <CheckCircle2 className="w-4 h-4" aria-hidden />}
          {isError && <AlertTriangle className="w-4 h-4" aria-hidden />}
          <span className="text-[10px] uppercase tracking-wider">{STATUS_COPY[status]}</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`export-format-${id}`}
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--color-muted-foreground)' }}
          >
            Formato de Salida
          </label>
          <div className="relative">
            <span
              className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center"
              style={{ color: accentVar }}
              aria-hidden
            >
              <FormatIcon className="w-3.5 h-3.5" />
            </span>
            <select
              id={`export-format-${id}`}
              aria-label="Formato de exportación"
              value={format}
              onChange={handleFormatChange}
              disabled={isExporting}
              className="w-full text-xs font-medium rounded-md py-1.5 pl-7 pr-2 outline-none appearance-none transition-colors focus:ring-1 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                background: 'var(--color-muted)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-card-foreground)',
              }}
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {EXPORT_FORMAT_META[f].label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[10px]" style={{ color: 'var(--color-muted-foreground)' }}>
            {meta.hint}
          </p>
        </div>

        {/* Complete: download link */}
        {isComplete && exportUrl && (
          <a
            href={exportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 w-full py-1.5 px-2 text-xs font-semibold rounded-md transition-colors focus:outline-none focus:ring-2"
            style={{
              background: 'color-mix(in srgb, var(--color-shift-status-completed) 12%, transparent)',
              color: 'var(--color-shift-status-completed)',
              border: '1px solid color-mix(in srgb, var(--color-shift-status-completed) 35%, transparent)',
            }}
          >
            <span className="truncate">Descargar archivo</span>
            <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden />
          </a>
        )}

        {/* Error: message + retry */}
        {isError && (
          <div className="flex flex-col gap-2">
            <p
              className="text-xs leading-snug rounded-md p-2"
              style={{
                background: 'color-mix(in srgb, var(--color-shift-status-failed) 10%, transparent)',
                color: 'var(--color-shift-status-failed)',
                border: '1px solid color-mix(in srgb, var(--color-shift-status-failed) 30%, transparent)',
              }}
            >
              {errorMsg || 'Hubo un problema generando el archivo.'}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="flex items-center justify-center gap-1.5 w-full py-1.5 text-xs font-semibold rounded-md transition-colors focus:outline-none focus:ring-2"
              style={{
                background: 'color-mix(in srgb, var(--color-shift-status-failed) 12%, transparent)',
                color: 'var(--color-shift-status-failed)',
                border: '1px solid color-mix(in srgb, var(--color-shift-status-failed) 35%, transparent)',
              }}
            >
              <RotateCw className="w-3.5 h-3.5" aria-hidden />
              Reintentar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
