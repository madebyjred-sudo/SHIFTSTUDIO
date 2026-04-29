import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, MessageSquare, X, Trash2 } from 'lucide-react';
import { useChat } from '@/lib/chat-context';
import { cn } from '@/lib/utils';

interface SidebarProps {
    open?: boolean;
    onClose?: () => void;
    mode?: 'chat' | 'canvas';
    variant?: 'panel' | 'drawer';
    side?: 'left' | 'right';
    className?: string;
}

export function Sidebar({
    open = true,
    onClose,
    mode = 'chat',
    variant = 'panel',
    side = 'left',
    className,
}: SidebarProps) {
    const { sessions, currentSessionId, setCurrentSessionId, createNewSession, deleteSession } = useChat();
    const drawerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (variant !== 'drawer' || !open) return;

        const drawer = drawerRef.current;
        if (!drawer) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;
        const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(selector)).filter(
            (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
        );

        const first = focusable[0] ?? drawer;
        const last = focusable[focusable.length - 1] ?? drawer;

        requestAnimationFrame(() => {
            first.focus();
        });

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose?.();
                return;
            }

            if (e.key !== 'Tab') return;

            if (focusable.length === 0) {
                e.preventDefault();
                drawer.focus();
                return;
            }

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            previouslyFocused?.focus?.();
        };
    }, [variant, open, onClose]);

    const handleSelectChat = (id: string) => {
        setCurrentSessionId(id);
        onClose?.();
    };

    const handleNewChat = () => {
        createNewSession();
        onClose?.();
    };

    // Group sessions by date
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    const groupedSessions = sessions.reduce((acc, session) => {
        const sessionDate = new Date(session.updatedAt).toDateString();
        let group = 'Anteriores';
        if (sessionDate === today) group = 'Hoy';
        else if (sessionDate === yesterday) group = 'Ayer';

        if (!acc[group]) acc[group] = [];
        acc[group].push(session);
        return acc;
    }, {} as Record<string, typeof sessions>);

    const orderedGroups: Array<'Hoy' | 'Ayer' | 'Anteriores'> = ['Hoy', 'Ayer', 'Anteriores'];

    const content = (
        <>
            <div className="p-5 flex items-center justify-between border-b border-[#0e1745]/5 dark:border-white/10">
                <div className="flex flex-col">
                    <span className="font-semibold text-base tracking-tight">Historial</span>
                    <span className="text-[11px] text-[#0e1745]/40 dark:text-white/40">
                        {mode === 'canvas' ? 'Sesiones para nodos y chat' : 'Chats recientes del workspace'}
                    </span>
                </div>
                {variant === 'drawer' && onClose && (
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-[#0e1745]/5 dark:hover:bg-white/10 text-[#0e1745]/50 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            <div className="p-3">
                <button
                    onClick={handleNewChat}
                    className="w-full min-h-11 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-white hover:bg-primary/90 transition-colors shadow-sm font-medium text-sm"
                >
                    <Plus className="w-4 h-4" />
                    Nuevo Chat
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 pt-0 space-y-4 scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                {orderedGroups.map((group) => {
                    const groupSessions = groupedSessions[group];
                    if (!groupSessions || groupSessions.length === 0) return null;

                    return (
                        <div key={group}>
                            <h3 className="text-[10px] font-medium text-[#0e1745]/40 dark:text-white/40 uppercase tracking-wider mb-2 px-2">{group}</h3>
                            <div className="space-y-0.5">
                                {groupSessions.map((chat) => (
                                    <div key={chat.id} className="relative group flex items-center">
                                        <button
                                            onClick={() => handleSelectChat(chat.id)}
                                            className={`w-full min-h-10 flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-[13px] ${currentSessionId === chat.id ? 'bg-[#0e1745]/5 dark:bg-white/10 text-[#0e1745] dark:text-white font-medium' : 'hover:bg-[#0e1745]/5 dark:hover:bg-white/5 text-[#0e1745]/70 dark:text-white/70'}`}
                                        >
                                            {chat.agent === 'Debate Swarm'
                                                ? <div className={`w-4 h-4 transition-colors flex items-center justify-center ${currentSessionId === chat.id ? 'text-indigo-600 dark:text-indigo-400' : 'text-indigo-500/50 dark:text-indigo-400/50 group-hover:text-indigo-600 dark:group-hover:text-indigo-400'}`}>
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-5.224 4.815 4 4 0 0 0 2.876 7.189 4 4 0 0 0 5.464-1.399 4 4 0 0 0 5.758-1.42 4 4 0 0 0 5.234-4.815A4 4 0 0 0 14.885 5.12 3 3 0 0 0 12 5Z" /><path d="M8.5 15.5 12 12l3.5 3.5" /><path d="M12 12v7" /></svg>
                                                </div>
                                                : <MessageSquare className={`w-3.5 h-3.5 shrink-0 transition-colors ${currentSessionId === chat.id ? 'text-primary dark:text-secondary' : 'text-[#0e1745]/30 dark:text-white/30 group-hover:text-primary dark:group-hover:text-secondary'}`} />
                                            }
                                            <span className="flex-1 truncate">
                                                {chat.title}
                                            </span>
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                deleteSession(chat.id);
                                            }}
                                            className="absolute right-1.5 p-1.5 rounded-md text-[#0e1745]/30 dark:text-white/30 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                                            aria-label={`Eliminar chat ${chat.title}`}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}

                {sessions.length === 0 && (
                    <div className="text-center text-xs text-[#0e1745]/40 dark:text-white/40 mt-8">
                        No hay chats recientes
                    </div>
                )}
            </div>
        </>
    );

    if (variant === 'panel') {
        return (
            <aside
                className={cn(
                    'h-full w-full bg-white/70 dark:bg-white/5 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_35px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_35px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden text-[#0e1745] dark:text-white',
                    side === 'right' && 'lg:order-last',
                    className
                )}
            >
                {content}
            </aside>
        );
    }

    return (
        <AnimatePresence>
            {open && (
                <>
                    {/* Backdrop — subtle, no full blur */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className={cn("fixed inset-0 bg-black/10 dark:bg-black/30 z-[60]", className)}
                    />

                    {/* Floating Mini-Drawer */}
                    <motion.div
                        ref={drawerRef}
                        initial={{ x: side === 'right' ? 20 : -20, opacity: 0, scale: 0.98 }}
                        animate={{ x: 0, opacity: 1, scale: 1 }}
                        exit={{ x: side === 'right' ? 20 : -20, opacity: 0, scale: 0.98 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Historial de chats"
                        tabIndex={-1}
                        className={cn(
                            'fixed top-20 bottom-5 w-72 bg-white/80 dark:bg-[#0e1745]/90 backdrop-blur-2xl border border-white/50 dark:border-white/10 rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.3)] z-[70] flex flex-col overflow-hidden text-[#0e1745] dark:text-white',
                            side === 'right'
                                ? 'right-3'
                                : mode === 'canvas'
                                    ? 'left-5 max-md:left-3'
                                    : 'left-[max(1.25rem,calc(50%-490px))] max-md:left-3',
                            className
                        )}
                    >
                        {content}
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}