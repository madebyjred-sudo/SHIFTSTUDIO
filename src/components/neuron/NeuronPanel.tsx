/**
 * @file NeuronPanel.tsx
 * @description "Mi memoria" modal — surfaces the user's Cerebro neuron
 * memory (per-user markdown files stored under realm=shift, keyed by
 * email). Two tabs:
 *
 *   • Files    — list + split-view editor (read, save, delete)
 *   • History  — audit log of agent writes (create/str_replace/delete)
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
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Brain,
  X,
  Trash2,
  Save,
  History as HistoryIcon,
  Files as FilesIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
  Copy,
  Check,
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
}

type Tab = 'files' | 'history';

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

// ─── Subcomponents ────────────────────────────────────────────────────

function QuotaBar({ quota }: { quota: NeuronQuota | null }) {
  if (!quota) {
    return (
      <div className="h-2 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden" />
    );
  }
  const pct = Math.min(100, (quota.used_bytes / quota.max_bytes) * 100);
  const warning = pct > 80;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] font-medium">
        <span className="text-[#0e1745]/55 dark:text-white/55">
          {formatBytes(quota.used_bytes)} / {formatBytes(quota.max_bytes)}
        </span>
        <span className="text-[#0e1745]/55 dark:text-white/55">
          {quota.file_count} / {quota.max_files} archivos
        </span>
      </div>
      <div className="h-1.5 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
        <motion.div
          className={cn(
            'h-full rounded-full',
            warning
              ? 'bg-gradient-to-r from-amber-400 to-rose-500'
              : 'bg-gradient-to-r from-indigo-500 to-purple-600',
          )}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

interface FilesTabProps {
  files: NeuronFile[];
  loading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function FilesList({ files, loading, selectedPath, onSelect }: FilesTabProps) {
  if (loading && files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full py-12 text-[#0e1745]/45 dark:text-white/45 text-sm">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Cargando archivos…
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-6 py-12">
        <Brain
          className="w-10 h-10 text-[#0e1745]/15 dark:text-white/15 mb-3"
          aria-hidden
        />
        <p className="text-sm font-medium text-[#0e1745]/70 dark:text-white/70 mb-1.5">
          Tu memoria está vacía
        </p>
        <p className="text-[12.5px] text-[#0e1745]/50 dark:text-white/50 max-w-[20rem] leading-relaxed">
          Conforme uses Studio, Ana va a recordar lo que vale la pena.
          Aquí vas a poder ver y editar lo que recuerda.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-1 py-2" role="list">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onSelect(f.path)}
            className={cn(
              'w-full text-left px-3 py-2 rounded-lg transition-colors',
              'hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
              selectedPath === f.path && 'bg-indigo-50 dark:bg-indigo-500/10',
            )}
            aria-pressed={selectedPath === f.path}
          >
            <div className="text-[12.5px] font-medium text-[#0e1745] dark:text-white truncate">
              {f.path}
            </div>
            <div className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 mt-0.5 flex items-center gap-2">
              <span>{formatBytes(f.size_bytes)}</span>
              <span aria-hidden>·</span>
              <span>{formatRelative(f.updated_at)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface EditorProps {
  path: string;
  content: string;
  dirty: boolean;
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
  dirty,
  saving,
  deleting,
  loadingContent,
  errorMsg,
  onChange,
  onSave,
  onDelete,
}: EditorProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-[#0e1745] dark:text-white truncate">
            {path}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving || deleting || loadingContent}
            className={cn(
              'h-8 px-3 rounded-md text-[11.5px] font-semibold flex items-center gap-1.5 transition-colors',
              'bg-gradient-to-r from-indigo-500 to-purple-600 text-white',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              'hover:from-indigo-600 hover:to-purple-700',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
            )}
            aria-label="Guardar archivo"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Guardar
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={saving || deleting || loadingContent}
            className={cn(
              'h-8 w-8 flex items-center justify-center rounded-md transition-colors',
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
        <div className="mx-3 mt-3 p-2.5 rounded-md bg-rose-50 dark:bg-rose-500/10 border border-rose-200/60 dark:border-rose-500/30 text-[11.5px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          <span>{errorMsg}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 p-3">
        {loadingContent ? (
          <div className="h-full flex items-center justify-center text-[#0e1745]/45 dark:text-white/45 text-sm">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Cargando contenido…
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
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
    </div>
  );
}

// History tab
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

// ─── Main panel ──────────────────────────────────────────────────────

export function NeuronPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('files');

  // Files state
  const [files, setFiles] = useState<NeuronFile[]>([]);
  const [quota, setQuota] = useState<NeuronQuota | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // Selected file editor
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // History
  const [historyEntries, setHistoryEntries] = useState<NeuronHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const dirty = content !== originalContent;

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

  // Close on Escape — but only if no save in flight.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving && !deleting) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, saving, deleting]);

  // Reset selection when panel closes — prevents stale dirty state
  // from leaking into the next open.
  useEffect(() => {
    if (!open) {
      setSelectedPath(null);
      setContent('');
      setOriginalContent('');
      setEditorError(null);
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

  // ── Render ────────────────────────────────────────────────────────

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
            if (e.target === e.currentTarget && !saving && !deleting) onClose();
          }}
        >
          <motion.div
            className={cn(
              'w-full max-w-3xl h-[78vh] max-h-[680px] flex flex-col',
              'bg-white dark:bg-[#0b1120] border border-black/10 dark:border-white/10',
              'rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.25)] overflow-hidden',
            )}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
                  <Brain className="w-4 h-4 text-white" aria-hidden />
                </div>
                <div className="min-w-0">
                  <h2
                    id="neuron-panel-title"
                    className="text-[14px] font-semibold text-[#0e1745] dark:text-white"
                  >
                    Mi memoria
                  </h2>
                  <p className="text-[11px] text-[#0e1745]/50 dark:text-white/50">
                    Lo que Ana recuerda sobre ti
                  </p>
                </div>
              </div>
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

            {/* Quota + tabs row */}
            <div className="px-5 py-3 border-b border-black/5 dark:border-white/5 space-y-3 shrink-0">
              <QuotaBar quota={quota} />
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
                  Files
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
                  History
                </button>
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
                    'hover:bg-white dark:hover:bg-white/10',
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
                  {/* Left: file list */}
                  <div className="w-[36%] min-w-[200px] max-w-[280px] border-r border-black/5 dark:border-white/5 flex flex-col min-h-0">
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
                    ) : (
                      <div className="flex-1 min-h-0 overflow-y-auto px-2">
                        <FilesList
                          files={files}
                          loading={filesLoading}
                          selectedPath={selectedPath}
                          onSelect={setSelectedPath}
                        />
                      </div>
                    )}
                  </div>
                  {/* Right: editor */}
                  <div className="flex-1 min-w-0 min-h-0">
                    {selectedPath ? (
                      <FileEditor
                        path={selectedPath}
                        content={content}
                        dirty={dirty}
                        saving={saving}
                        deleting={deleting}
                        loadingContent={contentLoading}
                        errorMsg={editorError}
                        onChange={setContent}
                        onSave={handleSave}
                        onDelete={handleDelete}
                      />
                    ) : (
                      <div className="h-full flex items-center justify-center px-6 text-center text-[12.5px] text-[#0e1745]/50 dark:text-white/45">
                        {files.length === 0 && !filesLoading
                          ? 'Tu memoria aparecerá aquí.'
                          : 'Selecciona un archivo para verlo y editarlo.'}
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
