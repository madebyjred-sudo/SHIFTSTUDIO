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
  Search, ArrowUpDown,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
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
      <div
        onClick={() => !menuOpen && !renaming && onOpen()}
        className="group relative flex flex-col gap-3 p-5 rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-xl border border-white/60 dark:border-white/8 hover:border-[#1534dc]/30 hover:shadow-[0_8px_35px_rgba(21,52,220,0.10)] dark:hover:shadow-[0_8px_35px_rgba(139,92,246,0.18)] transition-all cursor-pointer"
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
          className="hidden"
          onChange={handleFileChosen}
          onClick={(e) => e.stopPropagation()}
        />

        {/* Inline import error toast */}
        {importError && (
          <div className="absolute -top-1 left-2 right-2 z-10 px-3 py-1.5 rounded-md bg-red-500 text-white text-[11px] font-medium shadow-lg">
            {importError}
          </div>
        )}

        {/* Color accent line */}
        <div className="absolute top-0 left-5 right-5 h-[2px] rounded-b-full bg-gradient-to-r from-[#7A3B47]/40 via-[#1534dc]/30 to-transparent" />

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#7A3B47]/10 dark:bg-[#7A3B47]/20 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-[#7A3B47]" />
          </div>

          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-all text-[#0e1745]/50 dark:text-white/50"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-8 z-50 w-44 rounded-xl bg-white dark:bg-[#0b1120] shadow-xl border border-black/8 dark:border-white/10 py-1"
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
            onClick={(e) => e.stopPropagation()}
            className="text-[17px] font-semibold bg-transparent border-b border-[#1534dc] focus:outline-none text-[#0e1745] dark:text-white w-full"
          />
        ) : (
          <p className="text-[17px] font-semibold text-[#0e1745] dark:text-white leading-snug line-clamp-2">
            {ws.title}
          </p>
        )}

        {/* Meta */}
        <div className="flex items-center justify-between mt-auto">
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

      {/* Inline pptx result/error placeholder modal — T9/T10 will polish */}
      {(pptxResult || pptxError) && (
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => { setPptxResult(null); setPptxError(null); }}
        >
          <div
            className="max-w-md w-full p-6 rounded-2xl bg-white dark:bg-[#0b1120] border border-black/8 dark:border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {pptxResult && (
              <>
                <h3 className="text-[16px] font-semibold mb-1 text-[#0e1745] dark:text-white">Presentación lista</h3>
                <p className="text-[13px] text-[#0e1745]/60 dark:text-white/55 mb-4">{pptxResult.filename}</p>
                <div className="flex gap-2">
                  <a
                    href={pptxResult.gammaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3 py-2 rounded-lg bg-[#1534dc] text-white text-[13px] font-semibold text-center hover:bg-[#1230c0] transition-colors"
                  >
                    Abrir en Gamma
                  </a>
                  <a
                    href={pptxResult.exportUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3 py-2 rounded-lg bg-[#7A3B47]/10 text-[#7A3B47] text-[13px] font-semibold text-center hover:bg-[#7A3B47]/15 transition-colors"
                  >
                    Descargar .pptx
                  </a>
                </div>
              </>
            )}
            {pptxError && (
              <>
                <h3 className="text-[16px] font-semibold mb-1 text-red-600">Error generando presentación</h3>
                <p className="text-[13px] text-[#0e1745]/60 dark:text-white/55 mb-4 break-words">{pptxError}</p>
                <button
                  onClick={() => setPptxError(null)}
                  className="px-3 py-2 rounded-lg bg-[#0e1745]/8 dark:bg-white/8 text-[13px] font-semibold"
                >
                  Cerrar
                </button>
              </>
            )}
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
    <div className="min-h-screen flex flex-col bg-[#f8f9fc] dark:bg-mesh text-[#0e1745] dark:text-white font-sans transition-colors duration-500">
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#0e1745]/35 dark:text-white/35 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar…"
                className="pl-9 pr-3 py-2 rounded-xl bg-white/70 dark:bg-white/[0.05] backdrop-blur-xl border border-white/60 dark:border-white/8 text-[12.5px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-[#1534dc]/40 w-48"
              />
            </div>

            {/* Sort */}
            <div className="relative">
              <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#0e1745]/35 dark:text-white/35 pointer-events-none" />
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="pl-9 pr-3 py-2 rounded-xl bg-white/70 dark:bg-white/[0.05] backdrop-blur-xl border border-white/60 dark:border-white/8 text-[12.5px] text-[#0e1745] dark:text-white focus:outline-none focus:border-[#1534dc]/40 appearance-none"
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
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12.5px] font-medium transition-colors',
                showArchived
                  ? 'bg-[#0e1745]/10 dark:bg-white/10 text-[#0e1745] dark:text-white'
                  : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
              )}
            >
              <Archive className="w-3.5 h-3.5" />
              {showArchived ? 'Ocultar archivados' : 'Ver archivados'}
            </button>
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1534dc] text-white text-[13px] font-semibold hover:bg-[#1230c0] transition-colors disabled:opacity-60 shadow-sm shadow-[#1534dc]/25"
          >
            <Plus className="w-4 h-4" />
            {creating ? 'Creando…' : 'Nuevo workspace'}
          </button>
        </div>

        {/* ── Error ──────────────────────────────────────────────── */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-[13px]">{error}</div>
        )}

        {/* ── Grid ───────────────────────────────────────────────── */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-44 rounded-2xl bg-white/40 dark:bg-white/[0.04] border border-white/60 dark:border-white/8 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#7A3B47]/10 flex items-center justify-center">
              <BookOpen className="w-8 h-8 text-[#7A3B47]/60" />
            </div>
            {workspaces.length === 0 ? (
              <>
                <p className="text-[16px] font-semibold text-[#0e1745]/60 dark:text-white/50">Aún no tenés workspaces</p>
                <p className="text-[13px] text-[#0e1745]/40 dark:text-white/35">Cada workspace es un canvas; cada hoja, una página de análisis.</p>
                <button onClick={handleCreate} disabled={creating} className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#1534dc] text-white text-[13px] font-semibold hover:bg-[#1230c0] transition-colors">
                  <Plus className="w-4 h-4" /> Crea tu primera hoja
                </button>
              </>
            ) : (
              <>
                <p className="text-[16px] font-semibold text-[#0e1745]/60 dark:text-white/50">Nada coincide con tu búsqueda</p>
                <p className="text-[13px] text-[#0e1745]/40 dark:text-white/35">Probá con otro término o limpiá el filtro.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-12">
            {filtered.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                onOpen={() => navigate(`/workspaces/${ws.id}`)}
                onRename={(title) => handleRename(ws.id, title)}
                onArchive={() => handleArchive(ws.id, !ws.archived)}
                onDelete={() => handleDelete(ws.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
