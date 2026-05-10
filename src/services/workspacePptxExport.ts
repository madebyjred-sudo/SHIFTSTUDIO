/**
 * @file workspacePptxExport.ts
 * @description Shared pptx generation flow for Studio workspaces.
 *
 * Extracted so it can be called from two places:
 *
 *   1. POST /api/workspace/:id/export (the HTTP entrypoint, modal-driven UX)
 *   2. Future Atlas-style chat-tool dispatcher (not yet wired in Studio)
 *
 * Putting it in /services/ avoids a circular import: workspace.ts imports
 * openRouterDirect (for chat-style routes inside the workspace surface),
 * and a future chat-tool dispatcher would need to call this exporter — so
 * it lives outside both.
 *
 * ──────────────────────────────────────────────────────────────────────
 * SPLIT FLOW (Phase 3.F — Vercel maxDuration fix)
 * ──────────────────────────────────────────────────────────────────────
 * The original `runWorkspacePptxExport` blocked on Gamma's pollUntilComplete
 * (up to 5min) inside a single HTTP request. On Vercel that's a guaranteed
 * 504: function maxDuration caps at 60s (Pro) / 10s (Hobby). Works in dev
 * because Express has no default timeout.
 *
 * Fix: split into two stages.
 *   • `startGeneration` — kick off the deck via Gamma's POST /generations
 *     and return immediately with the generationId. Honors the 1h cache
 *     (returns the cached deck without burning Gamma credits).
 *   • `checkGeneration` — single status check (no polling). Persists
 *     last_pptx when the deck completes, so the cache is warmed.
 *
 * Frontend polls the status endpoint every 5s.
 *
 * The legacy `runWorkspacePptxExport` is intentionally removed — every
 * caller must move to start+check. Keeping it as a re-export would only
 * resurrect the timeout on the next refactor.
 *
 * Ported from CL2's apps/api/src/services/workspacePptxExport.ts. Critical
 * differences from the source:
 *   - Tables: `workspaces` → `studio_workspaces`,
 *             `workspace_nodes` → `studio_workspace_nodes`.
 *   - Uses the existing supabaseAdmin singleton (Studio's pattern) instead
 *     of a private createClient call.
 *   - Drops the legacy "last_pptx column missing" retry — Studio's
 *     migration 0003 ships the column from day 1.
 *   - Drops legislativo costarricense defaults in buildAdditionalInstructions.
 *     Studio is neutral; the defaults now read like a generic professional
 *     deck.
 *   - textOptions.tone goes from "professional, legislative" to
 *     "professional". Language stays 'es-419' (Studio is Spanish LATAM).
 *   - logger.* calls become console.* (Studio doesn't ship a logger).
 *   - Phase 3.F: split create/poll into two functions for Vercel.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import {
  createGeneration,
  getGenerationStatus,
  GammaApiError,
  type GammaFormat,
  type GammaExportAs,
} from './gammaApi.js';
import type { BranchSection } from '../types/export.js';

export interface WorkspacePptxResult {
  generationId: string;
  gammaUrl: string;
  exportUrl: string;
  filename: string;
  cached: boolean;
  generatedAt: string;
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('workspace_not_found');
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Per-presentation client preferences. All optional. When set, the values
 * are composed into Gamma's `additionalInstructions` field — that's the
 * only knob the public Gamma API exposes for stylistic + content guidance
 * (the `themeId` parameter exists too but requires user-saved themes,
 * which we don't surface yet).
 *
 * Cached on `studio_workspaces.last_pptx.options` so the next button click
 * pre-populates the form with last time's choices.
 */
export interface PptxOptions {
  /** "ejecutivo, seco" / "didáctico" / "persuasivo" / "técnico". */
  tono?: string;
  /** "Equipo de marketing" / "Stakeholders ejecutivos" / etc. */
  audiencia?: string;
  /** Free text — what the user wants the deck to argue or showcase. */
  proposito?: string;
  /** Brand voice / visual notes. e.g. "Mantener vocabulario formal,
   *  evitar tecnicismos. Logo de la marca, paleta sobria.". */
  marca?: string;
  /** Emojis si/no. Defaults false. */
  emojis?: boolean;
}

interface RunOpts {
  workspaceId: string;
  userId: string | null;
  /** Bypass the ~1h cache when true. */
  force?: boolean;
  /** Optional per-call branding/context options. When omitted, the cached
   *  options on the workspace row are reused (so re-clicks keep the same
   *  flavor without re-asking). */
  options?: PptxOptions;
}

/**
 * Outcome of `startGeneration`.
 *
 * Two terminal shapes:
 *   • cached deck (status='complete', everything filled in) — when the
 *     last_pptx row is fresh enough to reuse.
 *   • freshly-kicked-off generation (status='pending', generationId only)
 *     — caller polls /pptx-status to learn when it's ready.
 */
export type StartGenerationResult =
  | { status: 'complete'; result: WorkspacePptxResult }
  | { status: 'pending'; generationId: string; filename: string };

/**
 * Outcome of `checkGeneration`. Mirrors the HTTP shape the route returns.
 */
export type CheckGenerationResult =
  | { status: 'complete'; result: WorkspacePptxResult }
  | { status: 'pending'; generationId: string }
  | { status: 'failed'; generationId: string; error: string };

/**
 * Compose the Gamma `additionalInstructions` payload from user options +
 * sane neutral defaults. Pure — no DB. Easy to unit test.
 */
function buildAdditionalInstructions(opts: PptxOptions | undefined): string {
  const parts: string[] = [
    'Tono profesional.',
    'Mantené nombres propios y citas sin reformular.',
    'No uses lenguaje de marketing.',
  ];
  if (opts?.tono) parts.push(`Tono específico: ${opts.tono}.`);
  if (opts?.audiencia)
    parts.push(`Audiencia objetivo: ${opts.audiencia}. Adaptá nivel de detalle y términos técnicos.`);
  if (opts?.proposito) parts.push(`Propósito de esta presentación: ${opts.proposito}.`);
  if (opts?.marca) parts.push(`Lineamientos de marca: ${opts.marca}.`);
  if (opts?.emojis === false || opts?.emojis === undefined) {
    parts.push('NO uses emojis ni iconos decorativos en el texto de las slides.');
  }
  return parts.join(' ');
}

// Stable stringify so {tono, audiencia} and {audiencia, tono} hash the same.
// Default JSON.stringify preserves insertion order, which means a different
// client-side form mount order would silently bust the cache and burn
// Gamma credits.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableStringify(o: any): string {
  if (o == null) return 'null';
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

type WsRow = {
  id: string;
  title: string;
  description: string | null;
  last_pptx?:
    | (WorkspacePptxResult & { creditsUsed?: number; options?: PptxOptions })
    | null;
};

function safeFilenameFromTitle(title: string | null | undefined): string {
  return (
    (title ?? 'workspace')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'workspace'
  );
}

/**
 * Stage 1 — kick off (or reuse cached) Gamma generation.
 *
 * Returns immediately:
 *   • { status: 'complete', result } if the cached last_pptx is fresh and
 *     the requested options haven't changed.
 *   • { status: 'pending', generationId, filename } otherwise. Caller is
 *     expected to poll `checkGeneration` (or the HTTP /pptx-status route).
 *
 * Throws WorkspaceNotFoundError if the workspace doesn't exist or doesn't
 * belong to userId, or GammaApiError on Gamma create failures.
 */
export async function startGeneration(
  opts: RunOpts,
): Promise<StartGenerationResult> {
  const { workspaceId, userId, force = false } = opts;
  if (!userId) throw new Error('user_id required for startGeneration');
  if (!supabaseAdmin)
    throw new Error('supabase admin client not configured for startGeneration');

  // ── Load workspace ────────────────────────────────────────────────
  const { data: ws, error: wsErr } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id, title, description, last_pptx')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (wsErr || !ws) throw new WorkspaceNotFoundError();
  const workspace = ws as unknown as WsRow;

  const safeName = safeFilenameFromTitle(workspace.title);
  const filename = `${safeName}.pptx`;

  // ── Cache reuse ────────────────────────────────────────────────────
  // Cache returns the prior deck when:
  //   - force=false, AND
  //   - the cache is < 1h old, AND
  //   - either no new options were passed, OR the new options match what
  //     was cached (deep-equal as JSON). The latter rule prevents the
  //     options modal from quietly returning a stale deck after the user
  //     just changed their tone/audience.
  const cache = workspace.last_pptx;
  if (!force && cache?.generatedAt && cache.exportUrl && cache.gammaUrl) {
    const ageMs = Date.now() - new Date(cache.generatedAt).getTime();
    const oneHour = 60 * 60 * 1000;
    const optionsChanged = opts.options
      ? stableStringify(opts.options) !== stableStringify(cache.options ?? null)
      : false;
    if (ageMs >= 0 && ageMs < oneHour && !optionsChanged) {
      console.log(
        `[workspace_pptx] cache hit workspaceId=${workspaceId} ageMs=${ageMs} generationId=${cache.generationId}`,
      );
      return {
        status: 'complete',
        result: {
          generationId: cache.generationId,
          gammaUrl: cache.gammaUrl,
          exportUrl: cache.exportUrl,
          filename,
          cached: true,
          generatedAt: cache.generatedAt,
        },
      };
    }
  }

  // ── Load hojas ────────────────────────────────────────────────────
  const { data: nodes, error: nErr } = await supabaseAdmin
    .from('studio_workspace_nodes')
    .select('id, title, subtitle, content, x, y')
    .eq('workspace_id', workspaceId);
  if (nErr) throw new Error(`load_nodes_failed: ${nErr.message}`);

  // Reading order: top-to-bottom, left-to-right (snap y to 200px bands).
  const ordered = (nodes ?? []).slice().sort((a, b) => {
    const yA = Math.floor((a.y as number) / 200);
    const yB = Math.floor((b.y as number) / 200);
    if (yA !== yB) return yA - yB;
    return (a.x as number) - (b.x as number);
  });

  // ── Compose deck source ───────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# ${workspace.title}`);
  if (workspace.description) lines.push('', workspace.description);
  lines.push(
    '',
    `_${ordered.length} hoja${ordered.length === 1 ? '' : 's'} · Shifty Studio_`,
  );

  for (const n of ordered) {
    lines.push('', '---', '');
    lines.push(`# ${n.title}`);
    if (n.subtitle) lines.push('', `### ${n.subtitle}`);
    const md = ((n.content as Record<string, unknown>)?.md as string) ?? '';
    if (md.trim()) lines.push('', md.trim());
  }

  const inputText = lines.join('\n').slice(0, 400_000);

  // ── Persist the in-flight options into last_pptx so checkGeneration
  //    has them for cache write-back, AND so a future call from another
  //    tab can resolve the same deck. We stash a partial payload (no
  //    URLs yet) — checkGeneration overwrites it once the deck completes.
  const inflightOptions = opts.options ?? workspace.last_pptx?.options ?? undefined;

  // ── Call Gamma — create only, do NOT poll ─────────────────────────
  const created = await createGeneration({
    inputText,
    format: 'presentation',
    exportAs: 'pptx',
    cardSplit: 'inputTextBreaks',
    textMode: 'preserve',
    textOptions: { language: 'es-419', tone: 'professional' },
    imageOptions: { source: 'aiGenerated' },
    cardOptions: { dimensions: '16x9' },
    additionalInstructions: buildAdditionalInstructions(inflightOptions),
  });

  console.log(
    `[workspace_pptx] generation kicked off workspaceId=${workspaceId} hojas=${ordered.length} generationId=${created.generationId} chars=${inputText.length}`,
  );

  // Store the options we used (best-effort) so checkGeneration can
  // pick them up when the deck completes and write the final cache row.
  // We don't write URLs yet — those come from checkGeneration.
  try {
    const inflightPayload = {
      generationId: created.generationId,
      options: inflightOptions,
      // Sentinel: a pending row has no exportUrl/gammaUrl. We keep any
      // existing fresh cache entry around if it exists, but only when
      // we're not about to invalidate it (force or options changed).
      // Here we know we're starting a new generation, so it's safe to
      // null URLs out — but to keep the contract simple we just overlay
      // the generationId + options on top of whatever was there.
    };
    const merged = {
      ...(workspace.last_pptx ?? {}),
      ...inflightPayload,
    };
    const { error: upErr } = await supabaseAdmin
      .from('studio_workspaces')
      .update({ last_pptx: merged })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (upErr)
      console.warn(
        `[workspace_pptx] inflight write failed workspaceId=${workspaceId} error=${upErr.message}`,
      );
  } catch (err) {
    console.warn(
      `[workspace_pptx] inflight write threw workspaceId=${workspaceId} error=${(err as Error).message}`,
    );
  }

  return {
    status: 'pending',
    generationId: created.generationId,
    filename,
  };
}

/**
 * Stage 2 — single-shot status check on a pending generation.
 *
 * No polling. The frontend (or an external worker) is responsible for
 * calling this on a cadence until status !== 'pending'. The full call,
 * including the DB write on completion, fits well under Vercel's 10s
 * Hobby cap.
 *
 * On 'complete' we persist the final cache row (generationId, urls,
 * generatedAt, options) so the next startGeneration call within the
 * 1h window short-circuits without burning Gamma credits.
 *
 * Throws WorkspaceNotFoundError if the workspace doesn't exist or doesn't
 * belong to userId. Other errors propagate as GammaApiError.
 */
export async function checkGeneration(
  generationId: string,
  workspaceId: string,
  userId: string | null,
): Promise<CheckGenerationResult> {
  if (!userId) throw new Error('user_id required for checkGeneration');
  if (!supabaseAdmin)
    throw new Error('supabase admin client not configured for checkGeneration');

  // Verify ownership + load workspace title for the filename.
  const { data: ws, error: wsErr } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id, title, description, last_pptx')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (wsErr || !ws) throw new WorkspaceNotFoundError();
  const workspace = ws as unknown as WsRow;

  const safeName = safeFilenameFromTitle(workspace.title);
  const filename = `${safeName}.pptx`;

  // One status hit. No retry / no poll loop here — Vercel will time out
  // mid-poll, and the frontend already polls.
  let status;
  try {
    status = await getGenerationStatus(generationId);
  } catch (err) {
    // Surface failed generations as a typed status to the route layer
    // rather than throwing — the caller wants to render a friendly error
    // in the modal, not crash to a 500.
    if (err instanceof GammaApiError && err.code === 'failed') {
      return {
        status: 'failed',
        generationId,
        error: err.message,
      };
    }
    throw err;
  }

  if (status.status === 'failed') {
    return {
      status: 'failed',
      generationId,
      error: status.error?.message ?? 'gamma:generation failed',
    };
  }

  if (status.status !== 'completed') {
    // 'pending' covers Gamma's 'pending' | 'running' (and anything we
    // don't recognize as terminal). The frontend polls again in 5s.
    return {
      status: 'pending',
      generationId,
    };
  }

  if (!status.exportUrl) {
    return {
      status: 'failed',
      generationId,
      error: `gamma:generation ${generationId} completed but no exportUrl present`,
    };
  }

  // ── Complete — persist cache + return result ──────────────────────
  const generatedAt = new Date().toISOString();
  const cachePayload = {
    generationId: status.generationId,
    gammaUrl: status.gammaUrl ?? '',
    exportUrl: status.exportUrl,
    generatedAt,
    // Preserve whatever options were stashed at startGeneration time.
    options: workspace.last_pptx?.options ?? undefined,
  };

  try {
    const { error: upErr } = await supabaseAdmin
      .from('studio_workspaces')
      .update({ last_pptx: cachePayload, updated_at: generatedAt })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (upErr)
      console.warn(
        `[workspace_pptx] cache write failed workspaceId=${workspaceId} error=${upErr.message}`,
      );
  } catch (err) {
    console.warn(
      `[workspace_pptx] cache write threw workspaceId=${workspaceId} error=${(err as Error).message}`,
    );
  }

  console.log(
    `[workspace_pptx] generation complete workspaceId=${workspaceId} generationId=${generationId} credits_used=${status.credits?.used ?? '?'} credits_remaining=${status.credits?.remaining ?? '?'}`,
  );

  return {
    status: 'complete',
    result: {
      generationId: status.generationId,
      gammaUrl: status.gammaUrl ?? '',
      exportUrl: status.exportUrl,
      filename,
      cached: false,
      generatedAt,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Generalized Gamma export — pdf + carousel + sections support
// ──────────────────────────────────────────────────────────────────────
//
// `startGeneration` / `checkGeneration` above are pptx-only and read the
// hojas directly out of `studio_workspace_nodes`. For modo nodos (the
// ReactFlow grafo) the runner consolidates specialist outputs into a
// `BranchSection[]` array and ships them to the export endpoint without
// ever materializing hojas — those sections must drive the deck source
// directly.
//
// Rather than refactor `startGeneration` (which would risk regressing
// the proven pptx flow), the generic helpers below run side-by-side:
//   - `startGammaExport`  — accepts {format, exportAs, sections?, title?}
//   - `checkGammaExport`  — generation-id status check (no caching)
//
// Cache: skipped on this path. Modo nodos generations are user-driven
// and cheap to re-kick; the URL-cached `last_pptx` row only makes sense
// for the workspace-canvas pptx button (one deck per workspace).

/** Public extension hooks for the generalized helper. Kept narrow so
 *  routes can pass through user input without rebuilding the union by
 *  hand. */
export interface GammaExportInput {
  /** Workspace ownership gate — verified against studio_workspaces.user_id. */
  workspaceId: string;
  userId: string | null;
  /** Gamma `format` (presentation | document | social | webpage). */
  format: GammaFormat;
  /** Gamma `exportAs` (pptx | pdf | png) — what file the user downloads. */
  exportAs: GammaExportAs;
  /** Pre-consolidated sections from the modo nodos runner. Each section
   *  becomes one card slide with `# title` + `content`. */
  sections: BranchSection[];
  /** Cover title. Falls back to the workspace row's title. */
  title?: string;
  /** Cover subtitle / dek. Falls back to workspace.description. */
  subtitle?: string;
  /** Per-call branding/context options (tono, audiencia, etc). */
  options?: PptxOptions;
}

export type StartGammaExportResult =
  | {
      status: 'complete';
      result: {
        generationId: string;
        gammaUrl: string;
        exportUrl: string;
        filename: string;
        cached: false;
        generatedAt: string;
      };
    }
  | {
      status: 'pending';
      generationId: string;
      filename: string;
    };

export type CheckGammaExportResult =
  | {
      status: 'complete';
      result: {
        generationId: string;
        gammaUrl: string;
        exportUrl: string;
        filename: string;
        cached: false;
        generatedAt: string;
      };
    }
  | { status: 'pending'; generationId: string }
  | { status: 'failed'; generationId: string; error: string };

/**
 * Compose deck source markdown from a list of sections. One `# title`
 * heading per section, separated by `\n---\n` so Gamma's
 * `cardSplit:'inputTextBreaks'` lays them out as one card per section.
 *
 * Cover slide is prepended when `title` is provided.
 */
function buildSectionsInputText(input: {
  title?: string;
  subtitle?: string;
  sections: BranchSection[];
}): string {
  const lines: string[] = [];
  if (input.title) {
    lines.push(`# ${input.title}`);
    if (input.subtitle) lines.push('', input.subtitle);
    lines.push(
      '',
      `_${input.sections.length} sección${input.sections.length === 1 ? '' : 'es'} · Shifty Studio_`,
    );
  }
  for (const s of input.sections) {
    lines.push('', '---', '');
    lines.push(`# ${s.title}`);
    if (s.content && s.content.trim()) lines.push('', s.content.trim());
  }
  return lines.join('\n').slice(0, 400_000);
}

/** Map exportAs → file extension for the download filename. */
function extensionForExportAs(exportAs: GammaExportAs): string {
  switch (exportAs) {
    case 'pptx':
      return 'pptx';
    case 'pdf':
      return 'pdf';
    case 'png':
      return 'png';
  }
}

/**
 * Sections-driven Gamma kickoff. No cache — every call burns Gamma
 * credits. Caller is responsible for de-bouncing repeated clicks.
 *
 * Throws WorkspaceNotFoundError if the workspace doesn't exist or doesn't
 * belong to userId, or GammaApiError on Gamma create failures.
 */
export async function startGammaExport(
  input: GammaExportInput,
): Promise<StartGammaExportResult> {
  const { workspaceId, userId, format, exportAs, sections } = input;
  if (!userId) throw new Error('user_id required for startGammaExport');
  if (!supabaseAdmin)
    throw new Error('supabase admin client not configured for startGammaExport');
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new GammaApiError('sections array required and non-empty', 'bad_request');
  }

  // Ownership gate. We re-fetch the workspace row to lift the title
  // for the filename (when the caller didn't pass one) and to confirm
  // the row belongs to this user before burning Gamma credits.
  const { data: ws, error: wsErr } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id, title, description')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (wsErr || !ws) throw new WorkspaceNotFoundError();
  const workspace = ws as { id: string; title: string; description: string | null };

  const titleForCover = input.title ?? workspace.title;
  const subtitleForCover = input.subtitle ?? workspace.description ?? undefined;
  const safeName = safeFilenameFromTitle(titleForCover);
  const filename = `${safeName}.${extensionForExportAs(exportAs)}`;

  const inputText = buildSectionsInputText({
    title: titleForCover,
    subtitle: subtitleForCover,
    sections,
  });

  const created = await createGeneration({
    inputText,
    format,
    exportAs,
    cardSplit: 'inputTextBreaks',
    textMode: 'preserve',
    textOptions: { language: 'es-419', tone: 'professional' },
    imageOptions: { source: 'aiGenerated' },
    cardOptions: {
      // Carousel/social usually wants square or portrait. Gamma's
      // `social` format defaults to a fluid card; we leave dimensions
      // off for non-presentation formats so Gamma picks the right one.
      ...(format === 'presentation' ? { dimensions: '16x9' as const } : {}),
    },
    additionalInstructions: buildAdditionalInstructions(input.options),
  });

  console.log(
    `[workspace_gamma] kicked off workspaceId=${workspaceId} format=${format} exportAs=${exportAs} sections=${sections.length} generationId=${created.generationId} chars=${inputText.length}`,
  );

  return { status: 'pending', generationId: created.generationId, filename };
}

/**
 * Single-shot status check for a generic Gamma generation kicked off via
 * `startGammaExport`. Mirrors `checkGeneration` minus the `last_pptx`
 * cache write — sections-driven exports are not cached.
 */
export async function checkGammaExport(
  input: {
    generationId: string;
    workspaceId: string;
    userId: string | null;
    /** Used to derive the download filename suffix. */
    exportAs: GammaExportAs;
    /** Optional explicit title, falls back to workspace.title. */
    title?: string;
  },
): Promise<CheckGammaExportResult> {
  const { generationId, workspaceId, userId, exportAs } = input;
  if (!userId) throw new Error('user_id required for checkGammaExport');
  if (!supabaseAdmin)
    throw new Error('supabase admin client not configured for checkGammaExport');

  const { data: ws, error: wsErr } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id, title')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (wsErr || !ws) throw new WorkspaceNotFoundError();
  const workspace = ws as { id: string; title: string };
  const titleForFilename = input.title ?? workspace.title;
  const safeName = safeFilenameFromTitle(titleForFilename);
  const filename = `${safeName}.${extensionForExportAs(exportAs)}`;

  let status;
  try {
    status = await getGenerationStatus(generationId);
  } catch (err) {
    if (err instanceof GammaApiError && err.code === 'failed') {
      return { status: 'failed', generationId, error: err.message };
    }
    throw err;
  }

  if (status.status === 'failed') {
    return {
      status: 'failed',
      generationId,
      error: status.error?.message ?? 'gamma:generation failed',
    };
  }

  if (status.status !== 'completed') {
    return { status: 'pending', generationId };
  }

  if (!status.exportUrl) {
    return {
      status: 'failed',
      generationId,
      error: `gamma:generation ${generationId} completed but no exportUrl present`,
    };
  }

  const generatedAt = new Date().toISOString();
  return {
    status: 'complete',
    result: {
      generationId: status.generationId,
      gammaUrl: status.gammaUrl ?? '',
      exportUrl: status.exportUrl,
      filename,
      cached: false,
      generatedAt,
    },
  };
}
