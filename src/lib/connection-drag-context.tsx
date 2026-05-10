import { createContext, useContext } from 'react';

/**
 * Connection drag state — published by ShiftyNodeCanvas during a handle
 * drag, consumed by node components so their handles can self-style
 * (valid → glow, invalid → atenuar).
 *
 * Decoupled from the zustand store on purpose: this is ephemeral UI
 * state that only matters between `onConnectStart` and `onConnectEnd`.
 * Putting it in the store would trigger autosave and pollute the undo
 * history with non-meaningful changes.
 */
export interface ConnectionDragState {
  /** True between onConnectStart and onConnectEnd. */
  active: boolean;
  /** Node id that originated the drag (null when inactive). */
  sourceNodeId: string | null;
  /** Node type that originated the drag — used by validateConnection. */
  sourceNodeType: string | null;
}

export const INITIAL_CONNECTION_DRAG_STATE: ConnectionDragState = {
  active: false,
  sourceNodeId: null,
  sourceNodeType: null,
};

export const ConnectionDragContext = createContext<ConnectionDragState>(
  INITIAL_CONNECTION_DRAG_STATE,
);

export function useConnectionDrag(): ConnectionDragState {
  return useContext(ConnectionDragContext);
}
