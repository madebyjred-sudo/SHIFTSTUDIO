/**
 * @file services/openRouterDirect.ts
 * @description Cerebro-routed LLM client for Studio's Workspace AI primitives.
 *
 * HISTORY
 * -------
 * Originally a direct OpenRouter shim that bypassed Cerebro for Studio's
 * chat / transform / architect / edit paths. That bypass is gone — we now
 * route every Workspace LLM call through Cerebro's `/v1/llm/invoke` so the
 * tenant key, billing trace, and architect agent live in one place.
 *
 * The exported function name (`callOpenRouter`) is preserved for
 * backwards-compatibility with the workspace.ts handlers — under the hood
 * it talks to Cerebro, not OpenRouter.
 *
 * CEREBRO ENDPOINT
 * ----------------
 *   POST {SWARM_API_URL}/v1/llm/invoke
 *   body  { model, prompt, system?, tenant?, max_tokens?, temperature?, trace_label? }
 *   resp  { output, text, usage, latency_ms, call_id, model, agent_id }
 *
 * Cerebro's invoke is single-turn — multi-turn chat history is flattened
 * into the `prompt` as `[role]: content` lines (see flattenMessages below).
 *
 * `response_format` from the legacy CallArgs is dropped here. Architect /
 * classifier callers that need strict JSON output should append a "return
 * ONLY valid JSON" instruction to the system prompt and use
 * `extractJsonObject` to defensively parse the response.
 *
 * COST TELEMETRY (Phase 3.B)
 * --------------------------
 * After every call we fire-and-forget an INSERT into `studio_ai_call_log`
 * with model, usage, computed cost, latency, and status. The insert is
 * wrapped in try/catch + console.warn — log failures NEVER block the
 * user-facing response. Pricing comes from `services/aiPricing.ts`; if a
 * model is missing there cost columns fall back to NULL but token / latency
 * data still lands.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeCost, type UsageInput } from './aiPricing.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const SWARM_API_URL =
  process.env.SWARM_API_URL ?? 'https://shift-cerebro-production.up.railway.app';

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallArgs {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Legacy: ignored by Cerebro's invoke. Use a strict-JSON system prompt
   *  + `extractJsonObject` instead. Kept for caller-side compat. */
  response_format?: { type: 'json_object' | 'text' };
  /** Optional caller-controlled abort (e.g. request closed). Combines
   *  with the timeoutMs default via combineSignals. */
  signal?: AbortSignal;
  /** Override default 30s timeout. */
  timeoutMs?: number;
  /** Tenant id forwarded to Cerebro for billing / RAG scoping. Defaults
   *  to 'shift'. */
  tenant?: string;
  /** Trace label for Cerebro logs / dashboard rollups. Recommended:
   *  `studio.workspace.<purpose>` (e.g. `studio.workspace.turn.chat`). */
  trace_label?: string;
  /** Studio user id (auth.users.id) for cost-attribution telemetry.
   *  Logged into studio_ai_call_log.user_id. Nullable in dev /
   *  bypass-auth mode. Not forwarded upstream. */
  userId?: string | null;
  /** Studio workspace id when the call is workspace-scoped. Logged
   *  into studio_ai_call_log.workspace_id. Not forwarded upstream. */
  workspaceId?: string | null;
}

/**
 * Cerebro `/v1/llm/invoke` response shape — extended beyond the
 * `output`/`text` we used previously to capture usage, call_id, model,
 * and latency for cost telemetry.
 */
interface InvokeResponse {
  output?: string;
  text?: string;
  usage?: UsageInput & {
    total_tokens?: number | null;
  };
  call_id?: string;
  model?: string;
  latency_ms?: number;
  agent_id?: string;
}

/**
 * Fire-and-forget INSERT into studio_ai_call_log. Never throws —
 * a logging failure must not break the user-facing response.
 *
 * Called twice from callOpenRouter: once on success (status='ok'),
 * once on error (status='error' or 'timeout' with error_message).
 */
function logAiCall(row: {
  call_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  tenant_id: string | null;
  trace_label: string | null;
  model: string;
  usage: (UsageInput & { total_tokens?: number | null }) | null;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout';
  error_code?: string | null;
  error_message?: string | null;
}): void {
  if (!supabaseAdmin) return;
  const usage = row.usage ?? {};
  const cost = computeCost(row.model, usage);
  void (async () => {
    try {
      const { error } = await supabaseAdmin!.from('studio_ai_call_log').insert({
        call_id: row.call_id,
        user_id: row.user_id,
        workspace_id: row.workspace_id,
        tenant_id: row.tenant_id,
        app_id: 'studio',
        trace_label: row.trace_label,
        model: row.model,
        input_tokens: usage.input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
        cost_usd_input: cost.cost_usd_input,
        cost_usd_output: cost.cost_usd_output,
        cost_usd_total: cost.cost_usd_total,
        latency_ms: row.latency_ms,
        status: row.status,
        error_code: row.error_code ?? null,
        error_message: row.error_message ?? null,
      });
      if (error) {
        console.warn('[ai_call_log] insert failed:', error.message);
      }
    } catch (logErr) {
      console.warn('[ai_call_log] insert threw:', (logErr as Error).message);
    }
  })();
}

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  // AbortSignal.any is widely supported in Node ≥20.3. We avoid it for
  // older runtimes by manual fan-in.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('cerebro_timeout')), timeoutMs);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  }
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/**
 * Flatten OpenAI-style chat messages into Cerebro's single-turn shape.
 *
 * Rules:
 *   - The FIRST `system` message becomes `system` (any further system
 *     messages are appended to it with a `\n\n` join — defensive only,
 *     callers should not pass multiple system messages).
 *   - The LAST `user` message becomes `prompt`.
 *   - Any messages BETWEEN the first system and the last user (history,
 *     mid-conversation back-and-forth) are prepended to the prompt as
 *     `[role]: content` lines, in order.
 *   - If there are no user messages at all (degenerate case), prompt
 *     falls back to an empty string — callers will get an empty response.
 */
function flattenMessages(messages: OpenRouterMessage[]): {
  system: string | undefined;
  prompt: string;
} {
  const systemParts: string[] = [];
  const others: OpenRouterMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else others.push(m);
  }

  // Find the index of the LAST user message. Everything before it goes
  // into the history-prefix; that message itself becomes the prompt.
  let lastUserIdx = -1;
  for (let i = others.length - 1; i >= 0; i--) {
    if (others[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  let prompt = '';
  if (lastUserIdx === -1) {
    // No user message — fall back to joining whatever non-system content
    // exists. Shouldn't happen in practice.
    prompt = others.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
  } else {
    const history = others.slice(0, lastUserIdx);
    const current = others[lastUserIdx].content;
    if (history.length > 0) {
      const historyBlock = history
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n');
      prompt = `${historyBlock}\n\n${current}`;
    } else {
      prompt = current;
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    prompt,
  };
}

/**
 * Strip common LLM JSON-leak patterns and return a slice that should
 * be safe to pass to JSON.parse. Handles:
 *   - leading/trailing whitespace
 *   - ```json ... ``` and ``` ... ``` code fences
 *   - prose preamble before the first `{` (returns from `{` to last `}`)
 *
 * Caller is still responsible for try/catching JSON.parse — this just
 * narrows the input.
 */
export function extractJsonObject(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  // If there's prose before the first `{`, slice from the first `{` to
  // the matching last `}`. Cheaper than a real bracket-balance walk and
  // works for the common "Sure! Here's the JSON: { ... }" leak.
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  return s;
}

/**
 * Non-streaming JSON call — routes through Cerebro's `/v1/llm/invoke`.
 * Returns the trimmed text from `output` (or `text` as fallback). Throws
 * on non-2xx with the Cerebro body slice for diagnostics.
 *
 * The function name is `callOpenRouter` for caller compat — the request
 * goes to Cerebro, which then talks to OpenRouter on our behalf.
 */
export async function callOpenRouter(args: CallArgs): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combineSignals(args.signal, timeoutMs);

  const { system, prompt } = flattenMessages(args.messages);

  const body: Record<string, unknown> = {
    model: args.model,
    prompt,
  };
  if (system) body.system = system;
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
  const tenantId = args.tenant ?? 'shift';
  body.tenant = tenantId;
  if (args.trace_label) body.trace_label = args.trace_label;

  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${SWARM_API_URL}/v1/llm/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (fetchErr) {
    // Network / abort / timeout. Log telemetry then re-throw.
    const err = fetchErr as Error;
    const isTimeout = err?.message === 'cerebro_timeout' || err?.name === 'AbortError';
    logAiCall({
      call_id: null,
      user_id: args.userId ?? null,
      workspace_id: args.workspaceId ?? null,
      tenant_id: tenantId,
      trace_label: args.trace_label ?? null,
      model: args.model,
      usage: null,
      latency_ms: Date.now() - t0,
      status: isTimeout ? 'timeout' : 'error',
      error_message: err?.message?.slice(0, 500) ?? 'fetch_failed',
    });
    throw fetchErr;
  }

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    logAiCall({
      call_id: null,
      user_id: args.userId ?? null,
      workspace_id: args.workspaceId ?? null,
      tenant_id: tenantId,
      trace_label: args.trace_label ?? null,
      model: args.model,
      usage: null,
      latency_ms: Date.now() - t0,
      status: 'error',
      error_code: String(upstream.status),
      error_message: errBody.slice(0, 500),
    });
    // Keep the `openrouter_<status>` prefix shape — callers in
    // workspace.ts switch on it for status mapping (401/402/429/etc).
    throw new Error(`openrouter_${upstream.status}: ${errBody.slice(0, 300)}`);
  }

  const json = (await upstream.json()) as InvokeResponse;
  const latencyMs = Date.now() - t0;

  logAiCall({
    call_id: json.call_id ?? null,
    user_id: args.userId ?? null,
    workspace_id: args.workspaceId ?? null,
    tenant_id: tenantId,
    trace_label: args.trace_label ?? null,
    // Prefer the model echoed by Cerebro (confirms what was actually used)
    // — falls back to the request model if absent.
    model: json.model ?? args.model,
    usage: json.usage ?? null,
    latency_ms: latencyMs,
    status: 'ok',
  });

  return ((json?.output ?? json?.text) ?? '').trim();
}
