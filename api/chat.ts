import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AGENT_MAP, MODEL_MAP, isDebateRequest } from '../src/shared/constants.js';

// Python Swarm Backend URL
const SWARM_API_URL = process.env.SWARM_API_URL || "http://localhost:8000";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    // Aceptar AMBAS variantes: el frontend del Express server.ts manda
    // snake_case (tenant_id, session_id, preferred_agent), el legacy
    // mandaba camelCase. Hacemos fallback en cada par.
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const tenantId       = body.tenant_id     || body.tenantId     || 'shift';
    const sessionId      = body.session_id    || body.sessionId    || null;
    const agentInput     = body.preferred_agent || body.agent      || null;
    const model          = body.model         || 'Shifty 2.0 by Shift AI';
    const isSearchEnabled = body.search_enabled === true || body.searchEnabled === true;
    const attachments    = Array.isArray(body.attachments) ? body.attachments : [];
    const messageIdIn    = body.message_id    || null;

    // Si el frontend mandó un campo `prompt` (legacy), lo agregamos como
    // último mensaje user. Si no, asumimos que el último item de messages
    // YA es el turn actual del user — no duplicar.
    const apiMessages: any[] = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
      agent_id: m.agentActive || undefined,
    }));
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
      apiMessages.push({ role: 'user', content: body.prompt });
    }
    const lastUserContent = apiMessages
      .slice()
      .reverse()
      .find((m: any) => m.role === 'user')?.content || '';

    console.log(`[Vercel Gateway] tenant=${tenantId} agent=${agentInput} session=${sessionId || "none"} msgs=${apiMessages.length}`);

    const swarmAgentId = (agentInput && AGENT_MAP[agentInput]) || agentInput || "shiftai";
    const swarmModel   = MODEL_MAP[model] || "Claude 3.5 Sonnet";

    const isDebate = isDebateRequest(lastUserContent);
    const targetEndpoint = isDebate ? "/swarm/debate" : "/swarm/chat";

    // [DEBUG] Loggea el payload completo que va al Swarm para diagnosticar
    // por qué los agentes responden saludos genéricos en vez de procesar
    // el prompt real. Logs en Vercel → Logs tab.
    console.log("[Vercel Gateway DEBUG] Swarm payload:", JSON.stringify({
      endpoint: targetEndpoint,
      preferred_agent: swarmAgentId,
      model: swarmModel,
      messages_count: apiMessages.length,
      last_user_msg_preview: lastUserContent.slice(0, 120),
      tenant_id: tenantId,
      session_id: sessionId,
    }));

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

    // message_id estable para anclar el widget <cerebro-feedback> al
    // training_pair correcto en Cerebro. Si el frontend lo mandó, lo
    // respetamos; si no, generamos uno determinístico por turn.
    const studioMessageId = messageIdIn
      || `studio-${tenantId}-${sessionId || "anon"}-${Date.now()}`;

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
            message_id: studioMessageId,
            upstream_model: data.model_used || swarmModel,
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
      debate_participants: data.debate_participants || null,
      upstream_model: data.model_used || data.upstream_model || swarmModel,
      message_id: studioMessageId,
    });

  } catch (error) {
    console.error("[Gateway Server Error]:", error);
    res.status(500).json({ error: "Internal gateway error" });
  }
}
