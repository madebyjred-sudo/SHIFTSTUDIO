import express from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_MAP, MODEL_MAP, isDebateRequest } from "./src/shared/constants.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Python Swarm Backend URL
const SWARM_API_URL = process.env.SWARM_API_URL || "http://localhost:8000";

// Utilidad de Timeout/Circuit Breaker para conexiones estancadas
const fetchWithTimeout = async (url: string, options: any, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3001;

  app.use(express.json());

  // CORS — Permite requests del BrandHub (Shift y futuro Garnier)
  app.use((req, res, next) => {
    const allowedOrigins = [
      'http://localhost:3003',    // BrandHub dev
      'http://localhost:5173',    // Vite default
      'http://localhost:5174',    // Embed dev
    ];
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Health check endpoint
  app.get("/api/health", async (req, res) => {
    try {
      const swarmHealth = await fetch(`${SWARM_API_URL}/health`);
      const swarmStatus = swarmHealth.ok ? "connected" : "disconnected";
      res.json({
        status: "healthy",
        frontend: "running",
        swarm: swarmStatus,
        swarm_url: SWARM_API_URL,
      });
    } catch (e) {
      res.json({
        status: "healthy",
        frontend: "running",
        swarm: "disconnected",
        swarm_url: SWARM_API_URL,
        error: (e as Error).message,
      });
    }
  });

  // API Chat Endpoint: THE PYTHON BRIDGE
  // Updated to accept the same format as the Python backend (frontend compatibility)
  app.post("/api/chat", async (req, res) => {
    try {
      // Support both formats:
      // 1. Old: { prompt, model, agent, messages, sessionId, tenantId }
      // 2. New: { messages, preferred_agent, model, tenant_id, session_id }
      const body = req.body;

      // Extract fields with fallback between old and new naming
      const messages = body.messages || [];
      const model = body.model || "Claude Sonnet 4.6";
      const sessionId = body.session_id || body.sessionId;
      const tenantId = body.tenant_id || body.tenantId || 'shift';

      // Agent can come from preferred_agent (new) or agent (old)
      const agentInput = body.preferred_agent || body.agent;
      const swarmAgentId = agentInput ? (AGENT_MAP[agentInput] || agentInput) : "shiftai";

      // Map model name
      const swarmModel = MODEL_MAP[model] || model;

      console.log(`[Express Gateway] Forwarding: tenant=${tenantId}, agent=${swarmAgentId}, sessionId=${sessionId || "none"}`);

      // Detect if user wants a debate based on last message
      const lastMessage = messages[messages.length - 1];
      const lastContent = lastMessage?.content || "";
      const isDebate = isDebateRequest(lastContent);
      const targetEndpoint = isDebate ? "/swarm/debate" : "/swarm/chat";

      console.log(`[Express Gateway] Routing to: ${targetEndpoint}`);

      // Proxy directly to FastAPI
      // CRITICAL FIX: ALWAYS forward preferred_agent (even "shiftai") so the
      // Python backend can enforce Nodes Mode routing via [SYSTEM INSTRUCTION:].
      // Also forward search_enabled and attachments that the frontend sends.
      const swarmResponse = await fetchWithTimeout(`${SWARM_API_URL}${targetEndpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages,
          preferred_agent: swarmAgentId,
          model: swarmModel,
          tenant_id: tenantId,
          session_id: sessionId,
          search_enabled: body.search_enabled || false,
          attachments: body.attachments || [],
        }),
      }, 60000); // 60s max per node/chat

      if (!swarmResponse.ok) {
        const errorText = await swarmResponse.text();
        console.error(`[Swarm Error] ${swarmResponse.status} - ${errorText}`);
        return res.status(swarmResponse.status).json({ error: "Backend Intelligence Unavailable", details: errorText });
      }

      const data = await swarmResponse.json();

      // Enviar asíncronamente al Peaje (Insight DB).
      // app_id="studio" hace que el insight aterrice en el bucket
      // Studio del Punto Medio post v3 multi-app — peer de cl2/eco/sentinel.
      // message_id = ID del último turn assistant según Studio (lo usa
      // el widget <cerebro-feedback> para anclar likes al training_pair).
      // upstream_model fluye al training_pair para legal_status flagging.
      const studioMessageId = body.message_id
        || `studio-${tenantId}-${sessionId || "anon"}-${Date.now()}`;

      if (!isDebate) {
        console.log(`[Peaje Ingest →] firing for ${studioMessageId} app=studio agent=${data.agent_active || swarmAgentId}`);
        // void + await-immediate-then-detach pattern: fire-and-forget
        // pero garantiza que la promesa esté en el event loop ANTES
        // de que el handler de Express retorne. Si solo dejamos
        // `fetch().catch()` colgando, Node puede GC la promise antes
        // de que el TCP handshake salga.
        void (async () => {
          try {
            const r = await fetch(`${SWARM_API_URL}/peaje/ingest`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                app_id: "studio",
                tenantId: tenantId,
                sessionId: sessionId || "anon",
                agentId: data.agent_active || swarmAgentId,
                messages: messages,
                response: data.content,
                message_id: studioMessageId,
                upstream_model: data.model_used || swarmModel,
              })
            });
            console.log(`[Peaje Ingest ✓] ${studioMessageId} → ${r.status}`);
          } catch (err: any) {
            console.error(`[Peaje Ingest ✗] ${studioMessageId}: ${err?.message || err}`);
          }
        })();
      }

      return res.json({
        content: data.content,
        agent_active: data.agent_active || swarmAgentId,
        source: isDebate ? "swarm_debate" : "swarm_cerebro",
        tenantId: tenantId,
        debate_participants: data.debate_participants || null,
        // upstream_model — modelo que efectivamente respondió.
        // Lo usa el widget <cerebro-feedback> para tagear legal_status
        // del training_pair (kimi/llama=unrestricted).
        upstream_model: data.model_used || data.upstream_model || swarmModel,
        // message_id — el frontend lo necesita para que el widget
        // ancle likes al training_pair correcto en Cerebro. Se devuelve
        // tal cual lo usó el ingest.
        message_id: studioMessageId,
      });

    } catch (error: any) {
      console.error("[Express Gateway Error]:", error);
      if (error.name === 'AbortError') {
        return res.status(504).json({ error: "Gateway Timeout: El LLM tardó demasiado en responder." });
      }
      res.status(500).json({ error: "Internal gateway error", details: String(error) });
    }
  });

  // API Debate Endpoint: THE PYTHON BRIDGE for The Arena
  // v3.0: Simple JSON proxy — no streaming, same pattern as /api/chat
  app.post("/api/debate", async (req, res) => {
    try {
      const payload = req.body;
      console.log(`[Express Gateway] Debate: ${payload.agent_a_id} vs ${payload.agent_b_id} | ${payload.turns} turns`);

      const swarmResponse = await fetch(`${SWARM_API_URL}/swarm/debate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!swarmResponse.ok) {
        const errorText = await swarmResponse.text();
        console.error(`[Swarm Error] ${swarmResponse.status} - ${errorText}`);
        return res.status(swarmResponse.status).json({ error: "Backend Intelligence Unavailable", details: errorText });
      }

      const data = await swarmResponse.json();
      console.log(`[Express Gateway] Debate complete: ${data.turns_completed} turns, ${data.transcript?.length} entries`);

      // Forward JSON to client
      res.json(data);

      // Fire-and-forget Peaje ingestion
      if (data.transcript && data.transcript.length > 0) {
        const tenantId = payload.tenant_id || 'shift';
        const sessionId = payload.session_id || `debate-${Date.now()}`;

        fetch(`${SWARM_API_URL}/peaje/ingest-debate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: "studio",
            tenantId,
            sessionId,
            agentA: data.debate_participants?.[0] || payload.agent_a_id || 'unknown',
            agentB: data.debate_participants?.[1] || payload.agent_b_id || 'unknown',
            topic: payload.topic || '',
            transcript: data.transcript,
            synthesis: data.content || '',
          })
        })
          .then(r => r.json())
          .then(d => console.log(`[Peaje Debate] ✓ ${d.insights_saved || 0} insights`))
          .catch(err => console.error("[Peaje Debate Error]:", err));
      }

    } catch (error) {
      console.error("[Express Gateway Error]:", error);
      res.status(500).json({ error: "Internal gateway error" });
    }
  });

  // API Export Endpoint: THE PYTHON BRIDGE for Document Generation
  app.post("/api/export", async (req, res) => {
    try {
      const payload = req.body;
      console.log(`[Express Gateway] Exporting document: format=${payload.format}`);

      const swarmResponse = await fetchWithTimeout(`${SWARM_API_URL}/export/document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 90000); // Exporting can take longer (90s)

      if (!swarmResponse.ok) {
        const errorText = await swarmResponse.text();
        console.error(`[Swarm Export Error] ${swarmResponse.status} - ${errorText}`);
        return res.status(swarmResponse.status).json({ error: "Export Failed", details: errorText });
      }

      const data = await swarmResponse.json();

      // Make URL absolute if needed
      if (data.url && data.url.startsWith('/')) {
        data.url = `${SWARM_API_URL}${data.url}`;
      }

      return res.json(data);
    } catch (error: any) {
      console.error("[Express Gateway Export Error]:", error);
      if (error.name === 'AbortError') {
        return res.status(504).json({ error: "Gateway Timeout: La exportación tardó demasiado en responder." });
      }
      res.status(500).json({ error: "Internal gateway error", details: String(error) });
    }
  });

  // API Nodes Execution Endpoint: THE PYTHON BRIDGE for Graph Builder
  app.post("/api/peaje/nodes", async (req, res) => {
    try {
      const payload = req.body;
      console.log(`[Express Gateway] Forwarding Nodes Execution to Peaje 2.0: session=${payload.session_id}`);

      // Fire-and-forget proxy directly to Python backend
      fetch(`${SWARM_API_URL}/peaje/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(err => console.error("[Peaje 2.0 Nodes Error]:", err));

      return res.json({ status: "queued", message: "Node telemetry sent to Peaje 2.0" });
    } catch (error) {
      console.error("[Express Gateway Error]:", error);
      res.status(500).json({ error: "Internal gateway error", details: String(error) });
    }
  });

  // List available agents endpoint (Proxy to Swarm)
  app.get("/api/agents", async (req, res) => {
    try {
      const swarmResponse = await fetch(`${SWARM_API_URL}/swarm/agents`);
      if (swarmResponse.ok) {
        const data = await swarmResponse.json();
        return res.json(data);
      }
    } catch (e) {
      console.log("Swarm unavailable for agents list, returning local mapping");
    }

    // Static fallback if swarm is down
    res.json({
      agents: Object.keys(AGENT_MAP).map(name => ({ id: AGENT_MAP[name], name }))
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🚀 Shift AI Gateway (v1.0 Bridge) running on http://localhost:${PORT}`);
    console.log(`🧠 Swarm Backend: ${SWARM_API_URL}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  });
}

startServer();
