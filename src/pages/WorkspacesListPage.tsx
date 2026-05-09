/**
 * WorkspacesListPage — /workspaces
 *
 * Grid of workspace cards. Archive, rename, delete, create, search.
 * Mirrors the Studio dark/light glassmorphic look used in App.tsx + the
 * existing canvas surface.
 *
 * Ported from CL2's WorkspacesListPage with these adaptations:
 *   - Imports adjusted to Studio paths (workspaceApi instead of CL2's
 *     mixed Workspace + AssetNode types).
 *   - PptxResultModal / PptxOptionsModal dropped — Studio's T6 ships an
 *     inline placeholder; T9/T10 will polish.
 *   - "Mis espacios legislativos" → "Mis workspaces" (neutral creative-
 *     strategic tone).
 *   - "Lexa escribe dentro de ellas" copy → "Cada hoja es una página de
 *     análisis. Tu chat las reescribe." (no character branding).
 *   - cl2-burgundy / cl2-accent CSS-var tokens → Studio's #1534dc and
 *     #7A3B47 literals (tokens not yet wired in Studio's tailwind).
 *   - TopDock kept as-is (works in Studio context — no chat-history
 *     side-effects when isHistoryOpen/onOpenHistory left undefined).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, BookOpen, Archive, Trash2, MoreHorizontal,
  LayoutGrid, Clock, CheckSquare, FileDown, FileText, Upload, Presentation,
  Search, ArrowUpDown, AlertTriangle, Loader2,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { PptxResultModal } from '@/components/workspace/PptxResultModal';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  exportWorkspace, importAsset,
  type WorkspaceRow, type PptxExportResult, type PptxOptions,
} from '@/services/workspaceApi';

// ─── Relative time helper ────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.floor(hours / 24)}d`;
}

// ─── Sort helpers ────────────────────────────────────────────────────
type SortKey = 'updated' | 'created' | 'title' | 'nodes';

function sortWorkspaces(list: WorkspaceRow[], key: SortKey): WorkspaceRow[] {
  const arr = [...list];
  switch (key) {
    case 'created':
      arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      break;
    case 'title':
      arr.sort((a, b) => a.title.localeCompare(b.title, 'es'));
      break;
    case 'nodes':
      arr.sort((a, b) => b.node_count - a.node_count);
      break;
    case 'updated':
    default:
      arr.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      break;
  }
  return arr;
}

// ─── Workspace card ──────────────────────────────────────────────────
function WorkspaceCard({
  ws, onOpen, onRename, onArchive, onDelete,
}: {
  ws: WorkspaceRow;
  onOpen: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(ws.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState<'md' | 'docx' | 'pptx' | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pptxResult, setPptxResult] = useState<PptxExportResult | null>(null);
  const [pptxError, setPptxError] = useState<string | null>(null);

  const commitRename = () => {
    if (draft.trim() && draft !== ws.title) onRename(draft.trim());
    setRenaming(false);
  };

  const handleExport = async (format: 'md' | 'docx' | 'pptx') => {
    if (exporting) return;
    setExporting(format);
    try {
      if (format === 'pptx') {
        const result = await exportWorkspace(ws.id, 'pptx', {
          workspaceTitle: ws.title,
          options: {} as PptxOptions,
        });
        setPptxResult(result);
      } else if (format === 'docx') {
        await exportWorkspace(ws.id, 'docx', { workspaceTitle: ws.title });
      } else {
        await exportWorkspace(ws.id, 'md', { workspaceTitle: ws.title });
      }
    } catch (err) {
      if (format === 'pptx') setPptxError((err as Error).message);
    } finally {
      setExporting(null);
      setMenuOpen(false);
    }
  };

  const handleImportClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      await importAsset(ws.id, file);
      navigate(`/workspaces/${ws.id}`);
    } catch (err) {
      setImportError((err as Error).message);
      setTimeout(() => setImportError(null), 4000);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      {/*
        WCAG 2.1: a single role="button" wrapper around interactive
        descendants (kebab, rename input, hidden file input, action menu)
        violates ARIA — interactive elements cannot nest inside a button.
        We split the surface: the outer <div> is non-interactive layout,
        and a separate absolutely-positioned <button> covers ONLY the
        click-to-navigate area. Sibling controls sit ABOVE that button via
        higher z-index, so clicks on them never reach the navigation
        button. Visual layout is unchanged — purely structural HTML fix.
      */}
      <div
        className="group relative flex flex-col gap-3 p-5 rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl border border-white/60 dark:border-white/10 hover:border-[#1534dc]/30 dark:hover:border-[#8b5cf6]/30 hover:-translate-y-0.5 hover:shadow-[0_12px_40px_rgba(21,52,220,0.12)] dark:hover:shadow-[0_12px_40px_rgba(139,92,246,0.20)] focus-within:ring-2 focus-within:ring-[#1534dc]/45 dark:focus-within:ring-[#8b5cf6]/45 transition-all duration-200"
      >
        {/* Click-to-navigate surface — covers the whole card except where
            sibling interactive controls (kebab, rename, file input) overlay
            it via higher z-index. Does NOT contain interactive children. */}
        {!renaming && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Abrir workspace ${ws.title}`}
            className="absolute inset-0 z-0 rounded-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
          />
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
          className="hidden"
          onChange={handleFileChosen}
        />

        {/* Inline import error toast */}
        {importError && (
          <div
            role="alert"
            className="absolute -top-1 left-2 right-2 z-20 px-3 py-1.5 rounded-md bg-red-500 text-white text-[11px] font-medium shadow-lg flex items-center gap-1.5"
          >
            <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden />
            <span className="truncate">{importError}</span>
          </div>
        )}

        {/* Color accent line */}
        <div className="absolute top-0 left-5 right-5 h-[2px] rounded-b-full bg-gradient-to-r from-[#7A3B47]/40 via-[#1534dc]/30 to-transparent pointer-events-none z-[1]" />

        {/* Header */}
        <div className="relative z-10 flex items-start justify-between gap-3 pointer-events-none">
          <div className="w-10 h-10 rounded-xl bg-[#7A3B47]/10 dark:bg-[#7A3B47]/20 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-[#7A3B47]" />
          </div>

          <div className="relative pointer-events-auto">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              aria-label="Más opciones del workspace"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-all text-[#0e1745]/50 dark:text-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
            >
              <MoreHorizontal className="w-4 h-4" aria-hidden />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-8 z-50 w-44 rounded-xl bg-white dark:bg-[#0c1230] shadow-xl border border-black/8 dark:border-white/10 py-1 animate-in fade-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
              >
                <button onClick={() => { setRenaming(true); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors">Renombrar</button>
                <button onClick={() => { onArchive(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2">
                  <Archive className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50" />
                  {ws.archived ? 'Restaurar' : 'Archivar'}
                </button>

                <div className="border-t border-black/6 dark:border-white/8 my-1" />
                <button
                  onClick={handleImportClick}
                  disabled={importing}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5 text-[#7A3B47]" />
                  {importing ? 'Importando…' : 'Importar archivo'}
                </button>

                <div className="border-t border-black/6 dark:border-white/8 my-1" />
                <button
                  onClick={() => handleExport('pptx')}
                  disabled={exporting !== null}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Presentation className="w-3.5 h-3.5 text-[#7A3B47]" />
                  {exporting === 'pptx' ? 'Generando…' : 'Generar presentación'}
                </button>
                <button
                  onClick={() => handleExport('docx')}
                  disabled={exporting !== null}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <FileDown className="w-3.5 h-3.5 text-[#7A3B47]" />
                  {exporting === 'docx' ? 'Exportando…' : 'Exportar a Word'}
                </button>
                <button
                  onClick={() => handleExport('md')}
                  disabled={exporting !== null}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <FileText className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50" />
                  {exporting === 'md' ? 'Exportando…' : 'Exportar a Markdown'}
                </button>

                <div className="border-t border-black/6 dark:border-white/8 my-1" />
                {!confirmDelete ? (
                  <button onClick={() => setConfirmDelete(true)} className="w-full text-left px-3 py-2 text-[13px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2">
                    <Trash2 className="w-3.5 h-3.5" /> Eliminar
                  </button>
                ) : (
                  <button onClick={() => { onDelete(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] text-red-600 font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">¿Confirmar?</button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Title */}
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
            className="relative z-10 text-[17px] font-semibold bg-transparent border-b border-[#1534dc] focus:outline-none text-[#0e1745] dark:text-white w-full"
          />
        ) : (
          <p className="relative z-10 text-[17px] font-semibold text-[#0e1745] dark:text-white leading-snug line-clamp-2 pointer-events-none">
            {ws.title}
          </p>
        )}

        {/* Meta */}
        <div className="relative z-10 flex items-center justify-between mt-auto pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#1534dc]/8 text-[11px] font-medium text-[#1534dc] dark:text-[#8b5cf6]">
              <LayoutGrid className="w-3 h-3" />
              {ws.node_count} {ws.node_count === 1 ? 'hoja' : 'hojas'}
            </span>
            {ws.archived && (
              <span className="px-2 py-0.5 rounded-full bg-[#0e1745]/8 dark:bg-white/8 text-[11px] text-[#0e1745]/60 dark:text-white/60">
                archivado
              </span>
            )}
          </div>
          <span className="text-[11px] text-[#0e1745]/40 dark:text-white/35 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {relativeTime(ws.updated_at)}
          </span>
        </div>
      </div>

      {/* Pptx result — uses the polished shared PptxResultModal (T9). */}
      <PptxResultModal
        open={Boolean(pptxResult)}
        onClose={() => setPptxResult(null)}
        result={pptxResult}
        onRegenerate={() => {
          // From the list view we don't pre-fill — just trigger a fresh
          // export. Keeps behavior identical to before T10.
          setPptxResult(null);
          void handleExport('pptx');
        }}
        workspaceTitle={ws.title}
      />

      {/* Pptx error — small accessible dialog (no full-screen takeover). */}
      {pptxError && (
        <div
          className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
          onClick={() => setPptxError(null)}
          role="presentation"
        >
          <div
            className="max-w-md w-full p-6 rounded-2xl bg-white dark:bg-[#0c1230] border border-black/8 dark:border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-labelledby="pptx-error-title"
            aria-describedby="pptx-error-desc"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="pptx-error-title" className="text-[14px] font-semibold text-[#0e1745] dark:text-white">
                  No pudimos generar la presentación
                </h3>
                <p id="pptx-error-desc" className="mt-1 text-[12.5px] text-[#0e1745]/60 dark:text-white/55 break-words">
                  {pptxError}
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setPptxError(null)}
                className="px-3 py-2 rounded-xl text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 transition-colors"
              >
                Cerrar
              </button>
              <button
                onClick={() => { setPptxError(null); void handleExport('pptx'); }}
                className="px-3 py-2 rounded-xl text-[12.5px] font-semibold bg-[#1534dc] hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2] text-white shadow-sm transition-colors inline-flex items-center gap-1.5"
              >
                <Loader2 className={cn('w-3.5 h-3.5', exporting === 'pptx' ? 'animate-spin' : 'hidden')} aria-hidden />
                Reintentar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────
export function WorkspacesListPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updated');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listWorkspaces({ archived: showArchived });
      setWorkspaces(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const ws = await createWorkspace({ title: 'Mi workspace' });
      navigate(`/workspaces/${ws.id}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  const handleRename = async (id: string, title: string) => {
    await updateWorkspace(id, { title }).catch(() => null);
    setWorkspaces((prev) => prev.map((w) => w.id === id ? { ...w, title } : w));
  };

  const handleArchive = async (id: string, archived: boolean) => {
    await updateWorkspace(id, { archived }).catch(() => null);
    if (!showArchived) setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    else setWorkspaces((prev) => prev.map((w) => w.id === id ? { ...w, archived } : w));
  };

  const handleDelete = async (id: string) => {
    await deleteWorkspace(id).catch(() => null);
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q ? workspaces.filter((w) => w.title.toLowerCase().includes(q)) : workspaces;
    return sortWorkspaces(base, sortKey);
  }, [workspaces, search, sortKey]);

  const active = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fc] dark:bg-mesh text-[#0e1745] dark:text-white font-sans selection:bg-[#1534dc]/20 dark:selection:bg-[#8b5cf6]/25 transition-colors duration-500">
      {/* Subtle grid background — mirrors App.tsx chat surface */}
      <div
        className="absolute inset-0 z-0 pointer-events-none opacity-10 dark:opacity-[0.06]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h40v40H0V0zm20 20h20v20H20V20zM0 20h20v20H0V20z' fill='currentColor' fill-opacity='0.1' fill-rule='evenodd'/%3E%3C/svg%3E")`,
          maskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)',
        }}
      />

      <TopDock />

      <div className="relative z-10 max-w-[1320px] mx-auto w-full flex flex-col flex-1 px-4 sm:px-6">
        {/* ── Hero ───────────────────────────────────────────────── */}
        <div className="pt-10 pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[#1534dc]/80 dark:text-[#8b5cf6]/80 mb-2">
            Workspaces
          </p>
          <h1 className="text-[36px] sm:text-[44px] font-semibold leading-tight text-[#0e1745] dark:text-white">
            Mis workspaces
          </h1>
          <p className="mt-2 text-[15px] text-[#0e1745]/55 dark:text-white/50 max-w-xl">
            Canvases donde cada hoja es una página de análisis. Tu chat las reescribe en su lugar.
          </p>

          {/* KPI strip */}
          <div className="mt-6 flex flex-wrap gap-3">
            {[
              { icon: <LayoutGrid className="w-4 h-4" />, label: 'Workspaces', value: active.length },
              { icon: <CheckSquare className="w-4 h-4" />, label: 'Hojas totales', value: workspaces.reduce((s, w) => s + w.node_count, 0) },
              { icon: <Archive className="w-4 h-4" />, label: 'Archivados', value: archived.length },
            ].map(({ icon, label, value }) => (
              <div key={label} className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-white/70 dark:bg-white/[0.05] backdrop-blur-xl border border-white/60 dark:border-white/8">
                <span className="text-[#1534dc]/70 dark:text-[#8b5cf6]/80">{icon}</span>
                <div>
                  <p className="text-[20px] font-semibold leading-none">{value}</p>
                  <p className="text-[11px] text-[#0e1745]/50 dark:text-white/45 mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Toolbar ────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="relative">
              <label htmlFor="ws-search" className="sr-only">Buscar workspace</label>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#0e1745]/35 dark:text-white/35 pointer-events-none" aria-hidden />
              <input
                id="ws-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar…"
                aria-label="Buscar workspace por título"
                className="pl-9 pr-3 py-2 rounded-xl bg-white/70 dark:bg-white/[0.05] backdrop-blur-xl border border-white/60 dark:border-white/10 text-[12.5px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/45 focus-visible:ring-2 focus-visible:ring-[#1534dc]/15 dark:focus-visible:ring-[#8b5cf6]/20 w-48 transition-colors"
              />
            </div>

            {/* Sort */}
            <div className="relative">
              <label htmlFor="ws-sort" className="sr-only">Ordenar workspaces</label>
              <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#0e1745]/35 dark:text-white/35 pointer-events-none" aria-hidden />
              <select
                id="ws-sort"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                aria-label="Ordenar workspaces"
                className="pl-9 pr-3 py-2 rounded-xl bg-white/70 dark:bg-white/[0.05] backdrop-blur-xl border border-white/60 dark:border-white/10 text-[12.5px] text-[#0e1745] dark:text-white focus:outline-none focus:border-[#1534dc]/40 dark:focus:border-[#8b5cf6]/45 focus-visible:ring-2 focus-visible:ring-[#1534dc]/15 dark:focus-visible:ring-[#8b5cf6]/20 appearance-none transition-colors"
              >
                <option value="updated">Recientes</option>
                <option value="created">Creación</option>
                <option value="title">Título</option>
                <option value="nodes">Más hojas</option>
              </select>
            </div>

            {/* Archived toggle */}
            <button
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              aria-label={showArchived ? 'Ocultar workspaces archivados' : 'Ver workspaces archivados'}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45',
                showArchived
                  ? 'bg-[#0e1745]/10 dark:bg-white/10 text-[#0e1745] dark:text-white'
                  : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              <Archive className="w-3.5 h-3.5" aria-hidden />
              {showArchived ? 'Ocultar archivados' : 'Ver archivados'}
            </button>
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            aria-label={creating ? 'Creando nuevo workspace' : 'Crear nuevo workspace'}
            aria-busy={creating}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1534dc] text-white text-[13px] font-semibold hover:bg-[#1230c0] dark:bg-[#8b5cf6] dark:hover:bg-[#7a4cf2] transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm shadow-[#1534dc]/25 dark:shadow-[#8b5cf6]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4" aria-hidden />}
            {creating ? 'Creando…' : 'Nuevo workspace'}
          </button>
        </div>

        {/* ── Error ──────────────────────────────────────────────── */}
        {error && (
          <div
            role="alert"
            className="mb-4 px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200/60 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[13px] flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <div className="flex-1 min-w-0">
              <p className="font-medium">No pudimos cargar tus workspaces.</p>
              <p className="text-[12px] opacity-80 mt-0.5 break-words">{error}</p>
            </div>
            <button
              onClick={() => { setError(null); void load(); }}
              className="text-[12px] font-semibold px-2.5 py-1 rounded-lg bg-rose-100 dark:bg-rose-500/20 hover:bg-rose-200 dark:hover:bg-rose-500/30 transition-colors shrink-0"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* ── Grid ───────────────────────────────────────────────── */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true" aria-label="Cargando workspaces">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="relative h-44 rounded-2xl bg-white/50 dark:bg-white/[0.03] border border-white/60 dark:border-white/8 overflow-hidden"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="absolute inset-0 animate-pulse">
                  <div className="absolute top-5 left-5 w-10 h-10 rounded-xl bg-[#7A3B47]/10 dark:bg-white/5" />
                  <div className="absolute top-7 left-20 right-20 h-3 rounded-md bg-[#0e1745]/8 dark:bg-white/5" />
                  <div className="absolute top-12 left-20 right-32 h-2 rounded-md bg-[#0e1745]/5 dark:bg-white/[0.04]" />
                  <div className="absolute bottom-5 left-5 w-20 h-5 rounded-full bg-[#1534dc]/10 dark:bg-white/5" />
                  <div className="absolute bottom-5 right-5 w-16 h-3 rounded-md bg-[#0e1745]/5 dark:bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-center px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#7A3B47]/15 to-[#1534dc]/10 dark:from-[#7A3B47]/25 dark:to-[#8b5cf6]/15 flex items-center justify-center shadow-sm">
              <BookOpen className="w-8 h-8 text-[#7A3B47]/70 dark:text-[#7A3B47]" aria-hidden />
            </div>
            {workspaces.length === 0 ? (
              <>
                <p className="text-[17px] font-semibold text-[#0e1745]/80 dark:text-white/80">Aún no tenés workspaces</p>
                <p className="text-[13px] text-[#0e1745]/50 dark:text-white/40 max-w-sm">
                  Cada workspace es un canvas; cada hoja, una página de análisis. Tu chat las reescribe en su lugar.
                </p>
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  aria-busy={creating}
                  className="mt-3 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#1534dc] dark:bg-[#8b5cf6] text-white text-[13px] font-semibold hover:bg-[#1230c0] dark:hover:bg-[#7a4cf2] transition-colors disabled:opacity-60 shadow-sm shadow-[#1534dc]/25 dark:shadow-[#8b5cf6]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4" aria-hidden />}
                  Crear mi primer workspace
                </button>
              </>
            ) : (
              <>
                <p className="text-[16px] font-semibold text-[#0e1745]/70 dark:text-white/60">Nada coincide con tu búsqueda</p>
                <p className="text-[13px] text-[#0e1745]/45 dark:text-white/35">Probá con otro término o limpiá el filtro.</p>
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="mt-1 text-[12px] font-medium text-[#1534dc] dark:text-[#8b5cf6] hover:underline"
                  >
                    Limpiar búsqueda
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-12">
            {filtered.map((ws, i) => (
              <div
                key={ws.id}
                className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-300"
                style={{ animationDelay: `${Math.min(i * 35, 280)}ms` }}
              >
                <WorkspaceCard
                  ws={ws}
                  onOpen={() => navigate(`/workspaces/${ws.id}`)}
                  onRename={(title) => handleRename(ws.id, title)}
                  onArchive={() => handleArchive(ws.id, !ws.archived)}
                  onDelete={() => handleDelete(ws.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
