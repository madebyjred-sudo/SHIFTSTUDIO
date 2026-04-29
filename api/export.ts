import type { VercelRequest, VercelResponse } from '@vercel/node';

const SWARM_API_URL = process.env.SWARM_API_URL || "http://localhost:8000";

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s max for export

    try {
        const swarmResponse = await fetch(`${SWARM_API_URL}/export/document`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(req.body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!swarmResponse.ok) {
            const errorText = await swarmResponse.text();
            console.error(`[Export Gateway Error] ${swarmResponse.status} - ${errorText}`);
            return res.status(swarmResponse.status).json({ error: "Export Failed", details: errorText });
        }

        const data = await swarmResponse.json();

        // Make the URL absolute so the frontend can download it from the backend server
        if (data.url && data.url.startsWith('/')) {
            data.url = `${SWARM_API_URL}${data.url}`;
        }

        return res.json(data);

    } catch (error: any) {
        console.error("[Export Gateway Server Error]:", error);
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: "Gateway Timeout: La exportación tardó demasiado en responder." });
        }
        res.status(500).json({ error: "Internal gateway error" });
    }
}
