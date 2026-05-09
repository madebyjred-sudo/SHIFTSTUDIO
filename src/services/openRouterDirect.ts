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
 */

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
  body.tenant = args.tenant ?? 'shift';
  if (args.trace_label) body.trace_label = args.trace_label;

  const upstream = await fetch(`${SWARM_API_URL}/v1/llm/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    // Keep the `openrouter_<status>` prefix shape — callers in
    // workspace.ts switch on it for status mapping (401/402/429/etc).
    throw new Error(`openrouter_${upstream.status}: ${errBody.slice(0, 300)}`);
  }

  const json = (await upstream.json()) as {
    output?: string;
    text?: string;
  };
  return ((json?.output ?? json?.text) ?? '').trim();
}
