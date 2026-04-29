/**
 * Shared constants between Express (server.ts) and Vercel (api/chat.ts) gateways.
 * Single source of truth for agent and model mappings.
 * 
 * AGENT ROSTER v2.0 - Business/Marketing Focus
 * Optimizado para Garnier, Shift Lab y tenants similares
 */

// ═══════════════════════════════════════════════════════════════
// AGENT MAP v2.0 - 15 Agentes en 4 PODs
// ═══════════════════════════════════════════════════════════════

// POD 1: C-SUITE & ESTRATEGIA (4 agentes)
// POD 2: MARKETING & CONTENIDO (4 agentes)
// POD 3: DATA & INTELIGENCIA (3 agentes)
// POD 4: OPERACIONES & GOVERNANCE (4 agentes)

export const AGENT_MAP: Record<string, string> = {
  // Orquestador General
  "Shift AI": "shiftai",
  
  // POD 1: C-SUITE & ESTRATEGIA
  "Carmen - CEO": "carmen",
  "Roberto - CFO": "roberto",
  "Valentina - CMO": "valentina",
  "Diego - CPO": "diego",
  
  // POD 2: MARKETING & CONTENIDO
  "Jorge - Content": "jorge",
  "Lucía - SEO/Growth": "lucia",
  "Isabella - Paid Media": "isabella",
  "Mateo - Social": "mateo",
  
  // POD 3: DATA & INTELIGENCIA
  "Andrés - Analytics": "andres",
  "Daniela - Competitive Intel": "daniela",
  "Emilio - Customer Success": "emilio",
  
  // POD 4: OPERACIONES & GOVERNANCE
  "Patricia - Legal": "patricia",
  "Santiago - RevOps": "santiago",
  "Catalina - Project Mgr": "catalina",
};

// Map frontend model names to Swarm-compatible model identifiers
export const MODEL_MAP: Record<string, string> = {
  "Shifty 2.0 by Shift AI": "Shifty 2.0 by Shift AI",
  "Claude Sonnet 4.6": "Claude Sonnet 4.6",
  "Gemini 3.1 Flash Lite": "Gemini 3.1 Flash Lite",
  "DeepSeek V3.2": "DeepSeek V3.2",
  "Gemini 3.1 Pro": "Gemini 3.1 Pro",
  "Claude Opus 4.6": "Claude Opus 4.6",
  "Moonshot Kimi K2.5": "Moonshot Kimi K2.5",
};

/**
 * Detect if user prompt should trigger debate mode.
 */
export function isDebateRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return lower.includes("debate") || lower.includes("compara perspectivas");
}
