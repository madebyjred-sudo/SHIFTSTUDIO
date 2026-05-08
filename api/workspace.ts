/**
 * @file api/workspace.ts
 * @description Bare-path bridge for /api/workspace (no trailing segment).
 *
 * Vercel's [...path].ts catch-all under api/workspace/ requires AT LEAST
 * one path segment. Bare GET /api/workspace (used by listWorkspaces) and
 * POST /api/workspace (used by createWorkspace) would 404 otherwise.
 *
 * This file delegates to the same Express bridge as the catch-all so the
 * routing surface is identical. Both files exist; Vercel picks the right
 * one based on URL shape:
 *   /api/workspace            -> api/workspace.ts (this file)
 *   /api/workspace/anything   -> api/workspace/[...path].ts
 */
import handler, { config } from './workspace/[...path].js';

export default handler;
export { config };
