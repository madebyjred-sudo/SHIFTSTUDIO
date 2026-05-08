/**
 * HojaSlashExtension — TipTap slash-command system for hoja editors.
 *
 * Type `/` and a popup appears with content-block commands. The catalog
 * is intentionally generic (Studio is creative/strategic, not legislative)
 * and is wired into TipTap via `@tiptap/suggestion`. The popup itself is
 * a React component portaled to document.body and anchored to the caret.
 *
 * Available commands:
 *   /h1 /h2 /h3       headings
 *   /lista            bulleted list
 *   /numerada         ordered list
 *   /tareas           task list (interactive checkboxes)
 *   /cita             blockquote
 *   /codigo           code block
 *   /divisor          horizontal rule
 *   /enlace           insert link (prompts for URL)
 *
 * Architecture:
 *   - The TipTap Node extension uses @tiptap/suggestion for the trigger
 *     plumbing (`/` char, range tracking, command exec).
 *   - The popup is rendered via portal — we use TipTap's `clientRect` to
 *     anchor it to the caret.
 *   - Each command receives `{ editor, range }` so it can both delete the
 *     `/query` trigger and insert the requested block at the right spot.
 */
import { Extension } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/react';
import { ReactRenderer } from '@tiptap/react';
import { useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, Code2, Minus, Link as LinkIcon, Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Command catalog ──────────────────────────────────────────────────
//
// Items declare title/subtitle/icon only; the actual run logic lives in
// the extension's `command` callback below. This keeps the menu shape
// data-only (testable in isolation) and the editor mutations colocated
// with TipTap.

export type SlashCommandKey =
  | 'h1' | 'h2' | 'h3'
  | 'bulletList' | 'orderedList' | 'taskList'
  | 'blockquote' | 'codeBlock' | 'divider' | 'link';

export interface SlashItem {
  key: SlashCommandKey;
  title: string;
  subtitle: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Optional alias keywords for fuzzy filter (e.g. "h1" matches "titulo"). */
  aliases?: string[];
}

const CATALOG: SlashItem[] = [
  {
    key: 'h1',
    title: 'Título',
    subtitle: 'Encabezado grande',
    Icon: Heading1,
    aliases: ['titulo', 'heading1'],
  },
  {
    key: 'h2',
    title: 'Subtítulo',
    subtitle: 'Encabezado medio',
    Icon: Heading2,
    aliases: ['subtitulo', 'heading2'],
  },
  {
    key: 'h3',
    title: 'Sección',
    subtitle: 'Encabezado pequeño',
    Icon: Heading3,
    aliases: ['seccion', 'heading3'],
  },
  {
    key: 'bulletList',
    title: 'Lista con viñetas',
    subtitle: 'Una idea por línea, sin orden',
    Icon: List,
    aliases: ['lista', 'bullet'],
  },
  {
    key: 'orderedList',
    title: 'Lista numerada',
    subtitle: 'Pasos en orden',
    Icon: ListOrdered,
    aliases: ['numerada', 'numbered'],
  },
  {
    key: 'taskList',
    title: 'Lista de tareas',
    subtitle: 'Casillas interactivas para to-dos',
    Icon: ListChecks,
    aliases: ['tareas', 'todo', 'check'],
  },
  {
    key: 'blockquote',
    title: 'Cita',
    subtitle: 'Bloque destacado para una referencia',
    Icon: Quote,
    aliases: ['quote', 'cita'],
  },
  {
    key: 'codeBlock',
    title: 'Bloque de código',
    subtitle: 'Texto monoespaciado preformateado',
    Icon: Code2,
    aliases: ['codigo', 'code'],
  },
  {
    key: 'divider',
    title: 'Divisor',
    subtitle: 'Línea horizontal entre secciones',
    Icon: Minus,
    aliases: ['hr', 'separador'],
  },
  {
    key: 'link',
    title: 'Enlace',
    subtitle: 'Insertar un hipervínculo',
    Icon: LinkIcon,
    aliases: ['link', 'url'],
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return CATALOG;
  return CATALOG.filter(
    (it) =>
      it.key.toLowerCase().includes(q) ||
      it.title.toLowerCase().includes(q) ||
      (it.aliases?.some((a) => a.includes(q)) ?? false),
  );
}

/**
 * Dispatcher: run a slash command against the editor at a given range.
 * Each command first deletes the `/query` trigger then inserts the
 * appropriate block. Centralized here so the React popup stays dumb.
 */
function runCommand(item: SlashItem, args: { editor: Editor; range: Range }): void {
  const { editor, range } = args;
  const chain = editor.chain().focus().deleteRange(range);

  switch (item.key) {
    case 'h1':
      chain.setNode('heading', { level: 1 }).run();
      return;
    case 'h2':
      chain.setNode('heading', { level: 2 }).run();
      return;
    case 'h3':
      chain.setNode('heading', { level: 3 }).run();
      return;
    case 'bulletList':
      chain.toggleBulletList().run();
      return;
    case 'orderedList':
      chain.toggleOrderedList().run();
      return;
    case 'taskList':
      chain.toggleTaskList().run();
      return;
    case 'blockquote':
      chain.toggleBlockquote().run();
      return;
    case 'codeBlock':
      chain.toggleCodeBlock().run();
      return;
    case 'divider':
      chain.setHorizontalRule().run();
      return;
    case 'link': {
      // Prompt for URL; insert as link mark over the next typed text or
      // wrap the current selection. Keep simple — a richer modal can be
      // wired later once we have a URL-validation story.
      chain.run();
      const url = window.prompt('URL del enlace:', 'https://');
      if (!url || url === 'https://') return;
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] })
        .insertContent(' ')
        .run();
      return;
    }
  }
}

// ─── Popup component ──────────────────────────────────────────────────

interface PopupHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface PopupProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect: (() => DOMRect | null) | null;
}

const SlashPopup = forwardRef<PopupHandle, PopupProps>(({ items, command, clientRect }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setSelectedIndex(0), [items]);

  // Track caret position for the popup anchor. ReactRenderer calls
  // updateProps on every keystroke, but the clientRect closure stays
  // fresh, so we re-measure on each render.
  useEffect(() => {
    const r = clientRect?.();
    if (r) {
      setPos({ top: r.bottom + 6, left: r.left });
    }
  }, [clientRect, items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'Enter') {
        if (items[selectedIndex]) command(items[selectedIndex]);
        return true;
      }
      return false;
    },
  }));

  if (!pos) return null;

  if (items.length === 0) {
    return createPortal(
      <div
        className="fixed z-[250] rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-xl px-3 py-2 text-[12px] text-[#0e1745]/45 dark:text-white/40"
        style={{ top: pos.top, left: pos.left }}
      >
        <Search className="w-3 h-3 inline mr-1.5" aria-hidden />
        Sin coincidencias
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed z-[250] rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-xl py-1 min-w-[280px] max-w-[340px] overflow-hidden"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()} // keep editor focus
      role="listbox"
      aria-label="Bloques disponibles"
    >
      {items.map((item, i) => {
        const Icon = item.Icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(i)}
            role="option"
            aria-selected={i === selectedIndex}
            className={cn(
              'w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors',
              i === selectedIndex
                ? 'bg-[#1534dc]/10 dark:bg-[#8b5cf6]/15'
                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
            )}
          >
            <div className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 bg-black/5 dark:bg-white/8 text-[#0e1745]/70 dark:text-white/70">
              <Icon className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-[#0e1745] dark:text-white">
                {item.title}
              </span>
              <span className="block text-[11px] text-[#0e1745]/50 dark:text-white/40 leading-snug truncate">
                {item.subtitle}
              </span>
            </div>
          </button>
        );
      })}
    </div>,
    document.body,
  );
});
SlashPopup.displayName = 'SlashPopup';

// ─── Extension factory ────────────────────────────────────────────────
//
// The factory pattern was inherited from CL2 where the consumer needed to
// inject `onRun` callbacks (modals, transforms, etc.). Studio's catalog
// is self-contained so we no longer need a closure over consumer state —
// but we keep the factory shape so HojaNode can still pass through future
// hooks if Studio grows AI-powered slash items later (e.g. /reescribir).

export interface SlashExtensionOptions {
  /** Optional consumer hook fired AFTER the editor mutation lands. Useful
   *  for triggering an immediate save or analytics event without having
   *  to monkey-patch the editor. */
  onCommand?: (item: SlashItem) => void;
}

export function createSlashExtension(opts: SlashExtensionOptions = {}) {
  const { onCommand } = opts;

  return Extension.create({
    name: 'hojaSlash',

    addOptions() {
      return {
        suggestion: {
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: { item: SlashItem } }) => {
            runCommand(props.item, { editor, range });
            onCommand?.(props.item);
          },
        } as Partial<SuggestionOptions>,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
          items: ({ query }: { query: string }) => filterItems(query),
          render: () => {
            let renderer: ReactRenderer<PopupHandle> | null = null;

            return {
              onStart: (props) => {
                renderer = new ReactRenderer(SlashPopup, {
                  props: {
                    items: props.items,
                    command: (item: SlashItem) => props.command({ item }),
                    clientRect: props.clientRect ?? null,
                  },
                  editor: props.editor,
                });
              },
              onUpdate: (props) => {
                renderer?.updateProps({
                  items: props.items,
                  command: (item: SlashItem) => props.command({ item }),
                  clientRect: props.clientRect ?? null,
                });
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') {
                  renderer?.destroy();
                  return true;
                }
                return renderer?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                renderer?.destroy();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}
