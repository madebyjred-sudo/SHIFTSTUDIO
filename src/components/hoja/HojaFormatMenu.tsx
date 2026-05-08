/**
 * HojaFormatMenu — single consolidated docx-style toolbar.
 *
 * Layout (single row, no slide animation):
 *   [Aa ▾]  │  [B][I][U]  │  [🖍 ▾]  │  [⋮ ▾]  │  [✨ AI ▾]
 *
 *   - Aa ▾   heading style (Cuerpo / Título / Subtítulo / Sección)
 *   - B I U  core marks
 *   - 🖍 ▾  highlight palette (5 colors + clear)
 *   - ⋮ ▾   secondary format tools — strike, alignment, lists,
 *           task list, quote, code, link, unlink
 *   - ✨ ▾  AI actions — rewrite, summarize, expand, translate, ask,
 *           "hoja nueva con esto"; runs transformText() and replaces
 *           the selection in-place. ⌘Z undoes if disliked.
 *
 * Below the pill: live word/char count for the active hoja.
 *
 * Implementation notes:
 *   - Each dropdown is portaled to document.body (not nested inside
 *     the pill) so the pill's rounded-corner clipping doesn't hide
 *     them.
 *   - DOM-level commands (document.execCommand) drive most actions.
 *     TipTap's mutation observer parses the resulting tags via the
 *     loaded extensions (Underline, Highlight, Link, TextAlign...).
 *   - TaskList has no execCommand; we insertHTML in the exact shape
 *     TipTap's TaskItem.renderHTML emits so parseHTML picks it up.
 *   - AI replacement uses execCommand('insertText') after focus-
 *     restore — keeps PM history + auto-save in sync.
 */
import {
  forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, Pilcrow, ChevronDown,
  List, ListOrdered, Quote, Code, Highlighter,
  AlignLeft, AlignCenter, AlignRight,
  Link as LinkIcon, Unlink, ListChecks,
  MoreHorizontal, Sparkles, Wand2, FileText, Languages,
  MessageSquareText, Plus, Loader2, Check, X, RefreshCw,
  Maximize2, Eraser,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { transformText } from '@/services/workspaceApi';

const MIN_SELECTION_CHARS = 1;
const MAX_SELECTION_CHARS = 20_000;

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
  range: Range;
  editor: HTMLElement;
}

// Studio's transform endpoint accepts free-form `instruction` + a coarse
// `mode` hint. Pre-bake the verbs so the toolbar's chip taxonomy stays
// stable and prompt details don't leak into UI code.
type ActionKey = 'rewrite' | 'summarize' | 'expand' | 'polish' | 'translate' | 'custom';

const ACTION_INSTRUCTION: Record<Exclude<ActionKey, 'custom'>, string> = {
  rewrite: 'Reescribí este texto manteniendo el sentido pero mejorando el tono y la claridad.',
  summarize: 'Resumí este texto en 2-3 oraciones manteniendo los puntos clave.',
  expand: 'Expandí este texto agregando contexto, ejemplos y matices, sin desviarte del tema.',
  polish: 'Pulí este texto: corregí gramática, ortografía y puntuación, mejorando la legibilidad sin cambiar el sentido.',
  translate: 'Traducí este texto al inglés (o al español si ya está en inglés), manteniendo tono y registro.',
};

// Highlight palette — colors only. The "Sin color" eraser is rendered
// separately so it reads as a distinct action, not just another swatch.
const HIGHLIGHT_COLORS: Array<{ value: string; label: string; preview: string }> = [
  { value: 'rgba(234,179,8,0.45)',  label: 'Amarillo', preview: '#eab308' },
  { value: 'rgba(22,163,74,0.40)',  label: 'Verde',    preview: '#16a34a' },
  { value: 'rgba(225,29,72,0.40)',  label: 'Rosa',     preview: '#e11d48' },
  { value: 'rgba(37,99,235,0.40)',  label: 'Azul',     preview: '#2563eb' },
  { value: 'rgba(168,85,247,0.40)', label: 'Violeta',  preview: '#a855f7' },
];

type BlockKind = 'p' | 'h1' | 'h2' | 'h3';
const BLOCK_OPTIONS: Array<{ value: BlockKind; label: string; icon: React.ElementType; sample: string }> = [
  { value: 'p',  label: 'Cuerpo',    icon: Pilcrow,   sample: 'Texto normal' },
  { value: 'h1', label: 'Título',    icon: Heading1,  sample: 'Encabezado grande' },
  { value: 'h2', label: 'Subtítulo', icon: Heading2,  sample: 'Encabezado medio' },
  { value: 'h3', label: 'Sección',   icon: Heading3,  sample: 'Sub-sección' },
];

interface Props {
  /** Optional — caller can react when user clicks "Hoja nueva con esto". */
  onCreateHojaFromSelection?: (selectionText: string) => void;
  /** Workspace id needed to call /transform endpoint for AI actions. */
  workspaceId: string;
}

type Mode = 'idle' | 'transforming' | 'preview' | 'prompt';
type DropdownKind = null | 'heading' | 'highlight' | 'more' | 'ai';

export function HojaFormatMenu({ onCreateHojaFromSelection, workspaceId }: Props) {
  const [snap, setSnap] = useState<SelectionSnapshot | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [dropdown, setDropdown] = useState<DropdownKind>(null);
  const [stats, setStats] = useState<{ chars: number; words: number } | null>(null);

  // AI transform state
  const [transformResult, setTransformResult] = useState('');
  const [transformError, setTransformError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<ActionKey>('rewrite');
  const [lastInstruction, setLastInstruction] = useState<string | undefined>(undefined);
  const [customPrompt, setCustomPrompt] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);
  const headingBtnRef = useRef<HTMLButtonElement>(null);
  const highlightBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const aiBtnRef = useRef<HTMLButtonElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);

  // ── Detect selection inside a ProseMirror editor ─────────────────
  const captureSelection = useCallback(() => {
    // Don't lose snap while a sub-flow is mid-air. Clicks inside the
    // toolbar (popovers, prompt input) collapse the document
    // selection; otherwise we'd dismiss ourselves.
    const protect = mode !== 'idle' || dropdown !== null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (!protect) setSnap(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    if (text.length < MIN_SELECTION_CHARS) return;
    if (text.length > MAX_SELECTION_CHARS) return;

    let node: Node | null = range.startContainer;
    let editorEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('ProseMirror')) {
        editorEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!editorEl) {
      if (!protect) setSnap(null);
      return;
    }

    setSnap({
      text,
      rect: range.getBoundingClientRect(),
      range: range.cloneRange(),
      editor: editorEl,
    });
  }, [mode, dropdown]);

  useEffect(() => {
    const onSelect = () => requestAnimationFrame(captureSelection);
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, [captureSelection]);

  // Live word/char count for the active editor.
  useLayoutEffect(() => {
    if (!snap) { setStats(null); return; }
    const compute = () => {
      const txt = (snap.editor.innerText ?? '').replace(/​/g, '');
      const chars = txt.length;
      const words = txt.trim().length === 0 ? 0 : txt.trim().split(/\s+/).length;
      setStats({ chars, words });
    };
    compute();
    const mo = new MutationObserver(compute);
    mo.observe(snap.editor, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [snap]);

  // Escape resets state
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMode('idle');
        setDropdown(null);
        setTransformResult('');
        setTransformError(null);
        setSnap(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘K → jump straight to "preguntar" prompt mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMetaK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (!isMetaK) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      let n: Node | null = range.startContainer;
      while (n) {
        if (n instanceof HTMLElement && n.classList.contains('ProseMirror')) {
          e.preventDefault();
          captureSelection();
          setMode('prompt');
          setDropdown(null);
          setTimeout(() => promptInputRef.current?.focus(), 50);
          return;
        }
        n = n.parentNode;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [captureSelection]);

  // Outside click: close popovers + dismiss preview/prompt UI.
  // Toolbar root has data-hoja-toolbar; portaled dropdowns have
  // data-hoja-toolbar-popover so this handler can recognize both.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (menuRef.current?.contains(tgt)) return;
      if (tgt instanceof HTMLElement && tgt.closest('[data-hoja-toolbar-popover]')) return;
      if (dropdown !== null) setDropdown(null);
      if (mode === 'preview' || mode === 'prompt') {
        setMode('idle');
        setTransformResult('');
        setTransformError(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [dropdown, mode]);

  // ── Format command dispatch ──────────────────────────────────────
  const exec = useCallback((cmd: string, arg?: string) => {
    if (!snap) return;
    snap.editor.focus();
    document.execCommand(cmd, false, arg);
  }, [snap]);

  const setBlock = useCallback((kind: BlockKind) => {
    exec('formatBlock', `<${kind}>`);
    setDropdown(null);
  }, [exec]);

  // Highlight: manual <mark> wrap. The Highlight extension only parses
  // <mark>, not <span style>, so execCommand('hiliteColor') is unusable.
  // Three behaviors:
  //
  //   a) Selection is INSIDE an existing <mark> (recolor or clear):
  //      mutate that mark's bg in place (or unwrap if transparent).
  //
  //   b) Selection has NO mark, color is set:
  //      wrap selection in a fresh <mark style="background-color: X">.
  //
  //   c) Selection has NO mark, color is "transparent": no-op.
  const applyHighlight = useCallback((color: string) => {
    if (!snap) return;
    snap.editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    let n: Node | null = range.startContainer;
    let containingMark: HTMLElement | null = null;
    while (n && n !== snap.editor) {
      if (n instanceof HTMLElement && n.tagName === 'MARK') {
        containingMark = n;
        break;
      }
      n = n.parentNode;
    }

    if (containingMark) {
      if (color === 'transparent') {
        const parent = containingMark.parentNode;
        if (parent) {
          while (containingMark.firstChild) {
            parent.insertBefore(containingMark.firstChild, containingMark);
          }
          parent.removeChild(containingMark);
        }
      } else {
        containingMark.style.backgroundColor = color;
        containingMark.setAttribute('data-color', color);
      }
      setDropdown(null);
      return;
    }

    if (color === 'transparent') {
      setDropdown(null);
      return;
    }

    const mark = document.createElement('mark');
    mark.setAttribute('data-color', color);
    mark.style.backgroundColor = color;
    try {
      range.surroundContents(mark);
    } catch {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
    setDropdown(null);
  }, [snap]);

  const insertTaskList = useCallback(() => {
    if (!snap) return;
    snap.editor.focus();
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    const safe = text
      ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : '';
    const html = [
      '<ul data-type="taskList">',
      '<li data-type="taskItem" data-checked="false">',
      `<label><input type="checkbox"><span></span></label>`,
      `<div><p>${safe}</p></div>`,
      '</li>',
      '</ul>',
    ].join('');
    document.execCommand('insertHTML', false, html);
    setDropdown(null);
  }, [snap]);

  const handleLink = useCallback(() => {
    if (!snap) return;
    const sel = window.getSelection();
    const current = sel ? sel.toString().trim() : '';
    let existingHref = '';
    if (sel && sel.rangeCount > 0) {
      let n: Node | null = sel.getRangeAt(0).startContainer;
      while (n && n !== snap.editor) {
        if (n instanceof HTMLAnchorElement) { existingHref = n.href; break; }
        n = n.parentNode;
      }
    }
    const url = window.prompt('URL del enlace (vacío para quitar):', existingHref);
    if (url === null) return;
    snap.editor.focus();
    if (url.trim() === '') {
      document.execCommand('unlink');
    } else if (current.length === 0) {
      document.execCommand('insertHTML', false,
        `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`);
    } else {
      document.execCommand('createLink', false, url);
    }
    setDropdown(null);
  }, [snap]);

  // ── AI transform ─────────────────────────────────────────────────
  const runTransform = useCallback(async (action: ActionKey, instruction?: string) => {
    if (!snap) return;
    const baseInstruction = action === 'custom' ? instruction : ACTION_INSTRUCTION[action];
    if (!baseInstruction) return;
    setMode('transforming');
    setTransformError(null);
    setLastAction(action);
    setLastInstruction(action === 'custom' ? instruction : undefined);
    setDropdown(null);
    try {
      const r = await transformText(workspaceId, {
        text: snap.text,
        instruction: baseInstruction,
        mode: action,
      });
      setTransformResult(r.text);
      setMode('preview');
    } catch (err) {
      setTransformError((err as Error).message);
      setMode('idle');
    }
  }, [snap, workspaceId]);

  const applyPreview = useCallback(() => {
    if (!snap || !transformResult) return;
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(snap.range);
    }
    snap.editor.focus();
    document.execCommand('insertText', false, transformResult);
    setMode('idle');
    setTransformResult('');
    setSnap(null);
  }, [snap, transformResult]);

  const submitPrompt = useCallback(() => {
    const trimmed = customPrompt.trim();
    if (!trimmed) return;
    setCustomPrompt('');
    void runTransform('custom', trimmed);
  }, [customPrompt, runTransform]);

  // ── Render ───────────────────────────────────────────────────────
  if (!snap) return null;

  // Auto-sized toolbar: the pill width tracks its content (no fixed
  // width = no dead space on the right). We center using transform:
  // translateX(-50%) on the outer container, with `left` set to the
  // visual center point. Clamping uses an ESTIMATED width per mode
  // so the centered pill never overflows the viewport.
  const estimatedW = mode === 'preview' ? 480 : mode === 'prompt' ? 400 : 320;
  const ESTIMATED_H = mode === 'preview' ? 200 : mode === 'prompt' ? 56 : 40;
  const padding = 10;

  let top = snap.rect.top - ESTIMATED_H - padding;
  if (top < 8) top = snap.rect.bottom + padding;

  let centerX = snap.rect.left + snap.rect.width / 2;
  const halfW = estimatedW / 2;
  if (centerX - halfW < padding) centerX = halfW + padding;
  if (centerX + halfW > window.innerWidth - padding) {
    centerX = window.innerWidth - halfW - padding;
  }

  return createPortal(
    <AnimatePresence>
      {/* Outer wrapper handles positioning + the static
          translateX(-50%) that centers the pill on centerX. We CAN'T
          put translateX on the inner motion.div because motion
          overwrites the `transform` style with its own animated
          y/scale matrix every frame. Two-layer split = clean. */}
      <div
        key="hoja-toolbar"
        ref={menuRef}
        data-hoja-toolbar=""
        style={{
          top,
          left: centerX,
          transform: 'translateX(-50%)',
          position: 'fixed',
          zIndex: 210,
        }}
        onMouseDown={(e) => e.preventDefault()}
        role="toolbar"
        aria-label="Formato de texto"
      >
        <motion.div
          initial={{ opacity: 0, y: 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 2, scale: 0.97 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
        <div
          className="rounded-2xl border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-[#1c1c1c] shadow-[0_10px_30px_rgba(14,23,69,0.18),0_2px_8px_rgba(14,23,69,0.10)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.4)]"
          style={{ maxWidth: 'min(480px, calc(100vw - 20px))' }}
        >
          {mode === 'idle' && (
            <div className="flex items-center gap-0.5 py-1 pl-3 pr-2.5">
              <ToolbarBtn
                ref={headingBtnRef}
                onClick={() => setDropdown((v) => v === 'heading' ? null : 'heading')}
                title="Estilo de párrafo"
                ariaLabel="Cambiar estilo de párrafo"
                className="gap-0.5"
                active={dropdown === 'heading'}
              >
                <span className="text-[13px] font-semibold leading-none tracking-tight">Aa</span>
                <ChevronDown size={10} className={cn('opacity-60 transition-transform', dropdown === 'heading' && 'rotate-180')} aria-hidden />
              </ToolbarBtn>

              <Sep />

              <ToolbarBtn onClick={() => exec('bold')} title="Negrita (⌘B)" ariaLabel="Negrita"><Bold size={13} aria-hidden /></ToolbarBtn>
              <ToolbarBtn onClick={() => exec('italic')} title="Itálica (⌘I)" ariaLabel="Itálica"><Italic size={13} aria-hidden /></ToolbarBtn>
              <ToolbarBtn onClick={() => exec('underline')} title="Subrayado (⌘U)" ariaLabel="Subrayado"><UnderlineIcon size={13} aria-hidden /></ToolbarBtn>

              <Sep />

              <ToolbarBtn
                ref={highlightBtnRef}
                onClick={() => setDropdown((v) => v === 'highlight' ? null : 'highlight')}
                title="Resaltar"
                ariaLabel="Resaltar texto"
                className="gap-0.5"
                active={dropdown === 'highlight'}
              >
                <Highlighter size={13} aria-hidden />
                <ChevronDown size={10} className={cn('opacity-60 transition-transform', dropdown === 'highlight' && 'rotate-180')} aria-hidden />
              </ToolbarBtn>

              <Sep />

              <ToolbarBtn
                ref={moreBtnRef}
                onClick={() => setDropdown((v) => v === 'more' ? null : 'more')}
                title="Más herramientas"
                ariaLabel="Más herramientas de formato"
                active={dropdown === 'more'}
              >
                <MoreHorizontal size={13} aria-hidden />
              </ToolbarBtn>

              <Sep />

              <ToolbarBtn
                ref={aiBtnRef}
                onClick={() => setDropdown((v) => v === 'ai' ? null : 'ai')}
                title="Acciones de AI"
                ariaLabel="Acciones de AI"
                className="gap-1 px-2 text-[#1534dc] dark:text-[#8b5cf6] font-semibold"
                active={dropdown === 'ai'}
              >
                <Sparkles size={13} aria-hidden />
                <span className="text-[11px]">AI</span>
                <ChevronDown size={10} className={cn('opacity-60 transition-transform', dropdown === 'ai' && 'rotate-180')} aria-hidden />
              </ToolbarBtn>
            </div>
          )}

          {mode === 'transforming' && (
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <Loader2 size={14} className="animate-spin text-[#1534dc]" aria-hidden />
              <span className="text-[12.5px] font-semibold text-[#1534dc] dark:text-[#8b5cf6]">
                Pensando…
              </span>
            </div>
          )}

          {mode === 'prompt' && (
            <div className="flex items-center gap-2 px-2.5 py-2">
              <Sparkles size={13} className="text-[#1534dc] shrink-0" aria-hidden />
              <input
                ref={promptInputRef}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
                }}
                placeholder="Pedí una transformación…"
                aria-label="Instrucción personalizada"
                className="flex-1 bg-transparent text-[12.5px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/35 focus:outline-none"
              />
              <button
                type="button"
                onClick={submitPrompt}
                disabled={!customPrompt.trim()}
                aria-label="Ejecutar instrucción"
                className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#1534dc] text-white hover:bg-[#1028b8] disabled:opacity-40 transition-colors inline-flex items-center gap-1"
              >
                <Sparkles size={11} aria-hidden /> Enviar
              </button>
              <button
                type="button"
                onClick={() => { setMode('idle'); setCustomPrompt(''); }}
                aria-label="Cancelar"
                className="p-1 rounded text-[#0e1745]/45 dark:text-white/45 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          )}

          {mode === 'preview' && (
            <div className="overflow-hidden rounded-2xl">
              <div className="px-3 py-1.5 border-b border-emerald-200/30 dark:border-emerald-700/30 bg-emerald-50/60 dark:bg-emerald-900/20 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                <Sparkles size={11} aria-hidden /> Propuesta
              </div>
              <div className="px-3 py-2.5 max-h-[220px] overflow-y-auto">
                <p className="text-[12.5px] leading-relaxed text-[#0e1745] dark:text-white whitespace-pre-wrap">
                  {transformResult}
                </p>
              </div>
              <div className="flex items-center justify-end gap-1 px-2 py-1.5 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => void runTransform(lastAction, lastInstruction)}
                  aria-label="Volver a generar"
                  className="px-2 py-1 rounded-md text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] inline-flex items-center gap-1 transition-colors"
                >
                  <RefreshCw size={11} aria-hidden /> Reescribir
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('idle'); setTransformResult(''); }}
                  aria-label="Descartar propuesta"
                  className="px-2 py-1 rounded-md text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] inline-flex items-center gap-1 transition-colors"
                >
                  <X size={11} aria-hidden /> Descartar
                </button>
                <button
                  type="button"
                  onClick={applyPreview}
                  aria-label="Aplicar propuesta"
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 transition-colors"
                >
                  <Check size={11} aria-hidden /> Aplicar
                </button>
              </div>
            </div>
          )}

          {transformError && (
            <div className="px-3 py-1.5 text-[11px] text-rose-600 dark:text-rose-400 border-t border-rose-300/30" role="alert">
              {transformError}
            </div>
          )}
        </div>

        {stats && mode === 'idle' && (
          <div className="mt-1 flex items-center justify-center gap-2 text-[10px] tabular-nums text-[#0e1745]/45 dark:text-white/40 px-2">
            <span>{stats.words.toLocaleString('es-CR')} palabras</span>
            <span className="opacity-60">·</span>
            <span>{stats.chars.toLocaleString('es-CR')} caracteres</span>
          </div>
        )}
        </motion.div>
      </div>

      {/* Portaled dropdowns (siblings of the pill at document.body
          level) — avoids the pill's rounded-corner clipping. */}
      {dropdown === 'heading' && headingBtnRef.current && (
        <DropdownPortal anchor={headingBtnRef.current}>
          {BLOCK_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBlock(opt.value)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[#1534dc]/[0.06] dark:hover:bg-[#8b5cf6]/[0.10] transition-colors"
              >
                <Icon size={14} className="text-[#1534dc] dark:text-[#8b5cf6] shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold text-[#0e1745] dark:text-white">{opt.label}</div>
                  <div className="text-[10px] text-[#0e1745]/50 dark:text-white/50 truncate">{opt.sample}</div>
                </div>
              </button>
            );
          })}
        </DropdownPortal>
      )}

      {dropdown === 'highlight' && highlightBtnRef.current && (
        <DropdownPortal anchor={highlightBtnRef.current} variant="row">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => applyHighlight(c.value)}
              title={c.label}
              aria-label={`Resaltar ${c.label}`}
              className="w-6 h-6 rounded-md border border-black/[0.08] dark:border-white/[0.12] transition-transform hover:scale-110 active:scale-95"
              style={{ background: c.preview }}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-[#0e1745]/[0.10] dark:bg-white/[0.12]" aria-hidden />
          <button
            type="button"
            onClick={() => applyHighlight('transparent')}
            title="Sin color (quitar resaltado)"
            aria-label="Quitar resaltado"
            className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.12] text-[10.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-rose-50 dark:hover:bg-rose-900/20 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300/40 transition-colors"
          >
            <Eraser size={11} aria-hidden />
            <span>Sin color</span>
          </button>
        </DropdownPortal>
      )}

      {dropdown === 'more' && moreBtnRef.current && (
        <DropdownPortal anchor={moreBtnRef.current}>
          <DropdownItem onClick={() => exec('strikeThrough')} icon={<Strikethrough size={13} aria-hidden />}>Tachado</DropdownItem>
          <DropdownSep />
          <DropdownItem onClick={() => exec('justifyLeft')} icon={<AlignLeft size={13} aria-hidden />}>Alinear izq.</DropdownItem>
          <DropdownItem onClick={() => exec('justifyCenter')} icon={<AlignCenter size={13} aria-hidden />}>Centrar</DropdownItem>
          <DropdownItem onClick={() => exec('justifyRight')} icon={<AlignRight size={13} aria-hidden />}>Alinear der.</DropdownItem>
          <DropdownSep />
          <DropdownItem onClick={() => exec('insertUnorderedList')} icon={<List size={13} aria-hidden />}>Lista con viñetas</DropdownItem>
          <DropdownItem onClick={() => exec('insertOrderedList')} icon={<ListOrdered size={13} aria-hidden />}>Lista numerada</DropdownItem>
          <DropdownItem onClick={insertTaskList} icon={<ListChecks size={13} aria-hidden />}>Lista de tareas</DropdownItem>
          <DropdownSep />
          <DropdownItem onClick={() => exec('formatBlock', '<blockquote>')} icon={<Quote size={13} aria-hidden />}>Cita</DropdownItem>
          <DropdownItem onClick={() => exec('formatBlock', '<pre>')} icon={<Code size={13} aria-hidden />}>Bloque de código</DropdownItem>
          <DropdownSep />
          <DropdownItem onClick={handleLink} icon={<LinkIcon size={13} aria-hidden />}>Enlace…</DropdownItem>
          <DropdownItem onClick={() => exec('unlink')} icon={<Unlink size={13} aria-hidden />}>Quitar enlace</DropdownItem>
        </DropdownPortal>
      )}

      {dropdown === 'ai' && aiBtnRef.current && (
        <DropdownPortal anchor={aiBtnRef.current}>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#1534dc]/70 dark:text-[#8b5cf6]/80">
            AI
          </div>
          <DropdownItem onClick={() => void runTransform('rewrite')}    icon={<Wand2 size={13} aria-hidden />}>Reescribir</DropdownItem>
          <DropdownItem onClick={() => void runTransform('summarize')}  icon={<FileText size={13} aria-hidden />}>Resumir</DropdownItem>
          <DropdownItem onClick={() => void runTransform('expand')}     icon={<Maximize2 size={13} aria-hidden />}>Expandir</DropdownItem>
          <DropdownItem onClick={() => void runTransform('polish')}     icon={<Sparkles size={13} aria-hidden />}>Pulir</DropdownItem>
          <DropdownItem onClick={() => void runTransform('translate')}  icon={<Languages size={13} aria-hidden />}>Traducir</DropdownItem>
          <DropdownSep />
          <DropdownItem
            onClick={() => {
              setDropdown(null);
              setMode('prompt');
              setTimeout(() => promptInputRef.current?.focus(), 50);
            }}
            icon={<MessageSquareText size={13} aria-hidden />}
            shortcut="⌘K"
          >
            Pedir transformación…
          </DropdownItem>
          {onCreateHojaFromSelection && (
            <>
              <DropdownSep />
              <DropdownItem
                onClick={() => {
                  if (snap) onCreateHojaFromSelection(snap.text);
                  setDropdown(null);
                  setSnap(null);
                }}
                icon={<Plus size={13} aria-hidden />}
              >
                Hoja nueva con esto
              </DropdownItem>
            </>
          )}
        </DropdownPortal>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Building blocks ────────────────────────────────────────────────

interface ToolbarBtnProps {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  className?: string;
  active?: boolean;
}

const ToolbarBtn = forwardRef<HTMLButtonElement, ToolbarBtnProps>(
  function ToolbarBtn({ children, onClick, title, ariaLabel, className, active }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        title={title}
        aria-label={ariaLabel ?? title}
        className={cn(
          'inline-flex items-center justify-center min-w-[26px] h-7 px-1.5 rounded-md text-[#0e1745]/70 dark:text-white/70',
          'hover:bg-[#1534dc]/[0.08] dark:hover:bg-[#8b5cf6]/[0.12] hover:text-[#1534dc] dark:hover:text-[#8b5cf6]',
          'active:scale-95 transition-all',
          active && 'bg-[#1534dc]/[0.10] dark:bg-[#8b5cf6]/[0.16] text-[#1534dc] dark:text-[#8b5cf6]',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

function DropdownPortal({
  anchor,
  children,
  variant = 'col',
}: {
  anchor: HTMLElement;
  children: React.ReactNode;
  variant?: 'col' | 'row';
}) {
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6;
  const w = variant === 'row' ? 280 : 220;
  const baseLeft = variant === 'row' ? r.right - w : r.left;
  let left = baseLeft;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;

  return (
    <motion.div
      data-hoja-toolbar-popover=""
      initial={{ opacity: 0, y: -3, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -2, scale: 0.97 }}
      transition={{ duration: 0.12 }}
      onMouseDown={(e) => e.preventDefault()}
      style={{ top, left, position: 'fixed', zIndex: 220 }}
      className={cn(
        'rounded-lg border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-[#1c1c1c] shadow-[0_8px_24px_rgba(14,23,69,0.18)]',
        variant === 'col' ? 'py-1 min-w-[200px]' : 'flex items-center gap-1 py-1.5 px-2',
      )}
    >
      {children}
    </motion.div>
  );
}

function DropdownItem({
  children,
  onClick,
  icon,
  shortcut,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[#1534dc]/[0.06] dark:hover:bg-[#8b5cf6]/[0.10] transition-colors"
    >
      {icon && <span className="text-[#1534dc] dark:text-[#8b5cf6] shrink-0">{icon}</span>}
      <span className="flex-1 truncate text-[12px] font-medium text-[#0e1745] dark:text-white">{children}</span>
      {shortcut && (
        <span className="text-[10px] tabular-nums text-[#0e1745]/40 dark:text-white/40">{shortcut}</span>
      )}
    </button>
  );
}

function DropdownSep() {
  return <div className="my-1 h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.06]" aria-hidden />;
}

function Sep() {
  return <span className="mx-0.5 self-center h-5 w-px bg-[#0e1745]/[0.08] dark:bg-white/[0.10]" aria-hidden />;
}

// ─── HTML escape helpers ─────────────────────────────────────────────
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
