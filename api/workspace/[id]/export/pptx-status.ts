/**
 * Vercel function delegate for GET /api/workspace/<id>/export/pptx-status.
 *
 * Required because the existing [action].ts catch-all only matches
 * /api/workspace/<id>/<action> (4 segments). The pptx-status path adds
 * a fifth segment, which Vercel's filesystem router resolves through
 * [id]/export/pptx-status.ts before falling back to the dynamic
 * [id]/[action].ts.
 *
 * Re-exports api/workspace.ts; the Express workspaceRouter handles the
 * route by URL match.
 */
export { default, config } from '../../../workspace.js';
