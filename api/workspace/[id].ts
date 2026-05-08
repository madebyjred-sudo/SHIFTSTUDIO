/**
 * Vercel function delegate for GET/PATCH/DELETE /api/workspace/<id>.
 * Re-exports api/workspace.ts handler. Express router routes by URL.
 */
export { default, config } from '../workspace.js';
