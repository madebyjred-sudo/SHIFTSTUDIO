/**
 * HojaNode — T6 SHELL placeholder.
 *
 * IMPORTANT: This is a thin placeholder, NOT the rich-text node. T7 will
 * replace the body with TipTap (the full 562-line CL2 version is the
 * eventual target). For T6 the contract is intentionally narrow:
 *
 *   data: { id, title, subtitle, content.md, color }
 *   callbacks: onDelete(id), onSelect(id), onUpdate(id, patch)
 *
 * Rendering modes:
 *   - preview (default) — markdown rendered to HTML via a tiny inline
 *     formatter (headings/bold/italic/lists). No new dep.
 *   - editing — toggle on click; <textarea> with the raw markdown,
 *     auto-saves 800ms after last keystroke and on blur.
 *
 * Selected state comes through ReactFlow's `selected` prop; the ring
 * mirrors AssetNode for visual consistency. Color accent on the left
 * edge (4px) per data.color, mapped to the Studio palette.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeResizer } from '@xyflow/react';
import { GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { updateNode, type NodeColor, type UpdateNodePatch, type WorkspaceNode } from '@/services/workspaceApi';

// ─── Color accents (left-edge bar) ────────────────────────────────────
const COLOR_ACCENTS: Record<NodeColor, string> = {
  default:  'bg-[#1534dc]/30',
  burgundy: 'bg-[#7A3B47]',
  ink:      'bg-[#0e1745]',
  sage:     'bg-emerald-500',
  amber:    'bg-amber-500',
};

// ─── Tiny markdown → HTML renderer ────────────────────────────────────
// Intentionally minimal. T7's TipTap node will own real rendering; this
// just gives reviewers something legible while editing the textarea.
//
// Supports:
//   # / ## / ### headings, **bold**, *italic*, `code`, - / * lists,
//   blank-line paragraph splitting.
// Anything else falls through as plain text. We escape HTML up front so
// user input can't inject markup.
function renderMarkdown(md: string): string {
  if (!md.trim()) return '';
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const blocks = md.split(/\n{2,}/);
  const out: string[] = [];

  for (const raw of blocks) {
    const block = raw.trimEnd();
    if (!block.trim()) continue;

    // Headings
    const h = block.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const cls =
        level === 1
          ? 'text-[15px] font-semibold mb-1.5'
          : level === 2
          ? 'text-[13.5px] font-semibold mb-1.5'
          : 'text-[12.5px] font-semibold uppercase tracking-wide mb-1';
      out.push(`<h${level} class="${cls}">${inline(escape(h[2]))}</h${level}>`);
      continue;
    }

    // List block (single-level, - or *)
    if (/^[-*]\s+/.test(block)) {
      const items = block
        .split(/\n/)
        .filter((l) => /^[-*]\s+/.test(l))
        .map((l) => `<li class="ml-4 list-disc">${inline(escape(l.replace(/^[-*]\s+/, '')))}</li>`)
        .join('');
      out.push(`<ul class="my-1 space-y-0.5">${items}</ul>`);
      continue;
    }

    // Paragraph (single-line breaks → <br/>)
    const para = block
      .split(/\n/)
      .map((l) => inline(escape(l)))
      .join('<br/>');
    out.push(`<p class="my-1 leading-relaxed">${para}</p>`);
  }

  return out.join('');
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>')
    .replace(/`([^`]+)`/g, '<code class="px-1 rounded bg-black/8 dark:bg-white/8 font-mono text-[0.85em]">$1</code>');
}

// ─── Props ────────────────────────────────────────────────────────────
interface HojaNodeData extends Partial<WorkspaceNode> {
  workspaceId: string;
  onDelete?: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: Partial<WorkspaceNode>) => void;
}

// ─── Component ────────────────────────────────────────────────────────
export function HojaNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: HojaNodeData;
  selected?: boolean;
}) {
  const { workspaceId, onDelete, onSelect, onUpdate } = data;
  const initialMd = (data.content as { md?: string } | undefined)?.md ?? '';
  const color = (data.color as NodeColor) ?? 'default';
  const accent = COLOR_ACCENTS[color] ?? COLOR_ACCENTS.default;

  // ── Local state ────────────────────────────────────────────────────
  const [title, setTitle] = useState(data.title ?? 'Sin título');
  const [subtitle, setSubtitle] = useState(data.subtitle ?? '');
  const [md, setMd] = useState(initialMd);
  const [isEditing, setIsEditing] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync local state when ReactFlow data changes (e.g. lexa-driven
  // refresh). We only push when the prop value differs from local — the
  // user's in-flight edit shouldn't get clobbered mid-typing.
  useEffect(() => {
    if (data.title !== undefined && data.title !== title && !isEditing) {
      setTitle(data.title);
    }
    if (data.subtitle !== undefined && data.subtitle !== subtitle && !isEditing) {
      setSubtitle(data.subtitle);
    }
    const incomingMd = (data.content as { md?: string } | undefined)?.md ?? '';
    if (incomingMd !== md && !isEditing) {
      setMd(incomingMd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.title, data.subtitle, data.content]);

  // ── Save (debounced 800ms) ─────────────────────────────────────────
  const scheduleSave = useCallback(
    (patch: UpdateNodePatch) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState('saving');
      saveTimer.current = setTimeout(async () => {
        try {
          await updateNode(workspaceId, id, patch);
          setSaveState('saved');
          onUpdate?.(id, patch as Partial<WorkspaceNode>);
          setTimeout(() => setSaveState('idle'), 1200);
        } catch {
          setSaveState('idle');
        }
      }, 800);
    },
    [workspaceId, id, onUpdate],
  );

  const handleTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      scheduleSave({ title: next });
    },
    [scheduleSave],
  );

  const handleSubtitleChange = useCallback(
    (next: string) => {
      setSubtitle(next);
      scheduleSave({ subtitle: next });
    },
    [scheduleSave],
  );

  const handleMdChange = useCallback(
    (next: string) => {
      setMd(next);
      scheduleSave({ content: { md: next } });
    },
    [scheduleSave],
  );

  const flushSaveOnBlur = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      setSaveState('saving');
      const patch: UpdateNodePatch = { content: { md } };
      updateNode(workspaceId, id, patch)
        .then(() => {
          setSaveState('saved');
          onUpdate?.(id, patch as Partial<WorkspaceNode>);
          setTimeout(() => setSaveState('idle'), 1200);
        })
        .catch(() => setSaveState('idle'));
    }
    setIsEditing(false);
  }, [workspaceId, id, md, onUpdate]);

  // Focus the textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      // Place caret at end on first focus
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const renderedHtml = useMemo(() => renderMarkdown(md), [md]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.(id);
    },
    [id, onDelete],
  );

  const handleClick = useCallback(() => {
    onSelect?.(id);
  }, [id, onSelect]);

  return (
    <div
      onClick={handleClick}
      className={cn(
        'relative flex flex-col rounded-2xl overflow-hidden transition-all duration-150',
        'bg-white/85 dark:bg-white/[0.04] backdrop-blur-xl',
        'border border-black/8 dark:border-white/8 shadow-[0_4px_20px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.25)]',
        selected && 'ring-2 ring-[#1534dc]/60 dark:ring-[#8b5cf6]/60 shadow-[0_8px_35px_rgba(21,52,220,0.15)]',
      )}
      style={{ width: '100%', height: '100%' }}
    >
      <NodeResizer minWidth={280} minHeight={200} isVisible={selected} />

      {/* Color accent bar (left edge) */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', accent)} aria-hidden />

      {/* ── Header (drag handle, title, delete) ────────────────────── */}
      <div
        className="drag-handle flex items-center justify-between gap-2 px-3 pt-2 pb-1.5 border-b border-black/5 dark:border-white/5 cursor-grab active:cursor-grabbing"
        data-drag-handle
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <GripVertical className="w-3.5 h-3.5 text-black/20 dark:text-white/20 shrink-0" />
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder="Sin título"
            className="flex-1 min-w-0 bg-transparent text-[13px] font-semibold text-[#0e1745] dark:text-white focus:outline-none placeholder:text-[#0e1745]/30 dark:placeholder:text-white/30"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saveState !== 'idle' && (
            <span className="text-[10px] uppercase tracking-wider text-[#0e1745]/40 dark:text-white/40 font-medium">
              {saveState === 'saving' ? 'guardando…' : 'guardado'}
            </span>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleDelete}
            className="p-1 rounded-md hover:bg-black/8 dark:hover:bg-white/10 text-black/30 dark:text-white/30 hover:text-red-500 transition-colors"
            title="Eliminar hoja"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Subtitle ───────────────────────────────────────────────── */}
      {(subtitle || isEditing) && (
        <input
          value={subtitle}
          onChange={(e) => handleSubtitleChange(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          placeholder="Subtítulo (opcional)"
          className="nodrag px-4 pt-2 pb-1 bg-transparent text-[11.5px] text-[#0e1745]/55 dark:text-white/55 focus:outline-none placeholder:text-[#0e1745]/25 dark:placeholder:text-white/25"
        />
      )}

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div
        className="nodrag flex-1 min-h-0 overflow-auto px-4 py-3 text-[13px] text-[#0e1745]/85 dark:text-white/85"
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!isEditing) setIsEditing(true);
        }}
      >
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={md}
            onChange={(e) => handleMdChange(e.target.value)}
            onBlur={flushSaveOnBlur}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Escribí en markdown… **negrita**, *cursiva*, # encabezados, - listas."
            className="w-full h-full min-h-[140px] bg-transparent resize-none focus:outline-none font-mono text-[12.5px] leading-relaxed text-[#0e1745]/85 dark:text-white/85 placeholder:text-[#0e1745]/25 dark:placeholder:text-white/25"
          />
        ) : md.trim() ? (
          // Rendered preview. The renderer escapes user input first; the
          // resulting HTML uses an allowlisted token set defined above.
          <div
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
            className="prose-sm max-w-none [&>*+*]:mt-1.5"
          />
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
            }}
            className="w-full text-left text-[12.5px] text-[#0e1745]/35 dark:text-white/30 italic hover:text-[#0e1745]/60 dark:hover:text-white/55 transition-colors"
          >
            Hacé clic para empezar a escribir…
          </button>
        )}
      </div>
    </div>
  );
}
