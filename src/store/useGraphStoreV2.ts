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

  activeMode: 'chat' | 'canvas';
  setActiveMode: (mode: 'chat' | 'canvas') => void;

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

  // SSE-driven graph execution (mirrors V1's executeGraph surface).
  // The implementation lives in the create() body below; the type is
  // declared here so consumers can read it via useActiveGraphStore.
  isExecuting: boolean;
  executeGraph: () => Promise<void>;
  updateNodeStatus: (id: string, status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED') => void;

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
import { GraphSSEClient, AnyGraphSSEEvent } from '../services/sseClient';

let globalSseClient: GraphSSEClient | null = null;

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
    // nodes carry the user-typed brief in `text`. Fallback to label/title
    // when neither is set so an empty branch still surfaces a heading
    // (the server rejects empty-string content with a 400).
    let content = '';
    if (typeof data.outputText === 'string' && data.outputText.trim()) {
      content = data.outputText;
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
    const sections = buildSectionsForExportNode(exportNodeId, nodes, edges);
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
        // Map backend nodes — apply dagre auto-layout for clean positioning
        const rawNodes = response.graph.nodes.map((n: any) => {
          const existing = get().nodes.find(en => en.id === n.id);
          return {
            ...n,
            position: existing ? existing.position : { x: 0, y: 0 },
          };
        });
        
        // Auto-layout with dagre (top-down DAG)
        const { nodes: layoutedNodes } = getLayoutedElements(
          rawNodes,
          response.graph.edges,
          'TB',
        );
        
        get().takeSnapshot();
        set({ nodes: layoutedNodes, edges: response.graph.edges });
      }

      return response;
    } catch (e) {
      console.error("Error generating graph:", e);
      throw e;
    }
  },

  executeGraph: async () => {
    // T1.3 Ejecución SSE real - Wires to sseClient
    if (get().isExecuting) {
      if (globalSseClient) {
        globalSseClient.stop();
        globalSseClient = null;
      }
      set({ isExecuting: false, currentNarration: null });
      return;
    }

    set({ isExecuting: true, currentNarration: "Inicializando workflow..." });
    get().nodes.forEach(n => get().updateNodeStatus(n.id, 'IDLE'));

    globalSseClient = new GraphSSEClient();
    
    const payload = {
        graph: { nodes: get().nodes, edges: get().edges },
        tenant_id: 'shift', // Default tenant for alpha
        model: 'Claude 3.5 Sonnet'
    };

    await globalSseClient.execute(payload, {
      onEvent: (event: AnyGraphSSEEvent) => {
        // Handle visual node states based on SSE
        if (event.event === 'node_start') {
           get().updateNodeStatus(event.node_id, 'RUNNING');
           set({ currentNarration: event.content });
        } else if (event.event === 'node_complete') {
           get().updateNodeStatus(event.node_id, 'COMPLETED');
           get().updateNodeData(event.node_id, { outputText: event.content });
        } else if (event.event === 'synthesis') {
           set({ currentNarration: event.content });
        } else if (event.event === 'hitl_pause') {
           set({ hitlState: { pauseId: event.pause_id, prompt: event.content, status: 'paused' } });
        } else if (event.event === 'hitl_approved' || event.event === 'hitl_rejected') {
           set({ currentNarration: event.content });
        } else if (event.event === 'hitl_timeout') {
           set({ currentNarration: event.content });
           const hs = get().hitlState;
           if (hs) set({ hitlState: { ...hs, status: 'expired' } });
        } else if (event.event === 'delivery') {
           // Wave C: the orchestrator emits `delivery` when the export
           // node is the terminal of the DAG. The client owns the export
           // call now (it has the JWT + the in-memory node graph that
           // produced the sections), so we route the trigger through
           // runExportNode rather than just downloading whatever
           // document_url the backend may or may not have produced.
           //
           // Back-compat: if the server still ships a `document_url`
           // alongside (legacy stub flow), we honor it as a fallback —
           // useful for ad-hoc backend-driven exports where the client
           // didn't build the sections.
           const targetNode = get().nodes.find((n) => n.id === event.node_id);
           if (targetNode?.type === 'export') {
              void get().runExportNode(event.node_id);
           } else {
              try {
                 const deliveryData = JSON.parse(event.content);
                 if (deliveryData.document_url) {
                    const a = document.createElement('a');
                    a.href = deliveryData.document_url;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                 }
              } catch (e) {
                 console.error("Delivery JSON parse err", e);
              }
           }
        } else if (event.event === 'error') {
           get().updateNodeStatus(event.node_id, 'FAILED');
           set({ currentNarration: event.content });
        }
      },
      onError: (err) => {
        console.error("SSE Error:", err);
        set({ isExecuting: false, currentNarration: "Error de conexión." });
      },
      onComplete: () => {
        set({ isExecuting: false, currentNarration: "Ejecución finalizada." });
      }
    });
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
