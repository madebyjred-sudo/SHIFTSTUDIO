/**
 * Vercel function delegate for GET /api/admin/usage/summary.
 * Physical-files-per-route plan-B routing (same pattern as workspace/*).
 * Vercel's [[...path]] optional catch-all doesn't expand for 2+ segments
 * under Vite framework — verified empirically. Plain delegate works.
 */
export { default, config } from '../../admin.js';
