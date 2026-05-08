/**
 * Peaje client — WRITE side of the Cerebro flywheel for Studio.
 *
 * Architecture invariant (DO NOT VIOLATE):
 *   Studio's chat path BYPASSES Cerebro — it calls OpenRouter directly.
 *   Cerebro is only used for two flows:
 *     1. Peaje ingest (write, fire-and-forget)  → THIS FILE
 *     2. Punto Medio rag retrieval (read)       → see puntoMedioClient.ts
 *   These two clients are the ONLY surface between Studio BFF and Cerebro
 *   for the Workspace pathway. Do not add a third call site here.
 *
 * What this does: fire-and-forget POST to `${SWARM_API_URL}/peaje/ingest`
 * after every chat turn. Cerebro runs the conversation through the
 * LLM-based Pattern Extractor (Kimi K2.6 since 2026-04-25), strips PII
 * (Layer 2), categorizes into 4 macro buckets, and persists to
 * peaje_insights. From there the consolidation cron generates dynamic
 * RAG that flows back into system prompts via getApprovedRag(). That
 * round-trip — write here, read in puntoMedioClient — IS the flywheel.
 *
 * Multi-app v3: the body includes `app_id` (default 'studio') so the
 * insight lands in the Studio bucket of Punto Medio, peer to cl2 / eco /
 * sentinel. This matches the body shape Studio's existing inline ingest
 * in server.ts (~lines 146-173) already sends, so this client is a
 * drop-in replacement for that inline fetch in T4.
 *
 * Failure mode: NEVER blocks or fails the user-facing chat. The
 * flywheel is best-effort observability/intelligence, not a critical
 * path. If Peaje is down or slow, the user sees a normal completion and
 * we just lose ONE insight extraction (catch-all-and-warn-log).
 *
 * Deduplication: skips the POST entirely if the last user turn is
 * <20 chars AND the assistant response is <50 chars. Mirrors the
 * threshold inside Cerebro's process_auto_ingest (peaje/ingest.py) — no
 * point round-tripping single-emoji acks.
 *
 * Kill switch: PEAJE_ENABLED=false disables the hand-off without a
 * redeploy (e.g. during a Cerebro outage).
 *
 * Source: ported from CL2 (apps/api/src/services/peajeClient.ts) —
 * proven in production for ~6 weeks. Adaptations for Studio:
 *   - SWARM_API_URL env (not CEREBRO_BASE_URL) to match server.ts
 *   - app_id field added to body (multi-app v3)
 *   - message_id + upstream_model fields added so server.ts can fully
 *     replace its inline fetch with a single firePeajeIngest() call
 *   - inline withTimeout helper (no external resilience.ts dep)
 *   - inline types (no @shift-cl2/shared-types dep)
 */

const SWARM_API_URL = process.env.SWARM_API_URL ?? 'http://localhost:8000';
const CEREBRO_TENANT = process.env.CEREBRO_TENANT ?? 'shift';
const CEREBRO_APP_ID = process.env.CEREBRO_APP_ID ?? 'studio';
const PEAJE_TIMEOUT_MS = 8_000;
// Allow ops to disable the hand-off without a redeploy. Default: enabled.
const PEAJE_ENABLED = (process.env.PEAJE_ENABLED ?? 'true').toLowerCase() !== 'false';

// ─── Inline types (no @shift-cl2/shared-types dep) ────────────────────

export interface PeajeChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PeajeIngestArgs {
  /** Conversation id from Supabase. Used as sessionId on the Peaje side. */
  sessionId: string;
  agentId: string;
  /** All turns of the conversation up to (and not including) the assistant
   *  reply we just produced. Cerebro appends `response` to the synthetic
   *  conversation it builds. */
  messages: PeajeChatMessage[];
  /** The final assistant text we just streamed to the user. */
  response: string;
  /** Optional override; defaults to CEREBRO_TENANT env (default 'shift'). */
  tenantId?: string;
  /** Optional override; defaults to CEREBRO_APP_ID env (default 'studio').
   *  Multi-app v3 dimension — routes the insight to the right Punto
   *  Medio bucket. Studio = 'studio', CL2 = 'cl2', Sentinel = 'sentinel'. */
  app_id?: string;
  /** Studio-issued message id. Anchors the <cerebro-feedback> widget's
   *  likes back to the training_pair. server.ts already builds this as
   *  `studio-${tenantId}-${sessionId}-${Date.now()}` when not provided
   *  upstream — pass it through here so the body matches that contract. */
  message_id?: string;
  /** Model that effectively answered (e.g. "moonshotai/kimi-k2-thinking").
   *  Cerebro uses it to tag legal_status of the training_pair
   *  (kimi/llama=unrestricted). */
  upstream_model?: string;
}

// ─── Inline timeout helper (no ./resilience.js dep) ───────────────────

/**
 * Run an async fn with an AbortSignal-driven timeout. Throws on timeout
 * with a stable message ("peaje:ingest timed out after 8000ms") so
 * upstream logs are greppable. Mirrors CL2's resilience.withTimeout.
 */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { ms: number; label: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`${opts.label} timed out after ${opts.ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Fire-and-forget POST to /peaje/ingest. Returns a Promise that resolves
 * even on failure (after logging). The caller can `void` it without
 * awaiting; we still return a Promise so observability hooks (e.g. tests
 * or the void-IIFE in server.ts) can assert on completion.
 */
export async function firePeajeIngest(args: PeajeIngestArgs): Promise<void> {
  if (!PEAJE_ENABLED) return;

  // Bail early when the conversation isn't worth distilling — short pings,
  // single-emoji acks, etc. Mirrors the threshold inside Cerebro's
  // process_auto_ingest (peaje/ingest.py).
  const lastUser = [...args.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (lastUser.length < 20 && args.response.length < 50) return;

  const tenantId = args.tenantId ?? CEREBRO_TENANT;
  const appId = args.app_id ?? CEREBRO_APP_ID;

  const payload: Record<string, unknown> = {
    app_id: appId,
    tenantId,
    sessionId: args.sessionId,
    agentId: args.agentId,
    messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    response: args.response,
  };
  // Only include optional fields when actually provided so the body
  // shape matches server.ts's existing inline fetch when those fields
  // are present, and stays slim otherwise.
  if (args.message_id) payload.message_id = args.message_id;
  if (args.upstream_model) payload.upstream_model = args.upstream_model;

  try {
    await withTimeout(
      async (signal) => {
        const res = await fetch(`${SWARM_API_URL}/peaje/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
          },
          body: JSON.stringify(payload),
          signal,
        });
        if (!res.ok) {
          // Read but discard body — error logging happens in caller.
          await res.text().catch(() => '');
          throw new Error(`peaje ingest ${res.status}`);
        }
      },
      { ms: PEAJE_TIMEOUT_MS, label: 'peaje:ingest' },
    );
  } catch (err) {
    // Best-effort: log so we can spot Peaje outages in our own logs, but
    // never propagate — the user already got their chat reply.
    const code = (err as Error)?.message ?? 'unknown';
    console.warn(`[peaje] ingest failed (${code}) — flywheel skipped this turn`);
  }
}
