/**
 * AdminUsagePage — /admin/usage
 *
 * Operator dashboard summarizing studio_ai_call_log over a rolling
 * window (default 30d). Three sections:
 *   1. Daily cost line chart
 *   2. Per-user table sorted by spend desc
 *   3. Per-trace breakdown cards
 *
 * Auth: the page itself is just a React component; the real gate is the
 * server-side ADMIN_USER_IDS allowlist enforced by /api/admin/usage/summary.
 * Non-admin sessions get a friendly 403 message instead of data.
 *
 * Phase 3.B (Wave B). Mirrors WorkspacesListPage's chrome conventions
 * (TopDock + glassmorphic card) so navigating between /workspaces and
 * /admin/usage feels continuous.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Clock,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import { TopDock } from '@/components/top-dock';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/line-chart';
import { Badge } from '@/components/ui/badge';
import {
  getAdminUsageSummary,
  type AdminUsageSummary,
} from '@/services/workspaceApi';

// ─── Format helpers ──────────────────────────────────────────────────

const usd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });

const compactInt = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 0 });

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.floor(hours / 24)}d`;
}

function shortId(id: string): string {
  // Stable visual abbreviation — first 8 chars of a uuid plus a tail dot.
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

// ─── Chart config (single line) ──────────────────────────────────────

const chartConfig = {
  cost_usd_total: {
    label: 'Costo USD',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig;

// ─── Page ────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export default function AdminUsagePage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AdminUsageSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      const summary = await getAdminUsageSummary(windowDays);
      setData(summary);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      setError({
        status: typeof e.status === 'number' ? e.status : undefined,
        message: e.message ?? 'No se pudo cargar el uso',
      });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const totalCost = useMemo(
    () =>
      data?.daily.reduce((acc, d) => acc + Number(d.cost_usd_total ?? 0), 0) ?? 0,
    [data],
  );
  const totalCalls = useMemo(
    () => data?.daily.reduce((acc, d) => acc + d.calls, 0) ?? 0,
    [data],
  );

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f8f9fc] dark:bg-[#080d1a] text-[#0e1745] dark:text-white">
      <TopDock />

      <main
        className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 py-6 md:py-10 space-y-6"
        aria-busy={loading}
      >
        {/* Header */}
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2">
              <BarChart3 className="w-6 h-6 text-[#1534dc] dark:text-[#8b5cf6]" />
              Uso & costos
            </h1>
            <p className="text-sm text-[#0e1745]/65 dark:text-white/55 mt-1">
              Vista operativa sobre <code className="font-mono text-xs">studio_ai_call_log</code>.
              Agregados por usuario, workspace, traza y día.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label="Ventana temporal"
              className="inline-flex rounded-full border border-[#0e1745]/10 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur-xl p-1"
            >
              {WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  role="tab"
                  aria-selected={days === opt.days}
                  onClick={() => setDays(opt.days)}
                  className={
                    'px-3 py-1.5 text-xs font-semibold rounded-full transition-colors ' +
                    (days === opt.days
                      ? 'bg-[#1534dc] text-white dark:bg-[#8b5cf6]'
                      : 'text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white')
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load(days)}
              disabled={loading}
              title="Recargar"
              aria-label="Recargar"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/80 dark:bg-white/10 backdrop-blur-xl border border-[#0e1745]/10 dark:border-white/15 text-[#0e1745]/75 dark:text-white/75 hover:text-[#0e1745] dark:hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Recargar
            </button>
          </div>
        </header>

        {/* Error state */}
        {error && (
          <Card className="border-red-300/60 dark:border-red-500/30 bg-red-50/70 dark:bg-red-500/10">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-red-700 dark:text-red-300">
                  {error.status === 403
                    ? 'No tienes permisos para ver esta vista'
                    : error.status === 401
                    ? 'Tu sesión expiró'
                    : 'No se pudo cargar el uso'}
                </p>
                <p className="text-sm text-red-700/80 dark:text-red-200/80 mt-0.5">
                  {error.status === 403
                    ? 'Pídele al operador que te agregue al allowlist (ADMIN_USER_IDS).'
                    : error.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load(days)}
                className="text-xs font-semibold px-3 py-1 rounded-full bg-white dark:bg-white/15 text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-white/25 transition-colors"
              >
                Reintentar
              </button>
            </CardContent>
          </Card>
        )}

        {/* ─── Section 1: Daily cost chart ──────────────────────────── */}
        <Card className="bg-white/75 dark:bg-white/5 backdrop-blur-2xl border-[#0e1745]/8 dark:border-white/10">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
              <span className="flex items-center gap-2">
                Costo diario
                {!loading && data && (
                  <Badge
                    variant="outline"
                    className="text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-none ml-1"
                  >
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span className="text-[11px]">{usd(totalCost)} total</span>
                  </Badge>
                )}
              </span>
              {!loading && data && (
                <span className="text-xs font-normal text-[#0e1745]/55 dark:text-white/50">
                  {compactInt(totalCalls)} llamadas · ventana {data.windowDays}d
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Suma de <code className="font-mono text-xs">cost_usd_total</code> por día (UTC).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <DailyChartSkeleton />
            ) : data ? (
              <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
                <LineChart
                  accessibilityLayer
                  data={data.daily}
                  margin={{ left: 12, right: 12, top: 4, bottom: 4 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(v) =>
                      typeof v === 'string' ? v.slice(5) : String(v)
                    }
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                  />
                  <ChartTooltip
                    cursor={{ stroke: 'var(--chart-2)', strokeOpacity: 0.2 }}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label) => String(label)}
                        formatter={(value, name) => (
                          <span className="font-mono">
                            {usd(Number(value))} · {String(name)}
                          </span>
                        )}
                      />
                    }
                  />
                  <Line
                    dataKey="cost_usd_total"
                    type="monotone"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            ) : null}
          </CardContent>
        </Card>

        {/* ─── Section 2: Per-user table ─────────────────────────────── */}
        <Card className="bg-white/75 dark:bg-white/5 backdrop-blur-2xl border-[#0e1745]/8 dark:border-white/10">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[#1534dc] dark:text-[#8b5cf6]" />
              Por usuario
            </CardTitle>
            <CardDescription>
              Top 100, ordenados por costo total descendente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <RowsSkeleton rows={6} />
            ) : data && data.perUser.length > 0 ? (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-[#0e1745]/50 dark:text-white/45">
                      <th className="text-left font-semibold py-2 px-2">user_id</th>
                      <th className="text-right font-semibold py-2 px-2">Calls</th>
                      <th className="text-right font-semibold py-2 px-2">Tokens (in/out)</th>
                      <th className="text-right font-semibold py-2 px-2">$ total</th>
                      <th className="text-right font-semibold py-2 px-2">Última</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perUser.map((u) => (
                      <tr
                        key={u.user_id}
                        className="border-t border-[#0e1745]/8 dark:border-white/10 hover:bg-[#1534dc]/3 dark:hover:bg-white/5"
                      >
                        <td
                          className="py-2 px-2 font-mono text-[12px] text-[#0e1745]/80 dark:text-white/80"
                          title={u.user_id}
                        >
                          {shortId(u.user_id)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {compactInt(u.calls)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums text-[#0e1745]/70 dark:text-white/65">
                          {compactInt(u.input_tokens)} / {compactInt(u.output_tokens)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums font-semibold">
                          {usd(u.cost_usd_total)}
                        </td>
                        <td className="py-2 px-2 text-right text-[#0e1745]/60 dark:text-white/55 text-[12px] inline-flex items-center gap-1 justify-end">
                          <Clock className="w-3 h-3" />
                          {relativeTime(u.last_call_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : !error ? (
              <p className="text-sm text-[#0e1745]/55 dark:text-white/50 py-4">
                Sin llamadas registradas en esta ventana.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ─── Section 3: Per-trace breakdown ───────────────────────── */}
        <Card className="bg-white/75 dark:bg-white/5 backdrop-blur-2xl border-[#0e1745]/8 dark:border-white/10">
          <CardHeader>
            <CardTitle>Por traza</CardTitle>
            <CardDescription>
              Qué <code className="font-mono text-xs">trace_label</code> está consumiendo el presupuesto.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <RowsSkeleton rows={4} />
            ) : data && data.perTrace.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.perTrace.map((t) => (
                  <div
                    key={t.trace_label}
                    className="rounded-xl border border-[#0e1745]/8 dark:border-white/10 bg-white/65 dark:bg-white/[0.04] p-3 transition-colors hover:border-[#1534dc]/30 dark:hover:border-[#8b5cf6]/30"
                  >
                    <p
                      className="font-mono text-[12px] truncate text-[#0e1745]/85 dark:text-white/80"
                      title={t.trace_label}
                    >
                      {t.trace_label}
                    </p>
                    <div className="mt-2 flex items-baseline justify-between gap-3">
                      <span className="text-lg font-semibold tabular-nums">
                        {usd(t.cost_usd_total)}
                      </span>
                      <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55 tabular-nums">
                        {compactInt(t.calls)} calls
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : !error ? (
              <p className="text-sm text-[#0e1745]/55 dark:text-white/50 py-4">
                Sin trazas registradas en esta ventana.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// ─── Skeleton placeholders ───────────────────────────────────────────

function DailyChartSkeleton() {
  return (
    <div
      className="h-[260px] w-full rounded-lg bg-gradient-to-br from-[#0e1745]/3 to-[#1534dc]/5 dark:from-white/5 dark:to-white/[0.02] animate-pulse"
      aria-hidden
    />
  );
}

function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-9 rounded-md bg-[#0e1745]/5 dark:bg-white/5 animate-pulse"
        />
      ))}
    </div>
  );
}
