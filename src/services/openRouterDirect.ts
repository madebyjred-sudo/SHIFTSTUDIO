/**
 * @file services/openRouterDirect.ts
 * @description Minimal OpenRouter client for Studio's Workspace AI primitives.
 *
 * Architecture invariant (DO NOT VIOLATE):
 *   Studio's Workspace chat / transform / architect / edit paths BYPASS
 *   Cerebro and call OpenRouter directly. Cerebro is only used for the
 *   peaje ingest fire-and-forget (write) and Punto Medio rag retrieval
 *   (read). See peajeClient.ts and puntoMedioClient.ts for those.
 *
 * Why this is a 80-line shim and NOT a port of CL2's openRouterClient.ts
 * (1188 lines): CL2's client drags in agent personas, the SIL/reglamento
 * tool kit, the pass1/pass2 tool-loop, and an agent registry. Studio has
 * none of that — for the demo we just need:
 *   - streamOpenRouter:   SSE token stream for /turn intent=chat
 *   - callOpenRouter:     JSON one-shot for transform / architect / edit
 *
 * Both pull OPENROUTER_API_KEY from env. They do NOT throw into the
 * caller's response stream — the caller decides whether a non-2xx
 * upstream error becomes a 502 envelope or an inline error token.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallArgs {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Optional. JSON-mode for architect / classifier. */
  response_format?: { type: 'json_object' | 'text' };
  /** Optional caller-controlled abort (e.g. request closed). Combines
   *  with the timeoutMs default via AbortSignal.any. */
  signal?: AbortSignal;
  /** Override default 30s timeout. */
  timeoutMs?: number;
}

export interface StreamArgs extends CallArgs {
  /** Called once per delta.content token. The caller assembles the full
   *  string itself (we don't buffer) so the chat handler can fire peaje
   *  with the assembled text after the stream completes. */
  onChunk: (text: string) => void;
}

const HEADERS = {
  'Content-Type': 'application/json',
  // OpenRouter dashboard tags traffic by these so Shift can split usage
  // by product. Keep 'Shifty Studio' stable here.
  'HTTP-Referer': 'https://shiftstudio.shiftpn.com',
  'X-Title': 'Shifty Studio',
};

function authHeaders(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('openrouter_not_configured');
  return { ...HEADERS, Authorization: `Bearer ${key}` };
}

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  // AbortSignal.any is widely supported in Node ≥20.3. We avoid it for
  // older runtimes by manual fan-in.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('openrouter_timeout')), timeoutMs);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  }
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/**
 * Non-streaming JSON call. Returns the trimmed text from
 * `choices[0].message.content`. Throws on non-2xx with the OpenRouter
 * body slice for diagnostics.
 */
export async function callOpenRouter(args: CallArgs): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combineSignals(args.signal, timeoutMs);

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
  if (args.response_format) body.response_format = args.response_format;

  const upstream = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    throw new Error(`openrouter_${upstream.status}: ${errBody.slice(0, 300)}`);
  }

  const json = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json?.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Streaming SSE call. Forwards `delta.content` deltas to onChunk.
 * Returns when the upstream stream ends (or [DONE] sentinel arrives).
 *
 * The caller is responsible for the *outer* SSE response — this function
 * only consumes OpenRouter's stream and re-emits the token text. The
 * Workspace /turn handler wraps each chunk into its own
 * `{type:'token', payload}` envelope to match the CL2 frontend parser.
 */
export async function streamOpenRouter(args: StreamArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combineSignals(args.signal, timeoutMs);

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
  if (args.response_format) body.response_format = args.response_format;

  const upstream = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    const errBody = await upstream.text().catch(() => '');
    throw new Error(`openrouter_${upstream.status}: ${errBody.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // OpenRouter's SSE: lines prefixed with `data: `, terminated with the
  // sentinel `data: [DONE]`. Empty lines separate events. We split on
  // \n and process each prefix line individually — never assume the
  // chunk boundaries align with line boundaries.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;
      try {
        const evt = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const text = evt?.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          args.onChunk(text);
        }
      } catch {
        // OpenRouter occasionally sends keep-alive comments / partial
        // lines. Skip silently — the next iteration will catch up.
      }
    }
  }
}
