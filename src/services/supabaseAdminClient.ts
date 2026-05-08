/**
 * @file supabaseAdminClient.ts
 * @description Server-only Supabase client using the SERVICE ROLE key.
 *
 * Why a separate client from `supabaseClient.ts`:
 *   - `supabaseClient.ts` runs in the browser bundle (uses
 *     `import.meta.env.VITE_*`) and uses the ANON key. RLS applies.
 *   - This client runs ONLY in Node (Express BFF + Vercel functions). It
 *     uses the service-role key and bypasses RLS, so we can manually scope
 *     queries by user_id even when the request comes from bypass-auth
 *     mode where there is no Supabase session for RLS to read.
 *
 * Security contract:
 *   - NEVER import this file from anything that ends up in the Vite bundle.
 *     It only reads `process.env.*` (Node-only) and would silently no-op
 *     in the browser anyway, but more importantly the service-role key
 *     would leak into a client bundle if a future bundler config got it
 *     wrong.
 *   - All callers MUST manually filter by user_id on every query. Service
 *     role is RLS-bypassing — the BFF is the authorization layer.
 *
 * Soft-fail on missing env: returns null and warns once. Lets the rest
 * of the BFF boot in dev without Supabase configured (the workspace
 * router will reply with 503 if hit while the client is null).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client: SupabaseClient | null = null;

if (url && serviceKey) {
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
} else {
  console.warn(
    '[supabaseAdmin] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — admin client disabled. ' +
    'Set both env vars to enable workspace persistence.'
  );
}

export const supabaseAdmin = _client;
