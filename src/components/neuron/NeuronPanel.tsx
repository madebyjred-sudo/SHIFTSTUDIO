/**
 * @file NeuronPanel.tsx
 * @description "Lo que Shifty sabe sobre vos" — surfaces the user's
 * Cerebro neuron memory (per-user markdown files stored under
 * realm=shift, keyed by email).
 *
 * UI tour (post-2026-05-11 refactor):
 *
 *   • Header: editorial title (serif Lora italic) + sub explaining
 *     cross-app sharing (Shifty in Studio, Ana in Status). "Nueva
 *     nota" primary action + onboarding re-entry + close.
 *   • Counters row: file count + storage with visual progress bars.
 *     Bars color-shift green → amber → rose at 50% / 80% / 100%.
 *   • Tabs: Files (folder tree + editor) | History (audit log).
 *   • Files tab: left = folder tree with expand/collapse, hover "+"
 *     on folder to create file inside; right = markdown editor with
 *     path header, saved-state badge, trash, size+hint footer.
 *   • Cmd/Ctrl+S inside the textarea saves without losing cursor.
 *
 * State machine per tab is intentionally local — opening the modal
 * triggers list/history fetches lazily, and selecting a file fetches
 * its content on demand. We do NOT keep the whole content corpus in
 * memory; some users may approach the 5 MB quota.
 *
 * Errors are surfaced with status-code-aware copy (401 → re-auth, 502 →
 * Cerebro down, generic → "intenta de nuevo") because the neuron API
 * uses these distinctions meaningfully (see neuronClient.NeuronApiError).
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Brain,
  X,
  Trash2,
  History as HistoryIcon,
  Files as FilesIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
  Copy,
  Check,
  Sparkles,
  Folder,
  FolderOpen,
  FileText,
  FilePlus,
  Plus,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listNeuronFiles,
  getNeuronFile,
  saveNeuronFile,
  deleteNeuronFile,
  getNeuronHistory,
  NeuronApiError,
  type NeuronFile,
  type NeuronQuota,
  type NeuronHistoryEntry,
} from '@/services/neuronClient';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Optional handler that re-enters the first-login onboarding wizard.
   * Surfaced as a secondary button in the header — useful when a user
   * skipped or partially completed onboarding and wants to revisit.
   * When omitted (e.g. tests, embedded contexts), the button is hidden.
   */
  onReopenOnboarding?: () => void;
}

type Tab = 'files' | 'history';
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `hace ${d} d`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function errorMessage(e: unknown): { title: string; detail: string } {
  if (e instanceof NeuronApiError) {
    if (e.status === 401) {
      return {
        title: 'Sesión vencida',
        detail: 'Inicia sesión otra vez para ver tu memoria.',
      };
    }
    if (e.status === 502) {
      return {
        title: 'Cerebro inalcanzable',
        detail: 'No pude contactar el servicio de memoria. Intenta de nuevo en un momento.',
      };
    }
    if (e.status === 404) {
      return {
        title: 'No encontrado',
        detail: 'El archivo ya no existe o nunca existió.',
      };
    }
    return {
      title: `Error ${e.status}`,
      detail: 'Algo salió mal. Intenta de nuevo.',
    };
  }
  return {
    title: 'Error',
    detail: e instanceof Error ? e.message : 'Algo salió mal.',
  };
}

/**
 * Normalize a user-supplied path/name into a valid neuron file path.
 *
 * Rules:
 *   - Always rooted at `/memories/`
 *   - Trailing `.md` is added if absent
 *   - Leading/trailing slashes and whitespace stripped per segment
 *   - Empty segments collapsed (`foo//bar` → `foo/bar`)
 *   - Returns null if the result has no filename
 *
 * Examples:
 *   "nota1"             → "/memories/nota1.md"
 *   "proyectos/cl2"     → "/memories/proyectos/cl2.md"
 *   "/memories/foo.md"  → "/memories/foo.md"
 *   "proyectos/"        → null
 */
export function normalizeNeuronPath(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  // Strip explicit /memories/ prefix if user typed it
  const stripped = raw.replace(/^\/+/, '').replace(/^memories\//i, '');
  const parts = stripped
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  // If the last segment has no extension, append .md
  const withExt = /\.[a-z0-9]+$/i.test(last) ? last : `${last}.md`;
  parts[parts.length - 1] = withExt;
  return `/memories/${parts.join('/')}`;
}

// ─── Folder tree types + builder ──────────────────────────────────────

interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  size_bytes: number;
  updated_at: string;
}

interface TreeFolder {
  type: 'folder';
  name: string;
  /** Folder's own absolute path with trailing slash, e.g. `/memories/proyectos/` */
  path: string;
  children: Array<TreeFile | TreeFolder>;
}

type TreeNode = TreeFile | TreeFolder;

/**
 * Build a folder tree from the flat NeuronFile[] array.
 *
 * Each `file.path` is parsed as `/segment1/segment2/.../filename.ext`.
 * Folders are created lazily as we encounter them. We sort folders
 * before files inside each level, and alphabetically within each
 * category — this matches the muscle memory of any file explorer.
 *
 * Note: empty folders never appear (the API has no concept of empty
 * directories — folders are derived from file paths).
 */
function buildTree(files: NeuronFile[]): TreeFolder {
  const root: TreeFolder = {
    type: 'folder',
    name: '',
    path: '/',
    children: [],
  };
  for (const f of files) {
    const parts = f.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const folderPath = `/${parts.slice(0, i + 1).join('/')}/`;
      let next = cursor.children.find(
        (c): c is TreeFolder => c.type === 'folder' && c.name === segment,
      );
      if (!next) {
        next = {
          type: 'folder',
          name: segment,
          path: folderPath,
          children: [],
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
    const fileName = parts[parts.length - 1];
    cursor.children.push({
      type: 'file',
      name: fileName,
      path: f.path,
      size_bytes: f.size_bytes,
      updated_at: f.updated_at,
    });
  }
  // Recursively sort
  function sort(node: TreeFolder) {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach((c) => {
      if (c.type === 'folder') sort(c);
    });
  }
  sort(root);
  return root;
}

/**
 * Walk the tree collecting every folder path. Used to seed the
 * "expanded folders" set on first load — default is "all expanded"
 * to match CL2's UX (no hidden notes until user actively collapses).
 */
function collectAllFolderPaths(node: TreeFolder, acc: Set<string>): Set<string> {
  acc.add(node.path);
  for (const child of node.children) {
    if (child.type === 'folder') collectAllFolderPaths(child, acc);
  }
  return acc;
}

// ─── Subcomponents ────────────────────────────────────────────────────

/**
 * Counters row — file count + storage.
 *
 * Two stacked compact rows, each with a label + value + thin progress
 * bar. Progress color shifts at 50% / 80% thresholds. We render even
 * when `quota` is null (placeholder bars) so the row's height is
 * stable while the first request lands.
 */
function CountersRow({ quota }: { quota: NeuronQuota | null }) {
  const filesPct = quota
    ? Math.min(100, (quota.file_count / Math.max(quota.max_files, 1)) * 100)
    : 0;
  const bytesPct = quota
    ? Math.min(100, (quota.used_bytes / Math.max(quota.max_bytes, 1)) * 100)
    : 0;

  function barColor(pct: number) {
    if (pct < 50) return 'bg-gradient-to-r from-emerald-400 to-emerald-500';
    if (pct < 80) return 'bg-gradient-to-r from-amber-400 to-amber-500';
    return 'bg-gradient-to-r from-rose-400 to-rose-500';
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-[11px] font-medium">
          <span className="text-[#0e1745]/55 dark:text-white/55">archivos</span>
          <span className="font-mono text-[#0e1745]/80 dark:text-white/80 tabular-nums">
            {quota ? `${quota.file_count} / ${quota.max_files}` : '— / —'}
          </span>
        </div>
        <div className="h-1.5 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
          <motion.div
            className={cn('h-full rounded-full', barColor(filesPct))}
            initial={{ width: 0 }}
            animate={{ width: `${filesPct}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-[11px] font-medium">
          <span className="text-[#0e1745]/55 dark:text-white/55">uso</span>
          <span className="font-mono text-[#0e1745]/80 dark:text-white/80 tabular-nums">
            {quota
              ? `${formatBytes(quota.used_bytes)} / ${formatBytes(quota.max_bytes)}`
              : '— / —'}
          </span>
        </div>
        <div className="h-1.5 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
          <motion.div
            className={cn('h-full rounded-full', barColor(bytesPct))}
            initial={{ width: 0 }}
            animate={{ width: `${bytesPct}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Folder tree rendering ─────────────────────────────────────────────

interface TreeViewProps {
  root: TreeFolder;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleFolder: (folderPath: string) => void;
  onSelectFile: (path: string) => void;
  onAddInFolder: (folderPath: string) => void;
}

function TreeView({
  root,
  expanded,
  selectedPath,
  onToggleFolder,
  onSelectFile,
  onAddInFolder,
}: TreeViewProps) {
  return (
    <ul className="py-1.5" role="tree">
      {root.children.map((child) => (
        <TreeNodeView
          key={`${child.type}:${child.path}`}
          node={child}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
          onAddInFolder={onAddInFolder}
        />
      ))}
    </ul>
  );
}

interface TreeNodeProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleFolder: (folderPath: string) => void;
  onSelectFile: (path: string) => void;
  onAddInFolder: (folderPath: string) => void;
}

function TreeNodeView({
  node,
  depth,
  expanded,
  selectedPath,
  onToggleFolder,
  onSelectFile,
  onAddInFolder,
}: TreeNodeProps) {
  // 12px base padding + 14px per level — enough to read the hierarchy
  // without eating the 36% sidebar width.
  const indent = 12 + depth * 14;

  if (node.type === 'folder') {
    const isOpen = expanded.has(node.path);
    const childCount = node.children.length;
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <div
          className={cn(
            'group flex items-center gap-1 pr-1 rounded-md',
            'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
          )}
        >
          <button
            type="button"
            onClick={() => onToggleFolder(node.path)}
            style={{ paddingLeft: `${indent}px` }}
            className={cn(
              'flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 rounded-md',
            )}
            aria-label={`${isOpen ? 'Colapsar' : 'Expandir'} carpeta ${node.name}`}
          >
            {isOpen ? (
              <ChevronDown
                className="w-3 h-3 text-[#0e1745]/45 dark:text-white/45 shrink-0"
                aria-hidden
              />
            ) : (
              <ChevronRight
                className="w-3 h-3 text-[#0e1745]/45 dark:text-white/45 shrink-0"
                aria-hidden
              />
            )}
            {isOpen ? (
              <FolderOpen
                className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0"
                aria-hidden
              />
            ) : (
              <Folder
                className="w-3.5 h-3.5 text-indigo-500/80 dark:text-indigo-400/80 shrink-0"
                aria-hidden
              />
            )}
            <span className="text-[12.5px] font-medium text-[#0e1745] dark:text-white truncate">
              {node.name}
            </span>
            <span className="text-[10px] font-mono text-[#0e1745]/40 dark:text-white/40 tabular-nums shrink-0">
              {childCount}
            </span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddInFolder(node.path);
            }}
            className={cn(
              'h-6 w-6 shrink-0 flex items-center justify-center rounded',
              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
              'text-[#0e1745]/55 dark:text-white/55 hover:text-indigo-600 dark:hover:text-indigo-400',
              'hover:bg-indigo-50 dark:hover:bg-indigo-500/10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
            )}
            title={`Nueva nota en ${node.path}`}
            aria-label={`Nueva nota en ${node.path}`}
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {isOpen && childCount > 0 && (
          <ul role="group" className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNodeView
                key={`${child.type}:${child.path}`}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onAddInFolder={onAddInFolder}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  // file
  const isSelected = selectedPath === node.path;
  return (
    <li role="treeitem">
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        style={{ paddingLeft: `${indent + 14}px` }}
        className={cn(
          'w-full flex items-center gap-1.5 pr-2 py-1.5 text-left rounded-md transition-colors',
          'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
          isSelected && 'bg-indigo-50 dark:bg-indigo-500/10',
        )}
        aria-pressed={isSelected}
      >
        <FileText
          className={cn(
            'w-3.5 h-3.5 shrink-0',
            isSelected
              ? 'text-indigo-600 dark:text-indigo-300'
              : 'text-[#0e1745]/45 dark:text-white/45',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'flex-1 min-w-0 truncate text-[12.5px]',
            isSelected
              ? 'font-semibold text-[#0e1745] dark:text-white'
              : 'font-medium text-[#0e1745]/80 dark:text-white/80',
          )}
        >
          {node.name}
        </span>
        <span className="text-[10px] font-mono text-[#0e1745]/35 dark:text-white/35 shrink-0 tabular-nums">
          {formatBytes(node.size_bytes)}
        </span>
      </button>
    </li>
  );
}

// ── Editor area ───────────────────────────────────────────────────────

interface EditorProps {
  path: string;
  content: string;
  saveState: SaveState;
  saving: boolean;
  deleting: boolean;
  loadingContent: boolean;
  errorMsg: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

function FileEditor({
  path,
  content,
  saveState,
  saving,
  deleting,
  loadingContent,
  errorMsg,
  onChange,
  onSave,
  onDelete,
}: EditorProps) {
  // Compute size from the live content (NOT the server `size_bytes`).
  // Match server semantics: UTF-8 byte length, not character count.
  const byteSize = useMemo(() => new TextEncoder().encode(content).length, [
    content,
  ]);

  // Cmd/Ctrl+S inside the textarea triggers save. Returning false on
  // the event keeps the cursor in place — the browser's default
  // "save page" prompt is what we're suppressing.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (saveState === 'dirty' && !saving && !deleting && !loadingContent) {
          onSave();
        }
      }
    },
    [saveState, saving, deleting, loadingContent, onSave],
  );

  function badge() {
    switch (saveState) {
      case 'saving':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Loader2 className="w-3 h-3 animate-spin" />
            Guardando…
          </span>
        );
      case 'dirty':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            Sin guardar
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
            Error
          </span>
        );
      case 'saved':
      case 'idle':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Check className="w-3 h-3" />
            Guardado
          </span>
        );
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <FileText
            className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50 shrink-0"
            aria-hidden
          />
          <div
            className="text-[12px] font-mono text-[#0e1745]/80 dark:text-white/80 truncate select-all"
            title={path}
          >
            {path}
          </div>
          {badge()}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving || deleting || loadingContent}
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
              'text-[#0e1745]/55 dark:text-white/55 hover:text-rose-500 dark:hover:text-rose-400',
              'hover:bg-rose-50 dark:hover:bg-rose-500/10',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
            )}
            aria-label="Borrar archivo"
            title="Borrar archivo"
          >
            {deleting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
      {errorMsg && (
        <div className="mx-3 mt-3 p-2.5 rounded-md bg-rose-50 dark:bg-rose-500/10 border border-rose-200/60 dark:border-rose-500/30 text-[11.5px] text-rose-700 dark:text-rose-300 flex items-start gap-2 shrink-0">
          <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          <span>{errorMsg}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 px-3 pt-3">
        {loadingContent ? (
          <div className="h-full flex items-center justify-center text-[#0e1745]/45 dark:text-white/45 text-sm">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Cargando contenido…
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            aria-label={`Contenido de ${path}`}
            className={cn(
              'w-full h-full resize-none rounded-md font-mono text-[12px] leading-relaxed',
              'bg-white/40 dark:bg-black/30 border border-black/8 dark:border-white/10',
              'text-[#0e1745] dark:text-white/90 placeholder:text-[#0e1745]/30 dark:placeholder:text-white/30',
              'px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/40',
            )}
          />
        )}
      </div>
      <div className="px-3 py-2 border-t border-black/5 dark:border-white/5 flex items-center justify-between gap-2 text-[10.5px] text-[#0e1745]/45 dark:text-white/45 shrink-0">
        <span className="font-mono tabular-nums">
          {formatBytes(byteSize)} · markdown
        </span>
        <span>
          <kbd className="font-mono text-[10px] px-1 py-0.5 rounded border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.05]">
            {typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
              ? 'Cmd'
              : 'Ctrl'}{' '}
            + S
          </kbd>{' '}
          guarda
        </span>
      </div>
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────

function HistoryList({
  entries,
  loading,
}: {
  entries: NeuronHistoryEntry[];
  loading: boolean;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyCallId = (id: string) => {
    navigator.clipboard.writeText(id).then(
      () => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      },
      () => {
        /* clipboard denied — silent */
      },
    );
  };

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full py-12 text-[#0e1745]/45 dark:text-white/45 text-sm">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Cargando historial…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-6 py-12">
        <HistoryIcon
          className="w-10 h-10 text-[#0e1745]/15 dark:text-white/15 mb-3"
          aria-hidden
        />
        <p className="text-sm font-medium text-[#0e1745]/70 dark:text-white/70 mb-1.5">
          Sin actividad reciente
        </p>
        <p className="text-[12.5px] text-[#0e1745]/50 dark:text-white/50 max-w-[20rem] leading-relaxed">
          Cuando un agente escriba en tu memoria, vas a ver el registro acá.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2 py-3 px-1" role="list">
      {entries.map((e, i) => {
        const callId = e.call_id ?? '';
        const itemKey = `${e.created_at}-${i}-${callId}`;
        return (
          <li
            key={itemKey}
            className="rounded-lg border border-black/5 dark:border-white/8 bg-white/50 dark:bg-white/[0.03] p-2.5"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={cn(
                    'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                    e.command === 'create' &&
                      'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
                    e.command === 'str_replace' &&
                      'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
                    e.command === 'delete' &&
                      'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
                    !['create', 'str_replace', 'delete'].includes(e.command) &&
                      'bg-black/5 text-[#0e1745]/70 dark:bg-white/10 dark:text-white/70',
                  )}
                >
                  {e.command}
                </span>
                {e.app_id && (
                  <span className="text-[10.5px] font-medium text-[#0e1745]/50 dark:text-white/50">
                    {e.app_id}
                  </span>
                )}
                {e.agent_id && (
                  <span className="text-[10.5px] font-medium text-indigo-600/80 dark:text-indigo-300/80">
                    {e.agent_id}
                  </span>
                )}
              </div>
              <span className="text-[10.5px] text-[#0e1745]/40 dark:text-white/40">
                {formatRelative(e.created_at)}
              </span>
            </div>
            {e.path && (
              <div className="mt-1.5 text-[11.5px] font-mono text-[#0e1745]/75 dark:text-white/75 truncate">
                {e.path}
              </div>
            )}
            {e.diff_excerpt && (
              <pre className="mt-1.5 text-[10.5px] font-mono text-[#0e1745]/55 dark:text-white/55 bg-black/5 dark:bg-white/5 rounded px-2 py-1.5 overflow-hidden max-h-20 whitespace-pre-wrap leading-snug">
                {e.diff_excerpt}
              </pre>
            )}
            {callId && (
              <button
                type="button"
                onClick={() => handleCopyCallId(callId)}
                className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-mono text-[#0e1745]/40 dark:text-white/40 hover:text-[#0e1745]/70 dark:hover:text-white/70 transition-colors"
                title="Copiar call_id"
                aria-label={`Copiar call id ${callId}`}
              >
                {copiedId === callId ? (
                  <>
                    <Check className="w-3 h-3" /> copiado
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" /> {callId.slice(0, 12)}…
                  </>
                )}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── "Nueva nota" modal ──────────────────────────────────────────────

interface NewNoteModalProps {
  open: boolean;
  /** When set, prefilled into the input as `<seed>/` (folder shortcut) */
  seedFolder?: string | null;
  existingPaths: Set<string>;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}

/**
 * Lightweight modal for capturing a new note name. Lives inside the
 * panel's z-index stack so it can render above the editor without
 * stealing escape-to-close from the parent.
 *
 * Path normalization is done in `normalizeNeuronPath`; this component
 * only handles input + validation feedback.
 */
function NewNoteModal({
  open,
  seedFolder,
  existingPaths,
  onCancel,
  onConfirm,
}: NewNoteModalProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset when reopened — and seed with folder prefix if provided
  // (folder paths come in as `/memories/proyectos/`, strip the root
  // since the input is user-facing).
  useEffect(() => {
    if (open) {
      let seed = '';
      if (seedFolder) {
        seed = seedFolder
          .replace(/^\/+/, '')
          .replace(/^memories\//i, '');
      }
      setValue(seed);
      // Focus after the render commits + paint
      const t = setTimeout(() => {
        inputRef.current?.focus();
        // Place cursor at end
        const v = inputRef.current?.value ?? '';
        inputRef.current?.setSelectionRange(v.length, v.length);
      }, 50);
      return () => clearTimeout(t);
    }
  }, [open, seedFolder]);

  if (!open) return null;

  const normalized = normalizeNeuronPath(value);
  const conflict = normalized ? existingPaths.has(normalized) : false;
  const canSubmit = !!normalized && !conflict;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSubmit && normalized) onConfirm(normalized);
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 dark:bg-black/55 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-note-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.98 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className={cn(
          'w-full max-w-sm rounded-xl p-4 space-y-3',
          'bg-white dark:bg-[#0b1120] border border-black/10 dark:border-white/10',
          'shadow-[0_18px_40px_rgba(0,0,0,0.25)]',
        )}
      >
        <div>
          <h3
            id="new-note-title"
            className="text-[13px] font-semibold text-[#0e1745] dark:text-white"
          >
            Nueva nota
          </h3>
          <p className="mt-0.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55 leading-snug">
            Nombre del archivo. Puede incluir carpetas:{' '}
            <span className="font-mono">proyectos/cl2</span>.
          </p>
        </div>
        <div className="space-y-1">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
            placeholder="proyectos/cl2"
            className={cn(
              'w-full h-9 px-3 rounded-md text-[12.5px] font-mono',
              'bg-white/60 dark:bg-black/30 border border-black/10 dark:border-white/15',
              'text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/30 dark:placeholder:text-white/30',
              'focus:outline-none focus:ring-2 focus:ring-indigo-500/50',
            )}
            aria-label="Nombre del archivo (puede incluir carpetas)"
          />
          {normalized && (
            <p
              className={cn(
                'text-[10.5px] font-mono',
                conflict
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-[#0e1745]/45 dark:text-white/45',
              )}
            >
              {conflict ? `Ya existe: ${normalized}` : `Se creará: ${normalized}`}
            </p>
          )}
          {!normalized && value.trim() !== '' && (
            <p className="text-[10.5px] text-rose-600 dark:text-rose-400">
              Nombre inválido.
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'h-8 px-3 rounded-md text-[11.5px] font-semibold',
              'text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white',
              'hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
            )}
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'h-8 px-3 rounded-md text-[11.5px] font-semibold inline-flex items-center gap-1.5',
              'bg-gradient-to-r from-indigo-500 to-purple-600 text-white',
              'hover:from-indigo-600 hover:to-purple-700 transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <FilePlus className="w-3.5 h-3.5" />
            Crear
          </button>
        </div>
      </motion.form>
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────

export function NeuronPanel({ open, onClose, onReopenOnboarding }: Props) {
  const [tab, setTab] = useState<Tab>('files');

  // Files state
  const [files, setFiles] = useState<NeuronFile[]>([]);
  const [quota, setQuota] = useState<NeuronQuota | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // Folder tree expansion state. Once the user collapses a folder we
  // remember it across re-renders. New folders default to expanded
  // (see useEffect that reseeds after loadFiles).
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']));

  // Selected file editor
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number>(0);

  // History
  const [historyEntries, setHistoryEntries] = useState<NeuronHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // "Nueva nota" modal state
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteSeed, setNewNoteSeed] = useState<string | null>(null);

  const dirty = content !== originalContent;

  const saveState: SaveState = useMemo(() => {
    if (saving) return 'saving';
    if (editorError) return 'error';
    if (dirty) return 'dirty';
    // 1.5s post-save we render "Guardado" prominently; otherwise idle
    // which we treat as visually equivalent to "Guardado".
    if (Date.now() - lastSavedAt < 1500) return 'saved';
    return 'idle';
  }, [saving, editorError, dirty, lastSavedAt]);

  // Build the tree (memoized) + paths set for "Nueva nota" conflicts
  const tree = useMemo(() => buildTree(files), [files]);
  const existingPaths = useMemo(
    () => new Set(files.map((f) => f.path)),
    [files],
  );

  // ── Loaders ────────────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const data = await listNeuronFiles();
      setFiles(data.files ?? []);
      setQuota(data.quota ?? null);
    } catch (e) {
      const { title, detail } = errorMessage(e);
      setFilesError(`${title}: ${detail}`);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await getNeuronHistory(50);
      setHistoryEntries(data.entries ?? []);
    } catch (e) {
      const { title, detail } = errorMessage(e);
      setHistoryError(`${title}: ${detail}`);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setContentLoading(true);
    setEditorError(null);
    try {
      const data = await getNeuronFile(path);
      setContent(data.content ?? '');
      setOriginalContent(data.content ?? '');
    } catch (e) {
      const { title, detail } = errorMessage(e);
      setEditorError(`${title}: ${detail}`);
      setContent('');
      setOriginalContent('');
    } finally {
      setContentLoading(false);
    }
  }, []);

  // ── Side effects ───────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    if (tab === 'files') {
      void loadFiles();
    } else if (tab === 'history') {
      void loadHistory();
    }
  }, [open, tab, loadFiles, loadHistory]);

  useEffect(() => {
    if (!selectedPath) return;
    void loadFile(selectedPath);
  }, [selectedPath, loadFile]);

  // Whenever the file list changes, ensure all *currently present*
  // folder paths are in the expanded set. We don't remove user-
  // collapsed folders (that lives in `expanded` already); we only
  // additively expand any folder we haven't seen yet. This keeps
  // CL2's "all expanded by default" feel without fighting user intent.
  useEffect(() => {
    const all = collectAllFolderPaths(tree, new Set());
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of all) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tree]);

  // Close on Escape — but only if no save in flight and the new-note
  // modal isn't open (it handles its own Escape).
  useEffect(() => {
    if (!open) return;
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape' && !saving && !deleting && !newNoteOpen) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, saving, deleting, newNoteOpen]);

  // Reset selection when panel closes — prevents stale dirty state
  // from leaking into the next open.
  useEffect(() => {
    if (!open) {
      setSelectedPath(null);
      setContent('');
      setOriginalContent('');
      setEditorError(null);
      setNewNoteOpen(false);
      setNewNoteSeed(null);
    }
  }, [open]);

  // ── Actions ───────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!selectedPath || !dirty) return;
    setSaving(true);
    setEditorError(null);
    try {
      await saveNeuronFile(selectedPath, content);
      setOriginalContent(content);
      setLastSavedAt(Date.now());
      // Refresh the file list so size/updated_at reflect the save.
      void loadFiles();
    } catch (e) {
      const { title, detail } = errorMessage(e);
      setEditorError(`${title}: ${detail}`);
    } finally {
      setSaving(false);
    }
  }, [selectedPath, dirty, content, loadFiles]);

  const handleDelete = useCallback(async () => {
    if (!selectedPath) return;
    // Native confirm — Studio doesn't ship a dialog primitive yet and
    // destructive ops shouldn't be one-click.
    const ok = window.confirm(
      `¿Borrar "${selectedPath}"? Esta acción no se puede deshacer.`,
    );
    if (!ok) return;
    setDeleting(true);
    setEditorError(null);
    try {
      await deleteNeuronFile(selectedPath);
      setSelectedPath(null);
      setContent('');
      setOriginalContent('');
      void loadFiles();
    } catch (e) {
      const { title, detail } = errorMessage(e);
      setEditorError(`${title}: ${detail}`);
    } finally {
      setDeleting(false);
    }
  }, [selectedPath, loadFiles]);

  const handleToggleFolder = useCallback((folderPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  /** Create the file optimistically: PATCH with empty content, then
   * refresh the list, expand the parent folder, and select the new
   * file so the editor opens immediately. */
  const handleCreateNote = useCallback(
    async (path: string) => {
      setNewNoteOpen(false);
      setNewNoteSeed(null);
      // Optimistically expand the parent folder
      const parentFolder = path.substring(0, path.lastIndexOf('/') + 1);
      setExpanded((prev) => {
        const next = new Set(prev);
        // Expand every ancestor up the chain
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          next.add(`/${parts.slice(0, i).join('/')}/`);
        }
        next.add(parentFolder);
        return next;
      });
      try {
        // Persist empty file so it shows up in the listing and history
        // gets a `create` entry. The user can then edit and Cmd+S.
        await saveNeuronFile(path, '');
        await loadFiles();
        setSelectedPath(path);
        setContent('');
        setOriginalContent('');
      } catch (e) {
        const { title, detail } = errorMessage(e);
        setFilesError(`${title}: ${detail}`);
      }
    },
    [loadFiles],
  );

  const openNewNote = useCallback((seedFolder?: string | null) => {
    setNewNoteSeed(seedFolder ?? null);
    setNewNoteOpen(true);
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  const isEmpty = !filesLoading && files.length === 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="neuron-panel-title"
          onClick={(e) => {
            // Click outside content closes — but not when typing in
            // the textarea (event bubbles up only on overlay clicks).
            if (
              e.target === e.currentTarget &&
              !saving &&
              !deleting &&
              !newNoteOpen
            )
              onClose();
          }}
        >
          <motion.div
            className={cn(
              'relative w-full max-w-3xl h-[80vh] max-h-[720px] flex flex-col',
              'bg-white dark:bg-[#0b1120] border border-black/10 dark:border-white/10',
              'rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.25)] overflow-hidden',
            )}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {/* Header — editorial title + actions */}
            <div className="px-5 pt-4 pb-3 border-b border-black/5 dark:border-white/5 shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm shrink-0 mt-0.5">
                    <Brain className="w-4 h-4 text-white" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h2
                      id="neuron-panel-title"
                      className="text-[18px] leading-tight text-[#0e1745] dark:text-white"
                      style={{
                        fontFamily: 'var(--font-serif)',
                        fontStyle: 'italic',
                        letterSpacing: '-0.005em',
                      }}
                    >
                      Lo que{' '}
                      <span className="font-semibold not-italic">Shifty</span>{' '}
                      sabe sobre vos
                    </h2>
                    <p className="mt-1 text-[11.5px] text-[#0e1745]/60 dark:text-white/55 leading-snug max-w-[36rem]">
                      Esta es tu memoria personal — la usan{' '}
                      <span className="font-semibold text-[#0e1745]/75 dark:text-white/75">
                        Shifty
                      </span>{' '}
                      (en Studio) y{' '}
                      <span className="font-semibold text-[#0e1745]/75 dark:text-white/75">
                        Ana
                      </span>{' '}
                      (cuando generás reportes en Status) al inicio de cada
                      conversación para adaptar sus respuestas. Es privada:
                      nadie más la ve.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {tab === 'files' && (
                    <button
                      type="button"
                      onClick={() => openNewNote(null)}
                      disabled={saving || deleting}
                      className={cn(
                        'h-8 px-3 rounded-md text-[11.5px] font-semibold inline-flex items-center gap-1.5',
                        'bg-gradient-to-r from-indigo-500 to-purple-600 text-white',
                        'hover:from-indigo-600 hover:to-purple-700 transition-colors',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                      )}
                      aria-label="Crear nueva nota"
                    >
                      <FilePlus className="w-3.5 h-3.5" />
                      Nueva nota
                    </button>
                  )}
                  {onReopenOnboarding && (
                    <button
                      type="button"
                      onClick={onReopenOnboarding}
                      disabled={saving || deleting}
                      className={cn(
                        'h-8 px-2.5 rounded-md text-[11px] font-semibold inline-flex items-center gap-1.5',
                        'text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white',
                        'hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                      )}
                      title="Volver al onboarding"
                      aria-label="Volver al onboarding inicial"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Onboarding
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving || deleting}
                    className={cn(
                      'h-8 w-8 flex items-center justify-center rounded-full',
                      'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                      'hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                    )}
                    aria-label="Cerrar"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Counters + tabs row */}
            <div className="px-5 py-3 border-b border-black/5 dark:border-white/5 space-y-3 shrink-0">
              <CountersRow quota={quota} />
              <div className="flex items-center justify-between gap-2">
                <div
                  role="tablist"
                  aria-label="Mi memoria"
                  className="inline-flex items-center gap-0.5 rounded-lg p-1 bg-black/5 dark:bg-white/5"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'files'}
                    onClick={() => setTab('files')}
                    className={cn(
                      'h-7 px-3 rounded-md text-[11.5px] font-semibold flex items-center gap-1.5 transition-colors',
                      tab === 'files'
                        ? 'bg-white dark:bg-white/10 text-[#0e1745] dark:text-white shadow-sm'
                        : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                    )}
                  >
                    <FilesIcon className="w-3.5 h-3.5" />
                    Archivos
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'history'}
                    onClick={() => setTab('history')}
                    className={cn(
                      'h-7 px-3 rounded-md text-[11.5px] font-semibold flex items-center gap-1.5 transition-colors',
                      tab === 'history'
                        ? 'bg-white dark:bg-white/10 text-[#0e1745] dark:text-white shadow-sm'
                        : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                    )}
                  >
                    <HistoryIcon className="w-3.5 h-3.5" />
                    Historial
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (tab === 'files') void loadFiles();
                    else void loadHistory();
                  }}
                  disabled={filesLoading || historyLoading}
                  className={cn(
                    'h-7 px-2 rounded-md text-[11px] font-medium flex items-center gap-1.5 transition-colors',
                    'text-[#0e1745]/50 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white',
                    'hover:bg-black/5 dark:hover:bg-white/10',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                  title="Recargar"
                  aria-label="Recargar"
                >
                  <RefreshCw
                    className={cn(
                      'w-3.5 h-3.5',
                      (filesLoading || historyLoading) && 'animate-spin',
                    )}
                  />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 flex">
              {tab === 'files' ? (
                <>
                  {/* Left: folder tree */}
                  <div className="w-[40%] min-w-[220px] max-w-[320px] border-r border-black/5 dark:border-white/5 flex flex-col min-h-0">
                    {filesError ? (
                      <div className="p-4 text-[12px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <div>
                          <div>{filesError}</div>
                          <button
                            type="button"
                            onClick={() => void loadFiles()}
                            className="mt-1.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            Reintentar
                          </button>
                        </div>
                      </div>
                    ) : filesLoading && files.length === 0 ? (
                      <div className="flex items-center justify-center h-full py-12 text-[#0e1745]/45 dark:text-white/45 text-sm">
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Cargando…
                      </div>
                    ) : isEmpty ? (
                      <div className="flex flex-col items-center justify-center text-center px-5 py-10 flex-1 min-h-0">
                        <Brain
                          className="w-10 h-10 text-[#0e1745]/15 dark:text-white/15 mb-3"
                          aria-hidden
                        />
                        <p className="text-[13px] font-medium text-[#0e1745]/70 dark:text-white/70 mb-1.5">
                          Tu memoria está vacía
                        </p>
                        <p className="text-[11.5px] text-[#0e1745]/50 dark:text-white/50 leading-relaxed mb-3">
                          Agregá una nota o pedile a Shifty que recuerde algo
                          nuevo.
                        </p>
                        <div className="flex flex-col gap-1.5 w-full">
                          <button
                            type="button"
                            onClick={() => openNewNote(null)}
                            className={cn(
                              'h-8 w-full rounded-md text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5',
                              'bg-gradient-to-r from-indigo-500 to-purple-600 text-white',
                              'hover:from-indigo-600 hover:to-purple-700 transition-colors',
                            )}
                          >
                            <FilePlus className="w-3.5 h-3.5" />
                            Crear primera nota
                          </button>
                          {onReopenOnboarding && (
                            <button
                              type="button"
                              onClick={onReopenOnboarding}
                              className={cn(
                                'h-8 w-full rounded-md text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5',
                                'text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white',
                                'hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
                              )}
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              Empezar onboarding
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 min-h-0 overflow-y-auto px-1">
                        <TreeView
                          root={tree}
                          expanded={expanded}
                          selectedPath={selectedPath}
                          onToggleFolder={handleToggleFolder}
                          onSelectFile={setSelectedPath}
                          onAddInFolder={(p) => openNewNote(p)}
                        />
                      </div>
                    )}
                    {/* Sidebar footer hint — natural-language nudge */}
                    {!isEmpty && (
                      <div className="px-3 py-2 border-t border-black/5 dark:border-white/5 text-[10.5px] text-[#0e1745]/45 dark:text-white/45 leading-snug shrink-0">
                        Tip: en el chat con Shifty podés decir{' '}
                        <em>“recordá que X”</em> o{' '}
                        <em>“borrá la nota sobre Y”</em> y se actualiza acá
                        automáticamente.
                      </div>
                    )}
                  </div>
                  {/* Right: editor */}
                  <div className="flex-1 min-w-0 min-h-0">
                    {selectedPath ? (
                      <FileEditor
                        path={selectedPath}
                        content={content}
                        saveState={saveState}
                        saving={saving}
                        deleting={deleting}
                        loadingContent={contentLoading}
                        errorMsg={editorError}
                        onChange={setContent}
                        onSave={handleSave}
                        onDelete={handleDelete}
                      />
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center px-6 text-center gap-2">
                        <FileText
                          className="w-8 h-8 text-[#0e1745]/15 dark:text-white/15"
                          aria-hidden
                        />
                        <p className="text-[12.5px] text-[#0e1745]/55 dark:text-white/55 max-w-[18rem] leading-relaxed">
                          {isEmpty
                            ? 'Cuando crees tu primera nota, vas a poder editarla acá.'
                            : 'Seleccioná un archivo para verlo y editarlo.'}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto px-4">
                  {historyError ? (
                    <div className="p-4 text-[12px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <div>
                        <div>{historyError}</div>
                        <button
                          type="button"
                          onClick={() => void loadHistory()}
                          className="mt-1.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          Reintentar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <HistoryList
                      entries={historyEntries}
                      loading={historyLoading}
                    />
                  )}
                </div>
              )}
            </div>

            {/* "Nueva nota" modal lives inside the panel container so
                it inherits the rounded clip and dark background. */}
            <AnimatePresence>
              {newNoteOpen && (
                <NewNoteModal
                  open={newNoteOpen}
                  seedFolder={newNoteSeed}
                  existingPaths={existingPaths}
                  onCancel={() => {
                    setNewNoteOpen(false);
                    setNewNoteSeed(null);
                  }}
                  onConfirm={handleCreateNote}
                />
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
