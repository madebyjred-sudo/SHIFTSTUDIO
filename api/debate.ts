import type { VercelRequest, VercelResponse } from '@vercel/node';

// Python Swarm Backend URL
const SWARM_API_URL = process.env.SWARM_API_URL || "http://localhost:8000";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    console.log(`[Vercel Gateway] Debate: ${payload?.agent_a_id} vs ${payload?.agent_b_id} | ${payload?.turns} turns`);

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
    console.log(`[Vercel Gateway] Debate complete: ${data.turns_completed} turns`);

    // Forward JSON to client
    res.json(data);

  } catch (error) {
    console.error("[Gateway Error]:", error);
    res.status(500).json({ error: "Internal gateway error", details: String(error) });
  }
}
