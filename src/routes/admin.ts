/**
 * @file routes/admin.ts
 * @description Admin endpoints — operator-only views over Studio's
 * cost telemetry (`studio_ai_call_log`).
 *
 * MOUNTED AT: /api/admin
 *   - server.ts: app.use('/api/admin', adminRouter)
 *   - api/admin/[[...path]].ts: Vercel serverless delegate
 *
 * AUTHORIZATION
 * -------------
 * Two layers:
 *   1. requireUser — must be a valid Supabase session (no anon, no
 *      x-user-id bypass in production).
 *   2. ADMIN_USER_IDS env-var allowlist — comma-separated UUIDs. Any
 *      authenticated user NOT in this list gets 403. The env var being
 *      empty/unset means "no admins exist on this deploy", which is the
 *      safe default — admins must be explicitly enrolled.
 *
 * Notes
 *   - Service-role Supabase client (bypasses RLS). The admin layer is the
 *     authorization boundary; never expose this router without the gate.
 *   - All aggregations are read-only — no mutations live here.
 */
import { Router, type Request, type Response } from 'express';
import { supabaseAdmin } from '../services/supabaseAdminClient.js';
import { getUserIdFromRequest } from '../services/auth.js';
import { logger, type Logger } from '../lib/logger.js';

export const adminRouter = Router();

// ─── Helpers (mirrors workspace.ts patterns) ───────────────────────

function dbReady(res: Response): boolean {
  if (!supabaseAdmin) {
    res.status(503).json({
      ok: false,
      error: 'database_unavailable',
      hint: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars not set.',
    });
    return false;
  }
  return true;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

function reqLog(req: Request): Logger {
  return req.log ?? logger;
}

/**
 * Parse ADMIN_USER_IDS env var into a Set of UUIDs. Lazily computed once
 * per process — env vars don't change after boot. Empty/unset means
 * "no admins" (fail-closed default).
 */
let _adminSet: Set<string> | null = null;
function getAdminSet(): Set<string> {
  if (_adminSet) return _adminSet;
  const raw = process.env.ADMIN_USER_IDS ?? '';
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  _adminSet = new Set(ids);
  return _adminSet;
}

async function requireAdmin(req: Request, res: Response): Promise<string | null> {
  const userId = await requireUser(req, res);
  if (!userId) return null;
  const admins = getAdminSet();
  if (admins.size === 0) {
    reqLog(req).warn('admin.allowlist.empty', {
      hint: 'ADMIN_USER_IDS env var is unset or empty — no admins exist.',
    });
    res.status(403).json({ ok: false, error: 'forbidden' });
    return null;
  }
  if (!admins.has(userId.toLowerCase())) {
    reqLog(req).warn('admin.access_denied', { user_id: userId });
    res.status(403).json({ ok: false, error: 'forbidden' });
    return null;
  }
  return userId;
}

/** Coerce ?days= query into a sane integer in [1, 365]. */
function parseDaysWindow(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(365, Math.max(1, n));
}

// ═══════════════════════════════════════════════════════════════════════
// USAGE SUMMARY
// ═══════════════════════════════════════════════════════════════════════
//
// GET /api/admin/usage/summary?days=30
//
// Aggregates studio_ai_call_log over the last `days` days into four
// breakdowns:
//   - perUser       (user_id × calls × cost × tokens × last_call_at)
//   - perWorkspace  (workspace_id × calls × cost)
//   - perTrace      (trace_label × calls × cost)
//   - daily         (date × cost × calls)
//
// Returns successful + errored calls (status='ok' is implicit; the few
// rows with status='error'/'timeout' have no usage cost so they don't
// distort the totals).

interface CallLogRow {
  user_id: string | null;
  workspace_id: string | null;
  trace_label: string | null;
  cost_usd_total: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

adminRouter.get('/usage/summary', async (req: Request, res: Response) => {
  if (!dbReady(res)) return;
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const days = parseDaysWindow(req.query.days);
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // We page through rows manually because Supabase's PostgREST aggregator
    // is limited (no GROUP BY surface in the JS client). For Studio's
    // current scale (a few thousand calls/month per workspace) one read
    // is fine; if this grows we'll move to a SECURITY DEFINER SQL function.
    const { data: rows, error } = await supabaseAdmin!
      .from('studio_ai_call_log')
      .select(
        'user_id, workspace_id, trace_label, cost_usd_total, input_tokens, output_tokens, created_at',
      )
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(50_000);

    if (error) throw new Error(error.message);

    const allRows: CallLogRow[] = (rows ?? []) as CallLogRow[];

    // ─── Per-user aggregation ────────────────────────────────────────
    const perUserMap = new Map<
      string,
      {
        user_id: string;
        calls: number;
        cost_usd_total: number;
        input_tokens: number;
        output_tokens: number;
        last_call_at: string | null;
      }
    >();
    for (const r of allRows) {
      if (!r.user_id) continue;
      const cur =
        perUserMap.get(r.user_id) ??
        {
          user_id: r.user_id,
          calls: 0,
          cost_usd_total: 0,
          input_tokens: 0,
          output_tokens: 0,
          last_call_at: null as string | null,
        };
      cur.calls += 1;
      cur.cost_usd_total += Number(r.cost_usd_total ?? 0);
      cur.input_tokens += Number(r.input_tokens ?? 0);
      cur.output_tokens += Number(r.output_tokens ?? 0);
      if (!cur.last_call_at || r.created_at > cur.last_call_at) {
        cur.last_call_at = r.created_at;
      }
      perUserMap.set(r.user_id, cur);
    }
    const perUser = Array.from(perUserMap.values())
      .sort((a, b) => b.cost_usd_total - a.cost_usd_total)
      .slice(0, 100);

    // ─── Per-workspace aggregation ───────────────────────────────────
    const perWsMap = new Map<
      string,
      { workspace_id: string; calls: number; cost_usd_total: number }
    >();
    for (const r of allRows) {
      if (!r.workspace_id) continue;
      const cur =
        perWsMap.get(r.workspace_id) ??
        { workspace_id: r.workspace_id, calls: 0, cost_usd_total: 0 };
      cur.calls += 1;
      cur.cost_usd_total += Number(r.cost_usd_total ?? 0);
      perWsMap.set(r.workspace_id, cur);
    }
    const perWorkspace = Array.from(perWsMap.values())
      .sort((a, b) => b.cost_usd_total - a.cost_usd_total)
      .slice(0, 100);

    // ─── Per-trace aggregation ───────────────────────────────────────
    const perTraceMap = new Map<
      string,
      { trace_label: string; calls: number; cost_usd_total: number }
    >();
    for (const r of allRows) {
      const label = r.trace_label ?? '(none)';
      const cur =
        perTraceMap.get(label) ??
        { trace_label: label, calls: 0, cost_usd_total: 0 };
      cur.calls += 1;
      cur.cost_usd_total += Number(r.cost_usd_total ?? 0);
      perTraceMap.set(label, cur);
    }
    const perTrace = Array.from(perTraceMap.values()).sort(
      (a, b) => b.cost_usd_total - a.cost_usd_total,
    );

    // ─── Daily aggregation (UTC date keys) ───────────────────────────
    // Pre-seed every date in the window so the chart shows zero-cost
    // days as gaps-with-data rather than skipping them — easier to read.
    const dailyMap = new Map<string, { date: string; cost_usd_total: number; calls: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, cost_usd_total: 0, calls: 0 });
    }
    for (const r of allRows) {
      const key = r.created_at.slice(0, 10);
      const cur = dailyMap.get(key) ?? { date: key, cost_usd_total: 0, calls: 0 };
      cur.calls += 1;
      cur.cost_usd_total += Number(r.cost_usd_total ?? 0);
      dailyMap.set(key, cur);
    }
    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      ok: true,
      windowDays: days,
      perUser,
      perWorkspace,
      perTrace,
      daily,
    });
  } catch (err) {
    reqLog(req).error('admin.usage_summary.failed', { message: (err as Error).message });
    res.status(500).json({ ok: false, error: 'usage_summary_failed' });
  }
});
