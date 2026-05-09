/**
 * @file api/admin.ts
 * @description Vercel serverless bridge for the Admin BFF.
 *
 * Mirrors api/workspace.ts — wraps the Express adminRouter inside a tiny
 * one-shot app so Vercel's filesystem routing can hit it. Auth gating
 * (ADMIN_USER_IDS allowlist) lives inside the router itself.
 *
 * Path-shape delegates under /api/admin/* re-export this file (see
 * api/admin/[[...path]].ts) so any sub-route reaches the same handler.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import { adminRouter } from '../src/routes/admin.js';
import { correlationMiddleware } from '../src/routes/workspace.js';

let _app: express.Express | null = null;

function getApp(): express.Express {
  if (_app) return _app;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Mirror server.ts CORS — the admin endpoints are same-origin in
  // production, but the embed harness may probe them.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = [
      'http://localhost:3003',
      'http://localhost:5173',
      'http://localhost:5174',
    ];
    if (origin && (allowed.includes(origin) || process.env.NODE_ENV === 'development')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    const allowHeaders =
      process.env.NODE_ENV === 'production'
        ? 'Content-Type, Authorization, x-tenant-id'
        : 'Content-Type, Authorization, x-tenant-id, x-user-id';
    res.setHeader('Access-Control-Allow-Headers', allowHeaders);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Per-request correlation — same middleware the workspace router uses
  // so log greps by requestId span both surfaces.
  app.use(correlationMiddleware);

  // Mount the admin router under /api/admin so its relative paths
  // ('/usage/summary') line up with the URL Vercel forwards.
  app.use('/api/admin', adminRouter);

  _app = app;
  return app;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  return getApp()(req as unknown as express.Request, res as unknown as express.Response);
}

export const config = {
  api: {
    // JSON-only endpoint; no multipart. Cheaper to let Vercel parse the body
    // than to defer to express.json(), but we already wired express.json above
    // for parity with workspace.ts. Either works.
    bodyParser: false,
  },
  // Aggregations should comfortably fit in 10s; cap at 30s for headroom on
  // big windows (?days=365).
  maxDuration: 30,
};
