/**
 * AssetNode — ReactFlow node for imported image/audio/document files.
 *
 * Three render shapes (auto-routed by `data.type`):
 *   • image    → object-cover preview, click to enlarge
 *   • audio    → native <audio> player + filename + size
 *   • document → icon card with "Abrir" link (PDFs/DOCXs open in new tab)
 *
 * All three share:
 *   - NodeResizer when selected
 *   - Header with filename + delete button
 *   - Color accent bar (mirror of HojaNode tokens)
 *   - Click → onSelect(id) so the chat panel can attach context later
 *
 * Ported from CL2 with Studio palette substitutions:
 *   - cl2-burgundy → Studio's #7A3B47 burgundy literal (no token alias)
 *   - cl2-accent ring → Studio's #1534dc / dark #8b5cf6
 */
import { memo, useCallback, useState } from 'react';
import { NodeResizer } from '@xyflow/react';
import {
  GripVertical, Trash2, FileText, FileType, Music,
  ExternalLink, Maximize2, X, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssetContent, NodeColor, WorkspaceNode } from '@/services/workspaceApi';
import { reextractAsset } from '@/services/workspaceApi';

const COLOR_ACCENTS: Record<NodeColor, string> = {
  default:  'border-[#1534dc]/15 dark:border-[#8b5cf6]/30',
  burgundy: 'border-[#7A3B47]/30 dark:border-[#a8525f]/40',
  ink:      'border-[#0e1745]/30 dark:border-white/30',
  sage:     'border-emerald-500/30 dark:border-emerald-400/40',
  amber:    'border-amber-500/30 dark:border-amber-400/40',
};

interface AssetNodeData extends WorkspaceNode {
  workspaceId: string;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}

function AssetNodeImpl({
  id, data, selected,
}: { id: string; data: AssetNodeData; selected?: boolean }) {
  const content = data.content as AssetContent | null;
  const url = content?.url;
  const filename = content?.filename ?? data.title ?? 'archivo';
  const sizeKB = content?.size ? `${(content.size / 1024).toFixed(0)} KB` : '';
  const accent = COLOR_ACCENTS[data.color] ?? COLOR_ACCENTS.default;
  const [showLightbox, setShowLightbox] = useState(false);

  const handleClick = useCallback(() => data.onSelect(id), [data, id]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    data.onDelete(id);
  }, [data, id]);

  // ── Re-index (re-run text extraction for unindexed documents) ────
  // The "no indexado" badge becomes a button — clicking it hits the
  // /reextract endpoint which pulls the asset back from storage and
  // runs pdf-parse / mammoth / decode again, then patches
  // content.extracted_text. Useful when:
  //   - asset was uploaded before the extractor existed (legacy)
  //   - first-pass extraction silently failed (broken PDF, transient)
  //   - user just wants to retry
  // Local state for in-flight + error so the badge can swap UI.
  const [reindexing, setReindexing] = useState(false);
  const [reindexError, setReindexError] = useState<string | null>(null);
  const handleReindex = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reindexing) return;
    setReindexing(true);
    setReindexError(null);
    try {
      const updated = await reextractAsset(data.workspaceId, id);
      const newContent = updated.content as AssetContent | null;
      const hasText = !!(newContent?.extracted_text && newContent.extracted_text.length > 0);
      if (!hasText) {
        // Extraction returned null — most likely encrypted PDF, oversize,
        // unsupported MIME, or the underlying parser threw and was caught
        // server-side. Surface a friendly message instead of pretending it
        // worked.
        setReindexError('No se pudo extraer texto. Puede ser PDF protegido, formato no soportado, o muy grande.');
      } else {
        // Mutate the node data in place so the badge disappears immediately
        // (the parent will reconcile from the server on next reload). This
        // bypasses memo bailout because aHasText !== bHasText in the memo
        // equality check.
        if (data.content && typeof data.content === 'object') {
          (data.content as AssetContent).extracted_text = newContent!.extracted_text;
        }
      }
    } catch (err) {
      setReindexError((err as Error).message || 'Error indexando');
    } finally {
      setReindexing(false);
    }
  }, [data, id, reindexing]);

  return (
    <>
      <div
        onClick={handleClick}
        className={cn(
          'relative flex flex-col rounded-2xl border bg-white/85 dark:bg-white/[0.04] backdrop-blur-xl shadow-[0_4px_20px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.25)] transition-all duration-150 overflow-hidden',
          accent,
          selected && 'ring-2 ring-[#1534dc]/60 dark:ring-[#8b5cf6]/60 shadow-[0_8px_35px_rgba(21,52,220,0.15)]',
        )}
        style={{ width: '100%', height: '100%' }}
      >
        <NodeResizer minWidth={200} minHeight={120} isVisible={selected} />

        {/* ── Header (drag handle + delete) ─────────────────────── */}
        <div
          className="drag-handle flex items-center justify-between px-3 pt-2 pb-1.5 cursor-grab active:cursor-grabbing border-b border-black/5 dark:border-white/5"
          data-drag-handle
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <GripVertical className="w-3.5 h-3.5 text-black/20 dark:text-white/20 shrink-0" />
            {data.type === 'image' && <FileType className="w-3 h-3 text-[#7A3B47]/70 shrink-0" />}
            {data.type === 'audio' && <Music className="w-3 h-3 text-[#7A3B47]/70 shrink-0" />}
            {data.type === 'document' && <FileText className="w-3 h-3 text-[#7A3B47]/70 shrink-0" />}
            <span className="text-[11px] font-medium text-[#0e1745]/70 dark:text-white/70 truncate">
              {filename}
            </span>
          </div>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleDelete}
            className="p-1 rounded-md hover:bg-rose-100 dark:hover:bg-rose-900/30 text-black/30 dark:text-white/30 hover:text-rose-600 dark:hover:text-rose-400 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
            title="Eliminar"
            aria-label={`Eliminar ${filename}`}
          >
            <Trash2 className="w-3 h-3" aria-hidden />
          </button>
        </div>

        {/* ── Body — type-aware ─────────────────────────────────── */}
        <div className="nodrag flex-1 min-h-0 overflow-hidden flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
          {data.type === 'image' && url && (
            <div className="relative flex-1 min-h-0 group">
              <img
                src={url}
                alt={filename}
                className="w-full h-full object-cover"
                draggable={false}
              />
              <button
                onClick={(e) => { e.stopPropagation(); setShowLightbox(true); }}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-black/40 hover:bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="Ampliar"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {data.type === 'audio' && url && (
            <div className="flex-1 flex flex-col gap-2 px-3 py-3 justify-center">
              <audio
                controls
                src={url}
                className="w-full h-9"
                style={{ accentColor: '#7A3B47' }}
              />
              {sizeKB && (
                <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 text-center font-mono">
                  {sizeKB}
                </p>
              )}
            </div>
          )}

          {data.type === 'document' && url && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 py-3 text-center">
              <div className="w-12 h-14 rounded-md bg-[#7A3B47]/10 flex items-center justify-center border border-[#7A3B47]/20">
                <FileText className="w-6 h-6 text-[#7A3B47]" />
              </div>
              <p className="text-[12px] font-medium text-[#0e1745] dark:text-white truncate w-full">
                {filename}
              </p>
              {sizeKB && (
                <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 font-mono">
                  {sizeKB}
                </p>
              )}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label={`Abrir ${filename} en una nueva pestaña`}
                className="mt-1 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#7A3B47]/10 hover:bg-[#7A3B47]/20 dark:bg-[#7A3B47]/20 dark:hover:bg-[#7A3B47]/30 text-[#7A3B47] dark:text-[#c5828d] text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A3B47]/50"
              >
                Abrir <ExternalLink className="w-3 h-3" aria-hidden />
              </a>
            </div>
          )}

          {!url && (
            <div className="flex-1 flex items-center justify-center text-[11px] text-[#0e1745]/40 dark:text-white/30">
              Asset sin URL
            </div>
          )}
        </div>

        {/* "no indexado" badge → clickable button that re-runs extraction.
            Document/audio assets whose extracted_text is empty get this
            badge. The chat agent can't read them; clicking the badge hits
            /reextract to retry the parser. */}
        {(data.type === 'document' || data.type === 'audio') &&
         !(content?.extracted_text && content.extracted_text.length > 0) && (
          <button
            type="button"
            onClick={handleReindex}
            disabled={reindexing}
            className={cn(
              'absolute bottom-2 right-2 text-[10px] px-2 py-1 rounded inline-flex items-center gap-1 transition-colors',
              reindexError
                ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 hover:bg-rose-500/25'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25',
              reindexing && 'opacity-60 cursor-wait',
            )}
            title={
              reindexError
                ? reindexError
                : reindexing
                  ? 'Indexando…'
                  : 'Click para reintentar indexar este archivo (texto extraíble para chat).'
            }
            aria-label={reindexError ? `Error: ${reindexError}` : 'Reintentar indexación del archivo'}
          >
            <RefreshCw
              size={9}
              className={cn(reindexing && 'animate-spin')}
              aria-hidden
            />
            {reindexing ? 'Indexando…' : reindexError ? '⚠ falló' : '⚠ no indexado'}
          </button>
        )}
      </div>

      {/* ── Lightbox for images ────────────────────────────────── */}
      {showLightbox && url && (
        <div
          className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center p-8 animate-in fade-in duration-200"
          onClick={() => setShowLightbox(false)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Escape') setShowLightbox(false); }}
          role="dialog"
          aria-modal="true"
          aria-label={`Vista ampliada de ${filename}`}
        >
          <img
            src={url}
            alt={filename}
            className="max-w-full max-h-full object-contain animate-in fade-in zoom-in-95 duration-200"
          />
          <button
            onClick={(e) => { e.stopPropagation(); setShowLightbox(false); }}
            aria-label="Cerrar vista ampliada"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}

// Memoize to skip re-renders when ReactFlow churns the data identity
// without actually changing visible asset fields.
export const AssetNode = memo(AssetNodeImpl, (prev, next) => {
  if (prev.id !== next.id) return false;
  if (prev.selected !== next.selected) return false;
  const a = prev.data;
  const b = next.data;
  if (a === b) return true;
  if (a.title !== b.title) return false;
  if (a.color !== b.color) return false;
  if (a.type !== b.type) return false;
  const ac = a.content as AssetContent | null;
  const bc = b.content as AssetContent | null;
  if (ac?.url !== bc?.url) return false;
  if (ac?.filename !== bc?.filename) return false;
  if (ac?.size !== bc?.size) return false;
  // Phase 3.G: re-render when indexing status changes — the "no indexado"
  // badge depends on extracted_text presence, so flipping this must
  // bypass memo bailout.
  const aHasText = !!(ac?.extracted_text && ac.extracted_text.length > 0);
  const bHasText = !!(bc?.extracted_text && bc.extracted_text.length > 0);
  if (aHasText !== bHasText) return false;
  return true;
});
