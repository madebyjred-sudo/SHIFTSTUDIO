/**
 * Auto-layout utility for the Shifty Node Canvas.
 * Uses dagre to compute a clean top-down DAG layout for architect-generated graphs.
 */
import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';

/** Default dimensions per node type */
const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  contexto: { width: 288, height: 180 },  // w-72
  agente:   { width: 320, height: 220 },  // w-80
  revision: { width: 280, height: 120 },
  entrega:  { width: 256, height: 160 },  // w-64
  // Fallback for custom node types used by xyflow
  context:    { width: 288, height: 180 },
  specialist: { width: 320, height: 220 },
  export:     { width: 256, height: 160 },
};

const DEFAULT_DIMENSIONS = { width: 280, height: 160 };

export type LayoutDirection = 'TB' | 'LR';

/**
 * Compute dagre layout for a set of nodes and edges.
 *
 * @param nodes  React Flow nodes (position will be overwritten)
 * @param edges  React Flow edges (unchanged)
 * @param direction  'TB' (top-bottom) or 'LR' (left-right)
 * @returns  New array of nodes with updated positions + original edges
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'TB',
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 80,   // horizontal spacing between nodes
    ranksep: 100,  // vertical spacing between ranks
    marginx: 40,
    marginy: 40,
  });

  // Register nodes
  for (const node of nodes) {
    const type = (node.type || 'specialist') as string;
    const dims = NODE_DIMENSIONS[type] ?? DEFAULT_DIMENSIONS;
    g.setNode(node.id, { width: dims.width, height: dims.height });
  }

  // Register edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  // Run dagre layout
  dagre.layout(g);

  // Map back to React Flow nodes
  const layoutedNodes = nodes.map((node) => {
    const type = (node.type || 'specialist') as string;
    const dims = NODE_DIMENSIONS[type] ?? DEFAULT_DIMENSIONS;
    const dagreNode = g.node(node.id);

    return {
      ...node,
      position: {
        x: dagreNode.x - dims.width / 2,
        y: dagreNode.y - dims.height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
