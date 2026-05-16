/**
 * @file templateApi.ts
 * @description Typed fetch for the Studio template gallery (Wave-E).
 *
 * Wave-E ships built-in starting-point DAGs ("Brief creativo", "Plan de
 * campaña", etc.) that the user can load into the graph builder with a
 * single click. The list lives BOTH on Cerebro (`/v1/graph/templates`,
 * hardcoded Python) and on Supabase (`studio_templates`, migration 0011)
 * — same wire shape from either source so the gallery UI doesn't care.
 *
 * Current default: hit Cerebro. The frontend has no Supabase client
 * convention for cross-tenant reads yet; when the admin curation UX
 * lands we'll add a `source: 'supabase' | 'cerebro'` switch here.
 *
 * Cerebro base URL comes from `VITE_GATEWAY_URL` (same env var
 * `graphExecutionApi.ts` uses for /v1/graph/execute). When unset we
 * fall back to the same-origin gateway proxy that the BFF / Vercel
 * rewrites forward to Cerebro.
 */

import { supabase } from './supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────

export interface TemplateGraphNode {
  id: string;
  type: 'context' | 'specialist' | 'export' | string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface TemplateGraphEdge {
  id?: string;
  source: string;
  target: string;
}

export interface TemplateDag {
  nodes: TemplateGraphNode[];
  edges: TemplateGraphEdge[];
}

export interface Template {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  sort_order?: number;
  thumbnail_url?: string | null;
  dag_json: TemplateDag;
}

export interface ListTemplatesResponse {
  tenant_id: string;
  templates: Template[];
}

// ─── URL resolution ───────────────────────────────────────────────────

const DEFAULT_TENANT = 'shift';

/**
 * Resolve the gateway/Cerebro base URL.
 *
 *   1. `import.meta.env.VITE_GATEWAY_URL` — same var graphExecutionApi
 *      reads; canonical going forward.
 *   2. Empty → same-origin (the Express BFF proxies `/v1/graph/*` to
 *      Cerebro). Returns `''` so callers can prefix paths directly.
 *
 * Never throws on missing config — an empty base just makes calls
 * same-origin, and the dev/prod proxy handles it.
 */
function gatewayBaseUrl(): string {
  const raw = (import.meta.env.VITE_GATEWAY_URL as string | undefined) || '';
  return raw.replace(/\/+$/, '');
}

// ─── HTTP helpers (lean copy of workspaceApi.ts) ─────────────────────

async function getAuthHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* unauth read is fine for templates — fall through */
  }
  return {};
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * List active templates for a tenant.
 *
 * The `signal` plumbs cancellation when the gallery modal unmounts
 * mid-fetch; without it we'd keep the in-flight request alive and
 * setState into an unmounted component.
 */
export async function listTemplates(
  tenantId: string = DEFAULT_TENANT,
  signal?: AbortSignal,
): Promise<Template[]> {
  const base = gatewayBaseUrl();
  const url = `${base}/v1/graph/templates?tenant_id=${encodeURIComponent(tenantId)}`;

  const headers: Record<string, string> = {
    'x-tenant-id': tenantId,
    ...(await getAuthHeader()),
  };

  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `listTemplates HTTP ${res.status}: ${text || res.statusText}`,
    );
  }
  const body = (await res.json()) as ListTemplatesResponse;
  return body.templates ?? [];
}
