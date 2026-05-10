/**
 * @file graphExecutionApi.ts
 * @description SSE client for the Cerebro v1 graph-execution endpoints.
 *
 * Talks to three endpoints on the Cerebro gateway (Python team is shipping
 * them in parallel — contract pinned in the implementer prompt, mirrored
 * here so the diff is reviewable in isolation):
 *
 *   1. POST  /v1/graph/execute            → `{execution_id, status, sse_url}`
 *   2. GET   /v1/graph/execute/:id/events → SSE stream of node lifecycle
 *   3. POST  /v1/graph/execute/:id/cancel → aborts in-flight execution
 *
 * The SSE stream emits five event types:
 *
 *   - `node:start`    {node_id, started_at}
 *   - `node:token`    {node_id, delta}            (optional, token stream)
 *   - `node:complete` {node_id, output, tokens, cost_usd}
 *   - `node:error`    {node_id, error}
 *   - `graph:done`    {sections, total_cost_usd, total_tokens}
 *
 * The colons in event names are kept verbatim — they're what the server
 * writes to the `event:` SSE field, and EventSource dispatches a
 * synthetic event with that exact name. We listen for each via
 * `addEventListener('node:start', ...)`.
 *
 * ─── MOCK MODE ────────────────────────────────────────────────────────
 * When `VITE_MOCK_GRAPH_EXEC === 'true'`, every call is short-circuited
 * to an in-process simulator that fires the same handlers from setTimeout
 * timers. This keeps the UX verifiable while the Cerebro endpoints are
 * still being built, and lets QA/E2E tests run without a live backend.
 * The mock is intentionally simple: every `specialist` node emits start →
 * (jittered 500-1500ms) → complete, then a single `graph:done` lands with
 * one section per completed specialist. `cancelExecution` clears pending
 * timers.
 *
 * Auth follows the existing Studio pattern (supabase JWT in `Authorization:
 * Bearer`, tenant in `x-tenant-id`). Tokens are read fresh per call —
 * Supabase rotates them mid-session and stale tokens silently 401.
 */
import { supabase } from './supabaseClient';
import type { BranchSection } from '../types/export';

// ─── Types (wire contract) ────────────────────────────────────────────

export interface GraphExecutionNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GraphExecutionEdge {
  id?: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

export interface StartExecutionResponse {
  executionId: string;
  sseUrl: string;
}

export interface NodeStartPayload {
  node_id: string;
  started_at?: string | number;
}

export interface NodeTokenPayload {
  node_id: string;
  delta: string;
}

export interface NodeCompletePayload {
  node_id: string;
  output: string;
  tokens?: number;
  cost_usd?: number;
}

export interface NodeErrorPayload {
  node_id: string;
  error: string;
}

export interface GraphDoneSection {
  title: string;
  content: string;
  /** Snake-case on the wire; we surface it to callers unchanged so they can
   * map it onto `BranchSection.sourceNodeId` (camelCase) themselves. */
  source_node_id?: string;
}

export interface GraphDonePayload {
  sections: GraphDoneSection[];
  total_cost_usd?: number;
  total_tokens?: number;
}

export interface ExecutionHandlers {
  onNodeStart: (e: NodeStartPayload) => void;
  /** Optional: token-level streaming. Not all backends emit it. */
  onNodeToken?: (e: NodeTokenPayload) => void;
  onNodeComplete: (e: NodeCompletePayload) => void;
  onNodeError: (e: NodeErrorPayload) => void;
  onGraphDone: (e: GraphDonePayload) => void;
  /** Connection/network failure on the SSE channel itself (not a node error). */
  onConnectionError?: (err: Error) => void;
}

// ─── Config ───────────────────────────────────────────────────────────

const DEFAULT_TENANT =
  (import.meta.env.VITE_CEREBRO_TENANT as string | undefined) || 'shift';

const MOCK_MODE = import.meta.env.VITE_MOCK_GRAPH_EXEC === 'true';

const APP_ID = 'studio';

function getGatewayBaseUrl(): string {
  const raw = (import.meta.env.VITE_GATEWAY_URL as string | undefined) || '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

async function getAuthToken(): Promise<string | undefined> {
  if (!supabase) return undefined;
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token;
  } catch {
    return undefined;
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Kick off a graph execution. Returns the assigned `executionId` and the
 * SSE URL the caller passes back to `subscribeToExecution`.
 *
 * The server returns `sse_url` as either an absolute URL or a path
 * relative to the gateway root; we normalize to a fully-qualified URL
 * here so callers don't have to know about the gateway base.
 */
export async function startExecution(
  workspaceId: string | null,
  nodes: GraphExecutionNode[],
  edges: GraphExecutionEdge[],
  traceLabel?: string,
): Promise<StartExecutionResponse> {
  if (MOCK_MODE) {
    return mockStartExecution(workspaceId, nodes, edges, traceLabel);
  }

  const token = await getAuthToken();
  const base = getGatewayBaseUrl();
  const url = `${base}/v1/graph/execute`;

  const body = {
    app_id: APP_ID,
    workspace_id: workspaceId,
    nodes,
    edges,
    trace_label: traceLabel,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': DEFAULT_TENANT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(
      `startExecution failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
    );
  }

  const json = (await res.json()) as {
    execution_id?: string;
    executionId?: string;
    sse_url?: string;
    sseUrl?: string;
    status?: string;
  };

  const executionId = json.execution_id ?? json.executionId;
  const sseUrlRaw = json.sse_url ?? json.sseUrl;
  if (!executionId || !sseUrlRaw) {
    throw new Error(
      'startExecution: invalid response — missing execution_id or sse_url',
    );
  }

  // Normalize relative paths to the gateway origin so EventSource gets
  // an absolute URL regardless of how the backend phrased the field.
  const sseUrl = /^https?:\/\//i.test(sseUrlRaw)
    ? sseUrlRaw
    : `${base}${sseUrlRaw.startsWith('/') ? '' : '/'}${sseUrlRaw}`;

  return { executionId, sseUrl };
}

/**
 * Subscribe to the SSE stream for an in-flight execution. Returns a
 * cleanup function — the caller MUST invoke it on unmount or when the
 * execution is no longer needed (cancel, error, graph:done) to close
 * the underlying EventSource and free the HTTP connection.
 *
 * Idempotent on cleanup. Calling the returned function twice is safe.
 *
 * Note on auth: native browser EventSource does NOT support custom
 * headers, so JWT can't ride the Authorization header here. The
 * Cerebro server reads the auth cookie or accepts the token via query
 * string. We pass it as `?token=` if available; the server is expected
 * to validate it the same way it validates Authorization on POST.
 *
 * In MOCK mode the EventSource is never opened — we fake the events
 * with setTimeout instead.
 */
export function subscribeToExecution(
  executionId: string,
  sseUrl: string,
  handlers: ExecutionHandlers,
): () => void {
  if (MOCK_MODE) {
    return mockSubscribeToExecution(executionId, handlers);
  }

  let es: EventSource | null = null;
  let closed = false;

  void (async () => {
    if (closed) return;

    // Append the JWT as a query param when present. EventSource can't
    // send custom headers and the Cerebro gateway expects auth on the
    // SSE channel too. The server is the only thing that sees the URL.
    let url = sseUrl;
    try {
      const token = await getAuthToken();
      if (token) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(token)}`;
      }
    } catch {
      // Best effort — proceed without auth. Server will 401 if required.
    }

    if (closed) return;

    try {
      es = new EventSource(url, { withCredentials: true });
    } catch (err) {
      handlers.onConnectionError?.(err as Error);
      return;
    }

    const handleParsed = <T>(
      ev: MessageEvent,
      fn: ((p: T) => void) | undefined,
    ): void => {
      if (!fn) return;
      try {
        const parsed = JSON.parse(ev.data) as T;
        fn(parsed);
      } catch (err) {
        // Surface parse failures so callers see a real error vs a
        // silently-dropped event. They map to a connection error
        // because the stream is unusable from here.
        handlers.onConnectionError?.(
          new Error(
            `Failed to parse SSE event payload: ${(err as Error).message}`,
          ),
        );
      }
    };

    es.addEventListener('node:start', (ev) =>
      handleParsed<NodeStartPayload>(ev as MessageEvent, handlers.onNodeStart),
    );
    es.addEventListener('node:token', (ev) =>
      handleParsed<NodeTokenPayload>(ev as MessageEvent, handlers.onNodeToken),
    );
    es.addEventListener('node:complete', (ev) =>
      handleParsed<NodeCompletePayload>(
        ev as MessageEvent,
        handlers.onNodeComplete,
      ),
    );
    es.addEventListener('node:error', (ev) =>
      handleParsed<NodeErrorPayload>(ev as MessageEvent, handlers.onNodeError),
    );
    es.addEventListener('graph:done', (ev) => {
      handleParsed<GraphDonePayload>(ev as MessageEvent, handlers.onGraphDone);
      // graph:done is the terminal event — close the stream so the
      // server's keepalive comments don't keep the connection open.
      try {
        es?.close();
      } catch {
        /* noop */
      }
    });

    es.onerror = () => {
      // EventSource fires onerror for both transient network blips
      // (which it auto-recovers from) and terminal failures. We treat
      // it as terminal only when the readyState is CLOSED, otherwise
      // the browser will retry on its own.
      if (es && es.readyState === EventSource.CLOSED) {
        handlers.onConnectionError?.(
          new Error('SSE connection closed unexpectedly'),
        );
      }
    };
  })();

  return () => {
    if (closed) return;
    closed = true;
    if (es) {
      try {
        es.close();
      } catch {
        /* noop */
      }
      es = null;
    }
  };
}

/**
 * Cancel an in-flight graph execution. The backend tears down any
 * running node tasks and the SSE stream emits a terminal `node:error`
 * for each. Safe to call after the execution already finished — the
 * server returns 404, which we swallow.
 *
 * MOCK mode clears all pending simulated event timers.
 */
export async function cancelExecution(executionId: string): Promise<void> {
  if (MOCK_MODE) {
    mockCancelExecution(executionId);
    return;
  }

  const token = await getAuthToken();
  const base = getGatewayBaseUrl();
  const url = `${base}/v1/graph/execute/${encodeURIComponent(executionId)}/cancel`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-tenant-id': DEFAULT_TENANT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok && res.status !== 404) {
      const detail = await safeReadError(res);
      throw new Error(
        `cancelExecution failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      );
    }
  } catch (err) {
    // Cancellation is best-effort — log but don't propagate. The local
    // store will still mark isExecuting=false and clean up the SSE.
    console.warn('[cancelExecution] non-fatal:', (err as Error).message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function safeReadError(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const body = JSON.parse(text) as {
        error?: string;
        detail?: string;
        message?: string;
      };
      return body.detail ?? body.error ?? body.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/**
 * Convert wire-format `graph:done` sections to Studio's internal
 * `BranchSection` shape (camelCase). Exported so the store can call it
 * directly when graph:done lands.
 */
export function toBranchSections(
  sections: GraphDoneSection[],
): BranchSection[] {
  return sections.map((s) => ({
    title: s.title,
    content: s.content,
    ...(s.source_node_id ? { sourceNodeId: s.source_node_id } : {}),
  }));
}

// ─── Mock backend ─────────────────────────────────────────────────────
// In-process simulator used when VITE_MOCK_GRAPH_EXEC=true. Keeps a
// map of execution id → pending timers so cancelExecution can clear
// them. Module-scoped state is fine because the mock is a dev toggle —
// in production this code never runs (MOCK_MODE is checked first).

interface MockExecutionState {
  timers: ReturnType<typeof setTimeout>[];
  /** Used by mockSubscribe to drive node events from the original payload. */
  nodes: GraphExecutionNode[];
}

const mockExecutions = new Map<string, MockExecutionState>();

function mockStartExecution(
  _workspaceId: string | null,
  nodes: GraphExecutionNode[],
  _edges: GraphExecutionEdge[],
  _traceLabel?: string,
): Promise<StartExecutionResponse> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const executionId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mockExecutions.set(executionId, { timers: [], nodes });
      resolve({ executionId, sseUrl: `mock://graph-execute/${executionId}` });
    }, 100);
  });
}

function mockSubscribeToExecution(
  executionId: string,
  handlers: ExecutionHandlers,
): () => void {
  const state = mockExecutions.get(executionId);
  if (!state) {
    // Unknown execution — emit a connection error and bail.
    setTimeout(() => {
      handlers.onConnectionError?.(
        new Error(`[mock] unknown execution: ${executionId}`),
      );
    }, 0);
    return () => undefined;
  }

  const specialists = state.nodes.filter(
    (n) => (n.type ?? 'specialist') === 'specialist',
  );

  // Track which nodes completed so graph:done can synthesize sections.
  const completedOutputs: NodeCompletePayload[] = [];

  // Stagger node starts: each specialist starts ~150ms after the
  // previous one, then completes after a per-node delay between 500 and
  // 1500ms. That gives the UI a realistic flow even with one node.
  let cursorMs = 50;
  specialists.forEach((node, idx) => {
    const startAt = cursorMs;
    const duration = 500 + Math.floor(Math.random() * 1000);
    cursorMs += 150;

    const startTimer = setTimeout(() => {
      handlers.onNodeStart({
        node_id: node.id,
        started_at: Date.now(),
      });
    }, startAt);
    state.timers.push(startTimer);

    const completeTimer = setTimeout(
      () => {
        const label = readNodeLabel(node) || node.id;
        const payload: NodeCompletePayload = {
          node_id: node.id,
          output: `Mock output for ${label}`,
          tokens: 100,
          cost_usd: 0.001,
        };
        completedOutputs.push(payload);
        handlers.onNodeComplete(payload);

        // When this was the last specialist, fire graph:done on the
        // next tick so the consumer sees node:complete first.
        if (idx === specialists.length - 1) {
          const doneTimer = setTimeout(() => {
            const sections: GraphDoneSection[] = completedOutputs.map((c) => {
              const node2 = state.nodes.find((n) => n.id === c.node_id);
              const label = node2 ? readNodeLabel(node2) || node2.id : c.node_id;
              return {
                title: label,
                content: c.output,
                source_node_id: c.node_id,
              };
            });
            const totalCost = completedOutputs.reduce(
              (sum, c) => sum + (c.cost_usd ?? 0),
              0,
            );
            const totalTokens = completedOutputs.reduce(
              (sum, c) => sum + (c.tokens ?? 0),
              0,
            );
            handlers.onGraphDone({
              sections,
              total_cost_usd: Number(totalCost.toFixed(6)),
              total_tokens: totalTokens,
            });
            // Mock execution is now complete; free the state.
            mockExecutions.delete(executionId);
          }, 50);
          state.timers.push(doneTimer);
        }
      },
      startAt + duration,
    );
    state.timers.push(completeTimer);
  });

  // If there were no specialist nodes, fire graph:done immediately so
  // the UI doesn't hang.
  if (specialists.length === 0) {
    const doneTimer = setTimeout(() => {
      handlers.onGraphDone({
        sections: [],
        total_cost_usd: 0,
        total_tokens: 0,
      });
      mockExecutions.delete(executionId);
    }, 50);
    state.timers.push(doneTimer);
  }

  return () => {
    mockCancelExecution(executionId);
  };
}

function mockCancelExecution(executionId: string): void {
  const state = mockExecutions.get(executionId);
  if (!state) return;
  for (const t of state.timers) clearTimeout(t);
  mockExecutions.delete(executionId);
}

function readNodeLabel(node: GraphExecutionNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data.label === 'string' && data.label.trim()) return data.label;
  if (typeof data.title === 'string' && data.title.trim()) return data.title;
  if (typeof data.agent === 'string' && data.agent.trim()) return data.agent;
  return '';
}

/** True when the mock backend is active. Exported for diagnostics/UI badges. */
export function isMockGraphExecMode(): boolean {
  return MOCK_MODE;
}
