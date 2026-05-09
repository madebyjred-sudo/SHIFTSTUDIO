/**
 * workspace-broadcast — multi-tab event sync via BroadcastChannel.
 *
 * Why this exists
 * ───────────────
 * If a user has the same workspace open in two tabs (Tab A + Tab B) the
 * debounced auto-save in each tab is unaware of the other. A typical
 * silent-data-loss flow:
 *
 *   1. User edits hoja H in Tab A → 800ms debounce → PATCH lands.
 *   2. Tab B still holds the stale `content.md` it loaded on mount.
 *   3. User pivots to Tab B and edits hoja H → Tab B's debounce flushes
 *      and PATCHes the *stale* content over Tab A's fresh write. Last
 *      write wins, Tab A's edit is silently obliterated.
 *
 * Same shape applies to chat clears (Tab A clears, Tab B keeps writing
 * into a deleted thread), hoja delete/add, and workspace title rename.
 *
 * BroadcastChannel is the cheapest way to fan out same-origin tab events
 * without a server roundtrip. We key per-workspace so unrelated workspaces
 * in other tabs don't wake up each other's listeners.
 *
 * Conflict resolution lives in the *consumer* — this module is the
 * transport, not the merge strategy. See HojaNode for the timestamp
 * tie-break + in-flight-edit banner.
 *
 * Fallback: BroadcastChannel ships in every modern evergreen browser but
 * is missing on Safari < 15.4 and a few embedded WebViews. The factory
 * returns null on those engines and the helpers degrade to no-ops — sync
 * just doesn't happen, which is the same behavior as before this module
 * existed.
 */

export type WorkspaceEvent =
  | { type: 'hoja_updated'; nodeId: string; content: { md: string }; updatedAt: number }
  | { type: 'hoja_deleted'; nodeId: string }
  | { type: 'hoja_added'; nodeId: string }
  | { type: 'chat_cleared' }
  | { type: 'chat_message_added'; messageId: string }
  | { type: 'workspace_title_changed'; title: string };

/**
 * Construct a workspace-scoped BroadcastChannel, or null if the API is
 * unavailable. Callers must handle the null return path explicitly so
 * the lack of sync is observable rather than silently swallowed.
 */
export function workspaceChannel(workspaceId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(`studio-workspace-${workspaceId}`);
}

/**
 * Fire-and-forget event emitter. Opens a fresh channel, posts, closes.
 *
 * We close immediately because the BroadcastChannel object holds a strong
 * reference back into the messaging port and is not garbage-collected
 * while it's "open" — long-lived emitters (one per render in a hot path)
 * would slowly leak. The receivers' channels stay open via
 * `listenWorkspaceEvents` and pick up the message regardless.
 */
export function emitWorkspaceEvent(workspaceId: string, evt: WorkspaceEvent): void {
  const ch = workspaceChannel(workspaceId);
  if (!ch) return;
  try {
    ch.postMessage(evt);
  } finally {
    ch.close();
  }
}

/**
 * Subscribe to workspace events. Returns an unsubscribe thunk that the
 * caller MUST invoke on unmount (typical React useEffect return).
 *
 * The handler runs synchronously inside the channel's message dispatch;
 * keep it cheap or trampoline expensive work via setTimeout/queueMicrotask.
 */
export function listenWorkspaceEvents(
  workspaceId: string,
  handler: (evt: WorkspaceEvent) => void,
): () => void {
  const ch = workspaceChannel(workspaceId);
  if (!ch) return () => {};
  const onMessage = (e: MessageEvent<WorkspaceEvent>) => handler(e.data);
  ch.addEventListener('message', onMessage);
  return () => {
    ch.removeEventListener('message', onMessage);
    ch.close();
  };
}
