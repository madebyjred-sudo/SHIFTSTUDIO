/**
 * Vercel function delegate for POST /api/workspace/citations.
 * Re-exports the same Express bridge as api/workspace.ts. Vercel filesystem
 * routing matches this file (exact name) before falling back to [id].ts,
 * so /api/workspace/citations correctly hits POST /citations on the router.
 */
export { default, config } from '../workspace.js';
