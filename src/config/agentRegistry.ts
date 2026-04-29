/**
 * Agent Registry — Single source of truth for agent metadata in the frontend.
 *
 * Maps backend YAML agent IDs (e.g. "carmen", "roberto") to display metadata.
 * Derived from: shift-cerebro/agents/skills/*.yaml (READ-ONLY source)
 *
 * Attribution: Pattern inspired by LobeChat AgentInfo (MIT)
 * See THIRD_PARTY_NOTICES.md
 */

export interface AgentMeta {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;    // hex #RRGGBB
  pod: number;
  podName: string;
}

/**
 * Registry keyed by backend YAML filename (without .yaml extension).
 * These IDs match shift-cerebro/agents/skills/*.yaml files exactly.
 */
export const AGENT_REGISTRY: Record<string, AgentMeta> = {
  // ─── POD 1: C-Suite & Estrategia ───────────────────────────
  carmen:    { id: 'carmen',    name: 'Carmen',    role: 'CEO',                                   emoji: '👑', color: '#9333EA', pod: 1, podName: 'C-Suite & Estrategia' },
  roberto:   { id: 'roberto',   name: 'Roberto',   role: 'CFO',                                   emoji: '💰', color: '#059669', pod: 1, podName: 'C-Suite & Estrategia' },
  valentina: { id: 'valentina', name: 'Valentina', role: 'CMO',                                   emoji: '🌸', color: '#EC4899', pod: 1, podName: 'C-Suite & Estrategia' },
  diego:     { id: 'diego',     name: 'Diego',     role: 'CPO',                                   emoji: '🟢', color: '#7C3AED', pod: 1, podName: 'C-Suite & Estrategia' },

  // ─── POD 2: Marketing & Contenido ──────────────────────────
  jorge:     { id: 'jorge',     name: 'Jorge',     role: 'Content Strategist',                    emoji: '✍️', color: '#F97316', pod: 2, podName: 'Marketing & Contenido' },
  lucia:     { id: 'lucia',     name: 'Lucía',     role: 'SEO & AI Visibility Specialist',        emoji: '🔍', color: '#14B8A6', pod: 2, podName: 'Marketing & Contenido' },
  isabella:  { id: 'isabella',  name: 'Isabella',  role: 'Paid Media & Campaign Analytics',       emoji: '📢', color: '#8B5CF6', pod: 2, podName: 'Marketing & Contenido' },
  mateo:     { id: 'mateo',     name: 'Mateo',     role: 'Social Media & Brand Voice Manager',    emoji: '📱', color: '#3B82F6', pod: 2, podName: 'Marketing & Contenido' },

  // ─── POD 3: Data & Inteligencia ────────────────────────────
  andres:    { id: 'andres',    name: 'Andrés',    role: 'Data & Analytics Engineer',             emoji: '📊', color: '#6366F1', pod: 3, podName: 'Data & Inteligencia' },
  daniela:   { id: 'daniela',   name: 'Daniela',   role: 'Competitive Intelligence Specialist',   emoji: '🛡️', color: '#991B1B', pod: 3, podName: 'Data & Inteligencia' },
  emilio:    { id: 'emilio',    name: 'Emilio',    role: 'Customer Success Manager',              emoji: '🤝', color: '#10B981', pod: 3, podName: 'Data & Inteligencia' },

  // ─── POD 4: Operaciones & Governance ───────────────────────
  patricia:  { id: 'patricia',  name: 'Patricia',  role: 'Legal Counsel & Compliance Officer',    emoji: '⚖️', color: '#B45309', pod: 4, podName: 'Operaciones & Governance' },
  santiago:  { id: 'santiago',  name: 'Santiago',  role: 'Revenue Operations Specialist',         emoji: '📈', color: '#F59E0B', pod: 4, podName: 'Operaciones & Governance' },
  catalina:  { id: 'catalina',  name: 'Catalina',  role: 'Senior Project Manager',                emoji: '📋', color: '#EC4899', pod: 4, podName: 'Operaciones & Governance' },

  // ─── Orchestrator ──────────────────────────────────────────
  shiftai:   { id: 'shiftai',   name: 'Shifty',    role: 'Generalist Orchestrator',               emoji: '✨', color: '#00A651', pod: 0, podName: 'Orchestrator' },
};

/** Fallback when agent ID is unknown or absent */
export const FALLBACK_AGENT: AgentMeta = {
  id: 'unknown',
  name: 'Shifty',
  role: 'Assistant',
  emoji: '✨',
  color: '#1534dc',
  pod: 0,
  podName: 'General',
};

/**
 * Look up agent metadata by backend YAML ID.
 * Falls back gracefully if the ID is unknown/null/undefined.
 */
export function getAgent(id?: string | null): AgentMeta {
  if (!id) return FALLBACK_AGENT;
  return AGENT_REGISTRY[id] ?? FALLBACK_AGENT;
}

/**
 * Resolve an agent from either a backend ID ("carmen") or a frontend display
 * name ("Carmen - CEO"). Useful during the transition period while both
 * naming conventions coexist in the message objects.
 */
export function resolveAgent(agentRef?: string | null): AgentMeta {
  if (!agentRef) return FALLBACK_AGENT;

  // Direct ID match (backend YAML ID)
  if (AGENT_REGISTRY[agentRef]) return AGENT_REGISTRY[agentRef];

  // Match by display name prefix ("Carmen - CEO" → carmen)
  const lowerRef = agentRef.toLowerCase();
  for (const agent of Object.values(AGENT_REGISTRY)) {
    if (lowerRef.includes(agent.name.toLowerCase())) {
      return agent;
    }
  }

  // "Shift AI" special case
  if (lowerRef === 'shift ai' || lowerRef === 'shifty') {
    return AGENT_REGISTRY.shiftai;
  }

  return FALLBACK_AGENT;
}
