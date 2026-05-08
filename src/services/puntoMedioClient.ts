/**
 * Punto Medio client — READ side of the Cerebro flywheel for Studio.
 *
 * Architecture invariant (DO NOT VIOLATE):
 *   Studio's chat path BYPASSES Cerebro — it calls OpenRouter directly.
 *   Cerebro is only used for two flows:
 *     1. Peaje ingest (write, fire-and-forget)  → see peajeClient.ts
 *     2. Punto Medio rag retrieval (read)       → THIS FILE
 *   These two clients are the ONLY surface between Studio BFF and Cerebro
 *   for the Workspace pathway. Do not add a third call site here.
 *
 * What this does: pulls APPROVED-only dynamic_rag from
 * `${SWARM_API_URL}/punto-medio/rag/{tenantId}` and lets the BFF inject the
 * `combined_rag` string into the system prompt of AI primitives
 * (transform / architect / turn). The Cerebro endpoint filters by
 * `approval_status = 'approved'`, so until an operator approves a
 * consolidated insight in /admin/punto-medio it never enters the RAG.
 * That manual review gate guarantees zero blind insights affecting
 * Workspace responses pre-demo.
 *
 * Caching: in-process LRU with 60-second TTL on success and 15-second
 * negative TTL on failure. The consolidation cron in Cerebro runs every
 * 6h, so 60s of staleness is invisible to the user but cuts the per-turn
 * latency of the Cerebro hop. `invalidateRagCache()` is exported so the
 * admin route (when ported in T6+) can clear the cache after approval.
 *
 * Failure mode: Cerebro down / timeout → returns null. Caller falls
 * through to the un-enriched LLM path. Never throws into the chat flow.
 *
 * Source: ported from CL2 (apps/api/src/services/puntoMedioClient.ts) —
 * proven in production for ~6 weeks. Adaptations for Studio:
 *   - SWARM_API_URL env (not CEREBRO_BASE_URL) to match server.ts
 *   - inline withTimeout helper (no external resilience.ts dep)
 *   - inline PuntoMedioRag type (no @shift-cl2/shared-types dep)
 *   - admin-only review queue helpers (listPendingReviews, reviewItem)
 *     omitted — Studio has no /admin/punto-medio yet; add when needed.
 */

const SWARM_API_URL = process.env.SWARM_API_URL ?? 'http://localhost:8000';
const PM_TIMEOUT_MS = 4_000;
const RAG_CACHE_TTL_MS = 60_000;
const RAG_NEGATIVE_TTL_MS = 15_000;

// ─── Inline types (no @shift-cl2/shared-types dep) ────────────────────

export interface PuntoMedioRag {
  tenant_id: string;
  global_rag_length: number;
  tenant_rag_length: number;
  patterns_rag_length: number;
  combined_rag_length: number;
  global_rag: string;
  tenant_rag: string;
  patterns_rag: string;
  /** combined_rag = global + tenant + patterns concatenated. The single
   *  string we want to drop into the LLM system prompt. */
  combined_rag?: string;
}

interface RagCacheEntry {
  rag: PuntoMedioRag | null;
  expiresAt: number;
}

// ─── Inline timeout helper (no ./resilience.js dep) ───────────────────

/**
 * Run an async fn with an AbortSignal-driven timeout. Throws on timeout
 * with a stable message ("punto-medio:rag timed out after 4000ms") so
 * upstream logs are greppable. Mirrors the behaviour of CL2's
 * resilience.withTimeout to keep the port a true 1:1.
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

// ─── Cache ────────────────────────────────────────────────────────────

const ragCache = new Map<string, RagCacheEntry>();

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Fetch the approved-only RAG bundle for a tenant. Returns null when the
 * Cerebro backend is unreachable, has no approved data, or times out —
 * callers should fall through gracefully (LLM still answers, just
 * without the flywheel-enriched context).
 */
export async function getApprovedRag(tenantId: string): Promise<PuntoMedioRag | null> {
  const now = Date.now();
  const cached = ragCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.rag;

  try {
    const rag = await withTimeout(
      async (signal) => {
        const res = await fetch(
          `${SWARM_API_URL}/punto-medio/rag/${encodeURIComponent(tenantId)}`,
          { signal },
        );
        if (!res.ok) throw new Error(`punto-medio rag ${res.status}`);
        return (await res.json()) as PuntoMedioRag;
      },
      { ms: PM_TIMEOUT_MS, label: 'punto-medio:rag' },
    );
    // Best-effort combined_rag if backend doesn't ship it (older Cerebro).
    if (!rag.combined_rag) {
      rag.combined_rag = [rag.global_rag, rag.tenant_rag, rag.patterns_rag]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n');
    }
    ragCache.set(tenantId, { rag, expiresAt: now + RAG_CACHE_TTL_MS });
    return rag;
  } catch (err) {
    // Negative cache: shorter TTL so we recover quickly when Cerebro's back.
    ragCache.set(tenantId, { rag: null, expiresAt: now + RAG_NEGATIVE_TTL_MS });
    console.warn(
      `[punto-medio] rag fetch failed (${(err as Error).message}) — proceeding without enrichment`,
    );
    return null;
  }
}

/**
 * Force-clear the in-process RAG cache. Useful from an admin UI after
 * bulk-approving so the next user turn sees the new corpus right away.
 */
export function invalidateRagCache(): void {
  ragCache.clear();
}
