/**
 * Vercel optional catch-all delegate for /api/admin/* (any depth).
 *
 * Re-exports api/admin.ts so all admin sub-routes hit the same Express
 * adminRouter. Vercel matches the most-specific filesystem route first;
 * adding new static admin endpoints (e.g. api/admin/foo.ts) would
 * shadow this catch-all for that path only.
 */
export { default, config } from '../admin.js';
