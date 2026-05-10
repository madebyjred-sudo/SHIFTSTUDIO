/**
 * Graph connection rules — modo nodos.
 *
 * Single source of truth for which node types can connect to which.
 * Used by:
 *   - ReactFlow's `isValidConnection` (block the drop)
 *   - The connection-validation feedback layer (tooltip + handle highlight + shake)
 *
 * Visual node types (xyflow):    `context`, `specialist`, `export`
 * Architect backend node types:  `contexto`, `agente`, `entrega`, `revision`
 *
 * Rules:
 *   - context → specialist             ✅ (start of pipeline)
 *   - specialist → specialist          ✅ (chain)
 *   - specialist → export              ✅ (terminal)
 *   - revision → specialist | export   ✅ (HITL branch)
 *   - context → export                 ❌ (export expects specialist output)
 *   - export → *                       ❌ (export is terminal)
 *   - * → context                      ❌ (context is source-only)
 */

export type GraphNodeType =
  | 'context'
  | 'contexto'
  | 'specialist'
  | 'agente'
  | 'revision'
  | 'export'
  | 'entrega';

const VALID_CONNECTIONS: Record<string, readonly string[]> = {
  context: ['specialist', 'agente'],
  contexto: ['specialist', 'agente'],
  specialist: ['specialist', 'export', 'agente', 'entrega', 'revision'],
  agente: ['specialist', 'export', 'agente', 'entrega', 'revision'],
  revision: ['specialist', 'agente', 'export', 'entrega'],
  export: [],
  entrega: [],
};

/** User-facing display label per node-type family (for tooltips). */
const NODE_LABELS: Record<string, string> = {
  context: 'contexto',
  contexto: 'contexto',
  specialist: 'especialista',
  agente: 'especialista',
  revision: 'revisión',
  export: 'exportador',
  entrega: 'exportador',
};

export interface ConnectionValidation {
  valid: boolean;
  /** Spanish, user-facing motive — only present when `valid === false`. */
  reason?: string;
}

/**
 * Pure validation: can a connection from `source` to `target` exist?
 *
 * Defensive against unknown types (treats them as invalid with a generic
 * motive rather than throwing).
 */
export function validateConnection(
  source: string | null | undefined,
  target: string | null | undefined,
): ConnectionValidation {
  const src = (source ?? 'specialist') as string;
  const tgt = (target ?? 'specialist') as string;

  // Unknown source/target → reject, don't crash.
  if (!(src in VALID_CONNECTIONS)) {
    return { valid: false, reason: `Tipo de nodo desconocido: ${src}` };
  }
  if (!(tgt in NODE_LABELS)) {
    return { valid: false, reason: `Tipo de nodo desconocido: ${tgt}` };
  }

  const allowed = VALID_CONNECTIONS[src];
  if (allowed.includes(tgt)) return { valid: true };

  // Friendly reason — pick the most informative variant.
  const srcLabel = NODE_LABELS[src] ?? src;
  const tgtLabel = NODE_LABELS[tgt] ?? tgt;

  if (allowed.length === 0) {
    // Source is a terminal node.
    return {
      valid: false,
      reason: `${capitalize(srcLabel)} es nodo terminal: no acepta conexiones de salida.`,
    };
  }
  if (tgtLabel === 'contexto') {
    return {
      valid: false,
      reason: `Contexto es nodo de origen: no acepta conexiones entrantes.`,
    };
  }
  return {
    valid: false,
    reason: `No se puede conectar ${srcLabel} → ${tgtLabel}.`,
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Display label for a node type, for use outside the validation flow. */
export function nodeTypeLabel(type: string | null | undefined): string {
  if (!type) return 'nodo';
  return NODE_LABELS[type] ?? type;
}
