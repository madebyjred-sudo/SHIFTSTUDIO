import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Panel,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Viewport,
  type OnConnectStart,
  type OnConnectEnd,
} from '@xyflow/react';
import { Play, Square, LayoutGrid, Loader2, Check, AlertCircle, CloudOff, MessageSquare, Sparkles } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { useActiveGraphStore } from '../store';
import { useGraphStoreV2 } from '../store/useGraphStoreV2';
import { AgentStepper } from './AgentStepper';
import { ContextNode } from './nodes/ContextNode';
import { SpecialistNode } from './nodes/SpecialistNode';
import { ExportNode } from './nodes/ExportNode';
import { GraphChatSidebar } from './nodes/GraphChatSidebar';
import { GraphCommandBar, type GraphCommandBarHandle } from './nodes/GraphCommandBar';
import { GraphTemplateGallery, consumeFirstVisitFlag } from './nodes/GraphTemplateGallery';
import { AnimatedEdge } from './edges/AnimatedEdge';
import { HITLModal } from './HITLModal';
import { CanvasContextMenu } from './CanvasContextMenu';
import { TimeTravelTimeline } from './TimeTravelTimeline';
import { ShareWorkflowModal } from './ShareWorkflowModal';
import { Share2 } from 'lucide-react';
import { getLayoutedElements } from '../utils/layoutGraph';
import { getGraph, saveGraph } from '../services/workspaceApi';
import {
  ConnectionDragContext,
  INITIAL_CONNECTION_DRAG_STATE,
  type ConnectionDragState,
} from '../lib/connection-drag-context';
import { validateConnection } from '../lib/graph-rules';

const nodeTypes = {
  context: ContextNode,
  specialist: SpecialistNode,
  export: ExportNode,
  // Architect backend node types map to xyflow display types
  contexto: ContextNode,
  agente: SpecialistNode,
  entrega: ExportNode,
};

const edgeTypes = {
  animated: AnimatedEdge,
};

/**
 * Connection validation rules live in `src/lib/graph-rules.ts` as a pure
 * function — reused here for ReactFlow's isValidConnection and by every
 * node component to drive its handle-highlight state during a drag.
 */

// ─── Autosave plumbing ───────────────────────────────────────────────
//
// D3 (2026-05-10): the modo-nodos graph state was previously in-memory
// only — a refresh wiped it. The Wave A1 backend (`studio_workspace_graphs`)
// + the GET/PUT routes give us durable storage; this hook wires zustand
// changes to a debounced PUT and shows the user a save status badge.
//
// Constraints:
//   - Hydrate ONCE on mount; later workspaceId changes (not expected
//     today since the canvas unmounts when switching) re-hydrate.
//   - Debounce 2000ms — long enough that a continuous drag doesn't fan
//     out one save per pixel, short enough that a manual edit feels
//     "saved" before the user reaches for refresh.
//   - Single in-flight PUT — if changes happen during a save, set the
//     "dirty again" flag and trigger another save once the current one
//     resolves. No concurrent PUTs.
//   - Exponential backoff on failure (1s → 2s → 5s → 10s → give up,
//     keep state "error" until the next change). The user's "no
//     guardó" badge is the real feedback channel; we don't toast.
//
// Status states: 'idle' (nothing to save yet) / 'unsaved' (dirty, debounce
// pending) / 'saving' (PUT in flight) / 'saved' (PUT ok, idle) / 'error'
// (last attempt failed). Badge below renders all five.

type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 2000;
const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10_000];

/**
 * Coerce the xyflow Viewport (object with possibly `Inf`/NaN under
 * weird race conditions) into the on-the-wire shape, or null if the
 * canvas hasn't moved yet. The server validator rejects non-finite
 * numbers with a 400, so we filter here.
 */
function safeViewport(v: Viewport | undefined): { x: number; y: number; zoom: number } | null {
  if (!v) return null;
  if (
    !Number.isFinite(v.x) ||
    !Number.isFinite(v.y) ||
    !Number.isFinite(v.zoom)
  ) {
    return null;
  }
  return { x: v.x, y: v.y, zoom: v.zoom };
}

function ShiftyNodeCanvasInner() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    isExecuting,
    executeGraph,
    cancelExecution,
    undo,
    redo,
    setNodes,
    setEdges,
  } = useActiveGraphStore();
  const [menu, setMenu] = useState<{ id: string | null; top: number; left: number; type: 'pane' | 'node' | 'edge' } | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  // Wave-D: chat sidebar visibility + command bar focus handle. Both
  // surfaces share `useGraphArchitectChat` state via localStorage scope.
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const commandBarRef = useRef<GraphCommandBarHandle | null>(null);
  // Wave-E: template gallery state. First-visit auto-open runs once
  // per browser via the localStorage flag in `consumeFirstVisitFlag`.
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const { fitView, getViewport, setViewport } = useReactFlow();

  // Workspace id is set by `WorkspaceCanvasPage` on mount via the V2
  // store; in the legacy global "canvas mode" (App.tsx, no workspace
  // context) it's null and autosave gracefully no-ops with a hint.
  const workspaceId = useGraphStoreV2((s) => s.workspaceId);

  // ─── Autosave state ───────────────────────────────────────────────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Track hydration so the first store-set from the server doesn't
  // immediately re-fire a save with the same payload.
  const hydratedRef = useRef(false);
  // Debounce + queue plumbing.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  const pendingSaveRef = useRef(false);
  const backoffAttemptRef = useRef(0);
  // Capture the CURRENT viewport at save time. The store doesn't track
  // viewport (xyflow owns it), so we read it via `getViewport` — but
  // only if the canvas has actually moved (we set this ref in onMoveEnd).
  const lastViewportRef = useRef<Viewport | null>(null);

  // Force a re-render so the "guardado · hace N s" relative time stays
  // honest while idle. Cheap (no work for the badge subtree).
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (saveStatus !== 'saved' || lastSavedAt === null) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [saveStatus, lastSavedAt]);

  // ─── Hydration ────────────────────────────────────────────────────
  useEffect(() => {
    // Reset hydration when workspace changes so re-mounting doesn't
    // leak state across workspaces.
    hydratedRef.current = false;
    if (!workspaceId) {
      // Legacy chat-mode canvas — no persistence target.
      setSaveStatus('idle');
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setSaveStatus('idle');
    getGraph(workspaceId, ac.signal)
      .then((graph) => {
        if (cancelled) return;
        // Hydrate the store via the public setters. V2.setNodes only
        // calls takeSnapshot() when the previous nodes array was
        // non-empty, so on a fresh canvas this won't pollute the undo
        // history; on a re-hydrate we accept the snapshot as the
        // baseline (user can still ctrl-z to revert).
        setNodes(graph.nodes as Parameters<typeof setNodes>[0]);
        setEdges(graph.edges as Parameters<typeof setEdges>[0]);
        if (graph.viewport) {
          // Schedule on the next tick — ReactFlow needs the nodes
          // committed before applying a viewport, otherwise the
          // re-layout fitView() racing on the next render snaps it back.
          setTimeout(() => {
            if (cancelled) return;
            try {
              setViewport(graph.viewport!, { duration: 0 });
              lastViewportRef.current = graph.viewport;
            } catch {
              /* xyflow not ready yet — non-fatal, viewport stays default */
            }
          }, 0);
        }
        // Mark hydrated AFTER the setters have flushed so the change
        // subscription below ignores the hydration writes.
        setTimeout(() => {
          if (!cancelled) hydratedRef.current = true;
        }, 0);
        setLastSavedAt(graph.updated_at ? Date.parse(graph.updated_at) : null);
        setSaveStatus(graph.updated_at ? 'saved' : 'idle');
      })
      .catch((err) => {
        if (cancelled || ac.signal.aborted) return;
        // Hydration failure is non-fatal — the user can still build a
        // graph and the autosave will try to PUT on the next change.
        // Mark hydrated so changes don't get blocked indefinitely.
        console.error('[ShiftyNodeCanvas] graph hydration failed:', err);
        hydratedRef.current = true;
        setSaveStatus('error');
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [workspaceId, setNodes, setEdges, setViewport]);

  // ─── Wave-E: first-visit gallery auto-open ─────────────────────────
  // Open the template gallery once per browser the first time the user
  // lands on modo nodos. The flag is consumed on read so subsequent
  // visits go straight to the empty canvas (with the "+ Template"
  // button available in the top-right panel). We schedule this on a
  // microtask after hydration so the gallery doesn't race the autosave.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (consumeFirstVisitFlag()) setShowTemplateGallery(true);
    }, 400);
    return () => window.clearTimeout(t);
    // Intentionally empty deps — run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Save runner ──────────────────────────────────────────────────
  // Pulled out so it can be invoked from the debounce callback AND
  // from the in-flight completion handler (queued save).
  const runSave = useCallback(async () => {
    if (!workspaceId) return;
    // Already in flight — flag a follow-up so we don't lose the latest
    // state, then bail.
    if (inflightRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    const ac = new AbortController();
    inflightRef.current = ac;
    setSaveStatus('saving');

    // Read state at save time, not at debounce-schedule time, so a save
    // queued during a long backoff still ships the latest graph.
    const stateNow = useGraphStoreV2.getState();
    const viewport = safeViewport(getViewport());
    lastViewportRef.current = viewport;

    // Wave-D: strip transient diff-animation flags before persisting.
    // `diffState` + `__pendingRemoval` are set by `applyGraphWithDiff`
    // and cleared after the animation. Persisting them would replay the
    // animation on the next hydration (or worse — leak pendingRemoval
    // ghosts onto the canvas). Skip pendingRemoval nodes entirely so a
    // save that races the cleanup doesn't ship deleted nodes.
    const sanitizedNodes = stateNow.nodes
      .filter((n) => {
        const data = n.data as { __pendingRemoval?: boolean } | undefined;
        return !data?.__pendingRemoval;
      })
      .map((n) => {
        const data = (n.data ?? {}) as Record<string, unknown>;
        if (!('diffState' in data) && !('__pendingRemoval' in data)) return n;
        const { diffState: _d, __pendingRemoval: _p, ...rest } = data;
        return { ...n, data: rest };
      });

    try {
      const result = await saveGraph(
        workspaceId,
        {
          nodes: sanitizedNodes as unknown as Record<string, unknown>[],
          edges: stateNow.edges as unknown as Record<string, unknown>[],
          viewport,
        },
        ac.signal,
      );
      backoffAttemptRef.current = 0;
      setLastSavedAt(result.updated_at ? Date.parse(result.updated_at) : Date.now());
      // If a change happened while the PUT was in flight, run the next
      // save right after this one resolves. Status flips back to
      // "unsaved" briefly, then "saving" on the next tick.
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        inflightRef.current = null;
        setSaveStatus('unsaved');
        // Tail-call via the debounce so we get coalescing if the user
        // is still typing quickly, and so the followup doesn't hammer
        // the server.
        scheduleSaveRef.current();
      } else {
        inflightRef.current = null;
        setSaveStatus('saved');
      }
    } catch (err) {
      inflightRef.current = null;
      // Aborted (workspace switched mid-save) — don't surface as error.
      if (ac.signal.aborted) {
        setSaveStatus('idle');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ShiftyNodeCanvas] saveGraph failed:', msg);
      setSaveStatus('error');
      // Exponential backoff. After the schedule is exhausted we stop
      // retrying and wait for the next user change to trigger a save.
      const idx = backoffAttemptRef.current;
      if (idx < BACKOFF_SCHEDULE_MS.length) {
        backoffAttemptRef.current += 1;
        setTimeout(() => {
          // Only retry if no successful save has happened in the
          // meantime (e.g. the user kept editing and the debounce
          // already kicked a fresh save).
          if (saveStatusRef.current === 'error') {
            void runSave();
          }
        }, BACKOFF_SCHEDULE_MS[idx]);
      }
    }
  }, [workspaceId, getViewport]);

  // Mirror the latest saveStatus into a ref so the backoff timer's
  // closure reads the current value rather than its captured snapshot.
  const saveStatusRef = useRef<SaveStatus>('idle');
  useEffect(() => {
    saveStatusRef.current = saveStatus;
  }, [saveStatus]);

  // Wrap runSave in a ref so the debounce-firing closure (and the
  // tail-call on completion) always pick up the latest function
  // identity. Avoids stale-workspaceId saves across re-mounts.
  // We update the ref in a layout effect — never during render, which
  // would otherwise be a React rules violation under StrictMode.
  const scheduleSaveRef = useRef<() => void>(() => {});
  useEffect(() => {
    scheduleSaveRef.current = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runSave();
      }, AUTOSAVE_DEBOUNCE_MS);
    };
  }, [runSave]);

  // ─── Mark dirty + schedule save on store changes ──────────────────
  useEffect(() => {
    if (!workspaceId) return;
    // Subscribe directly to the V2 store. We watch nodes + edges
    // identity; xyflow gives us new arrays on every interaction so a
    // simple `===` compare is enough. Viewport changes fire through
    // onMoveEnd separately (see below).
    const unsub = useGraphStoreV2.subscribe((state, prev) => {
      if (!hydratedRef.current) return;
      if (state.nodes === prev.nodes && state.edges === prev.edges) return;
      setSaveStatus((s) => (s === 'saving' ? s : 'unsaved'));
      scheduleSaveRef.current();
    });
    return () => {
      unsub();
    };
  }, [workspaceId]);

  // Cleanup pending timers + abort in-flight save on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (inflightRef.current) inflightRef.current.abort();
    };
  }, []);

  // F3 — E2E hook: when the URL carries `?e2e=1`, expose the V2 graph
  // store on `window.__studioGraphStore` so Playwright specs can inject
  // nodes/edges directly via `page.evaluate` (drag&drop is flake-prone
  // in xyflow). The hook is a no-op in production (the query param is
  // never set there) and is removed on unmount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('e2e') !== '1') return;
    (window as unknown as { __studioGraphStore?: typeof useGraphStoreV2 }).__studioGraphStore = useGraphStoreV2;
    return () => {
      try {
        delete (window as unknown as { __studioGraphStore?: typeof useGraphStoreV2 }).__studioGraphStore;
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Keyboard shortcuts (Ctrl+Z / Cmd+Z + Wave-D Cmd+K / Cmd+/)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const inEditable =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA';

      // Wave-D shortcuts work even when an input is focused (so the
      // user can refocus the command bar from anywhere). Undo/redo
      // continue to ignore inputs to avoid clobbering text edits.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        commandBarRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setChatSidebarOpen((prev) => !prev);
        return;
      }

      if (inEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    setMenu({ id: null, top: event.clientY, left: event.clientX, type: 'pane' });
  }, []);

  const onNodeContextMenu = useCallback((event: React.MouseEvent | MouseEvent, node: any) => {
    event.preventDefault();
    setMenu({ id: node.id, top: event.clientY, left: event.clientX, type: 'node' });
  }, []);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent | MouseEvent, edge: any) => {
    event.preventDefault();
    setMenu({ id: edge.id, top: event.clientY, left: event.clientX, type: 'edge' });
  }, []);

  const onPaneClick = useCallback(() => {
    setMenu(null);
  }, []);

  // Connection validation — prevent invalid edge types. Delegates to
  // the pure rule in `lib/graph-rules` so tooltip + handle highlight
  // + the actual drop guard agree byte-for-byte.
  const isValidConnection = useCallback((connection: Connection | { source: string | null; target: string | null }) => {
    const sourceNode = nodes.find(n => n.id === connection.source);
    if (!sourceNode) return false;
    const targetNode = nodes.find(n => n.id === connection.target);
    if (!targetNode) return false;
    const sourceType = (sourceNode.type || 'specialist') as string;
    const targetType = (targetNode.type || 'specialist') as string;
    return validateConnection(sourceType, targetType).valid;
  }, [nodes]);

  // ─── Connection drag feedback (F2) ──────────────────────────────────
  //
  // While the user is dragging a connection (between onConnectStart and
  // onConnectEnd), we publish the source node-id + type via context so
  // every node can self-style its handles (valid → glow, invalid →
  // attenuate). We also track cursor position to position the floating
  // tooltip, and the current hover target (if any) to decide what
  // message to show.
  const [dragState, setDragState] = useState<ConnectionDragState>(INITIAL_CONNECTION_DRAG_STATE);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; reason: string; variant: 'error' | 'info' } | null>(null);
  // Persistent error tooltip after a failed drop. Cleared on next user
  // action (drag start, click, ...) or after 2s.
  const persistentTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Shake state — keyed by node id so we can re-trigger the same node
  // by remounting the className.
  const [shakeKey, setShakeKey] = useState<{ nodeId: string; n: number } | null>(null);

  const clearPersistentTooltip = useCallback(() => {
    if (persistentTooltipTimerRef.current) {
      clearTimeout(persistentTooltipTimerRef.current);
      persistentTooltipTimerRef.current = null;
    }
  }, []);

  const onConnectStart = useCallback<OnConnectStart>(
    (_event, { nodeId, handleType }) => {
      // We only track outbound drags (source handle). Target-handle
      // drags aren't part of our spec.
      if (!nodeId || handleType !== 'source') return;
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const sourceNodeType = (node.type || 'specialist') as string;
      clearPersistentTooltip();
      setTooltip(null);
      setDragState({ active: true, sourceNodeId: nodeId, sourceNodeType });
    },
    [nodes, clearPersistentTooltip],
  );

  // Cursor-tracking while dragging — keeps the tooltip near the pointer
  // and updates the message based on what's hovered. We only attach the
  // listener while `dragState.active` is true so the canvas stays cheap
  // when idle.
  useEffect(() => {
    if (!dragState.active) return;
    const handleMove = (event: MouseEvent) => {
      // Walk up from the event target to find a node element; xyflow
      // tags each node wrapper with `.react-flow__node-<type>`.
      const target = event.target as HTMLElement | null;
      const nodeEl = target?.closest('.react-flow__node') as HTMLElement | null;
      const hoverNodeId = nodeEl?.getAttribute('data-id') ?? null;

      if (!hoverNodeId || hoverNodeId === dragState.sourceNodeId) {
        // Over the pane (or back over source) — no tooltip yet.
        setTooltip(null);
        return;
      }
      const hoverNode = nodes.find(n => n.id === hoverNodeId);
      if (!hoverNode) {
        setTooltip(null);
        return;
      }
      const targetType = (hoverNode.type || 'specialist') as string;
      const result = validateConnection(dragState.sourceNodeType, targetType);
      if (result.valid) {
        // Valid hover — no tooltip needed, the green glow on the handle
        // is the affordance. Avoids visual clutter.
        setTooltip(null);
        return;
      }
      setTooltip({
        x: event.clientX,
        y: event.clientY,
        reason: result.reason ?? 'No se puede conectar.',
        variant: 'error',
      });
    };
    window.addEventListener('mousemove', handleMove);
    return () => window.removeEventListener('mousemove', handleMove);
  }, [dragState, nodes]);

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      // Capture the resolved drag before clearing the local state, then
      // decide whether to show the failure UX.
      const finalSourceNodeId = dragState.sourceNodeId;
      const finalSourceType = dragState.sourceNodeType;
      const wasActive = dragState.active;
      setDragState(INITIAL_CONNECTION_DRAG_STATE);
      if (!wasActive || !finalSourceNodeId) return;

      // xyflow's FinalConnectionState exposes `toHandle`/`toNode` when
      // the drop landed on a handle. We compute the target type from
      // those when available; otherwise the drop was on the pane and we
      // skip the failure animation (xyflow handles pane-drop as no-op).
      const cs = connectionState as unknown as { toNode?: { type?: string; id?: string } | null; toHandle?: { nodeId?: string } | null };
      const toType = cs.toNode?.type;
      const toNodeId = cs.toNode?.id;

      // No drop target → not a "failed" attempt, just an abandoned drag.
      if (!toType || !toNodeId || toNodeId === finalSourceNodeId) return;

      const result = validateConnection(finalSourceType, toType);
      if (result.valid) return; // Successful drop — xyflow already wired the edge.

      // Failed drop: shake the source card, surface the reason for 2s.
      setShakeKey({ nodeId: finalSourceNodeId, n: Date.now() });
      // Position the persistent tooltip near the release point so the
      // user sees it where they let go. Handle both Mouse and Touch.
      let px = window.innerWidth / 2;
      let py = window.innerHeight / 2;
      const me = event as MouseEvent;
      if (typeof me.clientX === 'number' && typeof me.clientY === 'number') {
        px = me.clientX;
        py = me.clientY;
      } else {
        const te = event as TouchEvent;
        const touch = te.changedTouches?.[0];
        if (touch) {
          px = touch.clientX;
          py = touch.clientY;
        }
      }
      setTooltip({ x: px, y: py, reason: result.reason ?? 'No se puede conectar.', variant: 'error' });
      clearPersistentTooltip();
      persistentTooltipTimerRef.current = setTimeout(() => {
        setTooltip(null);
        persistentTooltipTimerRef.current = null;
      }, 2000);
    },
    [dragState, clearPersistentTooltip],
  );

  // Apply shake class to the source node briefly — we modify the
  // node entry in `nodes` to add a className that the React Flow node
  // wrapper exposes. Cleared after 250ms (animation is 200ms).
  useEffect(() => {
    if (!shakeKey) return;
    const t = setTimeout(() => setShakeKey(null), 250);
    return () => clearTimeout(t);
  }, [shakeKey]);

  // xyflow puts the className from `node.className` on the wrapper div.
  // We synthesize that here without mutating the store — pure derived.
  // Two channels feed into the className:
  //   • shake (F2) — added when a failed-drop animation needs to play.
  //   • diff   (Wave-D) — added/modified/removed flair on architect turns.
  const flowNodes = useMemo(() => {
    return nodes.map((n) => {
      const data = n.data as { diffState?: 'added' | 'modified' | 'removed' } | undefined;
      const diffClass = data?.diffState ? `shifty-diff-${data.diffState}` : null;
      const shakeClass = shakeKey?.nodeId === n.id ? 'shifty-connection-shake' : null;
      if (!diffClass && !shakeClass) return n;
      const merged = [n.className, diffClass, shakeClass].filter(Boolean).join(' ');
      return { ...n, className: merged };
    });
  }, [nodes, shakeKey]);

  // Cleanup persistent tooltip on unmount.
  useEffect(() => () => clearPersistentTooltip(), [clearPersistentTooltip]);

  // Auto-focus on the currently executing node
  useEffect(() => {
    const runningNode = nodes.find(n => (n.data as any)?.status === 'RUNNING');
    if (runningNode && isExecuting) {
      fitView({ nodes: [runningNode], duration: 500, padding: 0.3 });
    }
  }, [nodes, isExecuting, fitView]);

  // Apply default edge type to all edges
  const styledEdges = useMemo(() =>
    edges.map(e => ({ ...e, type: 'animated' as const })),
    [edges],
  );

  // Re-layout button handler
  const handleRelayout = useCallback(() => {
    const { nodes: layouted } = getLayoutedElements(nodes, edges, 'TB');
    setNodes(layouted);
    setTimeout(() => fitView({ duration: 400 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  // Viewport changes don't go through the zustand store, so we hook
  // onMoveEnd to mark the canvas dirty. Pan/zoom is debounced into the
  // same save cycle as node edits.
  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      if (!workspaceId || !hydratedRef.current) return;
      const safe = safeViewport(viewport);
      const prev = lastViewportRef.current;
      // Skip when nothing actually changed (xyflow fires onMoveEnd on
      // mount/fitView, which would otherwise trigger an empty save).
      if (
        prev &&
        safe &&
        prev.x === safe.x &&
        prev.y === safe.y &&
        prev.zoom === safe.zoom
      ) {
        return;
      }
      lastViewportRef.current = safe;
      setSaveStatus((s) => (s === 'saving' ? s : 'unsaved'));
      scheduleSaveRef.current();
    },
    [workspaceId],
  );

  return (
    <ConnectionDragContext.Provider value={dragState}>
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 w-full bg-white dark:bg-transparent rounded-2xl border border-gray-200 dark:border-white/5 shadow-sm overflow-hidden relative">
        <ReactFlow
          nodes={flowNodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onMoveEnd={onMoveEnd}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          isValidConnection={isValidConnection}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneClick={onPaneClick}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-transparent"
          defaultEdgeOptions={{ type: 'animated' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(150, 150, 150, 0.15)" />
          <Controls className="bg-white dark:bg-black/50 border border-gray-200 dark:border-white/10 shadow-sm backdrop-blur-md" />
          <MiniMap className="bg-white dark:bg-black/50 border border-gray-200 dark:border-white/10 shadow-sm backdrop-blur-md" maskColor="rgba(0, 0, 0, 0.2)" />

          {menu && <CanvasContextMenu id={menu.id} top={menu.top} left={menu.left} type={menu.type} onClose={() => setMenu(null)} />}

          <Panel position="top-left" className="m-4">
            <div className="flex items-center gap-3">
              <div className="px-5 py-3 bg-white/80 dark:bg-black/80 backdrop-blur-md rounded-md border border-gray-200 dark:border-gray-800 shadow-subtle text-xs font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <div className="w-2 h-2 rounded-pill bg-green-500 animate-pulse" />
                Graph Builder Ready
              </div>
              <GraphSaveBadge
                status={saveStatus}
                lastSavedAt={lastSavedAt}
                hasWorkspace={Boolean(workspaceId)}
              />
            </div>
          </Panel>

          <Panel position="bottom-center" className="mb-4">
            <AgentStepper />
          </Panel>

          <Panel position="top-right" className="m-4">
            <div className="flex items-center gap-3">
              {/* Wave-D: open the conversational graph builder. The
                  button is always present so even an empty canvas can
                  bootstrap a graph via Shifty. */}
              <button
                type="button"
                onClick={() => setChatSidebarOpen((prev) => !prev)}
                title="Chat con Shifty (Cmd+/)"
                aria-label="Abrir chat con Shifty"
                aria-pressed={chatSidebarOpen}
                data-testid="graph-chat-toggle"
                className={`flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all backdrop-blur-md ${
                  chatSidebarOpen
                    ? 'bg-[#1534dc] text-white border-[#1230c0] dark:bg-[#8b5cf6] dark:border-[#7a4cf2]'
                    : 'bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-indigo-500 dark:hover:border-indigo-500'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                CHAT
              </button>

              {/* Wave-E: open template gallery. Pre-armed DAGs as starting
                  points; Shifty can iterate on them via chat afterwards. */}
              <button
                data-testid="open-template-gallery"
                onClick={() => setShowTemplateGallery(true)}
                title="Cargar un template pre-armado"
                className="flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-amber-500 dark:hover:border-amber-500 backdrop-blur-md"
              >
                <Sparkles className="w-3.5 h-3.5" />
                + TEMPLATE
              </button>

              {nodes.length > 0 && (
                <button
                  onClick={handleRelayout}
                  title="Auto-layout DAG"
                  className="flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-violet-500 dark:hover:border-violet-500 backdrop-blur-md"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  LAYOUT
                </button>
              )}

              {nodes.length > 0 && (
                <button
                  onClick={() => setShowShareModal(true)}
                  className="flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all bg-white dark:bg-black/50 text-gray-700 dark:text-white border-gray-200 dark:border-white/10 hover:border-indigo-500 dark:hover:border-indigo-500 backdrop-blur-md"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  COMPARTIR
                </button>
              )}

              <button
                data-testid="graph-run-button"
                aria-label={isExecuting ? 'Detener ejecución del grafo' : 'Ejecutar grafo'}
                onClick={isExecuting ? () => { void cancelExecution(); } : () => { void executeGraph(); }}
                className={`flex items-center gap-2 min-h-9 px-4 py-2 text-[12px] font-bold rounded-xl shadow-lg border-2 transition-all ${isExecuting
                    ? 'bg-red-500 hover:bg-red-600 text-white border-red-600'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-700'
                  }`}
              >
                {isExecuting ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    DETENER
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    EJECUTAR GRAFO
                  </>
                )}
              </button>
            </div>
          </Panel>
        </ReactFlow>
        <TimeTravelTimeline />

        {/* Wave-D: conversational graph builder surfaces. Both live
            inside the canvas container so they layer above the
            ReactFlow viewport but below modals. */}
        <GraphCommandBar
          ref={commandBarRef}
          onRequestOpenSidebar={() => setChatSidebarOpen(true)}
        />
        <GraphChatSidebar
          open={chatSidebarOpen}
          onClose={() => setChatSidebarOpen(false)}
        />
      </div>

      <ShareWorkflowModal isOpen={showShareModal} onClose={() => setShowShareModal(false)} />
      <GraphTemplateGallery
        isOpen={showTemplateGallery}
        onClose={() => setShowTemplateGallery(false)}
        onTemplateApplied={(template) => {
          // Hook for the Shifty sidebar to surface "Este flow hace X.
          // ¿Lo personalizamos para tu caso?". The sidebar isn't part
          // of this Wave-E task — emit a custom DOM event so whatever
          // owns the sidebar can subscribe without us coupling here.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('shifty:template-loaded', {
                detail: {
                  slug: template.slug,
                  name: template.name,
                  description: template.description,
                },
              }),
            );
          }
        }}
      />
      <HITLModal />

      {/* Floating connection-validation tooltip. role="status" + aria-live
          for screen readers; pointer-events:none in CSS so it never
          intercepts the drag. */}
      {tooltip && (
        <div
          id="shifty-connection-tooltip"
          data-testid="connection-tooltip"
          className="shifty-connection-tooltip"
          data-variant={tooltip.variant === 'error' ? 'error' : 'info'}
          role="status"
          aria-live="polite"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.reason}
        </div>
      )}
    </div>
    </ConnectionDragContext.Provider>
  );
}

/** Wrapper that provides ReactFlowProvider context (required for useReactFlow hook) */
export function ShiftyNodeCanvas() {
  return (
    <ReactFlowProvider>
      <ShiftyNodeCanvasInner />
    </ReactFlowProvider>
  );
}

// ─── Save status badge ───────────────────────────────────────────────
//
// Visual states:
//   - hasWorkspace=false → grey "sin workspace" pill (chat-mode global
//     canvas, autosave is a no-op).
//   - idle               → no badge (nothing has happened yet).
//   - unsaved            → amber "sin guardar" with a soft pulse.
//   - saving             → blue spinner "guardando…".
//   - saved              → green check "guardado · hace N s".
//   - error              → rose alert "no guardó — reintentando".
//
// Mirrors `SaveIndicator` in `src/components/hoja/HojaNode.tsx` so the
// language and palette stay consistent with the workspace canvas hojas.

interface GraphSaveBadgeProps {
  status: SaveStatus;
  lastSavedAt: number | null;
  hasWorkspace: boolean;
}

function GraphSaveBadge({ status, lastSavedAt, hasWorkspace }: GraphSaveBadgeProps) {
  if (!hasWorkspace) {
    return (
      <span
        data-testid="graph-save-badge"
        data-state="no-workspace"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-gray-100 dark:bg-white/5 text-[11px] font-medium text-gray-500 dark:text-white/50 border border-gray-200 dark:border-white/10 backdrop-blur-md"
        title="Modo nodos global — para activar autoguardado, abrí un workspace."
        role="status"
      >
        <CloudOff className="w-3 h-3" aria-hidden />
        Sin workspace
      </span>
    );
  }

  if (status === 'saving') {
    return (
      <span
        data-testid="graph-save-badge"
        data-state="saving"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#1534dc]/[0.06] dark:bg-[#8b5cf6]/[0.10] text-[11px] font-semibold text-[#1534dc]/85 dark:text-[#8b5cf6]/90 border border-[#1534dc]/15 dark:border-[#8b5cf6]/25 backdrop-blur-md"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
        Guardando…
      </span>
    );
  }
  if (status === 'unsaved') {
    return (
      <span
        data-testid="graph-save-badge"
        data-state="unsaved"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700/40 backdrop-blur-md"
        role="status"
        aria-live="polite"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden />
        Sin guardar
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        data-testid="graph-save-badge"
        data-state="error"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-rose-50 dark:bg-rose-900/20 text-[11px] font-semibold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700/40 backdrop-blur-md"
        title="No se pudo guardar — reintentando con backoff exponencial. Tu estado local está intacto."
        role="alert"
        aria-live="assertive"
      >
        <AlertCircle className="w-3 h-3" aria-hidden />
        No guardó · reintentando
      </span>
    );
  }
  if (status === 'saved' && lastSavedAt !== null) {
    return (
      <span
        data-testid="graph-save-badge"
        data-state="saved"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-50 dark:bg-emerald-900/15 text-[11px] font-semibold text-emerald-700/90 dark:text-emerald-300/90 border border-emerald-200/70 dark:border-emerald-700/30 backdrop-blur-md"
        title={`Última escritura: ${new Date(lastSavedAt).toLocaleString('es')}`}
        role="status"
      >
        <Check className="w-3 h-3" aria-hidden />
        Guardado · {formatRelativeAgo(lastSavedAt)}
      </span>
    );
  }
  // idle without a prior save — render nothing (keeps the topbar clean
  // until there's actually something to report).
  return null;
}

/**
 * "hace 5 s" / "hace 2 m" / "hace 1 h" — short relative format. Matches
 * the helper in `src/components/hoja/HojaNode.tsx` so the language is
 * uniform across canvas modes.
 */
function formatRelativeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5)   return 'recién';
  if (sec < 60)  return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `hace ${hr} h`;
  return new Date(ts).toLocaleDateString('es');
}
