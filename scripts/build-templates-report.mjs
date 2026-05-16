#!/usr/bin/env node
/**
 * Build a PDF report from the templates-smoke artifacts.
 *
 * Reads:
 *   test-results/templates-smoke/<slug>/
 *     - template.png
 *     - complete.png
 *     - events.json
 *     - outputs.json
 *
 * Emits:
 *   test-results/templates-smoke/templates-report.pdf
 *   test-results/templates-smoke/templates-report.html  (intermediate)
 *
 * Run AFTER `npm run smoke:templates` (or the equivalent playwright command).
 *
 * Usage:
 *   node scripts/build-templates-report.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(process.cwd(), 'test-results/templates-smoke');

const SLUG_ORDER = [
  'brief-creativo',
  'plan-campana',
  'analisis-performance',
  'reporte-financiero',
  'pitch-ejecutivo',
];

/** Encode a binary file as data: URL (base64). */
async function fileToDataURL(p, mime = 'image/png') {
  try {
    const buf = await fs.readFile(p);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function readJSON(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function fmtUSD(n) {
  if (n === null || n === undefined) return '—';
  return `$${Number(n).toFixed(4)}`;
}

function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

function escapeHTML(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pretty-print a node output. Cerebro returns various shapes — text, JSON,
 * markdown — so we render conservatively: <pre> for everything, truncate
 * to 8000 chars to keep PDF size sane.
 */
function renderOutput(out) {
  if (out === null || out === undefined) return '<em>no output</em>';
  let text;
  if (typeof out === 'string') {
    text = out;
  } else {
    try {
      text = JSON.stringify(out, null, 2);
    } catch {
      text = String(out);
    }
  }
  if (text.length > 8000) {
    text = text.slice(0, 8000) + `\n\n[...truncated ${text.length - 8000} chars]`;
  }
  return `<pre class="output">${escapeHTML(text)}</pre>`;
}

function renderNodeRow(nc, start) {
  const d = nc;
  const wallMs = start ? d.ts_complete && start.ts ? d.ts_complete - start.ts : null : null;
  return `
    <div class="node-row">
      <div class="node-head">
        <div class="node-title">
          <span class="badge specialist">SPECIALIST</span>
          <span class="node-id">${escapeHTML(d.node_id ?? '?')}</span>
          ${d.agent_id ? `<span class="agent-id">@${escapeHTML(d.agent_id)}</span>` : ''}
        </div>
        <div class="node-meta">
          <span title="Tokens">${fmtTokens(d.tokens)} tok</span>
          <span title="Cost">${fmtUSD(d.cost_usd)}</span>
          ${d.cache_read_input_tokens ? `<span class="cache-hit" title="Cache hits">⚡ ${fmtTokens(d.cache_read_input_tokens)}</span>` : ''}
        </div>
      </div>
      ${renderOutput(d.output)}
    </div>
  `;
}

function renderConsolidated(graphDone) {
  if (!graphDone) return '<p class="muted">No graph:done event captured.</p>';
  const sections = graphDone.sections ?? [];
  if (!Array.isArray(sections) || sections.length === 0) {
    return '<p class="muted">No sections in consolidated output.</p>';
  }
  return sections
    .map(
      (s, i) => `
        <div class="section">
          <h4>Sección ${i + 1}${s.title ? ` — ${escapeHTML(s.title)}` : ''}</h4>
          ${renderOutput(s.content ?? s.text ?? s)}
        </div>
      `,
    )
    .join('');
}

async function buildTemplateBlock(slug) {
  const dir = path.join(ROOT, slug);
  const outputs = await readJSON(path.join(dir, 'outputs.json'));
  const events = await readJSON(path.join(dir, 'events.json'));
  const templatePng = await fileToDataURL(path.join(dir, 'template.png'));
  const completePng = await fileToDataURL(path.join(dir, 'complete.png'));

  if (!outputs) {
    return `
      <section class="template missing">
        <h2>${escapeHTML(slug)}</h2>
        <p class="error">⚠️ No artifacts found — test may have failed before saving.</p>
      </section>
    `;
  }

  const completes = outputs.node_completes ?? [];
  const starts = outputs.node_starts ?? [];
  const startsByNode = new Map(starts.map((s) => [s.node_id, s]));

  const totalCost = outputs.graph_done?.total_cost_usd ?? completes.reduce((a, c) => a + (c.cost_usd ?? 0), 0);
  const totalTokens = outputs.graph_done?.total_tokens ?? completes.reduce((a, c) => a + (c.tokens ?? 0), 0);

  const errorBlock = outputs.graph_error
    ? `<div class="error-banner">⚠️ graph:error<pre>${escapeHTML(JSON.stringify(outputs.graph_error, null, 2))}</pre></div>`
    : '';

  return `
    <section class="template" id="tpl-${escapeHTML(slug)}">
      <header class="tpl-header">
        <div>
          <span class="tpl-eyebrow">PLANTILLA</span>
          <h2>${escapeHTML(slug)}</h2>
          <p class="ran-at">Corrida: ${escapeHTML(outputs.ran_at ?? '?')}</p>
        </div>
        <div class="tpl-stats">
          <div class="stat"><span class="label">Wall-clock</span><span class="value">${fmtMs(outputs.wall_clock_ms)}</span></div>
          <div class="stat"><span class="label">Tokens</span><span class="value">${fmtTokens(totalTokens)}</span></div>
          <div class="stat cost"><span class="label">Costo</span><span class="value">${fmtUSD(totalCost)}</span></div>
          <div class="stat"><span class="label">Estado</span><span class="value status-${escapeHTML(outputs.terminal_status?.replace(':', '-') ?? '?')}">${escapeHTML(outputs.terminal_status ?? '?')}</span></div>
        </div>
      </header>

      ${errorBlock}

      <div class="screenshot-block">
        <h3>Canvas — template cargado</h3>
        ${templatePng ? `<img src="${templatePng}" class="screenshot" alt="Template ${slug} canvas" />` : '<p class="muted">No screenshot.</p>'}
      </div>

      <div class="nodes-block">
        <h3>Respuestas por agente</h3>
        ${completes.map((nc) => renderNodeRow(nc, startsByNode.get(nc.node_id))).join('') || '<p class="muted">Sin respuestas de especialistas.</p>'}
      </div>

      <div class="consolidated-block">
        <h3>Salida consolidada (graph:done → sections)</h3>
        ${renderConsolidated(outputs.graph_done)}
      </div>

      <div class="screenshot-block">
        <h3>Canvas — post-ejecución</h3>
        ${completePng ? `<img src="${completePng}" class="screenshot" alt="Template ${slug} complete" />` : '<p class="muted">No screenshot.</p>'}
      </div>

      <details class="events-block">
        <summary>Eventos SSE (${events?.length ?? 0})</summary>
        <pre>${escapeHTML(JSON.stringify(events ?? [], null, 2))}</pre>
      </details>
    </section>
  `;
}

async function buildHTML() {
  const dirs = await fs.readdir(ROOT).catch(() => []);
  const knownSlugs = SLUG_ORDER.filter((s) => dirs.includes(s));
  const unknownSlugs = dirs.filter((d) => !SLUG_ORDER.includes(d) && !d.endsWith('.pdf') && !d.endsWith('.html'));
  const slugs = [...knownSlugs, ...unknownSlugs];

  // Aggregate totals for the cover.
  let totalCostAll = 0;
  let totalTokensAll = 0;
  let totalWallMs = 0;
  const perTemplate = [];
  for (const slug of slugs) {
    const outputs = await readJSON(path.join(ROOT, slug, 'outputs.json'));
    if (!outputs) {
      perTemplate.push({ slug, missing: true });
      continue;
    }
    const completes = outputs.node_completes ?? [];
    const cost = outputs.graph_done?.total_cost_usd ?? completes.reduce((a, c) => a + (c.cost_usd ?? 0), 0);
    const tokens = outputs.graph_done?.total_tokens ?? completes.reduce((a, c) => a + (c.tokens ?? 0), 0);
    totalCostAll += cost;
    totalTokensAll += tokens;
    totalWallMs += outputs.wall_clock_ms ?? 0;
    perTemplate.push({
      slug,
      cost,
      tokens,
      wallMs: outputs.wall_clock_ms,
      status: outputs.terminal_status,
      nodes: completes.length,
    });
  }

  const templateBlocks = await Promise.all(slugs.map(buildTemplateBlock));

  const coverRows = perTemplate
    .map((t) => {
      if (t.missing) {
        return `<tr><td>${escapeHTML(t.slug)}</td><td colspan="5" class="muted">no data</td></tr>`;
      }
      return `
        <tr>
          <td><a href="#tpl-${escapeHTML(t.slug)}">${escapeHTML(t.slug)}</a></td>
          <td>${t.nodes}</td>
          <td>${fmtMs(t.wallMs)}</td>
          <td>${fmtTokens(t.tokens)}</td>
          <td>${fmtUSD(t.cost)}</td>
          <td class="status-${escapeHTML(t.status?.replace(':', '-') ?? '')}">${escapeHTML(t.status ?? '?')}</td>
        </tr>
      `;
    })
    .join('');

  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Shifty Studio — Templates Smoke Report</title>
<style>
  @page { size: A4; margin: 20mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; color: #0e1745; line-height: 1.45; font-size: 11pt; margin: 0; }
  h1 { font-size: 28pt; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 18pt; margin: 0 0 4px; letter-spacing: -0.01em; }
  h3 { font-size: 13pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; color: #1534dc; }
  h4 { font-size: 11pt; margin: 12px 0 4px; color: #6b7280; }
  p, li { font-size: 10.5pt; }
  .muted { color: #6b7280; font-style: italic; }
  .error { color: #b91c1c; }
  pre { font-family: "SF Mono", "Menlo", monospace; font-size: 8.5pt; background: #f8fafc; border: 1px solid #e5e7eb; padding: 10px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  pre.output { max-height: none; }
  img.screenshot { width: 100%; max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); page-break-inside: avoid; }
  .cover { text-align: left; padding: 40px 0 60px; border-bottom: 2px solid #1534dc; margin-bottom: 40px; page-break-after: always; }
  .cover .eyebrow { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.18em; color: #6b7280; margin-bottom: 8px; }
  .cover .meta { color: #6b7280; font-size: 9.5pt; margin-top: 12px; }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 32px 0; }
  .totals .stat { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
  .totals .stat .label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.14em; color: #6b7280; }
  .totals .stat .value { display: block; font-size: 22pt; font-weight: 700; color: #0e1745; margin-top: 4px; letter-spacing: -0.02em; }
  .totals .stat.cost .value { color: #1534dc; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f8fafc; font-weight: 600; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.1em; color: #6b7280; }
  td a { color: #1534dc; text-decoration: none; }
  td.status-graph-done { color: #15803d; font-weight: 600; }
  td.status-graph-error { color: #b91c1c; font-weight: 600; }
  section.template { page-break-before: always; padding-top: 8px; }
  .tpl-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 14px; border-bottom: 1px solid #e5e7eb; margin-bottom: 20px; }
  .tpl-eyebrow { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.18em; color: #6b7280; }
  .ran-at { font-size: 9pt; color: #6b7280; margin: 4px 0 0; }
  .tpl-stats { display: flex; gap: 12px; }
  .tpl-stats .stat { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; min-width: 90px; }
  .tpl-stats .label { display: block; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.14em; color: #6b7280; }
  .tpl-stats .value { display: block; font-size: 13pt; font-weight: 700; color: #0e1745; margin-top: 2px; }
  .tpl-stats .cost .value { color: #1534dc; }
  .status-graph-done { color: #15803d; }
  .status-graph-error { color: #b91c1c; }
  .error-banner { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; margin: 12px 0; color: #991b1b; }
  .error-banner pre { background: white; }
  .node-row { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; page-break-inside: avoid; }
  .node-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .node-title { display: flex; align-items: center; gap: 8px; font-size: 11pt; }
  .badge.specialist { background: #ddd6fe; color: #5b21b6; padding: 2px 8px; border-radius: 4px; font-size: 8pt; font-weight: 700; letter-spacing: 0.06em; }
  .node-id { font-family: "SF Mono", monospace; font-size: 10pt; color: #1534dc; }
  .agent-id { font-size: 9.5pt; color: #6b7280; font-style: italic; }
  .node-meta { display: flex; gap: 12px; font-size: 9pt; color: #6b7280; }
  .node-meta .cache-hit { color: #15803d; }
  .section { margin-bottom: 16px; }
  .events-block { margin-top: 18px; }
  .events-block summary { cursor: pointer; font-size: 10pt; color: #6b7280; }
  .events-block pre { font-size: 7.5pt; max-height: 400px; overflow: auto; }
  .screenshot-block { margin: 20px 0 28px; }
</style>
</head>
<body>
  <section class="cover">
    <div class="eyebrow">Shifty Studio · Modo Nodos</div>
    <h1>Templates Smoke Report</h1>
    <p>Corrida end-to-end de las ${perTemplate.length} plantillas built-in contra Cerebro <code>production</code>. Cada plantilla se cargó en la UI real (Vercel), se ejecutó vía Studio frontend → <code>/v1/graph/execute</code>, y se capturaron screenshots, respuestas por agente, salida consolidada y costos via SSE.</p>

    <div class="totals">
      <div class="stat"><span class="label">Plantillas</span><span class="value">${perTemplate.length}</span></div>
      <div class="stat"><span class="label">Wall-clock</span><span class="value">${fmtMs(totalWallMs)}</span></div>
      <div class="stat"><span class="label">Tokens</span><span class="value">${fmtTokens(totalTokensAll)}</span></div>
      <div class="stat cost"><span class="label">Costo total</span><span class="value">${fmtUSD(totalCostAll)}</span></div>
    </div>

    <h3>Resumen por plantilla</h3>
    <table>
      <thead>
        <tr><th>Slug</th><th>Nodos</th><th>Wall-clock</th><th>Tokens</th><th>Costo</th><th>Estado</th></tr>
      </thead>
      <tbody>${coverRows}</tbody>
    </table>

    <p class="meta">Generado: ${escapeHTML(generatedAt)} · Base URL: <code>${escapeHTML(process.env.PLAYWRIGHT_BASE_URL ?? 'https://shiftstudio.vercel.app')}</code> · Cerebro: <code>https://shift-cerebro-production.up.railway.app</code></p>
  </section>

  ${templateBlocks.join('\n')}
</body>
</html>`;
}

async function main() {
  // Confirm the artifact root exists.
  try {
    await fs.access(ROOT);
  } catch {
    console.error(`No artifacts at ${ROOT}. Run the smoke spec first.`);
    process.exit(1);
  }

  const html = await buildHTML();
  const htmlPath = path.join(ROOT, 'templates-report.html');
  const pdfPath = path.join(ROOT, 'templates-report.pdf');
  await fs.writeFile(htmlPath, html);
  console.log(`✓ HTML written: ${htmlPath}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  // Allow images to render.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '15mm', right: '12mm', bottom: '15mm', left: '12mm' },
  });
  await browser.close();
  console.log(`✓ PDF written: ${pdfPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
