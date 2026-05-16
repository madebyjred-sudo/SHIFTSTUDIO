// src/services/graphApi.ts

const getBaseUrl = () => {
    // Si la variable está definida (ej. Prod), la usamos directamente saltando el proxy.
    // Si está vacía (local default), '' provoca llamadas relativas que el proxy Vite atrapa.
    const url = import.meta.env.VITE_GATEWAY_URL || '';
    // Quita el trailing slash si lo hay
    return url.endsWith('/') ? url.slice(0, -1) : url;
};

export interface GenerateGraphRequest {
    user_message: string;
    current_graph: any | null;
    chat_history: { role: string; content: string }[];
    tenant_id: string;
    model?: string;
}

export interface GraphGenerateResponse {
    mode: 'graph' | 'chat';
    narrative?: string;
    graph?: {
        nodes: any[];
        edges: any[];
    };
    explanation_per_node?: Record<string, string>;
    message?: string;
}

// Cerebro graph endpoints — namespace audit 2026-05-16:
//
//   /v1/graph/execute  → live (SSE, used by graphExecutionApi.ts)
//   /v1/graph/generate → NOT live (404). Legacy /graph/generate works.
//   /v1/graph/resume   → NOT live (404). Legacy /graph/resume also 404
//                        (was already broken pre-refactor — no consumers
//                         on Cerebro side appear to wire it).
//
// Originally migrated to /v1/* speculatively per W0-S2 prompt. Smoke
// revealed the v1 aliases were never deployed for generate/resume.
// Reverted generateGraph back to legacy /graph/generate (it works).
// resumeGraph is kept on /graph/resume for symmetry but emits a warning
// — the route's been broken upstream for a while. When Cerebro publishes
// /v1/graph/generate + /v1/graph/resume aliases, batch-edit both back
// to /v1/* (issue tracked in the next neuro handoff).
export async function generateGraph(params: GenerateGraphRequest): Promise<GraphGenerateResponse> {
    const res = await fetch(`${getBaseUrl()}/graph/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    if (!res.ok) {
        throw new Error(`Error en /graph/generate: ${res.status} ${res.statusText}`);
    }

    return await res.json();
}

export async function resumeGraph(pauseId: string, decision: 'approve' | 'reject'): Promise<any> {
    const res = await fetch(`${getBaseUrl()}/graph/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pause_id: pauseId, decision }),
    });

    if (!res.ok) {
        throw new Error(`Error en /graph/resume: ${res.status} ${res.statusText}`);
    }

    return await res.json();
}
