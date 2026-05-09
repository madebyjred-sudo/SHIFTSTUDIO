/**
 * @file api/admin/usage/summary.ts
 * @description Vercel serverless function — Admin BFF (single physical route).
 *
 * Studio is on Vercel Hobby tier (12-function cap). Originally we had
 * api/admin.ts (Express bridge) + api/admin/[[...path]].ts (catch-all).
 * The optional catch-all doesn't expand for 2+ segments under Vite
 * framework (same bug we hit with workspace), and api/admin.ts pushed
 * total functions to 13 → Vercel deploy failed.
 *
 * Solution: collapse to ONE physical file matching the only real route
 * (`GET /api/admin/usage/summary`). Express app construction lives here
 * directly. If we ever add a second admin route, add a sibling file
 * (e.g. api/admin/users/list.ts) that follows this same pattern.
 *
 * Auth gating (ADMIN_USER_IDS allowlist) lives inside the router itself.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import { adminRouter } from '../../../src/routes/admin.js';
import { correlationMiddleware } from '../../../src/routes/workspace.js';

let _app: express.Express | null = null;

function getApp(): express.Express {
  if (_app) return _app;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Mirror server.ts CORS — admin endpoints are same-origin in production
  // but the embed harness may probe them.
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
    bodyParser: false,
  },
  // Aggregations comfortably fit in 10s; cap at 30s for big windows.
  maxDuration: 30,
};
