/**
 * Vercel function delegate for POST /api/workspace/<id>/nodes/finalize-asset.
 *
 * Direct-to-storage upload finalization endpoint. The browser uploads the
 * file straight to Supabase Storage (bypassing Vercel's 4.5MB body limit),
 * then POSTs this endpoint with metadata only. The Express handler in
 * src/routes/workspace.ts downloads server-to-server, extracts text, and
 * inserts the studio_workspace_nodes row.
 */
export { default, config } from '../../../workspace.js';
