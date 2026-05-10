/**
 * @file store/index.ts
 * @description Single source of truth for the modo-nodos graph store.
 *
 * Until D1 (2026-05-10) Studio kept two parallel zustand stores behind the
 * `VITE_USE_GRAPH_V2` flag — V1 (`useGraphStore.ts`, local-exec, hit the
 * legacy `/api/export` proxy) and V2 (`useGraphStoreV2.ts`, wired to the
 * Cerebro `/graph/*` SSE stream and to `/api/workspace/:id/export`). V1
 * was deprecated when Wave C wired V2's `runExportNode` to the correct
 * workspace-scoped export, and the legacy `/api/export` path is removed
 * by Wave D2 in parallel with this file.
 *
 * V1 is now deleted. Every consumer goes through `useActiveGraphStore`
 * which is just a re-export of `useGraphStoreV2`. The flag is no longer
 * read — kept only as a deprecation log for environments still setting
 * it explicitly.
 */
import { useGraphStoreV2 } from './useGraphStoreV2';

if (
  typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_USE_GRAPH_V2 === 'false' &&
  typeof console !== 'undefined'
) {
  // Surface a one-shot warning so anyone still toggling the flag in CI
  // or local .env files gets a hint that it's a no-op now.
  console.warn(
    '[store] VITE_USE_GRAPH_V2=false is ignored — V1 was removed in D1 (2026-05-10). The graph store is now V2-only.',
  );
}

/** @deprecated kept for reverse-compat; V1 is gone, this is always true. */
export const isV2Enabled = true;

/**
 * Single entry point for the modo-nodos graph store. Backed by
 * `useGraphStoreV2` since D1 (2026-05-10).
 */
export const useActiveGraphStore = useGraphStoreV2;

// Re-export the public types so consumers don't need to know which file
// the store lives in. Mirrors the surface that `useGraphStore.ts` used to
// expose pre-D1 (ShareWorkflowModal imports `Snapshot` + `AppNode`).
export type { AppNode, Snapshot } from './useGraphStoreV2';
