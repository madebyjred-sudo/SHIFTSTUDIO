/**
 * Vercel function delegate for /api/workspace/<id>/<action> where action is
 * one of: nodes | transform | architect | turn | export | attach-context.
 * Re-exports api/workspace.ts. Express router matches the relative path
 * inside the workspaceRouter mount.
 */
export { default, config } from '../../workspace.js';
