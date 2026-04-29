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

import React, { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ShiftAIEmbed } from "./components/ShiftAIEmbed";
import AdminDashboard from "./components/admin/AdminDashboard";
import { ShiftyNodeCanvas } from "./components/ShiftyNodeCanvas";
import { useActiveGraphStore } from "./store";
import { useAuthStore } from "./store/useAuthStore";
import { supabase } from "./services/supabaseClient";

export default function App() {
  const activeMode = useActiveGraphStore((state) => state.activeMode);
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [isCerebroMode, setIsCerebroMode] = useState(false);
  const [tenantConfig, setTenantConfig] = useState({ tenantId: "shift", color: "#0047AB" });

  // History panel state — retractable on desktop, drawer on mobile
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);        // desktop panel
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false); // mobile drawer

  const toggleHistory = () => setIsHistoryOpen((v) => !v);
  const openMobileDrawer = () => setIsMobileDrawerOpen(true);
  const closeMobileDrawer = () => setIsMobileDrawerOpen(false);

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

  if (isCerebroMode) return <AdminDashboard />;

  if (isEmbedMode) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <ShiftAIEmbed tenantId={tenantConfig.tenantId} />
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

  const isCanvas = activeMode === 'canvas';

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
                isCanvas && "opacity-5 dark:opacity-[0.04]"
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
            />

            {/* ═══════════════════════════════════════════
                 MAIN WORKSPACE — flex row with retractable panels
                 ═══════════════════════════════════════════ */}
            <main className="relative z-20 flex-1 min-h-0 flex gap-0 md:gap-6 p-4 sm:p-5 md:p-6 md:pb-6">

              {/* ── CHAT MODE ── */}
              {!isCanvas && (
                <>
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
                  <section className="flex-1 min-h-0 min-w-0 bg-white/70 dark:bg-white/5 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)] overflow-hidden">
                    <AnimatedAiInput onOpenHistory={openMobileDrawer} />
                  </section>
                </>
              )}

              {/* ── CANVAS / NODES MODE ── */}
              {isCanvas && (
                <>
                  {/* Left: compact chat panel */}
                  <div className="hidden lg:flex flex-col min-h-0 w-[340px] shrink-0">
                    <section className="h-full bg-white/70 dark:bg-white/5 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)] overflow-hidden">
                      <AnimatedAiInput compact />
                    </section>
                  </div>

                  {/* Center: canvas */}
                  <div className="flex-1 min-h-0 min-w-0 flex flex-col gap-3">
                    <div className="min-h-0 flex-1 bg-white/55 dark:bg-black/20 border border-white/60 dark:border-white/10 rounded-2xl overflow-hidden shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)]">
                      <ShiftyNodeCanvas />
                    </div>

                    {/* Mobile: compact chat below canvas */}
                    <div className="lg:hidden h-[42svh] bg-white/70 dark:bg-white/5 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)] overflow-hidden">
                      <AnimatedAiInput compact onOpenHistory={openMobileDrawer} />
                    </div>
                  </div>

                  {/* Right: retractable history panel */}
                  <div
                    className={cn(
                      "hidden lg:flex flex-col min-h-0 transition-all duration-500 ease-out overflow-hidden shrink-0",
                      isHistoryOpen ? "w-[280px] opacity-100" : "w-0 opacity-0"
                    )}
                  >
                    <Sidebar variant="panel" mode="canvas" side="right" />
                  </div>
                </>
              )}
            </main>

            {/* Mobile history drawer */}
            <Sidebar
              open={isMobileDrawerOpen}
              onClose={closeMobileDrawer}
              mode={isCanvas ? "canvas" : "chat"}
              variant="drawer"
              side={isCanvas ? "right" : "left"}
              className="lg:hidden"
            />
          </div>
        </ChatProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
