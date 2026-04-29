import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AGENT_MAP, MODEL_MAP, isDebateRequest } from '../src/shared/constants.js';

// Python Swarm Backend URL
const SWARM_API_URL = process.env.SWARM_API_URL || "http://localhost:8000";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt, model, agent, searchEnabled, search_enabled, messages = [], sessionId, tenantId = 'shift', attachments = [] } = req.body;

    // Support both camelCase and snake_case from frontend
    const isSearchEnabled = searchEnabled === true || search_enabled === true;

    console.log(`[Vercel Gateway] Forwarding request to Swarm: tenant=${tenantId}, agent=${agent}, sessionId=${sessionId || "none"}, search=${isSearchEnabled}, attachments=${attachments.length}`);

    const swarmAgentId = AGENT_MAP[agent] || "shiftai";
    const swarmModel = MODEL_MAP[model] || "Claude 3.5 Sonnet";

    const apiMessages = [
      ...messages.map((m: any) => ({ role: m.role, content: m.content, agent_id: m.agentActive || undefined })),
      { role: "user", content: prompt }
    ];

    // Detect if user wants a debate
    const isDebate = isDebateRequest(prompt);
    const targetEndpoint = isDebate ? "/swarm/debate" : "/swarm/chat";

    console.log(`[Vercel Gateway] Routing to: ${targetEndpoint}`);

    // THE PYTHON BRIDGE: Always call FastAPI
    // CRITICAL FIX: ALWAYS forward preferred_agent (even "shiftai") so the
    // Python backend can enforce Nodes Mode routing via [SYSTEM INSTRUCTION:].
    const swarmResponse = await fetch(`${SWARM_API_URL}${targetEndpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: apiMessages,
        preferred_agent: swarmAgentId,
        model: swarmModel,
        tenant_id: tenantId,
        session_id: sessionId,
        search_enabled: isSearchEnabled,
        attachments: attachments
      }),
    });

    if (!swarmResponse.ok) {
      const errorText = await swarmResponse.text();
      console.error(`[Swarm Error] ${swarmResponse.status} - ${errorText}`);
      return res.status(swarmResponse.status).json({ error: "Backend Intelligence Unavailable", details: errorText });
    }

    const data = await swarmResponse.json();

    // Peaje ingest — sync await porque Vercel functions matan el
    // process al volver, así que fire-and-forget pierde la llamada.
    // 100-200 ms extra de latencia por respuesta a cambio de cero
    // insights perdidos. app_id="studio" hace que el insight aterrice
    // en el bucket Studio del Punto Medio post v3 multi-app.
    if (!isDebate) {
      try {
        await fetch(`${SWARM_API_URL}/peaje/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: "studio",
            tenantId,
            sessionId: sessionId || "anon",
            agentId: data.agent_active || swarmAgentId,
            messages: apiMessages,
            response: data.content,
          }),
        });
      } catch (ingestErr) {
        console.error("[Vercel Peaje Ingest Error]:", ingestErr);
      }
    }

    // Return unified response (aligned with Express gateway format)
    return res.json({
      content: data.content,
      agent_active: data.agent_active || swarmAgentId,
      source: isDebate ? "swarm_debate" : "swarm_cerebro",
      tenantId: tenantId,
      debate_participants: data.debate_participants || null
    });

  } catch (error) {
    console.error("[Gateway Server Error]:", error);
    res.status(500).json({ error: "Internal gateway error" });
  }
}
