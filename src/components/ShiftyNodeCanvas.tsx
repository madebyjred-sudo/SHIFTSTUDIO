import React, { useCallback, useState, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Panel,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
} from '@xyflow/react';
import { Play, Square, LayoutGrid } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { useActiveGraphStore } from '../store';
import { AgentStepper } from './AgentStepper';
import { ContextNode } from './nodes/ContextNode';
import { SpecialistNode } from './nodes/SpecialistNode';
import { ExportNode } from './nodes/ExportNode';
import { AnimatedEdge } from './edges/AnimatedEdge';
import { HITLModal } from './HITLModal';
import { CanvasContextMenu } from './CanvasContextMenu';
import { TimeTravelTimeline } from './TimeTravelTimeline';
import { ShareWorkflowModal } from './ShareWorkflowModal';
import { Share2 } from 'lucide-react';
import { getLayoutedElements } from '../utils/layoutGraph';

const nodeTypes = {
  context: ContextNode,
  specialist: SpecialistNode,
  export: ExportNode,
  // Architect backend node types map to xyflow display types
  contexto: ContextNode,
  agente: SpecialistNode,
  entrega: ExportNode,
};

const edgeTypes = {
  animated: AnimatedEdge,
};

/** Allowed connections: contexto→agente, agente→agente, agente→revision, agente→entrega, revision→agente, revision→entrega */
const VALID_CONNECTIONS: Record<string, string[]> = {
  context: ['specialist', 'agente'],
  contexto: ['specialist', 'agente'],
  specialist: ['specialist', 'export', 'agente', 'entrega', 'revision'],
  agente: ['specialist', 'export', 'agente', 'entrega', 'revision'],
  revision: ['specialist', 'agente', 'export', 'entrega'],
  export: [],
  entrega: [],
};

function ShiftyNodeCanvasInner() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, isExecuting, executeGraph, undo, redo, setNodes, setEdges } = useActiveGraphStore();
  const [menu, setMenu] = useState<{ id: string | null; top: number; left: number; type: 'pane' | 'node' | 'edge' } | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const { fitView } = useReactFlow();

  // Keyboard shortcuts (Ctrl+Z / Cmd+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    setMenu({ id: null, top: event.clientY, left: event.clientX, type: 'pane' });
  }, []);

  const onNodeContextMenu = useCallback((event: React.MouseEvent | MouseEvent, node: any) => {
    event.preventDefault();
    setMenu({ id: node.id, top: event.clientY, left: event.clientX, type: 'node' });
  }, []);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent | MouseEvent, edge: any) => {
    event.preventDefault();
    setMenu({ id: edge.id, top: event.clientY, left: event.clientX, type: 'edge' });
  }, []);

  const onPaneClick = useCallback(() => {
    setMenu(null);
  }, []);

  // Connection validation — prevent invalid edge types
  const isValidConnection = useCallback((connection: Connection) => {
    const sourceNode = nodes.find(n => n.id === connection.source);
    if (!sourceNode) return false;
    const sourceType = (sourceNode.type || 'specialist') as string;
    const targetNode = nodes.find(n => n.id === connection.target);
    if (!targetNode) return false;
    const targetType = (targetNode.type || 'specialist') as string;
    const allowed = VALID_CONNECTIONS[sourceType] || [];
    return allowed.includes(targetType);
  }, [nodes]);

  // Auto-focus on the currently executing node
  useEffect(() => {
    const runningNode = nodes.find(n => (n.data as any)?.status === 'RUNNING');
    if (runningNode && isExecuting) {
      fitView({ nodes: [runningNode], duration: 500, padding: 0.3 });
    }
  }, [nodes, isExecuting, fitView]);

  // Apply default edge type to all edges
  const styledEdges = useMemo(() =>
    edges.map(e => ({ ...e, type: 'animated' as const })),
    [edges],
  );

  // Re-layout button handler
  const handleRelayout = useCallback(() => {
    const { nodes: layouted } = getLayoutedElements(nodes, edges, 'TB');
    setNodes(layouted);
    setTimeout(() => fitView({ duration: 400 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 w-full bg-white dark:bg-transparent rounded-2xl border border-gray-200 dark:border-white/5 shadow-sm overflow-hidden relative">
        <ReactFlow
          nodes={nodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          isValidConnection={isValidConnection}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneClick={onPaneClick}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-transparent"
          defaultEdgeOptions={{ type: 'animated' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(150, 150, 150, 0.15)" />
          <Controls className="bg-white dark:bg-black/50 border border-gray-200 dark:border-white/10 shadow-sm backdrop-blur-md" />
          <MiniMap className="bg-white dark:bg-black/50 border border-gray-200 dark:border-white/10 shadow-sm backdrop-blur-md" maskColor="rgba(0, 0, 0, 0.2)" />

          {menu && <CanvasContextMenu id={menu.id} top={menu.top} left={menu.left} type={menu.type} onClose={() => setMenu(null)} />}

          <Panel position="top-left" className="m-4">
            <div className="px-5 py-3 bg-white/80 dark:bg-black/80 backdrop-blur-md rounded-md border border-gray-200 dark:border-gray-800 shadow-subtle text-xs font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <div className="w-2 h-2 rounded-pill bg-green-500 animate-pulse" />
              Graph Builder Ready
            </div>
          </Panel>

          <Panel position="bottom-center" className="mb-4">
            <AgentStepper />
          </Panel>

          <Panel position="top-right" className="m-4">
            <div className="flex items-center gap-3">
              {nodes.length > 0 && (
                <button
                  onClick={handleRelayout}
                  title="Auto-layout DAG"
                  className="flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-violet-500 dark:hover:border-violet-500 backdrop-blur-md"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  LAYOUT
                </button>
              )}

              {nodes.length > 0 && (
                <button
                  onClick={() => setShowShareModal(true)}
                  className="flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-indigo-500 dark:hover:border-indigo-500 backdrop-blur-md"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  COMPARTIR
                </button>
              )}

              <button
                onClick={executeGraph}
                className={`flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all ${isExecuting
                    ? 'bg-red-500 hover:bg-red-600 text-white border-red-600'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-700'
                  }`}
              >
                {isExecuting ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    DETENER
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    EJECUTAR GRAFO
                  </>
                )}
              </button>
            </div>
          </Panel>
        </ReactFlow>
        <TimeTravelTimeline />
      </div>

      <ShareWorkflowModal isOpen={showShareModal} onClose={() => setShowShareModal(false)} />
      <HITLModal />
    </div>
  );
}

/** Wrapper that provides ReactFlowProvider context (required for useReactFlow hook) */
export function ShiftyNodeCanvas() {
  return (
    <ReactFlowProvider>
      <ShiftyNodeCanvasInner />
    </ReactFlowProvider>
  );
}
