/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AnimatedAiInput } from "./components/animated-ai-input";
import { TopDock } from "./components/top-dock";
import { Sidebar } from "./components/sidebar";
import { ChatProvider } from "./lib/chat-context";
import { FlickeringGridDemo } from "./components/flickering-grid-demo";
import { ThemeProvider } from "./lib/theme-context";
import { ErrorBoundary } from "./components/error-boundary";
import { AuthView } from "./components/AuthView";

import React, { useState, useEffect, lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useNeuronOnboarding } from "./hooks/useNeuronOnboarding";
// Phase 3 perf — lazy the conditional-render top-level routes so the chat-only
// entry doesn't pay for ReactFlow + dagre (Canvas), the admin dashboard, or the
// embed primitives upfront. Each is only rendered on a specific URL/state.
const ShiftAIEmbed = lazy(() =>
  import("./components/ShiftAIEmbed").then((m) => ({ default: m.ShiftAIEmbed })),
);
const AdminDashboard = lazy(() => import("./components/admin/AdminDashboard"));
// F1 (2026-05-10): the root-level "canvas" mode (no workspace bound) was
// only ever an exploration surface — the V2 graph store can't autosave
// without a workspaceId. Modo nodos now lives INSIDE a workspace, and
// the unified top-nav (2026-05-16) collapsed the dual "TopDock Chat|Nodes
// + in-page Hojas|Nodos tabs" UX into a single Chat|Workspace|Nodos
// segmented control. Routing happens in this file (useEffect reacts to
// activeMode + currentPath and calls navigate()).
import { useActiveGraphStore } from "./store";
import { useAuthStore } from "./store/useAuthStore";
import { supabase } from "./services/supabaseClient";
import { useRoute, isWorkspacesList, matchWorkspaceId, navigate } from "./lib/router";

// T10 — Workspace routes lazy-loaded so the chat-only entry payload
// doesn't pay for TipTap (~150 kB gz) + ReactFlow + the workspace
// modals on the initial bundle. Vite SPA → dynamic import works without
// any SSR concerns.
const WorkspacesListPage = lazy(() =>
  import("./pages/WorkspacesListPage").then((m) => ({ default: m.WorkspacesListPage })),
);
const WorkspaceCanvasPage = lazy(() =>
  import("./pages/WorkspaceCanvasPage").then((m) => ({ default: m.WorkspaceCanvasPage })),
);
// Wave B — admin usage dashboard. Only loaded on /admin/usage; the
// recharts payload stays out of the chat-only entry bundle.
const AdminUsagePage = lazy(() => import("./pages/AdminUsagePage"));

// "Mi memoria" — opened on demand from the avatar dropdown. Lazy so
// the chat-only entry doesn't pay for motion/react animations + the
// neuron client + editor up front.
const NeuronPanel = lazy(() =>
  import("./components/neuron/NeuronPanel").then((m) => ({ default: m.NeuronPanel })),
);

// First-login onboarding wizard. Lazy: only mounted once the
// useNeuronOnboarding hook flags the user (or a re-entry from
// NeuronPanel). Keeps motion/react + the 8-step JSX off the cold path.
const NeuronOnboardingWizard = lazy(() =>
  import("./components/onboarding/NeuronOnboardingWizard").then((m) => ({
    default: m.NeuronOnboardingWizard,
  })),
);

// Shared route-level fallback — matches Studio's auth-loading spinner.
function WorkspaceRouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8f9fc] dark:bg-[#080d1a]">
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin w-7 h-7 text-[#1534dc]/45 dark:text-[#8b5cf6]/55" fill="none" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-[12px] font-medium text-[#0e1745]/55 dark:text-white/50">Cargando workspace…</p>
      </div>
    </div>
  );
}

export default function App() {
  const activeMode = useActiveGraphStore((state) => state.activeMode);
  const setActiveMode = useActiveGraphStore((state) => state.setActiveMode);
  const currentPath = useRoute();
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [isCerebroMode, setIsCerebroMode] = useState(false);
  const [tenantConfig, setTenantConfig] = useState({ tenantId: "shift", color: "#0047AB" });

  // History panel state — retractable on desktop, drawer on mobile
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);        // desktop panel
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false); // mobile drawer

  // Neuron ("Mi memoria") modal state — opened from the avatar dropdown.
  const [isNeuronOpen, setIsNeuronOpen] = useState(false);

  // Onboarding wizard — first-login flow for users with empty neurons.
  // The hook handles all the auto-fire gating; we lift the trigger here
  // so NeuronPanel can re-enter the flow via a "Volver al onboarding"
  // button without owning its own gating state.
  const onboarding = useNeuronOnboarding();

  const toggleHistory = () => setIsHistoryOpen((v) => !v);
  const openMobileDrawer = () => setIsMobileDrawerOpen(true);
  const closeMobileDrawer = () => setIsMobileDrawerOpen(false);
  const openNeuronPanel = () => setIsNeuronOpen(true);
  const closeNeuronPanel = () => setIsNeuronOpen(false);
  const reopenOnboarding = () => {
    // Re-entry from "Mi memoria". Close the neuron panel first so the
    // wizard takes the visual stage cleanly (both modals have high
    // z-index; the wizard's is higher but stacking two large overlays
    // looks confused).
    setIsNeuronOpen(false);
    onboarding.forceOpen();
  };

  // ─── Auth: Session Guard ───────────────────────────────────────────────────
  const { isAuthenticated, isAuthLoading, setSession } = useAuthStore();

  // TEMPORAL: bypass auth mientras Supabase está suspendido por billing.
  // Controlado por VITE_BYPASS_AUTH en .env.local — quitar antes de prod.
  const bypassAuth = import.meta.env.VITE_BYPASS_AUTH === 'true';

  useEffect(() => {
    if (bypassAuth) {
      // Marcamos como no-loading y dejamos sesión en null; el render de abajo
      // short-circuitea el guard de isAuthenticated cuando bypassAuth está on.
      setSession(null);
      return;
    }

    // Si supabase es null (env vars faltantes y sin bypass), degradamos
    // a anon en vez de crashear con `null.auth`. El warning del cliente
    // ya alertó en consola.
    if (!supabase) {
      setSession(null);
      return;
    }

    supabase.auth.getSession()
      .then(({ data: { session } }) => setSession(session))
      .catch((err) => {
        console.warn('[Auth] getSession falló — probablemente Supabase suspendido:', err);
        setSession(null); // desbloquea el spinner
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, [setSession, bypassAuth]);

  // ─── 401 from workspace API → force re-auth ─────────────────────
  // workspaceApi.handleJson dispatches a `workspace:unauthorized` event
  // when a request comes back 401 (stale JWT, server kicked us, etc.).
  // We clear the auth session here so the AuthView guard kicks in and
  // the user can sign back in cleanly. Important #6 from T6 review.
  useEffect(() => {
    const handler = () => {
      if (bypassAuth) return; // auth bypass mode: ignore
      useAuthStore.getState().setSession(null);
    };
    window.addEventListener('workspace:unauthorized', handler);
    return () => window.removeEventListener('workspace:unauthorized', handler);
  }, [bypassAuth]);

  // URL → activeMode sync: when the user lands directly on a workspace
  // URL (deep-link, refresh, browser back/forward), the global
  // `activeMode` may not match. Promote/demote so the segmented control
  // reflects the rendered surface:
  //   • on /workspaces/:id   — preserve 'nodos' or default to 'workspace'
  //   • on /workspaces (list)— always 'workspace' (the list can't render
  //                            the graph builder)
  //   • on /                  — always 'chat'
  useEffect(() => {
    if (matchWorkspaceId(currentPath)) {
      if (activeMode === 'chat') setActiveMode('workspace');
    } else if (isWorkspacesList(currentPath)) {
      // The list page has no canvas; if mode is still 'nodos' from a
      // prior canvas page, demote so the segmented control reads
      // 'Workspace' (matches the rendered list).
      if (activeMode !== 'workspace') setActiveMode('workspace');
    } else if (currentPath === '/' && activeMode !== 'chat') {
      // Root path but mode says non-chat — likely a manual URL edit.
      // Snap back to chat so the segmented control matches the rendered
      // chat-only layout.
      setActiveMode('chat');
    }
    // Run on URL changes; activeMode changes are handled in the
    // navigation effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  // Unified top-nav routing (2026-05-16): the global `activeMode` drives
  // both render output AND URL navigation. Three modes:
  //   • 'chat'      → root chat layout at `/`
  //   • 'workspace' → /workspaces (list) or /workspaces/:lastId (hojas)
  //   • 'nodos'     → /workspaces/:lastId (graph builder)
  //
  // We remember the last-visited workspace id in localStorage so users
  // who click "Workspace" or "Nodos" from chat-mode land on the workspace
  // they were last editing instead of bouncing through the list. If
  // there's no last id, Workspace falls back to /workspaces and Nodos
  // falls back to /workspaces (the list itself surfaces a "no workspaces"
  // empty state).
  useEffect(() => {
    if (currentPath.startsWith('/admin')) return; // admin owns its own routing
    const workspaceIdOnPath = matchWorkspaceId(currentPath);
    if (workspaceIdOnPath) {
      // Cache the id so other modes know where to deep-link back to.
      try {
        window.localStorage.setItem('studio-last-workspace-id', workspaceIdOnPath);
      } catch {
        /* quota / disabled — non-fatal */
      }
    }

    const lastWorkspaceId = (() => {
      try {
        return window.localStorage.getItem('studio-last-workspace-id');
      } catch {
        return null;
      }
    })();

    if (activeMode === 'chat') {
      // Anywhere outside `/` → bounce home so the user sees the chat
      // layout. Workspace pages don't render at `/`, so this is safe.
      if (currentPath !== '/') navigate('/');
      return;
    }

    if (activeMode === 'workspace') {
      // No workspace on path → either deep-link to last, or go to list.
      if (!currentPath.startsWith('/workspaces')) {
        if (lastWorkspaceId) navigate(`/workspaces/${lastWorkspaceId}`);
        else navigate('/workspaces');
      }
      // Already on /workspaces or /workspaces/:id — page itself handles
      // hojas-as-default. No further action.
      return;
    }

    if (activeMode === 'nodos') {
      // Need a workspace to render the graph. From the chat layout or
      // the workspaces LIST, deep-link to last workspace; if none,
      // demote back to 'workspace' so the list is the safe landing.
      const onWorkspaceCanvas = matchWorkspaceId(currentPath) !== null;
      if (!onWorkspaceCanvas) {
        if (lastWorkspaceId) navigate(`/workspaces/${lastWorkspaceId}`);
        else setActiveMode('workspace');
      }
      // Already on /workspaces/:id — WorkspaceCanvasPage reads activeMode
      // and renders ShiftyNodeCanvas directly when mode === 'nodos'.
      return;
    }
    // exhaustiveness placeholder — `activeMode` is the tri-state union
    // and TypeScript will catch any new variants here at compile time.
    void (activeMode satisfies never);
  }, [activeMode, currentPath, setActiveMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "embed") {
      setIsEmbedMode(true);
      const tenant = params.get("tenant") || "garnier";
      const color = params.get("color") || (tenant === "garnier" ? "#00A651" : "#0047AB");
      setTenantConfig({ tenantId: tenant, color });
      document.body.style.backgroundColor = "transparent";
    } else if (params.get("mode") === "cerebro") {
      setIsCerebroMode(true);
    }
  }, []);

  if (isCerebroMode) {
    return (
      <Suspense fallback={<WorkspaceRouteFallback />}>
        <AdminDashboard />
      </Suspense>
    );
  }

  if (isEmbedMode) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <Suspense fallback={<WorkspaceRouteFallback />}>
            <ShiftAIEmbed tenantId={tenantConfig.tenantId} />
          </Suspense>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  if (isAuthLoading && !bypassAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f8f9fc] dark:bg-[#080d1a]">
        <svg className="animate-spin w-8 h-8 text-[#1534dc]/40" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (!isAuthenticated && !bypassAuth) return <AuthView />;

  // Shared post-auth overlays — wizard auto-fires for users with empty
  // neurons (decided by useNeuronOnboarding), or can be re-entered from
  // NeuronPanel via the "Volver al onboarding" button. NeuronPanel is
  // the existing "Mi memoria" surface. Both are kept lazy so they don't
  // weigh on the cold-path bundle.
  const postAuthOverlays = (
    <>
      {isNeuronOpen && (
        <Suspense fallback={null}>
          <NeuronPanel
            open={isNeuronOpen}
            onClose={closeNeuronPanel}
            onReopenOnboarding={reopenOnboarding}
          />
        </Suspense>
      )}
      {onboarding.shouldShow && (
        <Suspense fallback={null}>
          <NeuronOnboardingWizard
            open={onboarding.shouldShow}
            onClose={onboarding.dismiss}
            onComplete={onboarding.complete}
            userEmail={onboarding.email}
          />
        </Suspense>
      )}
    </>
  );

  // ─── Workspace routes: /workspaces and /workspaces/:id ─────────────
  // These render full-screen, OUTSIDE the chat/canvas layout. They have
  // their own TopDock + chrome. The default (`/` and everything else)
  // falls through to the legacy chat/canvas mode below.
  const path = currentPath;
  // Admin usage dashboard — gated server-side via ADMIN_USER_IDS allowlist.
  // The page renders the 403/error itself when the API rejects, so we don't
  // need a client-side allowlist here.
  if (path === '/admin/usage' || path === '/admin/usage/') {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <Suspense fallback={<WorkspaceRouteFallback />}>
            <AdminUsagePage />
          </Suspense>
          {postAuthOverlays}
        </ThemeProvider>
      </ErrorBoundary>
    );
  }
  if (isWorkspacesList(path)) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <Suspense fallback={<WorkspaceRouteFallback />}>
            <WorkspacesListPage />
          </Suspense>
          {postAuthOverlays}
        </ThemeProvider>
      </ErrorBoundary>
    );
  }
  const workspaceIdFromPath = matchWorkspaceId(path);
  if (workspaceIdFromPath) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <ChatProvider>
            <Suspense fallback={<WorkspaceRouteFallback />}>
              <WorkspaceCanvasPage workspaceId={workspaceIdFromPath} />
            </Suspense>
            {postAuthOverlays}
          </ChatProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  // Unified top-nav (2026-05-16): root path is chat-only. If the user
  // clicks Workspace/Nodos from chat-mode, the redirect-effect above
  // hands them off to /workspaces (or /workspaces/:lastId); we render a
  // brief loading-style fallback while the navigation flushes so we
  // don't flash the chat layout under the new URL.
  if (activeMode !== 'chat') {
    return <WorkspaceRouteFallback />;
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ChatProvider>
          <div className="h-screen flex flex-col bg-[#f8f9fc] text-[#0e1745] dark:bg-mesh dark:text-white font-sans selection:bg-[#1534dc]/20 dark:selection:bg-[#8b5cf6]/25 relative overflow-hidden transition-colors duration-500">
            {/* Subtle grid background — en dark bajado a 8% para no competir
                con el FlickeringGrid, que queda como única textura viva. */}
            <div
              className={cn(
                "absolute inset-0 z-0 pointer-events-none opacity-10 dark:opacity-[0.08] transition-opacity duration-500",
              )}
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h40v40H0V0zm20 20h20v20H20V20zM0 20h20v20H0V20z' fill='currentColor' fill-opacity='0.1' fill-rule='evenodd'/%3E%3C/svg%3E")`,
                maskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)',
              }}
            />

            {/* Flickering Grid Background */}
            <div className="hidden dark:block">
              <FlickeringGridDemo />
            </div>

            {/* Top Dock — flush, non-floating */}
            <TopDock
              onOpenHistory={openMobileDrawer}
              onToggleHistory={toggleHistory}
              isHistoryOpen={isHistoryOpen}
              onOpenNeuronPanel={openNeuronPanel}
            />

            {/* ═══════════════════════════════════════════
                 MAIN WORKSPACE — chat-only at the root path. Modo nodos
                 lives inside WorkspaceCanvasPage via the Hojas/Nodos tabs.
                 ═══════════════════════════════════════════ */}
            <main className="relative z-20 flex-1 min-h-0 flex gap-0 md:gap-6 p-4 sm:p-5 md:p-6 md:pb-6">
              {/* Retractable history panel (left) */}
              <div
                className={cn(
                  "hidden lg:flex flex-col min-h-0 transition-all duration-500 ease-out overflow-hidden shrink-0",
                  isHistoryOpen ? "w-[280px] opacity-100" : "w-0 opacity-0"
                )}
              >
                <Sidebar variant="panel" mode="chat" side="left" />
              </div>

              {/* Chat workspace */}
              <section className="flex-1 min-h-0 min-w-0 bg-white/70 dark:bg-white/5 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)] overflow-hidden relative">
                {/* Portal to /workspaces list — entry via brand click in TopDock
                    (single nav, no floating duplicate with top-nav "Workspace" tab). */}
                <AnimatedAiInput onOpenHistory={openMobileDrawer} />
              </section>
            </main>

            {/* Mobile history drawer */}
            <Sidebar
              open={isMobileDrawerOpen}
              onClose={closeMobileDrawer}
              mode="chat"
              variant="drawer"
              side="left"
              className="lg:hidden"
            />

            {/* Shared post-auth overlays (Mi memoria + onboarding wizard). */}
            {postAuthOverlays}
          </div>
        </ChatProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
