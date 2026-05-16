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

// Cerebro v1 namespace migration (consolidated 2026-05-16).
//
// Legacy paths `/graph/generate` + `/graph/resume` siguen vivos como
// fallback. Canonical paths `/v1/graph/*` agregadas en Cerebro commit
// 9b3956d (alias delegates con schemas idénticos al legacy). Migración
// inicial W0-S2 fue revertida en `89644fb` por 404; ahora con aliases
// live, restauro la migration y consolido todo el namespace /v1/graph/*
// junto con /v1/graph/execute (graphExecutionApi.ts) y el resto del
// gateway surface (/v1/llm/invoke, /v1/neuron/*, /v1/chat/completions).
//
// Smoke 2026-05-16 con body `{}` → 422 (route live, validation falla).
// Schema validation idéntica a legacy — sin cambios de body shape.
export async function generateGraph(params: GenerateGraphRequest): Promise<GraphGenerateResponse> {
    const res = await fetch(`${getBaseUrl()}/v1/graph/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    if (!res.ok) {
        throw new Error(`Error en /v1/graph/generate: ${res.status} ${res.statusText}`);
    }

    return await res.json();
}

export async function resumeGraph(pauseId: string, decision: 'approve' | 'reject'): Promise<any> {
    const res = await fetch(`${getBaseUrl()}/v1/graph/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pause_id: pauseId, decision }),
    });

    if (!res.ok) {
        throw new Error(`Error en /v1/graph/resume: ${res.status} ${res.statusText}`);
    }

    return await res.json();
}
