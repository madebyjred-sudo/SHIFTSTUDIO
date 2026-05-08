/**
 * @file api/workspace/[...path].ts
 * @description Vercel serverless bridge for the Workspace BFF.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Studio is deployed on Vercel as a static SPA + serverless functions
 * under `api/*.ts`. The Express server in `server.ts` ONLY runs in
 * dev (`tsx server.ts`). On Vercel, anything under `/api/...` must
 * resolve to a file in `api/...` or it 404s.
 *
 * Without this bridge, every `/api/workspace/*` request from production
 * Studio (canvas, list, modals, AI primitives, exports) would 404 — the
 * entire T1-T10 surface would be dead on Vercel deploys despite working
 * locally. This is the deploy-blocking gap caught in the T11 audit.
 *
 * HOW IT WORKS
 * ------------
 * Vercel routes any path matching `/api/workspace/<...>` to this file
 * via the catch-all `[...path]` segment. We mount the same Express
 * `workspaceRouter` from `src/routes/workspace.ts` under `/api/workspace`
 * inside a tiny one-shot Express app, then hand the (req,res) pair off
 * to it. The router's relative routes (e.g. `/`, `/:id`, `/:id/turn`)
 * line up because Express strips the mount prefix internally.
 *
 * @vercel/node's VercelRequest / VercelResponse extend IncomingMessage /
 * ServerResponse with body parsing helpers — they are drop-in compatible
 * with Express middleware. The cast at the bottom is type-only.
 *
 * RESPONSE STREAMING
 * ------------------
 * /:id/turn returns SSE on intent=chat. Vercel functions on the Hobby /
 * Pro tier support streaming responses up to 60s (Pro) / 10s (Hobby).
 * If a single turn would exceed the timeout the client should fall back
 * to a non-streaming intent. The Express path under `node server.ts` has
 * no such limit; for very long turns prefer running Studio behind the
 * Express server (Render / Railway / Fly) instead of Vercel.
 *
 * REQUEST BODY
 * ------------
 * Vercel auto-parses JSON bodies on the request when Content-Type is
 * application/json. The Express router uses express.json() too — both
 * paths populate `req.body`, so handlers don't need to know which path
 * delivered them. Multipart (file uploads) is handled by the multer
 * middleware inside the router, which reads the raw stream — Vercel's
 * default body parser does NOT eagerly consume non-JSON bodies, so
 * multer still gets the raw stream as expected.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import { workspaceRouter } from '../../src/routes/workspace.js';

// One-shot Express app, lazily constructed on cold-start. Vercel keeps
// the warm container around between invocations so this is built once
// per warm instance — same lifetime as the workspaceRouter's module-level
// state (e.g. the supabaseAdmin singleton, the Punto Medio cache).
let _app: express.Express | null = null;

function getApp(): express.Express {
  if (_app) return _app;
  const app = express();

  // Same JSON body limit / urlencoded behavior as server.ts uses.
  app.use(express.json({ limit: '5mb' }));

  // Mirror server.ts's CORS — the workspace endpoints are called from the
  // same origin (Vercel rewrites `/api/*` to here), so this is mostly a
  // safety net for cross-origin embeds (BrandHub iframe).
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-tenant-id, x-user-id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Mount the same router server.ts uses. Path prefix matches the URL
  // shape Vercel sends ("/api/workspace/...") so the router's relative
  // patterns line up.
  app.use('/api/workspace', workspaceRouter);

  _app = app;
  return app;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Cast is purely structural — Vercel's req/res inherit from
  // IncomingMessage/ServerResponse which is what Express expects.
  return getApp()(req as unknown as express.Request, res as unknown as express.Response);
}

// Disable Vercel's body parser for this function — we let Express + multer
// handle bodies (express.json for application/json; multer for multipart).
// Without this, multipart uploads would arrive pre-consumed and multer
// would hang waiting for a body that's already been read.
export const config = {
  api: {
    bodyParser: false,
  },
};
