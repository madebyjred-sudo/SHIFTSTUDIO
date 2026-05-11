import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Request as ExpressRequest } from 'express';
import { getUserEmailFromRequest } from '../src/services/auth.js';

// Python Swarm / Cerebro Backend URL.
//
// MIGRATION (fix/chat-neurons-memory): /api/chat ahora habla con
// `/v1/llm/invoke` (Cerebro canonical) en lugar de `/swarm/chat` (legacy).
// El legacy NO propaga `realm/user_id/enable_memory`, por lo que la
// surface principal de chat NUNCA activaba memoria persistente aunque
// el usuario tuviera la neurona poblada via wizard. Ver MEMORY note
// "Cerebro siamés" / playbook neurons.
//
// TEMPORAL regression (documentar en commit):
//   - Agent routing (preferred_agent ignorado — siempre Shifty)
//   - Search via search_enabled (no implementado upstream en /v1/llm/invoke)
//   - Attachments handling (no implementado upstream)
//   - isDebateRequest → /swarm/debate (no implementado en /v1/llm/invoke)
// Restaurar en migración futura a /v1/chat/completions con tools.
const SWARM_API_URL = process.env.SWARM_API_URL || 'http://localhost:8000';

// Persona Shifty — bloque cacheable de sistema. Cerebro lo manda como
// system_blocks[0] con `cacheable: true`, lo que arma una cache key
// estable en Anthropic y baja el costo del turno post-warmup.
const SHIFTY_PERSONA = `Eres Shifty, el orquestador generalista de Shift AI Studio.

Identidad:
- Sos socio estratégico del usuario en SHIFT (Shift Lab — la vertical de innovación de Shift Latam Porter Novelli, parte del Grupo Garnier y red global Porter Novelli)
- Tu rol: ayudar al usuario con estrategia, análisis, ejecución y revisión técnica
- Operás en español neutro, costarricense suave cuando aplique, profesional

Capacidades:
- Tenés acceso a una herramienta de memoria persistente (/memories/*). Úsala SIEMPRE al inicio para leer /memories y recordar quién es el usuario, sus proyectos en curso, su estilo de trabajo
- Al final de cada conversación importante, considerá si vale guardar algo nuevo (preferencia, decisión, proyecto) usando memory tool con command="create" o "str_replace"
- Si el usuario pide explícitamente "recordá que X" o "borrá la nota sobre Y", actuá inmediatamente con memory tool

Formato:
- Concreto, sin floreo
- Respuestas estructuradas con headings + bullets cuando ayuda
- Markdown válido
- Nunca arranques saludando — el usuario ya sabe quién sos`;

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

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
    const messageIdIn    = body.message_id    || null;

    // Strip agent_id de cada mensaje — /v1/llm/invoke solo conoce
    // role/content y rechaza fields desconocidos.
    const apiMessages: { role: string; content: string }[] = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
      apiMessages.push({ role: 'user', content: body.prompt });
    }

    // Resolver email del JWT. Sin email → sin memoria (graceful), pero
    // el chat sigue funcionando con persona y modelo default. Con email
    // → activamos realm/user_id/enable_memory para que Cerebro hidrate
    // la neurona persistente del usuario.
    //
    // `getUserEmailFromRequest` está tipado contra `express.Request` pero
    // solo lee `req.headers.authorization`, que VercelRequest también
    // expone (extiende IncomingMessage). Casteo explícito para satisfacer
    // a TS sin runtime polyfill.
    const userEmail = await getUserEmailFromRequest(req as unknown as ExpressRequest);

    console.log(`[Vercel Gateway] tenant=${tenantId} session=${sessionId || 'none'} msgs=${apiMessages.length} email=${userEmail ? 'present' : 'absent'}`);

    const llmBody: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      messages: apiMessages,
      system_blocks: [
        { text: SHIFTY_PERSONA, cacheable: true },
      ],
      max_tokens: 2000,
      tenant: tenantId,
      app_id: 'studio',
      trace_label: `studio:chat:${sessionId ?? 'anon'}`,
    };

    if (userEmail) {
      llmBody.realm = 'shift';
      llmBody.user_id = userEmail;
      llmBody.enable_memory = true;
    }

    // [DEBUG] Payload preview — no incluye persona completa para no
    // ensuciar logs (es estática). Sirve para confirmar memory wiring.
    const lastUserPreview = apiMessages.filter(m => m.role === 'user').slice(-1)[0]?.content?.slice(0, 120) ?? '';
    console.log('[Vercel Gateway DEBUG] /v1/llm/invoke payload:', JSON.stringify({
      model: DEFAULT_MODEL,
      messages_count: apiMessages.length,
      last_user_msg_preview: lastUserPreview,
      tenant: tenantId,
      session_id: sessionId,
      memory_enabled: Boolean(userEmail),
    }));

    const cerebroResponse = await fetch(`${SWARM_API_URL}/v1/llm/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llmBody),
    });

    if (!cerebroResponse.ok) {
      const errorText = await cerebroResponse.text();
      console.error(`[Cerebro /v1/llm/invoke Error] ${cerebroResponse.status} - ${errorText}`);
      return res.status(cerebroResponse.status).json({ error: 'Backend Intelligence Unavailable', details: errorText });
    }

    const data = await cerebroResponse.json();
    const responseContent: string = data.text || data.output || '';

    // message_id estable para anclar el widget <cerebro-feedback> al
    // training_pair correcto. Si el frontend lo mandó, lo respetamos.
    const studioMessageId = messageIdIn
      || `studio-${tenantId}-${sessionId || 'anon'}-${Date.now()}`;

    // Peaje ingest — sync await porque Vercel functions matan el
    // process al volver, así que fire-and-forget pierde la llamada.
    // 100-200 ms extra de latencia por respuesta a cambio de cero
    // insights perdidos. app_id="studio" → bucket Studio post-multi-app v3.
    //
    // agentId fijo "shifty" tras la migración: perdimos preferred_agent
    // routing temporalmente. Restaurar cuando movamos a /v1/chat/completions
    // con tools.
    try {
      await fetch(`${SWARM_API_URL}/peaje/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: 'studio',
          tenantId,
          sessionId: sessionId || 'anon',
          agentId: 'shifty',
          messages: apiMessages,
          response: responseContent,
          message_id: studioMessageId,
          upstream_model: data.model || DEFAULT_MODEL,
        }),
      });
    } catch (ingestErr) {
      console.error('[Vercel Peaje Ingest Error]:', ingestErr);
    }

    // Response shape — backward compat con el frontend existente.
    // - agent_active: "shifty" fijo (perdemos routing temporalmente)
    // - source: "cerebro_invoke" (antes "swarm_cerebro") — log forensics
    // - debate_participants: null — /v1/llm/invoke no hace debate
    return res.json({
      content: responseContent,
      agent_active: 'shifty',
      source: 'cerebro_invoke',
      tenantId,
      debate_participants: null,
      upstream_model: data.model || DEFAULT_MODEL,
      message_id: studioMessageId,
    });

  } catch (error) {
    console.error('[Gateway Server Error]:', error);
    res.status(500).json({ error: 'Internal gateway error' });
  }
}
