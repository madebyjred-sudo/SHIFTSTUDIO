/**
 * @file routes/neuron-proxy.ts
 * @description BFF proxy that forwards Studio frontend calls to Cerebro's
 * neuron (per-user persistent memory) endpoints.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cerebro exposes 5 REST endpoints for neurons (user-scoped memory files)
 * under `/v1/neuron/{realm}/{user_email}` on the Railway deployment. They
 * are gated by a shared secret header `x-shift-internal-token` that the
 * browser MUST NOT see (it would unlock arbitrary user impersonation
 * across realms). This router runs server-side on Studio's Vercel
 * deployment, injects the secret, and authenticates the user via their
 * Supabase JWT (Authorization: Bearer ...) which yields a verified email.
 *
 *   browser →  Studio /api/neuron/*   →  Cerebro /v1/neuron/{realm}/{email}/*
 *   (JWT)      (verify JWT, add token)     (token-gated REST)
 *
 * The browser only ever sees same-origin /api/neuron/* — no CORS, no
 * exposed shared secret.
 *
 * REALM
 * -----
 * Hardcoded "shift" per-app. CL2 / Centinela / etc. each ship their own
 * neuron proxy with a different realm; this is intentional so a Studio
 * user's memory never leaks across products.
 *
 * USER IDENTITY
 * -------------
 * Resolved via getUserEmailFromRequest (JWT-only, never honors x-user-id
 * or anon fallback — see auth.ts for the rationale).
 */
import { Router, type Request, type Response } from 'express';
import { getUserEmailFromRequest } from '../services/auth.js';

const SWARM_API_URL = process.env.SWARM_API_URL || 'http://localhost:8000';
const SHIFT_INTERNAL_TOKEN = process.env.SHIFT_INTERNAL_TOKEN || '';
const REALM = 'shift';

if (!SHIFT_INTERNAL_TOKEN) {
  // Loud at boot so an operator misconfig doesn't manifest as silent
  // 401s downstream. We still mount the router (so the route table
  // matches dev/prod) but every call will 401 at Cerebro.
  // eslint-disable-next-line no-console
  console.warn(
    '[neuron-proxy] SHIFT_INTERNAL_TOKEN not set — calls to Cerebro will fail 401.',
  );
}

interface ForwardResult {
  status: number;
  body: unknown;
}

/**
 * Single source of truth for the upstream call. Builds the URL with the
 * realm + url-encoded email, injects the internal token, and normalizes
 * errors (network failure → 502 with structured body so the frontend can
 * distinguish "Cerebro is down" from "you don't have access").
 */
async function forward(
  method: string,
  userEmail: string,
  pathSuffix: string,
  query = '',
  body?: unknown,
): Promise<ForwardResult> {
  const url =
    `${SWARM_API_URL}/v1/neuron/${REALM}/${encodeURIComponent(userEmail)}` +
    `${pathSuffix}${query ? '?' + query : ''}`;

  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-shift-internal-token': SHIFT_INTERNAL_TOKEN,
    },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  };

  try {
    const r = await fetch(url, init);
    const responseBody = await r.json().catch(() => ({}));
    return { status: r.status, body: responseBody };
  } catch (e) {
    const err = e as Error;
    return {
      status: 502,
      body: { error: 'upstream_unavailable', detail: err?.message ?? String(e) },
    };
  }
}

export function createNeuronProxyRouter(): Router {
  const router = Router();

  // GET / — list files + quota
  router.get('/', async (req: Request, res: Response) => {
    const userEmail = await getUserEmailFromRequest(req);
    if (!userEmail) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const { status, body } = await forward('GET', userEmail, '');
    res.status(status).json(body);
  });

  // GET /file?path=... — contenido
  router.get('/file', async (req: Request, res: Response) => {
    const userEmail = await getUserEmailFromRequest(req);
    if (!userEmail) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const path = String(req.query.path ?? '');
    if (!path) {
      res.status(400).json({ error: 'path_required' });
      return;
    }
    const { status, body } = await forward(
      'GET',
      userEmail,
      '/file',
      `path=${encodeURIComponent(path)}`,
    );
    res.status(status).json(body);
  });

  // PATCH /file body { path, content }
  router.patch('/file', async (req: Request, res: Response) => {
    const userEmail = await getUserEmailFromRequest(req);
    if (!userEmail) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const { path, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'invalid_body', expected: '{path, content}' });
      return;
    }
    const { status, body } = await forward('PATCH', userEmail, '/file', '', {
      path,
      content,
    });
    res.status(status).json(body);
  });

  // DELETE /file?path=...
  router.delete('/file', async (req: Request, res: Response) => {
    const userEmail = await getUserEmailFromRequest(req);
    if (!userEmail) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const path = String(req.query.path ?? '');
    if (!path) {
      res.status(400).json({ error: 'path_required' });
      return;
    }
    const { status, body } = await forward(
      'DELETE',
      userEmail,
      '/file',
      `path=${encodeURIComponent(path)}`,
    );
    res.status(status).json(body);
  });

  // GET /history?limit=N — clamped [1, 200]
  router.get('/history', async (req: Request, res: Response) => {
    const userEmail = await getUserEmailFromRequest(req);
    if (!userEmail) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
    const { status, body } = await forward(
      'GET',
      userEmail,
      '/history',
      `limit=${limit}`,
    );
    res.status(status).json(body);
  });

  return router;
}
