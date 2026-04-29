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

  // New V2 Execution concepts
  generateGraph: (userMessage: string, chatHistory: any[], tenantId: string) => Promise<{ mode: string, narrative?: string, message?: string }>;
  
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

  setHitlState: (state) => set({ hitlState: state }),
  setCurrentNarration: (text) => set({ currentNarration: text }),

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
           // event.content will be JSON. Assuming doc is exported
           try {
              const deliveryData = JSON.parse(event.content);
              if (deliveryData.document_url) {
                 // Trigger download automatically
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
