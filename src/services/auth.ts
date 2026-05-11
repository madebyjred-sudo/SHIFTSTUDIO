/**
 * @file auth.ts
 * @description Server-side helper to resolve a user_id from an Express
 * request, supporting Studio's three modes:
 *
 *   1. Real Supabase auth — `Authorization: Bearer <jwt>` header is present
 *      and the supabase admin client is configured. We call
 *      `auth.getUser(token)` and trust the resolved id.
 *
 *      ⚠ HARD-FAIL: if a Bearer token is supplied but verification fails
 *      (revoked / expired / network blip) we return `null` immediately —
 *      we do NOT fall through to the x-user-id branch. Otherwise an
 *      attacker could send a stale Bearer + spoofed x-user-id and ride
 *      the silent fallback.
 *
 *   2. Frontend-managed bypass — frontend in `VITE_BYPASS_AUTH=true` mode
 *      sends `x-user-id: <uuid>` directly. Trusted ONLY when both:
 *        • `NODE_ENV !== 'production'`
 *        • `STUDIO_TRUST_HEADER_USER_ID === 'true'`
 *      In production the header is ignored regardless of any other env
 *      var — Vercel does not strip arbitrary client headers, and the
 *      CORS allow-list lets browsers send `x-user-id`, so this is the
 *      only gate keeping x-user-id from being a free spoofing primitive.
 *      The supplied value must also pass `isValidUuid` to be accepted.
 *
 *   3. Anon fallback — no headers at all. Returns the all-zero UUID in
 *      dev only. Production forcibly disables anon mode regardless of
 *      `STUDIO_ALLOW_ANON` (we warn at startup if the env var was set).
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

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// x-user-id is honored ONLY in dev AND when the operator explicitly opts
// in via STUDIO_TRUST_HEADER_USER_ID=true. Production is fail-closed.
const ALLOW_HEADER_USER_ID =
  !IS_PRODUCTION && process.env.STUDIO_TRUST_HEADER_USER_ID === 'true';

// Anon fallback is dev-only. Even if the operator sets STUDIO_ALLOW_ANON=true
// in production, we ignore it (and warn at startup so the misconfig is loud).
const ALLOW_ANON =
  !IS_PRODUCTION && process.env.STUDIO_ALLOW_ANON === 'true';

if (IS_PRODUCTION && process.env.STUDIO_ALLOW_ANON === 'true') {
  console.warn(
    '[auth] STUDIO_ALLOW_ANON=true ignored in production — anon fallback is forcibly disabled.',
  );
}
if (IS_PRODUCTION && process.env.STUDIO_TRUST_HEADER_USER_ID === 'true') {
  console.warn(
    '[auth] STUDIO_TRUST_HEADER_USER_ID=true ignored in production — x-user-id is forcibly disabled.',
  );
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  // 1. JWT route — only attempted if we have an admin client AND a Bearer token.
  //    If a Bearer token IS present, this branch is authoritative: success → ok,
  //    any failure → return null (caller responds 401). Never silently fall
  //    through to x-user-id.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (headerStr && typeof headerStr === 'string' && headerStr.startsWith('Bearer ')) {
    const token = headerStr.slice('Bearer '.length).trim();
    if (!token || !supabaseAdmin) {
      // Malformed Bearer (empty token) or no admin client to verify with —
      // fail closed. Do NOT consult x-user-id.
      return null;
    }
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data?.user?.id) return data.user.id;
      // Verification returned an error, or no user — token is invalid.
      // Fail closed: return null so the route responds 401.
      return null;
    } catch (err) {
      // Network blip / supabase outage — still fail closed. Surface a
      // warning so ops can see the failure mode in logs.
      console.warn('[auth] supabase.auth.getUser threw:', (err as Error).message);
      return null;
    }
  }

  // 2. Frontend-managed bypass — DEV ONLY, gated, UUID-validated.
  if (ALLOW_HEADER_USER_ID) {
    const xUser = req.headers['x-user-id'];
    const xUserStr = Array.isArray(xUser) ? xUser[0] : xUser;
    if (xUserStr && typeof xUserStr === 'string' && xUserStr.length > 0) {
      if (isValidUuid(xUserStr)) return xUserStr;
      // Malformed → reject explicitly rather than silently pass through.
      return null;
    }
  }

  // 3. Anon fallback — dev only AND opt-in via STUDIO_ALLOW_ANON. In
  //    production this is always null regardless of env.
  if (ALLOW_ANON) return ANON_USER_ID;

  return null;
}

/**
 * Resolve the user's email from a request, JWT-only.
 *
 * Used by the neurons (Cerebro persistent memory) wiring: Cerebro keys
 * memory files by `user_id = <email>` because email is the stable
 * cross-app identifier (UUID rotates per Supabase project; email does
 * not). Returning null is non-fatal — the caller responds 401 and the
 * frontend prompts re-auth.
 *
 * Contract:
 *   - Bearer token present + valid → return `data.user.email` (or null
 *     if the auth provider has no email on file).
 *   - Bearer token present + invalid → null (mirrors getUserIdFromRequest
 *     fail-closed semantics).
 *   - No Bearer token → null. We deliberately do NOT honor `x-user-id`
 *     or anon fallback here: those paths produce a UUID, not an email,
 *     and an attacker-supplied `x-user-email` header would be a trivial
 *     spoof primitive against another user's memory bucket.
 *
 * Never throws.
 */
export async function getUserEmailFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!headerStr || typeof headerStr !== 'string' || !headerStr.startsWith('Bearer ')) {
    return null;
  }
  const token = headerStr.slice('Bearer '.length).trim();
  if (!token || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.email) return null;
    return data.user.email;
  } catch (err) {
    console.warn('[auth] getUserEmailFromRequest threw:', (err as Error).message);
    return null;
  }
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
