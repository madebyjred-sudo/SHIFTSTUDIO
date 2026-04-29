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
