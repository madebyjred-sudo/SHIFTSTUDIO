/**
 * @file src/lib/logger.ts
 * @description Tiny zero-dep structured logger for the Studio BFF.
 *
 * Goals:
 *   - Emit one JSON object per line on stdout/stderr — greppable in
 *     production log aggregators (Vercel / Render / Datadog all parse
 *     JSON-line stdout natively).
 *   - Carry per-request correlation IDs via `child()` so a single chain
 *     of log lines can be filtered with `requestId=abc-123`.
 *   - No new runtime deps: under the hood we just call `console.log /
 *     console.warn / console.error` with a serialized JSON string.
 *
 * Shape of every emitted line:
 *   { ts, level, event, ...extra, ...data }
 *
 *   ts      — ISO-8601 UTC timestamp
 *   level   — "info" | "warn" | "error"
 *   event   — short dotted-path identifier (e.g. "workspace.list.failed")
 *   extra   — fields baked in via `child(...)` (requestId, route, method, …)
 *   data    — caller-supplied per-call fields
 *
 * Why not pino/winston: zero deps + zero config keeps cold-starts on
 * Vercel functions cheap and avoids surprise behaviour (file handles,
 * worker threads, transport pipelines). Studio's logging needs are
 * modest — one structured line per code path — and console.* is already
 * captured by every host we deploy to.
 */
type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  info: (event: string, data?: LogFields) => void;
  warn: (event: string, data?: LogFields) => void;
  error: (event: string, data?: LogFields) => void;
  /**
   * Return a new Logger that injects `extra` into every emit. Stacks —
   * `parent.child({a:1}).child({b:2})` produces a logger whose lines
   * include both `a` and `b`. Per-call data still wins on key collision.
   */
  child: (extra: LogFields) => Logger;
}

/**
 * Pick the right console method per level. We deliberately route warn
 * to console.warn and error to console.error so host log aggregators
 * tag them at the correct severity (stderr vs stdout). info goes to
 * console.log.
 */
function emit(level: LogLevel, payload: Record<string, unknown>): void {
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Build a logger that always merges `bound` into emitted lines. */
function makeLogger(bound: LogFields): Logger {
  const log = (level: LogLevel, event: string, data?: LogFields): void => {
    // Order: ts/level/event first (greppable headers), then bound
    // correlation fields, then per-call data — per-call wins on
    // collision because it spreads last.
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...bound,
      ...(data ?? {}),
    };
    emit(level, payload);
  };

  return {
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data) => log('error', event, data),
    child: (extra) => makeLogger({ ...bound, ...extra }),
  };
}

/** Singleton root logger — no bound fields. */
export const logger: Logger = makeLogger({});

// ─── Express Request augmentation ────────────────────────────────────
//
// Per-request correlation: every Express handler in workspace.ts /
// api/workspace.ts / server.ts can read `req.requestId` and call
// `req.log.info(...)` — the middleware in those files attaches both at
// the top of the chain. Declared here (and not in a separate types
// file) so importing the logger is enough to pick the augmentation up
// — no extra `tsconfig.types` plumbing needed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
    }
  }
}

