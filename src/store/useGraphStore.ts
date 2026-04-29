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

export type AppNode = Node;

export interface Snapshot {
  id: string;
  timestamp: number;
  nodes: AppNode[];
  edges: Edge[];
  metadata: {
    executionTimeMs: number;
  };
}

type AppState = {
  nodes: AppNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<AppNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: AppNode[]) => void;
  setEdges: (edges: Edge[]) => void;

  // Phase 1: Shared state for Workspace Toggle
  activeMode: 'chat' | 'canvas';
  setActiveMode: (mode: 'chat' | 'canvas') => void;

  // Phase 5: Execution Engine Simulation
  isExecuting: boolean;
  executeGraph: () => void;
  updateNodeStatus: (id: string, status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED') => void;

  // Phase 12-13: UI Editing & Undo/Redo History
  history: { past: { nodes: AppNode[]; edges: Edge[] }[]; future: { nodes: AppNode[]; edges: Edge[] }[] };
  takeSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  addNode: (node: AppNode) => void;
  deleteNode: (id: string) => void;
  deleteEdge: (id: string) => void;
  updateNodeData: (id: string, data: Record<string, any>) => void;

  // Phase 14: Time-Travel Snapshots
  snapshots: Snapshot[];
  activeSnapshotId: string | null;
  captureSnapshot: (executionTimeMs: number) => void;
  restoreSnapshot: (id: string) => void;
};

const initialNodes: AppNode[] = [];
const initialEdges: Edge[] = [];

export const useGraphStore = create<AppState>((set, get) => ({
  nodes: initialNodes,
  edges: initialEdges,
  activeMode: 'chat',
  isExecuting: false,
  history: { past: [], future: [] },
  snapshots: [],
  activeSnapshotId: null,
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
  executeGraph: async () => {
    const { nodes, edges, updateNodeStatus, updateNodeData } = get();
    if (get().isExecuting) {
      set({ isExecuting: false }); // Reset toggle if stopping
      nodes.forEach(n => updateNodeStatus(n.id, 'IDLE'));
      return;
    }

    set({ isExecuting: true });

    const startTime = performance.now();
    nodes.forEach(n => updateNodeStatus(n.id, 'IDLE'));
    console.log("🚀 REAL DAG BACKEND EXECUTION:", { topology: { nodes, edges } });

    // Build Topological Order
    const inDegree = new Map<string, number>();
    const graph = new Map<string, string[]>();
    nodes.forEach(n => {
      inDegree.set(n.id, 0);
      graph.set(n.id, []);
    });
    edges.forEach(e => {
      if (graph.has(e.source) && inDegree.has(e.target)) {
        graph.get(e.source)!.push(e.target);
        inDegree.set(e.target, inDegree.get(e.target)! + 1);
      }
    });
    // Cycle check simulation before executing
    let processedCount = 0;
    const simQueue: string[] = [];
    const simInDegree = new Map(inDegree);
    simInDegree.forEach((deg, id) => {
      if (deg === 0) simQueue.push(id);
    });
    while (simQueue.length > 0) {
      const curr = simQueue.shift()!;
      processedCount++;
      graph.get(curr)?.forEach(neighbor => {
        const newDeg = simInDegree.get(neighbor)! - 1;
        simInDegree.set(neighbor, newDeg);
        if (newDeg === 0) simQueue.push(neighbor);
      });
    }

    if (processedCount !== nodes.length) {
      console.error("❌ ERROR: Ciclo detectado o nodos inaccesibles en el grafo.");
      alert("No se puede ejecutar el grafo: Se ha detectado un ciclo infinito.");
      set({ isExecuting: false });
      return;
    }

    const queue: string[] = [];
    inDegree.forEach((degree, id) => {
      if (degree === 0) queue.push(id);
    });

    // Mantenemos el orden de ejecución para el ExportNode
    const executionOrder: AppNode[] = [];
    const nodeOutputs = new Map<string, string>();
    const telemetryNodes: any[] = [];

    // Función auxiliar para reintentos de red (Exponential Backoff)
    const fetchWithRetry = async (url: string, options: any, maxRetries = 2) => {
      let retries = 0;
      while (retries <= maxRetries) {
        try {
          const res = await fetch(url, options);
          if (res.ok) return res;
          if (res.status !== 429 && res.status >= 400 && res.status < 500) {
            // Client errors (4xx) usually shouldn't be retried except 429
            return res;
          }
        } catch (err) {
          if (retries === maxRetries) throw err;
        }
        retries++;
        if (retries <= maxRetries) {
          console.warn(`[Reintento ${retries}/${maxRetries}] LLM/Red falló, esperando ${retries * 1500}ms...`);
          await new Promise(r => setTimeout(r, retries * 1500));
        }
      }
      throw new Error("Límite de reintentos superado");
    };

    // Execute Layer by Layer (Parallel)
    let globalFailed = false;

    while (queue.length > 0 && get().isExecuting && !globalFailed) {
      const currentLayer = [...queue];
      queue.length = 0; // Clear queue for next layer

      const layerPromises = currentLayer.map(async (currentId) => {
        const node = nodes.find(n => n.id === currentId);
        if (!node) return;

        // Esto sincroniza el orden para la exportación cronológica
        executionOrder.push(node);
        updateNodeStatus(node.id, 'RUNNING');

        let currentOutput = "";
        const nodeStartTime = performance.now();
        let nodeFailed = false;

        if (node.type === 'context') {
          currentOutput = node.data?.text as string || "";
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        else if (node.type === 'specialist') {
          const predecessors = edges.filter(e => e.target === node.id).map(e => e.source);
          const inputContexts = predecessors.map(id => nodeOutputs.get(id) || "").filter(Boolean).join('\n\n---\n\n');

          const agentId = node.data?.agent || "shiftai";
          const prompt = node.data?.prompt || "Analiza el contexto.";

          try {
            const sysInstruction = inputContexts
              ? `[SYSTEM INSTRUCTION: MODO NODOS]\nRESPONDE EXCLUSIVAMENTE EN TEXTO PLANO. NO uses markdown, code blocks, JSON ni formato especial. Escribe prosa directa y profesional.\n\nAquí está el output previo para que construyas sobre él:\n${inputContexts}`
              : `[SYSTEM INSTRUCTION: MODO NODOS]\nRESPONDE EXCLUSIVAMENTE EN TEXTO PLANO. NO uses markdown, code blocks, JSON ni formato especial. Escribe prosa directa y profesional.\n\nEjecuta tu rol.`;

            const res = await fetchWithRetry('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agent: agentId,
                prompt: prompt,
                messages: [{ role: 'user', content: sysInstruction }],
                sessionId: 'nodes_' + Date.now()
              })
            }, 2); // 2 retries (3 total attempts)

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            currentOutput = data.content || data.result || "Sin respuesta";
            // Post-procesador: Strip markdown code blocks y JSON wrappers
            currentOutput = currentOutput
              .replace(/```(?:json|markdown|text|html|css|js|ts|python)?\n?/gi, '')
              .replace(/```\s*$/gm, '')
              .trim();
            updateNodeData(node.id, { outputText: currentOutput });
          } catch (e) {
            console.error("Error executing node", node.id, e);
            currentOutput = "[Error de Ejecución]";
            updateNodeData(node.id, { outputText: currentOutput });
            nodeFailed = true;
          }
        }
        else if (node.type === 'export') {
          const format = node.data?.format || 'DOCX';

          // AISLAMIENTO DE RAMAS: Recolectar SOLO los predecesores DIRECTOS
          // para no exportar todo el historial ruidoso de la cadena, 
          // asumiendo que el último especialista ya consolidó la información.
          const branchSections: any[] = [];

          // Obtener los IDs de los nodos que apuntan directamente a este Export Node
          const predecessorIds = edges.filter(e => e.target === node.id).map(e => e.source);

          for (const pId of predecessorIds) {
            const predNode = nodes.find(n => n.id === pId);
            if (predNode) {
              const outText = nodeOutputs.get(pId) || "";
              if (predNode.type === 'context') {
                branchSections.push({ heading: 'Contexto Base', content: outText });
              } else if (predNode.type === 'specialist') {
                const aId = predNode.data?.agent || "shiftai";
                const aName = String(aId).charAt(0).toUpperCase() + String(aId).slice(1);
                branchSections.push({ heading: `Análisis Consolidado - ${aName}`, content: outText });
              }
            }
          }

          try {
            const res = await fetchWithRetry('/api/export', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                format: format,
                title: "Documento Estratégico Legio Digitalis",
                subtitle: "Generado vía Shifty Studio Nodos",
                content: "El siguiente documento fue ensamblado de forma autónoma por la cadena de agentes.",
                sections: branchSections
              })
            });
            if (res.ok) {
              const data = await res.json();
              if (data.url) {
                const a = document.createElement('a');
                a.href = data.url;
                a.download = '';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }
            } else {
              throw new Error(`Export HTTP ${res.status}`);
            }
          } catch (err) {
            console.error("Error exporting document", err);
            nodeFailed = true;
          }

          // Small delay for UX
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        const nodeTimeMs = performance.now() - nodeStartTime;

        if (node.type === 'specialist' || node.type === 'export') {
          telemetryNodes.push({
            node_id: node.id,
            agent: node.data?.agent || 'unknown',
            prompt: node.data?.prompt || '',
            output_text: currentOutput || `[Salida]`,
            metrics: {
              tokens: Math.floor(currentOutput.length / 4) + 50, // Estimación de tokens
              time_ms: Math.floor(nodeTimeMs),
              user_rating: 0,
              failed: nodeFailed
            }
          });
        }

        if (nodeFailed) {
          updateNodeStatus(node.id, 'FAILED');
          return { failed: true, id: currentId };
        }

        nodeOutputs.set(node.id, currentOutput);
        updateNodeStatus(node.id, 'COMPLETED');
        return { failed: false, id: currentId };
      });

      const layerResults = await Promise.all(layerPromises);

      if (layerResults.some(res => res?.failed)) {
        globalFailed = true;
        set({ isExecuting: false });
        break;
      }

      // Desbloquear dependencias de la siguiente capa
      for (const res of layerResults) {
        if (res && !res.failed) {
          graph.get(res.id)?.forEach(neighbor => {
            const deg = inDegree.get(neighbor)! - 1;
            inDegree.set(neighbor, deg);
            if (deg === 0) queue.push(neighbor);
          });
        }
      }
    }

    const elapsedTimeMs = performance.now() - startTime;
    get().captureSnapshot(elapsedTimeMs);

    // ─── PEAJE 2.0 DUAL INGESTION (Smart Client Payload) ───
    if (telemetryNodes.length > 0) {
      const payload = {
        session_id: crypto.randomUUID(),
        client_id: "shift-studio",
        tenant_id: "shift",
        telemetry: {
          total_time_ms: Math.floor(elapsedTimeMs),
          user_interventions: 0
        },
        executed_nodes: telemetryNodes
      };

      console.log("📡 Sending Telemetry to Peaje 2.0:", payload);
      fetch('/api/peaje/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(console.error);
    }

    console.log("✅ GRAPH EXECUTION FINISHED");
    set({ isExecuting: false });
  },
  onNodesChange: (changes: NodeChange<AppNode>[]) => {
    // Auto-snapshot before native removal
    if (changes.some(c => c.type === 'remove')) get().takeSnapshot();

    set({
      nodes: applyNodeChanges(changes, get().nodes),
    });
  },
  onEdgesChange: (changes: EdgeChange[]) => {
    if (changes.some(c => c.type === 'remove')) get().takeSnapshot();

    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },
  onConnect: (connection: Connection) => {
    get().takeSnapshot();
    set({
      edges: addEdge(connection, get().edges),
    });
  },
  setNodes: (nodes) => {
    if (get().nodes.length > 0) get().takeSnapshot();
    set({ nodes });
  },
  setEdges: (edges) => set({ edges }),

  // Phase 14: Time-Travel Snapshots
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

    get().takeSnapshot(); // Hook into Undo/Redo history before time-traveling

    set({
      nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
      edges: JSON.parse(JSON.stringify(snapshot.edges)),
      activeSnapshotId: id
    });
  },

  // Phase 12-13: Undo/Redo Implementation
  takeSnapshot: () => {
    set(state => {
      // Limit history to 20 to prevent memory blowup over time
      const newPast = [...state.history.past, { nodes: state.nodes, edges: state.edges }];
      if (newPast.length > 20) newPast.shift();
      return {
        history: { past: newPast, future: [] }
      };
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
        history: {
          past: newPast,
          future: [{ nodes: state.nodes, edges: state.edges }, ...future]
        }
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
        history: {
          past: [...past, { nodes: state.nodes, edges: state.edges }],
          future: newFuture
        }
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
    set(state => ({
      edges: state.edges.filter(e => e.id !== id)
    }));
  },
  updateNodeData: (id, data) => {
    set(state => ({
      nodes: state.nodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, ...data } } : n
      )
    }));
  },
}));
