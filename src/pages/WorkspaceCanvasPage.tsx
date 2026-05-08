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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Panel,
  ReactFlowProvider, useNodesState, useReactFlow,
  type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Plus, Layers, Sparkles, Upload, ZoomIn, Presentation,
  FileDown, FileText, Download, Loader2,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { AnimatedAiInput } from '@/components/animated-ai-input';
import { HojaNode } from '@/components/hoja/HojaNode';
import { AssetNode } from '@/components/hoja/AssetNode';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listNodes, createNode, updateNode, deleteNode, getNode, importAsset,
  updateWorkspace, exportWorkspace, runArchitect, getWorkspace,
  type WorkspaceNode, type PptxExportResult,
} from '@/services/workspaceApi';

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

  // Architect state — inline prompt panel
  const [architectOpen, setArchitectOpen] = useState(false);
  const [architectPrompt, setArchitectPrompt] = useState('');
  const [architectRunning, setArchitectRunning] = useState(false);
  const [architectError, setArchitectError] = useState<string | null>(null);

  // Export state — inline result panel
  const [exporting, setExporting] = useState<'md' | 'docx' | 'pptx' | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [pptxResult, setPptxResult] = useState<PptxExportResult | null>(null);
  const [pptxError, setPptxError] = useState<string | null>(null);

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

  // ── Cleanup all pending timers on unmount. Important #2 + #3. ────
  useEffect(() => () => {
    positionSaveTimers.current.forEach((t) => clearTimeout(t));
    positionSaveTimers.current.clear();
    pendingTimers.current.forEach((t) => clearTimeout(t));
    pendingTimers.current.clear();
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).contentEditable === 'true'
      ) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        void handleDelete(selectedNodeId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNodeId, handleDelete]);

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
    } catch {
      // graceful — node didn't save, don't add to canvas
    }
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer]);

  // ── Upload asset ─────────────────────────────────────────────────
  const handleFilesPicked = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const basePos = gridPosition(nodes.length);
    let i = 0;
    for (const file of Array.from(files)) {
      const offset = i * 24;
      const apiNode = await importAsset(workspaceId, file, {
        x: basePos.x + offset,
        y: basePos.y + offset,
      }).catch(() => null);
      if (apiNode) {
        const rfNode = toRFNode(apiNode, workspaceId, { onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate });
        setNodes((ns) => [...ns, rfNode]);
      }
      i++;
    }
    scheduleTimer(() => fitView({ padding: 0.15, duration: 400 }), 60);
  }, [workspaceId, nodes.length, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer]);

  // ── Double-click pane → add hoja at click ────────────────────────
  const handlePaneDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    void handleAddHoja({ x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }, [screenToFlowPosition, handleAddHoja]);

  // ── Architect ────────────────────────────────────────────────────
  const handleArchitectRun = useCallback(async () => {
    const prompt = architectPrompt.trim();
    if (!prompt || architectRunning) return;
    setArchitectRunning(true);
    setArchitectError(null);
    try {
      const { nodes: newNodes } = await runArchitect(workspaceId, prompt);
      // Stagger materialization
      for (let i = 0; i < newNodes.length; i++) {
        const n = newNodes[i];
        const rf = toRFNode(n, workspaceId, { onDelete: handleDelete, onSelect: handleSelect, onUpdate: handleNodeUpdate });
        scheduleTimer(() => setNodes((ns) => [...ns, rf]), i * 120);
      }
      scheduleTimer(() => fitView({ padding: 0.18, duration: 600 }), newNodes.length * 120 + 100);
      setArchitectPrompt('');
      setArchitectOpen(false);
    } catch (err) {
      setArchitectError((err as Error).message);
    } finally {
      setArchitectRunning(false);
    }
  }, [architectPrompt, architectRunning, workspaceId, setNodes, fitView, handleDelete, handleSelect, handleNodeUpdate, scheduleTimer]);

  // ── Export ───────────────────────────────────────────────────────
  const handleExport = useCallback(async (format: 'md' | 'docx' | 'pptx') => {
    if (exporting) return;
    setExporting(format);
    setExportMenuOpen(false);
    setPptxError(null);
    try {
      if (format === 'pptx') {
        const result = await exportWorkspace(workspaceId, 'pptx', { workspaceTitle: title });
        setPptxResult(result);
      } else if (format === 'docx') {
        await exportWorkspace(workspaceId, 'docx', { workspaceTitle: title });
      } else {
        await exportWorkspace(workspaceId, 'md', { workspaceTitle: title });
      }
    } catch (err) {
      if (format === 'pptx') setPptxError((err as Error).message);
    } finally {
      setExporting(null);
    }
  }, [workspaceId, title, exporting]);

  // ── Title commit ─────────────────────────────────────────────────
  const commitTitle = () => {
    if (draftTitle.trim() && draftTitle !== title) {
      onTitleChange(draftTitle.trim());
    }
    setEditingTitle(false);
  };

  return (
    <div className="flex h-full">
      {/* ── Chat Panel (Studio's existing AnimatedAiInput in compact) ── */}
      <div className="hidden lg:flex flex-col min-h-0 w-[340px] shrink-0 border-r border-black/8 dark:border-white/8">
        <section className="h-full bg-white/70 dark:bg-white/5 backdrop-blur-2xl overflow-hidden">
          <AnimatedAiInput compact />
        </section>
      </div>

      {/* ── Canvas ────────────────────────────────────────────────── */}
      <div className="flex-1 relative h-full">
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#f8f9fc]/80 dark:bg-mesh/80 backdrop-blur-sm">
            <div className="h-10 w-10 rounded-full border-2 border-[#1534dc]/20 border-t-[#1534dc] animate-spin" />
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
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#0e1745]/70 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white transition-colors"
                title="Volver a workspaces"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              {editingTitle ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                  className="px-3 py-2 rounded-xl bg-white dark:bg-[#0b1120] border border-[#1534dc]/40 shadow-sm text-[14px] font-semibold text-[#0e1745] dark:text-white focus:outline-none w-56"
                />
              ) : (
                <button
                  onClick={() => { setEditingTitle(true); setDraftTitle(title); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm"
                >
                  <Layers className="w-4 h-4 text-[#7A3B47]" />
                  <span className="text-[14px] font-semibold text-[#0e1745] dark:text-white max-w-[200px] truncate">{title}</span>
                </button>
              )}
            </div>
          </Panel>

          {/* Top-right: action toolbar */}
          <Panel position="top-right" className="m-3">
            <div className="flex items-center gap-2">
              {/* Architect */}
              <button
                onClick={() => setArchitectOpen((v) => !v)}
                title="Pedirle al chat que arme un set de hojas"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#1534dc] dark:text-[#8b5cf6] hover:bg-white dark:hover:bg-[#0b1120] transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                <span className="hidden md:inline">Arquitecta</span>
              </button>

              {/* Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Subir archivo (imagen, audio, documento)"
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#0e1745] dark:text-white hover:bg-white dark:hover:bg-[#0b1120] transition-colors"
              >
                <Upload className="w-4 h-4" />
                <span className="hidden md:inline">Subir</span>
              </button>

              {/* Export */}
              <div className="relative">
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  disabled={exporting !== null}
                  title="Exportar (md, docx, pptx)"
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm text-[13px] font-medium text-[#7A3B47] hover:bg-white dark:hover:bg-[#0b1120] transition-colors disabled:opacity-60"
                >
                  {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  <span className="hidden md:inline">{exporting ? 'Exportando…' : 'Exportar'}</span>
                </button>
                {exportMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-white dark:bg-[#0b1120] border border-black/8 dark:border-white/10 shadow-xl py-1 z-50"
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
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1534dc] text-white text-[13px] font-semibold hover:bg-[#1230c0] transition-colors shadow-sm shadow-[#1534dc]/25"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden md:inline">Nueva hoja</span>
              </button>
            </div>
          </Panel>

          {/* Architect inline panel */}
          {architectOpen && (
            <Panel position="top-center" className="mt-16">
              <div className="w-[min(640px,80vw)] p-4 rounded-2xl bg-white/85 dark:bg-[#0b1120]/85 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-[0_8px_35px_rgba(0,0,0,0.10)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.4)]">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-[#1534dc] dark:text-[#8b5cf6]" />
                  <h3 className="text-[13px] font-semibold text-[#0e1745] dark:text-white">Arquitecta de hojas</h3>
                </div>
                <p className="text-[12px] text-[#0e1745]/55 dark:text-white/50 mb-3">
                  Describí qué set de hojas necesitás. La arquitecta arma 3-6 hojas relacionadas en el canvas.
                </p>
                <textarea
                  autoFocus
                  value={architectPrompt}
                  onChange={(e) => setArchitectPrompt(e.target.value)}
                  placeholder="Ej. Un análisis de marca para una fintech LATAM: posicionamiento, audiencia, mensaje, tono, plan de lanzamiento."
                  className="w-full min-h-[100px] resize-none rounded-xl bg-white dark:bg-white/[0.03] border border-black/8 dark:border-white/10 px-3 py-2 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-[#1534dc]/40"
                />
                {architectError && (
                  <p className="mt-2 text-[12px] text-red-500">{architectError}</p>
                )}
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => { setArchitectOpen(false); setArchitectError(null); }}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8 transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={() => void handleArchitectRun()}
                    disabled={!architectPrompt.trim() || architectRunning}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#1534dc] text-white text-[12.5px] font-semibold hover:bg-[#1230c0] transition-colors disabled:opacity-60"
                  >
                    {architectRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {architectRunning ? 'Generando…' : 'Generar'}
                  </button>
                </div>
              </div>
            </Panel>
          )}

          {/* Empty state */}
          {nodes.length === 0 && !loading && (
            <Panel position="bottom-center" className="mb-10">
              <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-white/80 dark:bg-[#0b1120]/80 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-sm">
                <div className="w-12 h-12 rounded-2xl bg-[#7A3B47]/10 flex items-center justify-center">
                  <ZoomIn className="w-5 h-5 text-[#7A3B47]/70" />
                </div>
                <p className="text-[13px] font-semibold text-[#0e1745] dark:text-white">Tu canvas está vacío</p>
                <p className="text-[12px] text-[#0e1745]/55 dark:text-white/50 text-center max-w-xs">
                  Doble clic en el lienzo para crear hoja, o usá los botones para subir un archivo o pedirle a la arquitecta.
                </p>
                <button
                  onClick={() => void handleAddHoja()}
                  className="mt-1 flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1534dc] text-white text-[12.5px] font-semibold hover:bg-[#1230c0] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Crea tu primera hoja
                </button>
              </div>
            </Panel>
          )}
        </ReactFlow>
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

      {/* Pptx result modal (placeholder — T9/T10 polish) */}
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
                <p className="text-[13px] text-[#0e1745]/60 dark:text-white/55 mb-4 truncate">{pptxResult.filename}</p>
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
                <h3 className="text-[16px] font-semibold mb-1 text-red-600">No se pudo generar la presentación</h3>
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
