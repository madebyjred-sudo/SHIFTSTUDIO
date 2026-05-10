#!/usr/bin/env node
/**
 * verify-cache-swap.mjs
 *
 * End-to-end check that Studio's chat path can drive a cache write +
 * cache hit through Cerebro's `system_blocks` shape (Cerebro Change 1).
 *
 * Mimics what `src/routes/workspace.ts /turn` sends from the chat
 * intent: 4 stable cacheable blocks + 1 dynamic block, plus a tiny
 * `messages` array. Cumulative cacheable text is well over the
 * Anthropic 1024-token minimum.
 *
 * Run twice in a row (the script makes both calls itself):
 *   call 1 → cache write   → expect cci > 0, crt = 0
 *   call 2 → cache hit     → expect crt > 0
 *
 * Exit code 0 on success, non-zero on contract failure. The script is
 * safe to re-run — Cerebro key, billing, and tenant routing are
 * already production-correct.
 *
 * Usage:
 *   SWARM_API_URL=https://shift-cerebro-production.up.railway.app \
 *     node scripts/verify-cache-swap.mjs
 */

const SWARM_API_URL =
  process.env.SWARM_API_URL ?? 'https://shift-cerebro-production.up.railway.app';

// Force a cold cache on every run — Anthropic prompt-cache keys on
// the literal content prefix, so adding a per-run nonce to the FIRST
// block guarantees call 1 is a write and call 2 is a hit. Otherwise
// repeated runs see `cci=0, crt=>0` on call 1 (cache already warm
// from a previous run) and we can't distinguish a real write path
// from a same-hash carryover.
const RUN_NONCE = `[verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}] `;

// Block sizing notes:
//   Anthropic prompt-cache requires ≥1024 cumulative tokens of
//   cacheable content for the LAST `cache_control` breakpoint to
//   fire. With 4 cache_control markers placed across 4 blocks, the
//   cumulative position of every marker that DOES qualify gets
//   written; markers below 1024 are silently dropped.
//
//   The sizing below tracks production: ~2400 cacheable tokens, the
//   same ballpark Studio's chat path produces (verified live
//   2026-05-09: 90.9% cost reduction on hit at ~2234 cacheable
//   tokens). Don't shrink the repeat factors — empirically, slimmer
//   payloads under-fire the cache (last breakpoint slips below the
//   1024-token floor). If you need to tune, keep the LAST cacheable
//   block big enough that the cumulative-to-end count is well over
//   the minimum.
const blocks = [
  {
    text:
      RUN_NONCE +
      'Sos Lexa, una asistente creativa de Shifty Studio. ' .repeat(40),
    cacheable: true,
  },
  {
    text:
      '[Canvas reading rules] ...detailed rules... '.repeat(80),
    cacheable: true,
  },
  {
    text: '[Workspace] title="Demo" description="Test"',
    cacheable: true,
  },
  {
    text:
      '[Punto Medio] rag content rag content rag content rag content rag content rag content '.repeat(
        40,
      ),
    cacheable: true,
  },
  {
    text: '[Selected hoja] dynamic content here',
    // cacheable omitted — must default to false on the wire
  },
];

const body = {
  model: 'anthropic/claude-sonnet-4.6',
  system_blocks: blocks.map((b) => ({
    text: b.text,
    cacheable: b.cacheable === true,
  })),
  messages: [{ role: 'user', content: 'di pong' }],
  max_tokens: 5,
  app_id: 'studio',
  tenant: 'shift',
  trace_label: 'studio.verify.swap_e2e',
};

async function call(label) {
  const t0 = Date.now();
  const r = await fetch(`${SWARM_API_URL}/v1/llm/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${label}: HTTP ${r.status} (${ms}ms) — ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  const usage = j.usage ?? {};
  const cci = usage.cache_creation_input_tokens ?? 0;
  const crt = usage.cache_read_input_tokens ?? 0;
  const inT = usage.input_tokens ?? 0;
  const outT = usage.output_tokens ?? 0;
  console.log(
    `${label}: input_tokens=${inT}  output_tokens=${outT}  cci=${cci}  crt=${crt}  latency=${ms}ms  call_id=${
      j.call_id ?? 'n/a'
    }`,
  );
  return { cci, crt, inT, outT, ms };
}

(async () => {
  console.log('verify-cache-swap.mjs → Cerebro:', SWARM_API_URL);
  console.log(
    `cacheable blocks: ${
      blocks.filter((b) => b.cacheable).length
    } / ${blocks.length}  (chars cacheable: ${blocks
      .filter((b) => b.cacheable)
      .reduce((s, b) => s + b.text.length, 0)})`,
  );

  const r1 = await call('call 1 (write)');
  // Anthropic per-call min is 1024 cumulative cacheable tokens.
  if (r1.cci <= 0) {
    console.error('FAIL: call 1 did not write cache (cci must be > 0).');
    console.error(
      'Check that the cumulative cacheable text exceeds the 1024-token minimum and that Cerebro is on a build that includes Change 1.',
    );
    process.exit(2);
  }

  const r2 = await call('call 2 (hit)');
  if (r2.crt <= 0) {
    console.error('FAIL: call 2 did not read cache (crt must be > 0).');
    console.error(
      'Cache may have been evicted, the system_blocks payload may differ between calls, or the wire shape may have drifted.',
    );
    process.exit(3);
  }

  console.log(
    `\nOK: cache write ${r1.cci}  →  cache hit ${r2.crt}  (input drop: ${r1.inT} → ${r2.inT})`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('verify-cache-swap.mjs threw:', e?.message ?? e);
  process.exit(1);
});
