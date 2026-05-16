/**
 * @file useGraphStoreV2.ts
 * @description Single source of truth for the modo-nodos graph store
 *   since D1 (2026-05-10). V1 (`useGraphStore.ts`) was deleted in the
 *   same pass — every consumer routes through `useActiveGraphStore`
 *   re-exported from `src/store/index.ts`.
 *
 *   The "V2" suffix is kept for git-archeology purposes (Wave C and
 *   earlier docs reference it) but the store no longer lives behind a
 *   feature flag. Adding new actions here is the only path forward.
 */
import { create } from 'zustand';
import {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  addEdge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import { getLayoutedElements } from '../utils/layoutGraph';
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMATS,
  type BranchSection,
  type ExportFormat,
  type TableData,
} from '../types/export';
import { exportWorkspace, pollPptxStatus } from '../services/workspaceApi';

export type AppNode = Node;

export interface Snapshot {
  id: string;
  timestamp: number;
  nodes: AppNode[];
  edges: Edge[];
  metadata: { executionTimeMs: number };
}

// V2 AppState — adaptado para la nueva lógica (algunos hooks viejos se mantienen para compatibilidad de la UI)
type AppState = {
  nodes: AppNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<AppNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: Edge[]) => void;

  // Tri-state global nav mode. `'canvas'` (legacy) was split into
  // `'workspace'` (hojas-mode inside a workspace) and `'nodos'` (graph
  // builder) when the top-dock collapsed Chat|Nodes into Chat|Workspace|
  // Nodos (2026-05-16). Routing in App.tsx maps modes → URLs:
  //   • 'chat'      → /  (root chat layout)
  //   • 'workspace' → /workspaces or /workspaces/:lastId in hojas mode
  //   • 'nodos'     → /workspaces/:lastId in nodos mode
  activeMode: 'chat' | 'workspace' | 'nodos';
  setActiveMode: (mode: 'chat' | 'workspace' | 'nodos') => void;

  // Wave C: workspace association for the modo nodos export pipeline.
  // The active workspace id is set by `WorkspaceCanvasPage` on mount and
  // cleared on unmount; export nodes route through `exportWorkspace(id,
  // format, …)` which needs this scope. Null while no workspace is
  // mounted (e.g. on the workspaces list or during early boot).
  workspaceId: string | null;
  setWorkspaceId: (id: string | null) => void;
  /**
   * Trigger a client-driven export for the given export node. Builds
   * sections from immediate predecessors, calls /api/workspace/:id/export,
   * polls Gamma for async formats, and writes status/exportUrl/errorMsg
   * back into the node's data so the ExportNode UI can render the right
   * visual state. Resolves once the export settles (success, failure or
   * blob download). Safe to call multiple times — each call sets status
   * RUNNING → COMPLETED|FAILED.
   */
  runExportNode: (exportNodeId: string) => Promise<void>;

  // New V2 Execution concepts
  generateGraph: (userMessage: string, chatHistory: any[], tenantId: string) => Promise<{ mode: string, narrative?: string, message?: string }>;

  /**
   * Wave-D (2026-05-16): apply a freshly-architected graph onto the
   * canvas while painting an animated diff. Each node receives a
   * transient `data.diffState` ('added'|'removed'|'modified') that
   * `SpecialistNode`/`ContextNode`/`ExportNode` consume to render the
   * visual flair (green ring/scale, red fade, blue pulse). The flag is
   * cleared after `DIFF_ANIMATION_MS` so subsequent edits don't keep
   * pulsing forever.
   *
   * The diff is computed BEFORE the new graph is committed:
   *   • added    → ids in newGraph that weren't in current.
   *   • removed  → ids in current that aren't in newGraph (we keep them
   *                in the rendered nodes for one animation cycle with
   *                `diffState: 'removed'` so the fade-out is visible,
   *                then drop them on cleanup).
   *   • modified → id match, data object differs (shallow stringify
   *                compare — cheap and good enough for the architect
   *                output which is plain JSON).
   *
   * Layout: re-runs dagre on the merged node set so newly added nodes
   * snap into a clean DAG instead of stacking at (0,0). Existing node
   * positions are preserved when they already had a position so the
   * canvas doesn't lurch around for the user.
   */
  applyGraphWithDiff: (newGraph: { nodes: any[]; edges: Edge[] }) => void;

  // SSE-driven graph execution (mirrors V1's executeGraph surface).
  // The implementation lives in the create() body below; the type is
  // declared here so consumers can read it via useActiveGraphStore.
  isExecuting: boolean;
  /** Set by `executeGraph` once the server assigns an id; cleared on
   *  graph:done / cancel / error. The Cancelar button uses this to call
   *  `cancelExecution(id)` against the gateway. Null while idle. */
  currentExecutionId: string | null;
  executeGraph: () => Promise<void>;
  /** Cancel the in-flight graph execution. No-op when idle. */
  cancelExecution: () => Promise<void>;
  updateNodeStatus: (id: string, status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED') => void;
  /** Stream a token chunk onto a node's `outputText`. Used by the SSE
   *  client's `onNodeToken` handler for live token-by-token output. */
  appendNodeOutput: (id: string, delta: string) => void;

  // V2 Specific UI state
  hitlState: { pauseId: string, prompt: string, status: 'paused' | 'expired' } | null;
  setHitlState: (state: AppState['hitlState']) => void;
  resumeHitl: (decision: 'approve' | 'reject') => Promise<void>;

  currentNarration: string | null;
  setCurrentNarration: (text: string | null) => void;

  // UI Editing
  history: { past: { nodes: AppNode[]; edges: Edge[] }[]; future: { nodes: AppNode[]; edges: Edge[] }[] };
  takeSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  addNode: (node: AppNode) => void;
  deleteNode: (id: string) => void;
  deleteEdge: (id: string) => void;
  updateNodeData: (id: string, data: Record<string, any>) => void;

  // Time-Travel Snapshots (legacy compatible)
  snapshots: Snapshot[];
  activeSnapshotId: string | null;
  captureSnapshot: (executionTimeMs: number) => void;
  restoreSnapshot: (id: string) => void;
};

const initialNodes: AppNode[] = [];
const initialEdges: Edge[] = [];

import { generateGraph as fetchGenerateGraph, resumeGraph as fetchResumeGraph } from '../services/graphApi';
import {
  startExecution as startGraphExecution,
  subscribeToExecution,
  cancelExecution as cancelGraphExecution,
  toBranchSections,
  type GraphExecutionNode,
  type GraphExecutionEdge,
} from '../services/graphExecutionApi';

/**
 * Active SSE unsubscribe handle for the current graph execution. Held in
 * module scope (not state) because it's a non-serializable disposer
 * function — zustand state should stay JSON-friendly for devtools/SSR.
 * Cleared on graph:done, cancel, or connection error.
 */
let activeUnsubscribe: (() => void) | null = null;

/**
 * Wave-D diff animation duration. Long enough for the eye to register
 * the colour change, short enough that subsequent edits don't queue up
 * a long-running pulse storm. Mirrors the CSS animation duration in
 * `src/index.css` (`shifty-graph-diff-*` keyframes).
 */
const DIFF_ANIMATION_MS = 1500;

/**
 * Pending diff-cleanup timer. Module-scope so a follow-up
 * applyGraphWithDiff call replaces the previous timer rather than
 * scheduling parallel cleanups that would prematurely clear the new
 * diffState before the user sees the animation.
 */
let diffCleanupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Cheap shallow equality for two node `data` objects. Used by the diff
 * to decide if a same-id node counts as "modified". Stringify is good
 * enough — the architect output is plain JSON and we only need to know
 * if the visible config (agent, prompt, label, text…) changed.
 */
function nodeDataEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  } catch {
    return false;
  }
}

/**
 * Coerce an unknown raw `data.format` value into a known ExportFormat.
 * Mirrors the normalizer in `src/components/nodes/ExportNode.tsx` so the
 * runner and the visual stay in lockstep.
 */
function normalizeExportFormat(raw: unknown): ExportFormat {
  if (typeof raw !== 'string') return DEFAULT_EXPORT_FORMAT;
  const lower = raw.toLowerCase();
  return (EXPORT_FORMATS as readonly string[]).includes(lower)
    ? (lower as ExportFormat)
    : DEFAULT_EXPORT_FORMAT;
}

/** True when the format goes through Gamma (async kickoff + polling). */
function isAsyncExportFormat(f: ExportFormat): boolean {
  return f === 'pptx' || f === 'pdf' || f === 'carousel';
}

/**
 * Build the modo-nodos `sections[]` payload from the immediate predecessors
 * of an export node. Mirrors the original V1 branch-isolation rule
 * (`useGraphStore.ts` was deleted in D1 — see git history for the
 * pre-Wave-C export path): each direct predecessor produces one
 * section, with the specialist's `outputText` as content (or the
 * context's text). Tabular data attached as `data: TableData` rides
 * through unchanged so the xlsx exporter can pivot on it.
 */
function buildSectionsForExportNode(
  exportNodeId: string,
  nodes: AppNode[],
  edges: Edge[],
): BranchSection[] {
  const predecessorIds = edges
    .filter((e) => e.target === exportNodeId)
    .map((e) => e.source);
  const sections: BranchSection[] = [];
  for (const pid of predecessorIds) {
    const pred = nodes.find((n) => n.id === pid);
    if (!pred) continue;
    const data = (pred.data ?? {}) as Record<string, unknown>;
    // Specialist nodes carry their LLM output in `outputText`; context
    // nodes carry the user-typed brief in `content` (legacy graphs stored
    // it as `text` — keep that fallback so older saved graphs still
    // export). Order: outputText → content → text. The server rejects
    // empty-string content with a 400, so we skip branches without any.
    let content = '';
    if (typeof data.outputText === 'string' && data.outputText.trim()) {
      content = data.outputText;
    } else if (typeof data.content === 'string' && data.content.trim()) {
      content = data.content;
    } else if (typeof data.text === 'string' && data.text.trim()) {
      content = data.text;
    }
    if (!content) continue;
    const labelRaw =
      (typeof data.label === 'string' && data.label) ||
      (typeof data.title === 'string' && data.title) ||
      (typeof data.agent === 'string' && data.agent) ||
      pred.type ||
      'Section';
    const title =
      String(labelRaw).charAt(0).toUpperCase() + String(labelRaw).slice(1);
    const tableData = data.data as TableData | undefined;
    sections.push({
      title,
      content,
      sourceNodeId: pred.id,
      ...(tableData && Array.isArray(tableData.headers) && Array.isArray(tableData.rows)
        ? { data: tableData }
        : {}),
    });
  }
  return sections;
}

export const useGraphStoreV2 = create<AppState>((set, get) => ({
  nodes: initialNodes,
  edges: initialEdges,
  activeMode: 'chat',
  isExecuting: false,
  currentExecutionId: null,
  history: { past: [], future: [] },
  snapshots: [],
  activeSnapshotId: null,
  hitlState: null,
  currentNarration: null,
  workspaceId: null,

  setHitlState: (state) => set({ hitlState: state }),
  setCurrentNarration: (text) => set({ currentNarration: text }),
  setWorkspaceId: (id) => set({ workspaceId: id }),

  resumeHitl: async (decision: 'approve' | 'reject') => {
    const { hitlState } = get();
    if (!hitlState?.pauseId) return;
    try {
      await fetchResumeGraph(hitlState.pauseId, decision);
      set({ hitlState: null });
    } catch (e) {
      console.error("Resume failed:", e);
      // Optionally handle error modal/toast
    }
  },

  setActiveMode: (mode) => set({ activeMode: mode }),

  runExportNode: async (exportNodeId: string) => {
    const { nodes, edges, workspaceId, updateNodeData, updateNodeStatus } =
      get();
    const node = nodes.find((n) => n.id === exportNodeId);
    if (!node) {
      console.warn('[runExportNode] node not found:', exportNodeId);
      return;
    }
    if (!workspaceId) {
      // No workspace mounted — surface the error on the node so the UI
      // gives the user a real reason rather than a silent no-op. The
      // backend would have rejected with 401/404 anyway.
      updateNodeStatus(exportNodeId, 'FAILED');
      updateNodeData(exportNodeId, {
        errorMsg:
          'No hay workspace activo — abrí un workspace antes de exportar.',
      });
      return;
    }

    const data = (node.data ?? {}) as Record<string, unknown>;
    const format = normalizeExportFormat(data.format);
    // Prefer sections pushed onto the node by the SSE `graph:done` event
    // — those carry the Cerebro-synthesized output verbatim. Fall back
    // to the predecessor-walk for manual export triggers (user clicks
    // run on the export node without an upstream graph run).
    const presetSections = Array.isArray(data.presetSections)
      ? (data.presetSections as BranchSection[]).filter(
          (s) =>
            s &&
            typeof s.title === 'string' &&
            typeof s.content === 'string' &&
            s.content.trim().length > 0,
        )
      : [];
    const sections =
      presetSections.length > 0
        ? presetSections
        : buildSectionsForExportNode(exportNodeId, nodes, edges);
    if (sections.length === 0) {
      updateNodeStatus(exportNodeId, 'FAILED');
      updateNodeData(exportNodeId, {
        errorMsg:
          'El exportador no recibió contenido — conectá un especialista o un contexto al nodo.',
      });
      return;
    }

    // Mark as in-flight + clear stale download/error state so the UI
    // re-renders cleanly when the user retries.
    updateNodeStatus(exportNodeId, 'RUNNING');
    updateNodeData(exportNodeId, { exportUrl: undefined, errorMsg: undefined });

    const titleOverride =
      (typeof data.title === 'string' && data.title.trim()) ||
      'Exportación · Modo Nodos';
    const subtitleOverride = 'Generado vía modo nodos';

    try {
      if (isAsyncExportFormat(format)) {
        // pptx / pdf / carousel — kick off + poll.
        const start = await exportWorkspace(workspaceId, format as 'pptx', {
          sections,
          title: titleOverride,
          subtitle: subtitleOverride,
        });
        if (start.status === 'complete') {
          updateNodeData(exportNodeId, {
            exportUrl: start.result.exportUrl,
            gammaUrl: start.result.gammaUrl,
            generationId: start.result.generationId,
          });
          updateNodeStatus(exportNodeId, 'COMPLETED');
          return;
        }
        const result = await pollPptxStatus(workspaceId, start.generationId, {
          format: format as 'pptx' | 'pdf' | 'carousel',
        });
        updateNodeData(exportNodeId, {
          exportUrl: result.exportUrl,
          gammaUrl: result.gammaUrl,
          generationId: result.generationId,
        });
        updateNodeStatus(exportNodeId, 'COMPLETED');
      } else {
        // md / docx / xlsx — in-process blob (the call also auto-triggers
        // the browser download). We mark complete once the bytes land;
        // there's no shareable url for these, but ExportNode renders the
        // "complete" badge regardless and skips the link button when
        // `exportUrl` is undefined.
        await exportWorkspace(workspaceId, format as 'docx', {
          sections,
          title: titleOverride,
          subtitle: subtitleOverride,
          workspaceTitle: titleOverride,
        });
        updateNodeStatus(exportNodeId, 'COMPLETED');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al exportar';
      console.error('[runExportNode] export failed:', err);
      updateNodeData(exportNodeId, { errorMsg: msg });
      updateNodeStatus(exportNodeId, 'FAILED');
    }
  },

  updateNodeStatus: (id, status) => {
    set({
      nodes: get().nodes.map(n => {
        if (n.id !== id) return n;
        const update: any = { status };
        if (status === 'RUNNING' && !n.data?.startTime) {
          update.startTime = Date.now();
        }
        if (status === 'COMPLETED' || status === 'FAILED') {
          update.endTime = Date.now();
        }
        return { ...n, data: { ...n.data, ...update } };
      })
    });
  },

  generateGraph: async (userMessage: string, chatHistory: any[], tenantId: string) => {
    try {
      const response = await fetchGenerateGraph({
        user_message: userMessage,
        current_graph: get().nodes.length > 0 ? { nodes: get().nodes, edges: get().edges } : null,
        chat_history: chatHistory.map(m => ({ role: m.role, content: m.content })),
        tenant_id: tenantId,
        model: 'claude-sonnet-4-6'
      });

      if (response.mode === 'graph' && response.graph) {
        // Wave-D: route through applyGraphWithDiff so the user sees
        // added/removed/modified animations. Legacy plain-set kept for
        // reference in git history; the diff path is strictly additive
        // (it still calls takeSnapshot for undo support).
        get().applyGraphWithDiff({
          nodes: response.graph.nodes,
          edges: response.graph.edges as Edge[],
        });
      }

      return response;
    } catch (e) {
      console.error("Error generating graph:", e);
      throw e;
    }
  },

  applyGraphWithDiff: (newGraph) => {
    const current = get();
    const prevNodes = current.nodes;
    const prevEdges = current.edges;

    const prevById = new Map(prevNodes.map((n) => [n.id, n]));
    const nextById = new Map((newGraph.nodes as AppNode[]).map((n) => [n.id, n]));

    // ─── Build the merged node set with diffState markers ───────────
    //
    // Pass 1: new + retained nodes carry forward their previous
    // position when known so the canvas doesn't jump on a partial
    // update (the architect doesn't include positions). Newly added
    // nodes get a placeholder (0,0) — dagre below assigns the real
    // coordinates.
    const mergedRaw: AppNode[] = newGraph.nodes.map((n: any) => {
      const prev = prevById.get(n.id);
      const isNew = !prev;
      const isModified = !isNew && !nodeDataEqual(prev?.data, n.data);
      const diffState = isNew ? 'added' : isModified ? 'modified' : null;
      return {
        ...n,
        position: prev?.position ?? { x: 0, y: 0 },
        data: { ...(n.data ?? {}), diffState },
      } as AppNode;
    });

    // Pass 2: removed nodes — keep them on the canvas one animation
    // cycle so the fade-out is visible, then strip them on cleanup.
    // We mark them with diffState='removed' and tag a transient
    // `__pendingRemoval` flag so the cleanup pass knows to drop them.
    const removedNodes: AppNode[] = prevNodes
      .filter((n) => !nextById.has(n.id))
      .map((n) => ({
        ...n,
        data: { ...(n.data ?? {}), diffState: 'removed', __pendingRemoval: true },
      }));

    const merged = [...mergedRaw, ...removedNodes];

    // Re-layout dagre on the survivors (skip removed nodes from the
    // layout pass so they fade in place rather than being relayouted
    // mid-animation).
    const survivors = merged.filter(
      (n) => !((n.data as { __pendingRemoval?: boolean })?.__pendingRemoval),
    );
    let layoutedSurvivors: AppNode[] = survivors;
    try {
      const { nodes: laid } = getLayoutedElements(
        survivors,
        newGraph.edges,
        'TB',
      );
      // dagre returns the same array shape — but the positions of
      // already-positioned nodes might shift slightly. Preserve the
      // PREVIOUS position for any node that already had one so the
      // canvas doesn't lurch; only newly-added nodes get fresh
      // coordinates.
      layoutedSurvivors = laid.map((n) => {
        const prev = prevById.get(n.id);
        const isNew = !prev;
        return isNew ? n : { ...n, position: prev?.position ?? n.position };
      });
    } catch (e) {
      console.warn('[applyGraphWithDiff] dagre layout failed:', e);
    }

    const finalNodes: AppNode[] = [
      ...layoutedSurvivors,
      ...merged.filter(
        (n) => (n.data as { __pendingRemoval?: boolean })?.__pendingRemoval,
      ),
    ];

    // Take a snapshot BEFORE applying so undo restores the pre-diff
    // state in one step (the user can ctrl-z the entire architect
    // turn).
    current.takeSnapshot();
    set({ nodes: finalNodes, edges: newGraph.edges });

    // Schedule cleanup — clear diffState on survivors + actually
    // remove pendingRemoval nodes. Overwrite any prior timer so
    // back-to-back applyGraphWithDiff calls don't trip each other.
    if (diffCleanupTimer) {
      clearTimeout(diffCleanupTimer);
      diffCleanupTimer = null;
    }
    diffCleanupTimer = setTimeout(() => {
      diffCleanupTimer = null;
      set((state) => ({
        nodes: state.nodes
          .filter(
            (n) =>
              !((n.data as { __pendingRemoval?: boolean })?.__pendingRemoval),
          )
          .map((n) => {
            const data = n.data as { diffState?: unknown } | undefined;
            if (!data || !data.diffState) return n;
            const { diffState: _drop, ...rest } = data as Record<
              string,
              unknown
            >;
            return { ...n, data: rest };
          }),
      }));
    }, DIFF_ANIMATION_MS);
  },

  /**
   * Kick off graph execution against the Cerebro `/v1/graph/execute` SSE
   * endpoint (or the in-process mock when `VITE_MOCK_GRAPH_EXEC=true`).
   * Calling while already executing is a no-op — use `cancelExecution()`
   * to stop. The DETENER button on the canvas calls cancelExecution
   * directly; this method only handles the kickoff path.
   *
   * Wave E2 (2026-05-10): replaces the legacy `GraphSSEClient` POST→stream
   * flow with the new contract `POST /v1/graph/execute` → SSE `GET
   * /v1/graph/execute/:id/events`. Node lifecycle and export trigger map
   * 1:1 with the contracted events. `graph:done.sections` is fed into the
   * terminal export node's data so `runExportNode` can use them directly
   * (skipping the predecessor-walk fallback for this run).
   */
  executeGraph: async () => {
    if (get().isExecuting) return;

    // Tear down any stray subscription from a previous failed run.
    if (activeUnsubscribe) {
      try {
        activeUnsubscribe();
      } catch {
        /* noop */
      }
      activeUnsubscribe = null;
    }

    set({
      isExecuting: true,
      currentNarration: 'Iniciando ejecución…',
      currentExecutionId: null,
    });
    get().nodes.forEach((n) => get().updateNodeStatus(n.id, 'IDLE'));

    const { nodes, edges, workspaceId } = get();
    const wireNodes: GraphExecutionNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: (n.data ?? {}) as Record<string, unknown>,
    }));
    const wireEdges: GraphExecutionEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    }));

    let executionId: string;
    let sseUrl: string;
    try {
      const started = await startGraphExecution(
        workspaceId,
        wireNodes,
        wireEdges,
        'studio:graph:exec',
      );
      executionId = started.executionId;
      sseUrl = started.sseUrl;
    } catch (err) {
      console.error('[executeGraph] startExecution failed:', err);
      set({
        isExecuting: false,
        currentExecutionId: null,
        currentNarration: 'No se pudo iniciar la ejecución.',
      });
      return;
    }

    set({ currentExecutionId: executionId });

    activeUnsubscribe = subscribeToExecution(executionId, sseUrl, {
      onNodeStart: ({ node_id }) => {
        get().updateNodeStatus(node_id, 'RUNNING');
        // Reset previous output so token streaming starts clean. Safe
        // even if onNodeToken is never called — onNodeComplete writes
        // the final output unconditionally.
        get().updateNodeData(node_id, { outputText: '' });
      },
      onNodeToken: ({ node_id, delta }) => {
        get().appendNodeOutput(node_id, delta);
      },
      onNodeComplete: ({ node_id, output, tokens, cost_usd }) => {
        get().updateNodeData(node_id, {
          outputText: output,
          tokens,
          costUsd: cost_usd,
        });
        get().updateNodeStatus(node_id, 'COMPLETED');
      },
      onNodeError: ({ node_id, error }) => {
        get().updateNodeData(node_id, { errorMsg: error });
        get().updateNodeStatus(node_id, 'FAILED');
      },
      onGraphDone: ({ sections, total_cost_usd }) => {
        // If the graph terminates in an export node, push the
        // server-built sections onto its data and trigger the export.
        // Falls back to the predecessor-walk in `runExportNode` if no
        // sections were emitted (e.g. graph without an export node).
        const exportNode = get().nodes.find((n) => n.type === 'export');
        if (exportNode) {
          const branchSections = toBranchSections(sections);
          if (branchSections.length > 0) {
            get().updateNodeData(exportNode.id, {
              presetSections: branchSections,
            });
          }
          void get().runExportNode(exportNode.id);
        }
        const costNote =
          typeof total_cost_usd === 'number'
            ? ` (US$${total_cost_usd.toFixed(4)})`
            : '';
        set({
          isExecuting: false,
          currentExecutionId: null,
          currentNarration: `Ejecución finalizada${costNote}.`,
        });
        if (activeUnsubscribe) {
          try {
            activeUnsubscribe();
          } catch {
            /* noop */
          }
          activeUnsubscribe = null;
        }
      },
      onConnectionError: (err) => {
        console.error('[executeGraph] SSE connection error:', err);
        set({
          isExecuting: false,
          currentExecutionId: null,
          currentNarration: 'Error de conexión con la ejecución.',
        });
        if (activeUnsubscribe) {
          try {
            activeUnsubscribe();
          } catch {
            /* noop */
          }
          activeUnsubscribe = null;
        }
      },
    });
  },

  cancelExecution: async () => {
    const { currentExecutionId, isExecuting } = get();
    if (!isExecuting) return;

    // Close the SSE channel immediately so no further events apply.
    if (activeUnsubscribe) {
      try {
        activeUnsubscribe();
      } catch {
        /* noop */
      }
      activeUnsubscribe = null;
    }

    // Mark any still-running nodes as FAILED — the server may also emit
    // node:error for them, but the channel is closed so we won't see it.
    get().nodes.forEach((n) => {
      const status = (n.data as { status?: string } | undefined)?.status;
      if (status === 'RUNNING') {
        get().updateNodeStatus(n.id, 'FAILED');
        get().updateNodeData(n.id, { errorMsg: 'Cancelado por el usuario.' });
      }
    });

    set({
      isExecuting: false,
      currentExecutionId: null,
      currentNarration: 'Ejecución cancelada.',
    });

    // Best-effort server-side cancel. Errors are logged but not surfaced
    // — the local state is already clean.
    if (currentExecutionId) {
      try {
        await cancelGraphExecution(currentExecutionId);
      } catch (err) {
        console.warn('[cancelExecution] server cancel failed:', err);
      }
    }
  },

  appendNodeOutput: (id, delta) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== id) return n;
        const prev =
          typeof (n.data as { outputText?: unknown })?.outputText === 'string'
            ? ((n.data as { outputText: string }).outputText)
            : '';
        return { ...n, data: { ...n.data, outputText: prev + delta } };
      }),
    }));
  },

  onNodesChange: (changes: NodeChange<AppNode>[]) => {
    if (changes.some(c => c.type === 'remove')) get().takeSnapshot();
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },
  onEdgesChange: (changes: EdgeChange[]) => {
    if (changes.some(c => c.type === 'remove')) get().takeSnapshot();
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },
  onConnect: (connection: Connection) => {
    get().takeSnapshot();
    set({ edges: addEdge(connection, get().edges) });
  },
  setNodes: (nodes) => {
    if (get().nodes.length > 0) get().takeSnapshot();
    set({ nodes });
  },
  setEdges: (edges) => set({ edges }),

  captureSnapshot: (executionTimeMs) => {
    const newSnapshot: Snapshot = {
      id: `snapshot_${Date.now()}`,
      timestamp: Date.now(),
      nodes: JSON.parse(JSON.stringify(get().nodes)),
      edges: JSON.parse(JSON.stringify(get().edges)),
      metadata: { executionTimeMs }
    };
    set(state => ({
      snapshots: [...state.snapshots, newSnapshot],
      activeSnapshotId: newSnapshot.id
    }));
  },
  restoreSnapshot: (id) => {
    const snapshot = get().snapshots.find(s => s.id === id);
    if (!snapshot) return;
    get().takeSnapshot();
    set({
      nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
      edges: JSON.parse(JSON.stringify(snapshot.edges)),
      activeSnapshotId: id
    });
  },
  takeSnapshot: () => {
    set(state => {
      const newPast = [...state.history.past, { nodes: state.nodes, edges: state.edges }];
      if (newPast.length > 20) newPast.shift();
      return { history: { past: newPast, future: [] } };
    });
  },
  undo: () => {
    set(state => {
      const { past, future } = state.history;
      if (past.length === 0) return state;
      const previous = past[past.length - 1];
      const newPast = past.slice(0, past.length - 1);
      return {
        nodes: previous.nodes,
        edges: previous.edges,
        history: { past: newPast, future: [{ nodes: state.nodes, edges: state.edges }, ...future] }
      };
    });
  },
  redo: () => {
    set(state => {
      const { past, future } = state.history;
      if (future.length === 0) return state;
      const next = future[0];
      const newFuture = future.slice(1);
      return {
        nodes: next.nodes,
        edges: next.edges,
        history: { past: [...past, { nodes: state.nodes, edges: state.edges }], future: newFuture }
      };
    });
  },
  addNode: (node) => {
    get().takeSnapshot();
    set(state => ({ nodes: [...state.nodes, node] }));
  },
  deleteNode: (id) => {
    get().takeSnapshot();
    set(state => ({
      nodes: state.nodes.filter(n => n.id !== id),
      edges: state.edges.filter(e => e.source !== id && e.target !== id)
    }));
  },
  deleteEdge: (id) => {
    get().takeSnapshot();
    set(state => ({ edges: state.edges.filter(e => e.id !== id) }));
  },
  updateNodeData: (id, data) => {
    set(state => ({
      nodes: state.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...data } } : n)
    }));
  },
}));
