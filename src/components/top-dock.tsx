import { Clock, Layers, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from 'lucide-react';
import { DynamicSVG } from './DynamicSVG';
import { useActiveGraphStore } from '@/store';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme-context';
import { useAuthStore } from '@/store/useAuthStore';

interface TopDockProps {
  onOpenHistory?: () => void;
  onToggleHistory?: () => void;
  isHistoryOpen?: boolean;
}

export function TopDock({ onOpenHistory, onToggleHistory, isHistoryOpen }: TopDockProps) {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuthStore();
  const activeMode = useActiveGraphStore((state) => state.activeMode);
  const setActiveMode = useActiveGraphStore((state) => state.setActiveMode);

  const handleLogout = async () => {
    await logout();
  };

  return (
    <header className="sticky top-0 z-[90] w-full">
      <div className="w-full bg-white/80 dark:bg-[#0b1120]/80 border-b border-white/60 dark:border-white/10 backdrop-blur-xl shadow-[0_4px_20px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.3)] px-3 py-2 md:px-4 md:py-2.5 flex items-center justify-between gap-2 md:gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-9 px-3 rounded-xl bg-white/80 dark:bg-white/5 border border-white/80 dark:border-white/10 shadow-sm flex items-center">
            <DynamicSVG path="/logo.svg" className="h-[18px] w-auto" />
          </div>
          <div className="hidden xl:flex flex-col leading-tight">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/35 dark:text-white/35">Shift Studio</span>
            <span className="text-[11px] font-medium text-[#0e1745]/70 dark:text-white/70">Legio Digitalis Workspace</span>
          </div>
        </div>

        {/* Workspace toggle */}
        <div className="flex items-center gap-0.5 rounded-xl p-1 bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10">
          <button
            className={cn(
              "h-9 px-4 rounded-lg text-xs font-semibold transition-all",
              activeMode === 'chat'
                ? "bg-white dark:bg-white/10 shadow-sm text-[#0e1745] dark:text-white"
                : "text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white"
            )}
            onClick={() => setActiveMode('chat')}
            aria-label="Cambiar a modo chat"
          >
            Chat
          </button>
          <button
            className={cn(
              "h-9 px-4 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5",
              activeMode === 'canvas'
                ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm"
                : "text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white"
            )}
            onClick={() => setActiveMode('canvas')}
            aria-label="Cambiar a modo nodos"
          >
            <Layers className="w-3.5 h-3.5" />
            Nodes
          </button>
        </div>

        {/* Utilities */}
        <div className="flex items-center gap-1.5">
          {/* Desktop history toggle */}
          {onToggleHistory && (
            <button
              onClick={onToggleHistory}
              className="hidden lg:flex h-9 w-9 items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 text-[#0e1745]/60 dark:text-white/60 transition-all"
              aria-label={isHistoryOpen ? "Cerrar historial" : "Abrir historial"}
              title={isHistoryOpen ? "Cerrar historial" : "Abrir historial"}
            >
              {isHistoryOpen
                ? <PanelLeftClose className="w-4 h-4" />
                : <PanelLeftOpen className="w-4 h-4" />
              }
            </button>
          )}

          {/* Mobile history */}
          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="lg:hidden h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 text-[#0e1745]/60 dark:text-white/60 transition-all"
              aria-label="Abrir historial"
            >
              <Clock className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={toggleTheme}
            className="h-9 w-9 flex items-center justify-center rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 shadow-sm text-[#0e1745]/60 dark:text-white/60 hover:text-[#0e1745] dark:hover:text-white transition-all"
            title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Avatar */}
          <div className="relative group">
            <button className="h-9 w-9 rounded-full overflow-hidden border-2 border-white dark:border-white/20 shadow-sm hover:scale-105 transition-transform">
              <div className="w-full h-full bg-[#1534dc] flex items-center justify-center text-white text-xs font-semibold">
                {user?.email ? user.email[0].toUpperCase() : 'S'}
              </div>
            </button>

            <div className="absolute right-0 top-[2.75rem] w-52 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-all duration-200 translate-y-1 group-hover:translate-y-0">
              <div className="bg-white dark:bg-[#0b1120] border border-black/8 dark:border-white/10 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] p-1 overflow-hidden">
                <div className="px-3 py-2 border-b border-black/5 dark:border-white/5">
                  <p className="text-xs text-[#0e1745]/40 dark:text-white/30 truncate">
                    {user?.email ?? 'Usuario Shift'}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[#0e1745]/70 dark:text-white/60 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-all duration-150"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Cerrar sesión</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
