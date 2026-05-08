/**
 * Vercel function delegate for /api/workspace/<id>/nodes/<node> where node
 * is either a nodeId UUID (GET/PATCH/DELETE) or the literal "import"
 * (POST multipart upload).
 */
export { default, config } from '../../../workspace.js';
