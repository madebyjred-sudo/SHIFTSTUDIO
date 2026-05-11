/**
 * @file api/neuron.ts
 * @description Vercel serverless bridge for the neuron BFF proxy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Studio's neuron memory feature ("Mi memoria") needs a server-side
 * proxy to inject the shared secret `x-shift-internal-token` when
 * forwarding to Cerebro. The Express server in server.ts handles this
 * in dev; on Vercel, /api/* paths must resolve to a file in api/, so
 * this file mounts the same router under one entrypoint.
 *
 * VERCEL FUNCTION COUNT
 * ---------------------
 * Hobby tier caps serverless functions at 12. Studio already deploys 12
 * (chat, debate, export, workspace + workspace/[id] catch-alls, admin/
 * usage/summary). Adding a separate api/neuron/[...path].ts file would
 * tip us to 13 and fail the deploy. Instead, we ship ONE function and
 * use a vercel.json rewrite to route /api/neuron/(.*) → /api/neuron.
 * The Express router inside handles the sub-paths (/file, /history).
 *
 * ROUTING SHAPE
 * -------------
 * Vercel rewrites preserve the original URL on `req.url`, so by the time
 * this handler executes, `req.url` is e.g. `/api/neuron/file?path=...`.
 * The Express app mounts the router at `/api/neuron`, so the router sees
 * `/file?path=...` as expected. Bare `/api/neuron` (list+quota) maps to
 * the router's `/`.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import { createNeuronProxyRouter } from '../src/routes/neuron-proxy.js';

// One-shot Express app, lazily constructed on cold-start. Re-used across
// warm invocations — same lifetime as the router's module-level state.
let _app: express.Express | null = null;

function getApp(): express.Express {
  if (_app) return _app;
  const app = express();

  // Neurons are markdown files capped at 50kb upstream. 200kb gives
  // headroom for the JSON wrapping + bursty large saves without
  // surprising the user with a 413 mid-edit.
  app.use(express.json({ limit: '200kb' }));

  // CORS — same pattern as api/workspace.ts. Same-origin in prod
  // (Vercel rewrites /api/* internally) so this is mostly a safety net
  // for cross-origin embeds and dev clients.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3003',
      'http://localhost:5173',
      'http://localhost:5174',
    ];
    if (
      origin &&
      (allowed.includes(origin) || process.env.NODE_ENV === 'development')
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, PATCH, DELETE, OPTIONS',
    );
    // x-shift-internal-token is NOT in the allow-list intentionally —
    // it's a server-side-only secret. Clients send the user's Supabase
    // JWT via Authorization; that's the only header we accept for auth.
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api/neuron', createNeuronProxyRouter());

  _app = app;
  return app;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Cast is purely structural — Vercel's req/res inherit from
  // IncomingMessage/ServerResponse which is what Express expects.
  return getApp()(
    req as unknown as express.Request,
    res as unknown as express.Response,
  );
}

export const config = {
  // Cerebro's neuron endpoints are fast (Postgres single-row reads,
  // small md writes). 30s is more than enough.
  maxDuration: 30,
};
