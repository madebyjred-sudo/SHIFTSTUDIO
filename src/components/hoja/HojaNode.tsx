/**
 * HojaNode — custom ReactFlow node for the Workspace canvas (T7).
 *
 * Replaces T6's textarea shell with a full TipTap v3 rich-text editor.
 * Each node is a "page" (hoja) with:
 *   - Draggable header bar (ReactFlow handles drag via the .drag-handle).
 *   - Editable title + subtitle (debounced auto-save).
 *   - TipTap rich-text body (StarterKit + format extensions + custom
 *     slash command).
 *   - Color theme accent on left edge.
 *   - Auto-save (debounced 800ms) — patches via workspaceApi.updateNode
 *     AND notifies the parent via onUpdate so ReactFlow's mirror state
 *     stays consistent.
 *   - Live save indicator with relative timestamp.
 *
 * External contract (preserved from T6):
 *   data: { id, title, subtitle, content.md, color, workspaceId }
 *   callbacks: onDelete(id), onSelect(id), onUpdate(id, patch)
 *
 * Storage shape:
 *   - On the wire we keep `content.md` per the workspace API contract.
 *   - TipTap stores HTML internally. On load we convert `content.md` →
 *     HTML via `marked` (preserves headings, lists, links, code blocks,
 *     blockquotes, hr). On save we serialize HTML → markdown via a
 *     small custom converter (htmlToMarkdown below), so the column
 *     stays portable / diff-friendly and a future plain-text-only
 *     consumer (export, embedding) doesn't have to parse HTML.
 *
 * Drag pass-through (CRITICAL):
 *   ReactFlow distinguishes "draggable" vs "interactive" surfaces by the
 *   `nodrag` class + by stopPropagation on mousedown. The header keeps
 *   `drag-handle` for the canvas drag; the editor body has `nodrag` and
 *   stops mousedown propagation so clicks land on TipTap, not the canvas.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { NodeResizer } from '@xyflow/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
// Format extensions — see comments in CL2's port for the rationale of
// each. Studio inherits the same set; the slash menu replaces CL2's
// legislative-specific commands with generic content blocks.
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import Typography from '@tiptap/extension-typography';
import CharacterCount from '@tiptap/extension-character-count';
import { marked } from 'marked';
import {
  GripHorizontal, Trash2, Check, Loader2, AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  updateNode, type NodeColor, type UpdateNodePatch, type WorkspaceNode,
} from '@/services/workspaceApi';
import { createSlashExtension } from './HojaSlashExtension';

// ─── Color accents (left-edge bar) ────────────────────────────────────
// Mirrors the T6 token set so AssetNode + HojaNode read consistently.
const COLOR_ACCENTS: Record<NodeColor, string> = {
  default:  'bg-[#1534dc]/30',
  burgundy: 'bg-[#7A3B47]',
  ink:      'bg-[#0e1745]',
  sage:     'bg-emerald-500',
  amber:    'bg-amber-500',
};

// ─── Markdown ↔ HTML bridge ───────────────────────────────────────────
// TipTap operates in HTML. The wire contract is markdown. We need a
// round-trippable conversion for the feature set we expose:
//   headings (h1-h3), bold/italic/strike/code/underline,
//   bullet/ordered/task lists, links, blockquote, code blocks, hr,
//   highlight (mark), text-align (data attr only, no md analog → kept
//   as raw HTML when present)

function mdToHtml(md: string): string {
  if (!md.trim()) return '';
  // Already HTML? (round-trip from a previous save). Detect by leading
  // tag — heuristic but cheap. Marked is tolerant either way.
  if (/^\s*<(h[1-6]|p|ul|ol|blockquote|pre|hr|div|figure|table)\b/i.test(md)) {
    return md;
  }
  try {
    const out = marked.parse(md, { async: false, breaks: true, gfm: true });
    return typeof out === 'string' ? out : '';
  } catch {
    // Fall back to plain paragraph if parsing trips on weird input.
    return `<p>${escapeHtml(md)}</p>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * HTML → Markdown serializer for the editor's supported tag set.
 *
 * Intentionally minimal — we own the HTML shape (we set it via TipTap),
 * so we don't need a generic HTML parser. We walk a temporary DOM,
 * emit markdown for known tags, and fall back to text for anything
 * weird. Output is normalized (single trailing newline, no leading
 * blank lines, code fences guarded with backticks count).
 *
 * Round-trips:
 *   md → mdToHtml → htmlToMarkdown should produce the same md (modulo
 *   whitespace) for the documented feature set.
 */
function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.querySelector('div');
  if (!root) return '';

  const out = serializeBlock(root).replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function serializeBlock(el: Element): string {
  const parts: string[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent ?? '';
      if (t.trim()) parts.push(t);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const e = child as Element;
    const tag = e.tagName.toLowerCase();

    switch (tag) {
      case 'h1': parts.push(`# ${serializeInline(e)}\n\n`); break;
      case 'h2': parts.push(`## ${serializeInline(e)}\n\n`); break;
      case 'h3': parts.push(`### ${serializeInline(e)}\n\n`); break;
      case 'h4': parts.push(`#### ${serializeInline(e)}\n\n`); break;
      case 'h5': parts.push(`##### ${serializeInline(e)}\n\n`); break;
      case 'h6': parts.push(`###### ${serializeInline(e)}\n\n`); break;
      case 'p': {
        const inner = serializeInline(e);
        if (inner.trim()) parts.push(`${inner}\n\n`);
        break;
      }
      case 'ul': {
        // TaskList lives under <ul data-type="taskList"> with nested
        // <li data-type="taskItem" data-checked>; we emit GFM-style
        // - [ ] / - [x] for those. Plain UL is hyphen-bulleted.
        const isTask = e.getAttribute('data-type') === 'taskList';
        for (const li of Array.from(e.querySelectorAll(':scope > li'))) {
          if (isTask) {
            const checked = li.getAttribute('data-checked') === 'true';
            const inner = serializeInline(li.querySelector(':scope > div') ?? li);
            parts.push(`- [${checked ? 'x' : ' '}] ${inner}\n`);
          } else {
            parts.push(`- ${serializeInline(li)}\n`);
          }
        }
        parts.push('\n');
        break;
      }
      case 'ol': {
        let i = 1;
        for (const li of Array.from(e.querySelectorAll(':scope > li'))) {
          parts.push(`${i}. ${serializeInline(li)}\n`);
          i += 1;
        }
        parts.push('\n');
        break;
      }
      case 'blockquote': {
        const inner = serializeBlock(e).trim().split('\n').map((l) => `> ${l}`).join('\n');
        parts.push(`${inner}\n\n`);
        break;
      }
      case 'pre': {
        // Code block. TipTap emits <pre><code class="language-foo">…
        const code = e.querySelector('code');
        const lang = code?.className.match(/language-(\S+)/)?.[1] ?? '';
        const text = (code?.textContent ?? e.textContent ?? '').replace(/\n+$/, '');
        // Use enough backticks to avoid collision with content fences.
        const matches: string[] = text.match(/`+/g) ?? [];
        let longest = 0;
        for (const m of matches) longest = Math.max(longest, m.length);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        parts.push(`${fence}${lang}\n${text}\n${fence}\n\n`);
        break;
      }
      case 'hr':
        parts.push('---\n\n');
        break;
      case 'br':
        parts.push('\n');
        break;
      case 'div':
        // Pass-through container (e.g. TipTap's TaskItem inner div).
        parts.push(serializeBlock(e));
        break;
      default:
        // Unknown block → fall through as inline.
        parts.push(serializeInline(e));
    }
  }
  return parts.join('');
}

function serializeInline(el: Element | null): string {
  if (!el) return '';
  let out = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const e = child as Element;
    const tag = e.tagName.toLowerCase();
    const inner = serializeInline(e);
    switch (tag) {
      case 'strong':
      case 'b':
        out += `**${inner}**`;
        break;
      case 'em':
      case 'i':
        out += `*${inner}*`;
        break;
      case 'u':
        // No native md for underline; HTML passthrough is the cleanest
        // round-trip (mdToHtml/marked passes raw HTML through).
        out += `<u>${inner}</u>`;
        break;
      case 's':
      case 'del':
      case 'strike':
        out += `~~${inner}~~`;
        break;
      case 'code':
        out += `\`${inner}\``;
        break;
      case 'mark':
        // No native md for highlight; preserve as raw HTML so the
        // server-side md parser keeps the styling intact on next load.
        out += `<mark>${inner}</mark>`;
        break;
      case 'a': {
        const href = (e as HTMLAnchorElement).getAttribute('href') ?? '';
        out += `[${inner}](${href})`;
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'p':
      case 'div':
      case 'span':
        out += inner;
        break;
      default:
        out += inner;
    }
  }
  return out;
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
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Tick state lifts a 1-Hz refresh on the relative-time label.
  const [, setTick] = useState(0);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks the last incoming md we applied from props so we can short-
  // circuit when ReactFlow churns the data object identity but the md
  // bytes haven't changed (cheap ref compare avoids the htmlToMarkdown
  // walk on every store tick).
  const lastIncomingMdRef = useRef<string>(initialMd);

  // ── Auto-save helper ─────────────────────────────────────────────
  // Debounced 800ms — fast enough that the user sees "guardado" within
  // a second of pausing, slow enough to coalesce a rapid burst of
  // keystrokes into one PATCH. On success we record `lastSavedAt`
  // so the header chrome can render "guardado hace N s" continuously.
  // Also fires `onUpdate` so the parent's ReactFlow mirror picks up the
  // patch (so chat / export consumers see the latest content without a
  // refetch).
  const scheduleSave = useCallback((patch: UpdateNodePatch) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(async () => {
      try {
        await updateNode(workspaceId, id, patch);
        setSaveState('saved');
        setLastSavedAt(Date.now());
        onUpdate?.(id, patch as Partial<WorkspaceNode>);
      } catch {
        setSaveState('error');
      }
    }, 800);
  }, [workspaceId, id, onUpdate]);

  // ── Slash extension ──────────────────────────────────────────────
  // Memoized so we don't re-instantiate the suggestion plugin on every
  // render (would tear down/rebuild the ProseMirror plugin chain).
  const slashExtension = useMemo(() => createSlashExtension(), []);

  // ── TipTap editor ────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      slashExtension,
      Underline,
      // multicolor=true so each highlight click can set a different
      // color via setHighlight({color}).
      Highlight.configure({ multicolor: true }),
      // Link: open in new tab + auto-link pasted URLs. We disable
      // openOnClick because clicking-to-navigate while editing steals
      // the click from caret placement.
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      // TextAlign applies textAlign attr to heading/paragraph nodes.
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      // Task list: interactive checkboxes inside hojas.
      TaskList,
      TaskItem.configure({ nested: true }),
      // Typography: smart-quote and arrow auto-replacements.
      Typography,
      // CharacterCount: exposed via storage; future word-count UI.
      CharacterCount,
    ],
    content: mdToHtml(initialMd),
    editorProps: {
      attributes: {
        class: 'hoja-prose ProseMirror focus:outline-none min-h-[120px] px-4 py-3 text-[13.5px] leading-relaxed',
      },
    },
    onUpdate: ({ editor }) => {
      // Serialize HTML → md so the wire contract stays markdown.
      // Whitespace is normalized inside htmlToMarkdown.
      const md = htmlToMarkdown(editor.getHTML());
      scheduleSave({ content: { md } });
    },
  });

  // ── Sync incoming data changes (e.g. chat-driven refresh) ────────
  // Only push when the prop value differs AND the editor is not focused —
  // an in-flight edit shouldn't get clobbered mid-typing.
  //
  // Hot-path guard: ReactFlow rebuilds `data` references on every store
  // tick, so this effect re-runs constantly. The expensive bit is
  // `htmlToMarkdown(editor.getHTML())` — a full DOM walk. We track the
  // last-applied incoming md in a ref and short-circuit on byte equality
  // before touching the editor at all.
  useEffect(() => {
    if (data.title !== undefined && data.title !== title) {
      setTitle(data.title);
    }
    if (data.subtitle !== undefined && data.subtitle !== subtitle) {
      setSubtitle(data.subtitle);
    }
    if (!editor) return;
    const incomingMd = (data.content as { md?: string } | undefined)?.md ?? '';
    if (incomingMd === lastIncomingMdRef.current) return; // cheap ref compare, common case
    lastIncomingMdRef.current = incomingMd;
    if (editor.isFocused || !incomingMd) return; // preserve original gates
    const currentMd = htmlToMarkdown(editor.getHTML());
    if (currentMd === incomingMd) return;
    // setContent without triggering onUpdate (last arg = false on emitUpdate)
    editor.commands.setContent(mdToHtml(incomingMd), { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, data.title, data.subtitle, data.content]);

  // ── Sync title/subtitle edits ────────────────────────────────────
  const handleTitleChange = useCallback((val: string) => {
    setTitle(val);
    scheduleSave({ title: val });
  }, [scheduleSave]);

  const handleSubtitleChange = useCallback((val: string) => {
    setSubtitle(val);
    scheduleSave({ subtitle: val });
  }, [scheduleSave]);

  // ── 1-Hz tick for the relative-time label ────────────────────────
  // Only runs while we have a saved timestamp to display.
  useEffect(() => {
    if (lastSavedAt === null) return;
    tickInterval.current = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      if (tickInterval.current) clearInterval(tickInterval.current);
      tickInterval.current = null;
    };
  }, [lastSavedAt]);

  // ── Cleanup all timers on unmount (T6 quality patterns reapplied) ─
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    if (tickInterval.current) clearInterval(tickInterval.current);
  }, []);

  // ── Click / select handlers ──────────────────────────────────────
  const handleClick = useCallback(() => {
    onSelect?.(id);
  }, [id, onSelect]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(id);
  }, [id, onDelete]);

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
      <NodeResizer minWidth={320} minHeight={220} isVisible={!!selected} />

      {/* Color accent bar (left edge) */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', accent)} aria-hidden />

      {/* ── Header (drag handle, title/subtitle, save state, delete) ── */}
      <div
        className="drag-handle flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-black/5 dark:border-white/5 cursor-grab active:cursor-grabbing"
        data-drag-handle
      >
        <div className="mt-0.5 text-black/25 dark:text-white/25 shrink-0" aria-hidden>
          <GripHorizontal className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder="Sin título"
            aria-label="Título de la hoja"
            className="w-full bg-transparent text-[15px] font-semibold text-[#0e1745] dark:text-white placeholder:text-black/25 dark:placeholder:text-white/25 focus:outline-none leading-snug"
          />
          <input
            value={subtitle}
            onChange={(e) => handleSubtitleChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder="Subtítulo opcional…"
            aria-label="Subtítulo de la hoja"
            className="w-full bg-transparent text-[11.5px] text-[#0e1745]/55 dark:text-white/55 placeholder:text-black/20 dark:placeholder:text-white/20 focus:outline-none mt-0.5 font-medium"
          />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleDelete}
            aria-label="Eliminar hoja"
            title="Eliminar hoja"
            className="p-1 rounded-md hover:bg-black/8 dark:hover:bg-white/10 text-black/30 dark:text-white/30 hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* ── TipTap body ─────────────────────────────────────────── */}
      {/*
        nodrag: stops ReactFlow from initiating a drag on mousedown
                inside the editor (would fight TipTap's caret placement).
        onMouseDown stopPropagation: belt-and-suspenders for browsers
                                     that don't honor .nodrag uniformly.
      */}
      <div
        className="nodrag flex-1 min-h-0 overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// ─── Save indicator ──────────────────────────────────────────────────
// Renders the auto-save status in the header. Separated so the parent's
// render isn't a giant ternary and the timestamp formatter is colocated
// with the consumer.
function SaveIndicator({
  state,
  lastSavedAt,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: number | null;
}) {
  if (state === 'saving') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[#1534dc]/80 dark:text-[#8b5cf6]/85 px-1.5 py-0.5 rounded-md bg-[#1534dc]/[0.06] dark:bg-[#8b5cf6]/[0.10]"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
        Guardando…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-rose-700 dark:text-rose-400 px-1.5 py-0.5 rounded-md bg-rose-50 dark:bg-rose-900/20"
        title="No se pudo guardar — reintentá editando o revisá tu conexión"
        role="alert"
      >
        <AlertCircle className="w-3 h-3" aria-hidden />
        No guardó
      </span>
    );
  }
  if (state === 'saved' && lastSavedAt !== null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-700/85 dark:text-emerald-400/85"
        title={`Última escritura: ${new Date(lastSavedAt).toLocaleString('es-CR')}`}
        role="status"
      >
        <Check className="w-3 h-3" aria-hidden />
        Guardado · {formatRelativeAgo(lastSavedAt)}
      </span>
    );
  }
  // idle without a prior save — render nothing
  return null;
}

/**
 * "hace 5 s" / "hace 2 m" / "hace 1 h" — short relative format. We
 * cap the granularity at hours; anything older just shows the date.
 */
function formatRelativeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5)   return 'recién';
  if (sec < 60)  return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `hace ${hr} h`;
  return new Date(ts).toLocaleDateString('es-CR');
}
