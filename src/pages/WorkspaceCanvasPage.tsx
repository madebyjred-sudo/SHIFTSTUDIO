/**
 * WorkspaceCanvasPage — /workspaces/:id
 *
 * Split layout:
 *   Left  340px — compact AnimatedAiInput chat (Studio's existing chat
 *                 widget; T8/T9 will wire workspace scope properly).
 *   Right        — ReactFlow canvas with HojaNode + AssetNode.
 *
 * T6 scope:
 *   • Infinite zoomable canvas, mini-map, dot grid background
 *   • Add hoja (button + double-click empty pane)
 *   • Upload asset (file picker → importAsset)
 *   • Architect (inline prompt → POST /api/workspace/:id/architect →
 *     materialize returned nodes with stagger)
 *   • Export (md / docx / pptx) with simple inline result panel
 *   • Drag/drop position persistence with debounced auto-save (300ms)
 *   • Backspace/Delete removes selected node
 *   • HojaNode in-card auto-save (800ms) handled inside the component
 *
 * Ported from CL2's WorkspaceCanvasPage — DROPPED for T6: PodcastModal,
 * BoardAudioStrip, LexaContextPanel, LexaInlineModal, LexaQuickHojaModal,
 * SilCitePickerModal, VoiceCaptureModal, expediente/sesion/sil hooks,
 * HojaFormatMenu, useChat workspace-scope helpers, ChatSplitter, the
 * document-level capture-phase context-menu hack (no Studio context-menu
 * lib yet). T7-T10 will reintroduce Studio versions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Panel,
  ReactFlowProvider, useNodesState, useReactFlow,
  type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Plus, Layers, Sparkles, Upload, ZoomIn, Presentation,
  FileDown, FileText, Download, Loader2, MessageSquareText, X,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { ChatPanel } from '@/components/workspace/ChatPanel';
import { QuickHojaModal } from '@/components/workspace/QuickHojaModal';
import { PptxOptionsModal, type PptxOptionsSubmit } from '@/components/workspace/PptxOptionsModal';
import { PptxResultModal } from '@/components/workspace/PptxResultModal';
import { HojaNode } from '@/components/hoja/HojaNode';
import { AssetNode } from '@/components/hoja/AssetNode';
import { HojaFormatMenu } from '@/components/hoja/HojaFormatMenu';
import { HojaSelectionMenu } from '@/components/hoja/HojaSelectionMenu';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listNodes, createNode, updateNode, deleteNode, importAsset,
  updateWorkspace, exportWorkspace, getWorkspace,
  type WorkspaceNode, type PptxExportResult, type PptxOptions,
} from '@/services/workspaceApi';
import type { WorkspaceActionPayload } from '@/services/workspaceTurnStream';

// ─── Node type registration ───────────────────────────────────────────
const NODE_TYPES = {
  hoja: HojaNode,
  image: AssetNode,
  audio: AssetNode,
  document: AssetNode,
} as const;

// ─── Grid layout helper ───────────────────────────────────────────────
const GRID_COLS = 3;
const NODE_W = 520;
const NODE_H = 360;
const GAP = 40;

function gridPosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return { x: col * (NODE_W + GAP) + 80, y: row * (NODE_H + GAP) + 80 };
}

// ─── API node → ReactFlow node ────────────────────────────────────────
// Pass through n.type so document/image/audio render via AssetNode
// (read-only metadata) instead of HojaNode (markdown editor).
function toRFNode(n: WorkspaceNode, workspaceId: string, callbacks: {
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<WorkspaceNode>) => void;
}): Node {
  const t = (n.type ?? 'hoja').toString().toLowerCase();
  const rfType: 'hoja' | 'image' | 'audio' | 'document' =
    t === 'image' || t === 'audio' || t === 'document'
      ? (t as 'image' | 'audio' | 'document')
      : 'hoja';
  return {
    id: n.id,
    type: rfType,
    position: { x: n.x, y: n.y },
    style: { width: n.width, height: n.height },
    data: {
      ...n,
      workspaceId,
      onDelete: callbacks.onDelete,
      onSelect: callbacks.onSelect,
      onUpdate: callbacks.onUpdate,
    },
    selected: false,
    draggable: true,
  };
}

// ─── Inner canvas (needs ReactFlow context) ───────────────────────────
function CanvasInner({
  workspaceId,
  title,
  onTitleChange,
}: {
  workspaceId: string;
  title: string;
  onTitleChange: (t: string) => void;
}) {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  // T9 — quick-hoja modal (replaces inline architect prompt panel)
  const [quickHojaOpen, setQuickHojaOpen] = useState(false);

  // Surface errors from create/import/export so the user sees what's
  // actually happening when a click "does nothing". Auto-dismissed after 6s.
  const [actionError, setActionError] = useState<{ title: string; detail: string } | null>(null);

  // T9 — pptx export pipeline:
  //   options modal → exportWorkspace → result modal.
  // We cache the last submitted options on the page so the regenerate
  // path (and any reopen) pre-fills the form.
  const [exporting, setExporting] = useState<'md' | 'docx' | 'pptx' | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [pptxOptionsOpen, setPptxOptionsOpen] = useState(false);
  const [pptxOptionsCache, setPptxOptionsCache] = useState<PptxOptions | undefined>(undefined);
  // Phase 3.F split: result modal can render in two modes — cache-hit
  // (`pptxResult` filled) or polling (`pptxPending` filled). At most
  // one of these is non-null at a time. Both null = result modal closed.
  const [pptxResult, setPptxResult] = useState<PptxExportResult | null>(null);
  const [pptxPending, setPptxPending] = useState<{
    generationId: string;
    filename: string;
  } | null>(null);

  // T10 — mobile chat drawer (shown on screens below lg breakpoint).
  // Desktop keeps the persistent 360px sidebar.
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Use a Map so we can iterate it cleanly on unmount.
  const positionSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tracks every stray setTimeout we kick off (fitView delay, architect
  // stagger, etc.) so we can clear them on unmount. Important #3.
  const pendingTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Helper: schedule a timer that auto-removes itself from the tracking
  // set once it fires. Returned id can be passed to clearTimeout.
  const scheduleTimer = useCallback((fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      pendingTimers.current.delete(id);
      fn();
    }, delay);
    pendingTimers.current.add(id);
    return id;
  }, []);

  useEffect(() => { setDraftTitle(title); }, [title]);

  // ── Selection ref (lets handleDelete read the latest selectedNodeId
  //    without re-creating its identity on every selection change).
  //    Important #4. ─────────────────────────────────────────────────
  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

  // ── Delete callback ──────────────────────────────────────────────
  const handleDelete = useCallback(async (nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    if (selectedNodeIdRef.current === nodeId) setSelectedNodeId(null);
    await deleteNode(workspaceId, nodeId).catch(() => null);
  }, [workspaceId, setNodes]);

  // ── Select callback ──────────────────────────────────────────────
  const handleSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  // ── Update callback (merge title/subtitle/content/etc into RF data
  //    so re-renders see fresh fields). Important #5. ───────────────
  const handleNodeUpdate = useCallback((nodeId: string, patch: Partial<WorkspaceNode>) => {
    setNodes((ns) => ns.map((n) =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, ...patch } }
        : n
    ));
  }, [setNodes]);

  // ── Load nodes ───────────────────────────────────────────────────
  useEffect(() => {
    listNodes(workspaceId, { withContent: true })
      .then((apiNodes) => {
        const rfNodes = apiNodes.map((n) =>
          toRFNode(n, workspaceId, { onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate }),
        );
        setNodes(rfNodes);
        scheduleTimer(() => fitView({ padding: 0.2, duration: 500 }), 100);
      })
      .catch(() => null)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ── Sync callbacks into node.data when they change ───────────────
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: { ...n.data, onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate },
      })),
    );
  }, [handleDelete, handleSelect, handleNodeUpdate, setNodes]);

  // ── Cleanup all pending timers + dismiss modals on unmount.
  //    Important #2 + #3 + T9 modal hygiene. ────────────────────────
  useEffect(() => () => {
    positionSaveTimers.current.forEach((t) => clearTimeout(t));
    positionSaveTimers.current.clear();
    pendingTimers.current.forEach((t) => clearTimeout(t));
    pendingTimers.current.clear();
    // Modals own their own AbortController + timer cleanup, but make
    // sure no stale `open` flag survives a route change.
    setQuickHojaOpen(false);
    setPptxOptionsOpen(false);
    setPptxResult(null);
    setPptxPending(null);
  }, []);

  // ── Persist position on drag end (debounced 300ms) ───────────────
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) {
      if (c.type === 'position' && !c.dragging && c.position) {
        const { id, position } = c;
        const existing = positionSaveTimers.current.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          positionSaveTimers.current.delete(id);
          updateNode(workspaceId, id, { x: position.x, y: position.y }).catch(() => null);
        }, 300);
        positionSaveTimers.current.set(id, timer);
      }
    }
  }, [onNodesChange, workspaceId]);

  // ── Keyboard: Delete/Backspace removes selected ──────────────────
  // Scoped to the canvas pane (not window) so Backspace anywhere else in
  // the app — toolbar, chat, popovers, modals — never destroys a node.
  // Also gated behind a confirm because the previous global handler had
  // a high blast radius: clicking into a hoja header and back out left
  // selectedNodeId set, so a stray Backspace after dismissing a popover
  // would delete the last-selected node with zero recovery surface.
  const canvasPaneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = canvasPaneRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).contentEditable === 'true'
      ) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        if (!window.confirm('¿Borrar la hoja seleccionada? Esta acción no se puede deshacer.')) return;
        void handleDelete(selectedNodeId);
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [selectedNodeId, handleDelete]);

  // ── Surface a backend error in the inline banner. Auto-dismiss 6s. ──
  const showActionError = useCallback((title: string, detail: string) => {
    console.error(`[workspace] ${title}:`, detail);
    setActionError({ title, detail });
    scheduleTimer(() => setActionError(null), 6000);
  }, [scheduleTimer]);

  // ── Add hoja ─────────────────────────────────────────────────────
  const handleAddHoja = useCallback(async (pos?: { x: number; y: number }) => {
    const position = pos ?? gridPosition(nodes.length);
    try {
      const apiNode = await createNode(workspaceId, {
        type: 'hoja',
        title: 'Sin título',
        x: position.x, y: position.y,
        width: NODE_W, height: NODE_H,
      });
      const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate });
      setNodes((ns) => [...ns, rfNode]);
      setSelectedNodeId(apiNode.id);
      scheduleTimer(() => fitView({ padding: 0.15, duration: 400 }), 50);
    } catch (err) {
      showActionError(
        'No pudimos crear la hoja',
        err instanceof Error ? err.message : 'Error desconocido',
      );
    }
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer, showActionError]);

  // ── Upload asset ─────────────────────────────────────────────────
  // Process every file in the batch even if some fail. We keep a
  // running list of failures and report them after the loop so the
  // banner reflects the worst case without silencing successes.
  const handleFilesPicked = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const basePos = gridPosition(nodes.length);
    let i = 0;
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      const offset = i * 24;
      try {
        const apiNode = await importAsset(workspaceId, file, {
          x: basePos.x + offset,
          y: basePos.y + offset,
        });
        const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate });
        setNodes((ns) => [...ns, rfNode]);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'Error desconocido';
        failures.push(`${file.name}: ${detail}`);
      }
      i++;
    }
    if (failures.length > 0) {
      const title = failures.length === 1
        ? 'No pudimos subir el archivo'
        : `No pudimos subir ${failures.length} archivos`;
      showActionError(title, failures.join(' · '));
    }
    scheduleTimer(() => fitView({ padding: 0.15, duration: 400 }), 60);
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer, showActionError]);

  // ── Double-click pane → add hoja at click ────────────────────────
  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    void handleAddHoja({ x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }, [screenToFlowPosition, handleAddHoja]);

  // ── Hoja titles list (for ChatPanel context) ─────────────────────
  // Recomputed when nodes mutate. Subtitle preserved so Atlas's
  // edit_by_match heuristic has more signal to disambiguate.
  const hojaTitles = useMemo(() => {
    return nodes
      .filter((n) => {
        const t = (n.data as { type?: string }).type;
        return !t || t === 'hoja';
      })
      .map((n) => {
        const d = n.data as { title?: string; subtitle?: string };
        return {
          id: n.id,
          title: d.title?.trim() || 'Sin título',
          subtitle: d.subtitle ?? null,
        };
      });
  }, [nodes]);

  // ── ChatPanel → canvas bridge ────────────────────────────────────
  // Branches on action.intent and applies node mutations to RF state.
  // Re-uses the same toRFNode + scheduleTimer pattern as the architect
  // path so timer cleanup remains centralized (Important #3).
  const handleWorkspaceAction = useCallback((action: WorkspaceActionPayload) => {
    if (action.intent === 'build') {
      const newNodes = action.nodes ?? [];
      if (newNodes.length === 0) return;
      for (let i = 0; i < newNodes.length; i++) {
        const n = newNodes[i];
        const rf = toRFNode(n, workspaceId, {
          onDelete: handleDelete,
          onSelect: handleSelect,
          onUpdate: handleNodeUpdate,
        });
        scheduleTimer(() => setNodes((ns) => [...ns, rf]), i * 120);
      }
      scheduleTimer(() => fitView({ padding: 0.18, duration: 600 }), newNodes.length * 120 + 100);
      return;
    }

    if (action.intent === 'edit_selected' || action.intent === 'edit_by_match') {
      const targetId = action.node_id;
      const newMd = action.new_content;
      if (!targetId || typeof newMd !== 'string') return;
      setNodes((ns) => ns.map((n) => {
        if (n.id !== targetId) return n;
        const prev = (n.data as { content?: { md?: string } }).content ?? {};
        return {
          ...n,
          data: {
            ...n.data,
            content: { ...prev, md: newMd },
          },
        };
      }));
      return;
    }
  }, [workspaceId, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer]);

  // ── Quick-hoja onCreated: same materialization path as the chat
  //    `build` intent — stagger insert + fitView. ──────────────────
  const handleQuickHojaCreated = useCallback((newNodes: WorkspaceNode[]) => {
    if (newNodes.length === 0) return;
    for (let i = 0; i < newNodes.length; i++) {
      const n = newNodes[i];
      const rf = toRFNode(n, workspaceId, {
        onDelete: handleDelete,
        onSelect: handleSelect,
        onUpdate: handleNodeUpdate,
      });
      scheduleTimer(() => setNodes((ns) => [...ns, rf]), i * 120);
    }
    scheduleTimer(() => fitView({ padding: 0.18, duration: 600 }), newNodes.length * 120 + 100);
  }, [workspaceId, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer]);

  // ── Export ───────────────────────────────────────────────────────
  // md / docx → direct binary download (no modal needed).
  // pptx     → open PptxOptionsModal; that modal owns the call and
  //            hands `(opts, result)` back to onPptxOptionsSubmit.
  const handleExport = useCallback(async (format: 'md' | 'docx' | 'pptx') => {
    if (exporting) return;
    setExportMenuOpen(false);
    if (format === 'pptx') {
      // Don't fire the request yet — let the user fill the form first.
      setPptxOptionsOpen(true);
      return;
    }
    setExporting(format);
    try {
      if (format === 'docx') {
        await exportWorkspace(workspaceId, 'docx', { workspaceTitle: title });
      } else {
        await exportWorkspace(workspaceId, 'md', { workspaceTitle: title });
      }
    } catch (err) {
      showActionError(
        `No pudimos exportar (${format})`,
        err instanceof Error ? err.message : 'Error desconocido',
      );
    } finally {
      setExporting(null);
    }
  }, [workspaceId, title, exporting, showActionError]);

  // Options modal → fired when the request to start generation succeeds.
  // Phase 3.F: the modal returns either a `pending` generationId (Gamma
  // is working, frontend polls) or a cache-hit `complete` result. Cache
  // opts so future "Generar de nuevo" pre-fills the form.
  const handlePptxOptionsSubmit = useCallback((opts: PptxOptions, submit: PptxOptionsSubmit) => {
    setPptxOptionsCache(opts);
    setPptxOptionsOpen(false);
    if (submit.status === 'complete') {
      setPptxPending(null);
      setPptxResult(submit.result);
    } else {
      setPptxResult(null);
      setPptxPending({ generationId: submit.generationId, filename: submit.filename });
    }
  }, []);

  // Result modal → "Generar de nuevo" closes result and reopens options.
  const handlePptxRegenerate = useCallback(() => {
    setPptxResult(null);
    setPptxPending(null);
    setPptxOptionsOpen(true);
  }, []);

  // Result modal close — clear both shapes regardless of which one was active.
  const handlePptxResultClose = useCallback(() => {
    setPptxResult(null);
    setPptxPending(null);
  }, []);

  // ── Title commit ─────────────────────────────────────────────────
  const commitTitle = () => {
    if (draftTitle.trim() && draftTitle !== title) {
      onTitleChange(draftTitle.trim());
    }
    setEditingTitle(false);
  };

  return (
    <div className="flex h-full">
      {/* ── Chat Panel (workspace-scoped /turn streaming) ─────────────
           Desktop: persistent 360px column.
           Mobile  (<lg): hidden by default, opened as drawer via the
           "Chat" floating button on the canvas. */}
      <div className="hidden lg:flex flex-col min-h-0 w-[360px] shrink-0 border-r border-white/50 dark:border-white/10">
        <section className="h-full min-h-0 bg-white/70 dark:bg-white/5 backdrop-blur-2xl overflow-hidden shadow-[0_8px_35px_rgba(0,0,0,0.06)]">
          <ChatPanel
            workspaceId={workspaceId}
            workspaceTitle={title}
            selectedNodeId={selectedNodeId}
            hojaTitles={hojaTitles}
            onWorkspaceAction={handleWorkspaceAction}
          />
        </section>
      </div>

      {/* Mobile chat drawer */}
      {mobileChatOpen && (
        <div
          className="lg:hidden fixed inset-0 z-[180] flex"
          role="dialog"
          aria-modal="true"
          aria-label="Chat del workspace"
        >
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setMobileChatOpen(false)}
            aria-hidden
          />
          <div className="relative ml-auto w-[min(420px,90vw)] h-full bg-[#f8f9fc] dark:bg-mesh shadow-2xl border-l border-black/10 dark:border-white/10 animate-in slide-in-from-right duration-250">
            <button
              type="button"
              onClick={() => setMobileChatOpen(false)}
              aria-label="Cerrar chat"
              className="absolute top-3 right-3 z-10 p-2 rounded-lg bg-white/80 dark:bg-white/10 backdrop-blur-xl border border-black/8 dark:border-white/10 text-[#0e1745]/65 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white transition-colors"
            >
              <X className="w-4 h-4" aria-hidden />
            </button>
            <ChatPanel
              workspaceId={workspaceId}
              workspaceTitle={title}
              selectedNodeId={selectedNodeId}
              hojaTitles={hojaTitles}
              onWorkspaceAction={handleWorkspaceAction}
            />
          </div>
        </div>
      )}

      {/* ── Canvas ──────────────────────────────────────────────────
        tabIndex=-1 + ref + onBlur: lets the pane hold focus so the
        scoped Backspace listener fires, and clears the selection when
        focus actually leaves the canvas (e.g. user tabs into ChatPanel
        or a popover). Without this, selectedNodeId could linger across
        unrelated focus changes and a stray Backspace would delete it. */}
      <div
        ref={canvasPaneRef}
        tabIndex={-1}
        onBlur={(e) => {
          // Cast through `unknown` because xyflow's `Node` type shadows
          // the DOM Node import in this file. We just need a DOM-Node
          // reference for `contains` to detect cross-pane focus moves.
          const next = e.relatedTarget as unknown as globalThis.Node | null;
          if (!e.currentTarget.contains(next)) {
            setSelectedNodeId(null);
          }
        }}
        className="flex-1 relative h-full focus:outline-none"
      >
        {/* Inline action error banner — surfaces backend failures from
             create/import so the user sees the real reason instead of a
             silent no-op. Auto-dismissed after 6s, also dismissable. */}
        {actionError && (
          <div
            role="alert"
            className="absolute left-1/2 top-3 z-40 -translate-x-1/2 max-w-[min(560px,calc(100%-2rem))] rounded-xl bg-rose-50 dark:bg-rose-900/25 border border-rose-200 dark:border-rose-700/40 px-4 py-3 flex items-start justify-between gap-3 shadow-lg animate-in fade-in slide-in-from-top-2 duration-200"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-rose-900 dark:text-rose-200">{actionError.title}</p>
              <p className="text-xs text-rose-700/80 dark:text-rose-300/70 mt-0.5 break-words">{actionError.detail}</p>
            </div>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Cerrar error"
              className="text-rose-700 dark:text-rose-300 hover:opacity-70 text-lg leading-none shrink-0"
            >×</button>
          </div>
        )}

        {loading && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-[#f8f9fc]/85 dark:bg-[#080d1a]/85 backdrop-blur-sm animate-in fade-in duration-200"
            role="status"
            aria-busy="true"
            aria-label="Cargando canvas"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-10 w-10 rounded-full border-2 border-[#1534dc]/20 border-t-[#1534dc] dark:border-[#8b5cf6]/20 dark:border-t-[#8b5cf6] animate-spin" aria-hidden />
              <p className="text-[12px] font-medium text-[#0e1745]/60 dark:text-white/55">Abriendo workspace…</p>
            </div>
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={[]}
          onNodesChange={handleNodesChange}
          nodeTypes={NODE_TYPES}
          onPaneClick={() => setSelectedNodeId(null)}
          onNodeClick={(_, node) => handleSelect(node.id)}
          // @ts-expect-error — onPaneDoubleClick supported at runtime, missing in this typing
          onPaneDoubleClick={handlePaneDoubleClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={2}
          panOnScroll
          selectionOnDrag
          className="bg-[#f8f9fc] dark:bg-[#080d1a]"
        >
          {/* Subtle dot grid background */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color="rgba(14,23,69,0.10)"
            className="dark:[color:rgba(255,255,255,0.05)]"
          />

          {/* Mini-map */}
          <MiniMap
            nodeColor={() => 'rgba(21,52,220,0.25)'}
            maskColor="rgba(14,23,69,0.04)"
            className="!border-black/8 dark:!border-white/10 !rounded-xl !shadow-lg !bg-white dark:!bg-[#0b1120]"
          />

          {/* Controls */}
          <Controls
            showInteractive={false}
            className="!border-black/8 dark:!border-white/10 !rounded-xl !shadow-sm !bg-white dark:!bg-[#0b1120] [&>button]:!border-none [&>button]:!text-[#0e1745] dark:[&>button]:!text-white"
          />

          {/* Top-left: back + title */}
          <Panel position="top-left" className="m-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('/workspaces')}
                aria-label="Volver a la lista de workspaces"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#0e1745]/70 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                title="Volver a workspaces"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden />
              </button>

              {editingTitle ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                  aria-label="Editar título del workspace"
                  className="px-3 py-2 rounded-xl bg-white dark:bg-[#0c1230] border border-[#1534dc]/40 dark:border-[#8b5cf6]/40 shadow-sm text-[14px] font-semibold text-[#0e1745] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#1534dc]/15 dark:focus:ring-[#8b5cf6]/20 w-56"
                />
              ) : (
                <button
                  onClick={() => { setEditingTitle(true); setDraftTitle(title); }}
                  aria-label={`Editar título: ${title}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm hover:bg-white dark:hover:bg-[#0c1230] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                >
                  <Layers className="w-4 h-4 text-[#7A3B47]" aria-hidden />
                  <span className="text-[14px] font-semibold text-[#0e1745] dark:text-white max-w-[200px] truncate">{title}</span>
                </button>
              )}
            </div>
          </Panel>

          {/* Top-right: action toolbar */}
          <Panel position="top-right" className="m-3">
            <div className="flex items-center gap-2">
              {/* Mobile-only chat drawer trigger */}
              <button
                onClick={() => setMobileChatOpen(true)}
                title="Abrir chat del workspace"
                aria-label="Abrir chat del workspace"
                className="lg:hidden flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#0e1745] dark:text-white hover:bg-white dark:hover:bg-[#0c1230] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
              >
                <MessageSquareText className="w-4 h-4" aria-hidden />
              </button>

              {/* Quick hoja (Lexa) / Arquitecta (Atlas) — opens QuickHojaModal */}
              <button
                onClick={() => setQuickHojaOpen(true)}
                title="Crear una hoja rápida o un set con la arquitecta"
                aria-label="Abrir modal de nueva hoja con IA"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#1534dc] dark:text-[#8b5cf6] hover:bg-white dark:hover:bg-[#0c1230] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
              >
                <Sparkles className="w-4 h-4" aria-hidden />
                <span className="hidden md:inline">Arquitecta</span>
              </button>

              {/* Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Subir archivo (imagen, audio, documento)"
                aria-label="Subir archivo al workspace"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#0e1745] dark:text-white hover:bg-white dark:hover:bg-[#0c1230] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
              >
                <Upload className="w-4 h-4" aria-hidden />
                <span className="hidden md:inline">Subir</span>
              </button>

              {/* Export */}
              <div className="relative">
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  disabled={exporting !== null}
                  title="Exportar (md, docx, pptx)"
                  aria-label="Exportar workspace"
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  aria-busy={exporting !== null}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#7A3B47] hover:bg-white dark:hover:bg-[#0c1230] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                >
                  {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Download className="w-4 h-4" aria-hidden />}
                  <span className="hidden md:inline">{exporting ? 'Exportando…' : 'Exportar'}</span>
                </button>
                {exportMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-white dark:bg-[#0c1230] border border-black/8 dark:border-white/10 shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-150"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => handleExport('pptx')}
                      className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 flex items-center gap-2"
                    >
                      <Presentation className="w-3.5 h-3.5 text-[#7A3B47]" />
                      Presentación (.pptx)
                    </button>
                    <button
                      onClick={() => handleExport('docx')}
                      className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 flex items-center gap-2"
                    >
                      <FileDown className="w-3.5 h-3.5 text-[#7A3B47]" />
                      Word (.docx)
                    </button>
                    <button
                      onClick={() => handleExport('md')}
                      className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 flex items-center gap-2"
                    >
                      <FileText className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50" />
                      Markdown (.md)
                    </button>
                  </div>
                )}
              </div>

              {/* Add hoja */}
              <button
                onClick={() => void handleAddHoja()}
                aria-label="Agregar nueva hoja al canvas"
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1534dc] dark:bg-[#8b5cf6] text-white text-[13px] font-semibold hover:bg-[#1230c0] dark:hover:bg-[#7a4cf2] transition-colors shadow-sm shadow-[#1534dc]/25 dark:shadow-[#8b5cf6]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f8f9fc] dark:focus-visible:ring-offset-[#080d1a]"
              >
                <Plus className="w-4 h-4" aria-hidden />
                <span className="hidden md:inline">Nueva hoja</span>
              </button>
            </div>
          </Panel>

          {/* Empty state */}
          {nodes.length === 0 && !loading && (
            <Panel position="bottom-center" className="mb-10">
              <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-white/85 dark:bg-[#0c1230]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-[0_12px_40px_rgba(14,23,69,0.10)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.40)] animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#7A3B47]/15 to-[#1534dc]/10 dark:from-[#7A3B47]/30 dark:to-[#8b5cf6]/15 flex items-center justify-center shadow-inner">
                  <ZoomIn className="w-5 h-5 text-[#7A3B47]/80 dark:text-[#7A3B47]" aria-hidden />
                </div>
                <p className="text-[13px] font-semibold text-[#0e1745] dark:text-white">Tu canvas está vacío</p>
                <p className="text-[12px] text-[#0e1745]/55 dark:text-white/50 text-center max-w-xs leading-relaxed">
                  Doble clic en el lienzo para crear una hoja, o usá los botones para subir un archivo o pedirle a la arquitecta.
                </p>
                <div className="mt-1 flex items-center gap-2 flex-wrap justify-center">
                  <button
                    onClick={() => void handleAddHoja()}
                    aria-label="Crear primera hoja"
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1534dc] dark:bg-[#8b5cf6] text-white text-[12.5px] font-semibold hover:bg-[#1230c0] dark:hover:bg-[#7a4cf2] transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1534dc]/45 dark:focus-visible:ring-[#8b5cf6]/45"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden /> Crea tu primera hoja
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Importar archivo"
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/8 dark:hover:bg-white/10 text-[#0e1745] dark:text-white text-[12.5px] font-medium transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5" aria-hidden /> Importar archivo
                  </button>
                  <button
                    onClick={() => setQuickHojaOpen(true)}
                    aria-label="Pedirle a la arquitecta"
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#7A3B47]/8 dark:bg-[#7A3B47]/15 hover:bg-[#7A3B47]/12 dark:hover:bg-[#7A3B47]/25 text-[#7A3B47] dark:text-[#a8525f] text-[12.5px] font-medium transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden /> Genera con Atlas
                  </button>
                </div>
              </div>
            </Panel>
          )}
        </ReactFlow>

        {/* Floating overlays: format toolbar + selection-bound AI menu. Listen to TipTap selection events globally. */}
        <HojaFormatMenu workspaceId={workspaceId} />
        <HojaSelectionMenu workspaceId={workspaceId} />
      </div>

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,audio/*,application/pdf,.docx,.md,.txt"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          void handleFilesPicked(files);
          e.currentTarget.value = '';
        }}
      />

      {/* T9 — quick-hoja modal (replaces inline architect panel) */}
      <QuickHojaModal
        open={quickHojaOpen}
        onClose={() => setQuickHojaOpen(false)}
        workspaceId={workspaceId}
        onCreated={(nodes) => {
          setQuickHojaOpen(false);
          handleQuickHojaCreated(nodes);
        }}
      />

      {/* T9 — pptx pre-generation form (owns the exportWorkspace call) */}
      <PptxOptionsModal
        open={pptxOptionsOpen}
        onClose={() => setPptxOptionsOpen(false)}
        workspaceId={workspaceId}
        workspaceTitle={title}
        initial={pptxOptionsCache}
        onSubmit={handlePptxOptionsSubmit}
      />

      {/* T9 — pptx result with explicit user-clicked CTAs.
           Phase 3.F: also handles the polling state when the server
           kicked off a fresh generation rather than returning a cache hit. */}
      <PptxResultModal
        open={Boolean(pptxResult) || Boolean(pptxPending)}
        onClose={handlePptxResultClose}
        result={pptxResult}
        generationId={pptxPending?.generationId ?? null}
        workspaceId={workspaceId}
        filename={pptxPending?.filename}
        onRegenerate={handlePptxRegenerate}
        workspaceTitle={title}
      />
    </div>
  );
}

// ─── Page wrapper (provides ReactFlow context + workspace meta) ───────
export function WorkspaceCanvasPage({ workspaceId }: { workspaceId: string }) {
  const [title, setTitle] = useState('Cargando…');

  useEffect(() => {
    let alive = true;
    getWorkspace(workspaceId)
      .then((b) => { if (alive && b.workspace?.title) setTitle(b.workspace.title); })
      .catch(() => { if (alive) setTitle('Workspace'); });
    return () => { alive = false; };
  }, [workspaceId]);

  const handleTitleChange = useCallback(async (newTitle: string) => {
    setTitle(newTitle);
    await updateWorkspace(workspaceId, { title: newTitle }).catch(() => null);
  }, [workspaceId]);

  return (
    <div className={cn(
      'h-screen flex flex-col bg-[#f8f9fc] dark:bg-mesh text-[#0e1745] dark:text-white overflow-hidden',
    )}>
      <TopDock />
      <div className="flex-1 min-h-0">
        <ReactFlowProvider>
          <CanvasInner
            workspaceId={workspaceId}
            title={title}
            onTitleChange={handleTitleChange}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
