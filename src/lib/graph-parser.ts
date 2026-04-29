import { useActiveGraphStore } from '../store';

/**
 * Extracts a JSON block from text using bracket-counting parser.
 * This handles nested JSON correctly (unlike regex which fails on nested objects).
 */
function extractJsonBlock(content: string, startIdx: number): string | null {
  let braceCount = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = startIdx; i < content.length; i++) {
    const char = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"' && !escaped) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (braceCount === 0) {
          start = i;
        }
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && start !== -1) {
          return content.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Finds the position of a JSON block containing a graph topology in the content.
 * Searches for both `"topology"` wrapper AND bare `"nodes"` + `"edges"` shapes.
 * Returns the start and end indices of the entire JSON block.
 */
function findTopologyBlock(content: string): { start: number; end: number; json: string } | null {
  // Strategy 1: Look for JSON inside markdown code fences (case-insensitive)
  const codeFenceRegex = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match;

  while ((match = codeFenceRegex.exec(content)) !== null) {
    const blockContent = match[1];
    // Check for "topology" OR bare "nodes" key
    const hasTopology = blockContent.indexOf('"topology"') !== -1;
    const hasNodes = blockContent.indexOf('"nodes"') !== -1;

    if (hasTopology || hasNodes) {
      const jsonStr = extractJsonBlock(blockContent, 0);
      if (jsonStr) {
        return {
          start: match.index,
          end: match.index + match[0].length,
          json: jsonStr
        };
      }
    }
  }

  // Strategy 2: Look for raw JSON with "topology" key
  const topologyIdx = content.indexOf('"topology"');
  if (topologyIdx !== -1) {
    let braceStart = topologyIdx;
    while (braceStart >= 0 && content[braceStart] !== '{') {
      braceStart--;
    }
    if (braceStart >= 0) {
      const jsonStr = extractJsonBlock(content, braceStart);
      if (jsonStr) {
        return {
          start: braceStart,
          end: braceStart + jsonStr.length,
          json: jsonStr
        };
      }
    }
  }

  // Strategy 3: Look for raw JSON with bare "nodes" key (no topology wrapper)
  const nodesIdx = content.indexOf('"nodes"');
  if (nodesIdx !== -1) {
    let braceStart = nodesIdx;
    while (braceStart >= 0 && content[braceStart] !== '{') {
      braceStart--;
    }
    if (braceStart >= 0) {
      const jsonStr = extractJsonBlock(content, braceStart);
      if (jsonStr) {
        // Validate it actually has an array of nodes
        try {
          const test = JSON.parse(jsonStr);
          if (test.nodes && Array.isArray(test.nodes)) {
            return {
              start: braceStart,
              end: braceStart + jsonStr.length,
              json: jsonStr
            };
          }
        } catch {
          // Not valid JSON, continue
        }
      }
    }
  }

  return null;
}

/**
 * Parses markdown text to extract a JSON block representing the Graph Topology.
 *
 * Accepts BOTH formats:
 *
 * Format A (wrapped):
 * ```json
 * { "topology": { "nodes": [...], "edges": [...] } }
 * ```
 *
 * Format B (bare):
 * ```json
 * { "nodes": [...], "edges": [...] }
 * ```
 *
 * Returns an object with:
 * - success: boolean indicating if topology was found and applied
 * - cleanContent: the original content with the JSON block removed (for chat display)
 */
export function parseAndApplyGraphTopology(content: string): { success: boolean; cleanContent: string } {
  try {
    const blockInfo = findTopologyBlock(content);

    if (!blockInfo) {
      return { success: false, cleanContent: content };
    }

    const parsed = JSON.parse(blockInfo.json);

    // Accept both { topology: { nodes, edges } } and { nodes, edges }
    const topology = parsed.topology || parsed;

    if (topology && topology.nodes && Array.isArray(topology.nodes)) {
      const { nodes, edges } = topology;

      let currentY = 50;

      // Map JSON to xyflow React Flow Node schema
      const flowNodes = nodes.map((n: any) => {
        const x = n.position?.x || 250;
        const y = n.position?.y || currentY;
        currentY += 250; // Auto-staggering vertically if no coordinates provided

        return {
          id: n.id || `node-${Math.random()}`,
          type: n.type,
          position: { x, y },
          data: n.data || {}
        };
      });

      // Map JSON to xyflow React Flow Edge schema
      const flowEdges = (edges || []).map((e: any, i: number) => ({
        id: e.id || `e-${e.source}-${e.target}-${i}`,
        source: e.source,
        target: e.target,
        animated: true,
        style: { strokeWidth: 2, stroke: '#6366f1' }
      }));

      // Commit to Zustand state
      const store = useActiveGraphStore.getState();
      store.setNodes(flowNodes);
      store.setEdges(flowEdges);
      store.setActiveMode('canvas'); // Immersive auto-transition to Canvas

      // Remove the JSON block from content for clean chat display
      const beforeBlock = content.slice(0, blockInfo.start);
      const afterBlock = content.slice(blockInfo.end);
      const cleanContent = (beforeBlock + afterBlock).trim();

      return { success: true, cleanContent };
    }
  } catch (err) {
    console.warn("Failed to parse Shift Graph Topology:", err);
  }

  return { success: false, cleanContent: content };
}
