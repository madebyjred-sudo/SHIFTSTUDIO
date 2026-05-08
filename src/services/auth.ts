/**
 * @file auth.ts
 * @description Server-side helper to resolve a user_id from an Express
 * request, supporting Studio's three modes:
 *
 *   1. Real Supabase auth — `Authorization: Bearer <jwt>` header is present
 *      and the supabase admin client is configured. We call
 *      `auth.getUser(token)` and trust the resolved id.
 *
 *   2. Frontend-managed bypass — frontend in `VITE_BYPASS_AUTH=true` mode
 *      sends `x-user-id: <uuid>` directly. We trust it because the BFF is
 *      not internet-exposed in this mode (it's behind the Studio dev
 *      tunnel / Authelia gateway). This lets the canvas persist data per
 *      profile even without a real session.
 *
 *   3. Anon fallback — no headers at all. Returns the all-zero UUID so
 *      bypass-mode demos work without crashing on writes. This is dev-
 *      only behavior; production should never hit it because the proxy
 *      always injects an x-user-id.
 *
 * Returns `string | null`. NEVER throws — handlers decide whether to
 * 401 (typical for writes) or accept anon (typical for reads).
 *
 * Mirrors the contract of CL2's `getUserIdFromRequest` so the workspace
 * router port from CL2 can call this helper unchanged.
 */
import type { Request } from 'express';
import { supabaseAdmin } from './supabaseAdminClient.js';

const ANON_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  // 1. JWT route — only attempted if we have an admin client AND a Bearer token
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (headerStr && typeof headerStr === 'string' && headerStr.startsWith('Bearer ')) {
    const token = headerStr.slice('Bearer '.length).trim();
    if (token && supabaseAdmin) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (!error && data?.user?.id) return data.user.id;
      } catch (err) {
        // Soft-fail to next layer; never let auth crash the handler.
        console.warn('[auth] supabase.auth.getUser threw:', (err as Error).message);
      }
    }
  }

  // 2. Frontend-managed bypass
  const xUser = req.headers['x-user-id'];
  const xUserStr = Array.isArray(xUser) ? xUser[0] : xUser;
  if (xUserStr && typeof xUserStr === 'string' && xUserStr.length > 0) {
    return xUserStr;
  }

  // 3. Anon fallback — only in dev / bypass mode
  if (process.env.NODE_ENV !== 'production' || process.env.STUDIO_ALLOW_ANON === 'true') {
    return ANON_USER_ID;
  }

  return null;
}

export { ANON_USER_ID };

/**
 * Cheap, regex-only UUID v1–v5 validator. Used by route handlers to
 * 400 on malformed `:id` / `:nodeId` params before they reach Postgres
 * (avoids a 500 + noisy log on `invalid input syntax for type uuid`).
 *
 * Does NOT verify the UUID exists or belongs to anyone — that's the
 * handler's job. Format check only.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(s: unknown): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}
