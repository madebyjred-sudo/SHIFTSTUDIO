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
 * Contract:
 *   - Verify the workspace exists and belongs to userId.
 *   - If !force AND last_pptx is < 1h old (and options match), return cached.
 *   - Else: compose markdown from hojas, call Gamma generateAndWait, persist
 *     last_pptx, return the result.
 *   - Errors propagate as GammaApiError so callers can map to HTTP / UI.
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
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { generateAndWait } from './gammaApi.js';

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

/**
 * Run the full pptx export flow. Returns either the cached or freshly-
 * generated deck metadata. Throws WorkspaceNotFoundError if the workspace
 * doesn't exist or doesn't belong to userId, or GammaApiError on Gamma
 * failures.
 */
export async function runWorkspacePptxExport(
  opts: RunOpts,
): Promise<WorkspacePptxResult> {
  const { workspaceId, userId, force = false } = opts;
  if (!userId) throw new Error('user_id required for runWorkspacePptxExport');
  if (!supabaseAdmin)
    throw new Error('supabase admin client not configured for runWorkspacePptxExport');

  // ── Load workspace ────────────────────────────────────────────────
  // Studio's migration 0003 guarantees last_pptx exists, so no fallback
  // retry needed (CL2 had to support pre-migration envs).
  type WsRow = {
    id: string;
    title: string;
    description: string | null;
    last_pptx?:
      | (WorkspacePptxResult & { creditsUsed?: number; options?: PptxOptions })
      | null;
  };
  const { data: ws, error: wsErr } = await supabaseAdmin
    .from('studio_workspaces')
    .select('id, title, description, last_pptx')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (wsErr || !ws) throw new WorkspaceNotFoundError();
  const workspace = ws as unknown as WsRow;

  const safeName =
    (workspace.title ?? 'workspace')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'workspace';

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
    // Stable stringify so {tono, audiencia} and {audiencia, tono} hash
    // the same. Default JSON.stringify preserves insertion order, which
    // means a different client-side form mount order would silently bust
    // the cache and burn Gamma credits.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stableStringify = (o: any): string => {
      if (o == null) return 'null';
      if (typeof o !== 'object') return JSON.stringify(o);
      if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
    };
    const optionsChanged = opts.options
      ? stableStringify(opts.options) !== stableStringify(cache.options ?? null)
      : false;
    if (ageMs >= 0 && ageMs < oneHour && !optionsChanged) {
      console.log(
        `[workspace_pptx] cache hit workspaceId=${workspaceId} ageMs=${ageMs} generationId=${cache.generationId}`,
      );
      return {
        generationId: cache.generationId,
        gammaUrl: cache.gammaUrl,
        exportUrl: cache.exportUrl,
        filename: `${safeName}.pptx`,
        cached: true,
        generatedAt: cache.generatedAt,
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

  // ── Call Gamma ────────────────────────────────────────────────────
  const gen = await generateAndWait(
    {
      inputText,
      format: 'presentation',
      exportAs: 'pptx',
      cardSplit: 'inputTextBreaks',
      textMode: 'preserve',
      textOptions: { language: 'es-419', tone: 'professional' },
      imageOptions: { source: 'aiGenerated' },
      cardOptions: { dimensions: '16x9' },
      additionalInstructions: buildAdditionalInstructions(
        // Use explicit options when caller passed them, else fall back to
        // whatever the user saved last time on this workspace, else nothing.
        opts.options ?? workspace.last_pptx?.options ?? undefined,
      ),
    },
    { maxDurationMs: 5 * 60 * 1000 },
  );
  const generatedAt = new Date().toISOString();

  // ── Persist cache (best-effort) ───────────────────────────────────
  // Stash the options we used too — next time the user opens the modal
  // it pre-populates with their last choices, so they're not re-typing
  // "tono ejecutivo" every time.
  const cachePayload = {
    generationId: gen.generationId,
    gammaUrl: gen.gammaUrl,
    exportUrl: gen.exportUrl,
    generatedAt,
    options: opts.options ?? workspace.last_pptx?.options ?? undefined,
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
    `[workspace_pptx] generated workspaceId=${workspaceId} hojas=${ordered.length} generationId=${gen.generationId} chars=${inputText.length}`,
  );

  return {
    generationId: gen.generationId,
    gammaUrl: gen.gammaUrl ?? '',
    exportUrl: gen.exportUrl,
    filename: `${safeName}.pptx`,
    cached: false,
    generatedAt,
  };
}
