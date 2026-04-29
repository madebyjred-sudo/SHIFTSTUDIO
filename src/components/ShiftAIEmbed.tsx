import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MessageCircle, X } from "lucide-react";
import { ChatProvider } from "@/lib/chat-context";
import { AnimatedAiInput } from "@/components/animated-ai-input";

interface ShiftAIEmbedProps {
    tenantId?: string;
}

export function ShiftAIEmbed({ tenantId = "shift" }: ShiftAIEmbedProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <ChatProvider defaultTenantId={tenantId}>
            {/* Floating Button */}
            <AnimatePresence>
                {!isOpen && (
                    <motion.button
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setIsOpen(true)}
                        className="fixed bottom-6 right-6 z-[9999] w-14 h-14 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-[0_8px_32px_rgba(59,130,246,0.5)] flex items-center justify-center hover:shadow-[0_8px_40px_rgba(59,130,246,0.7)] transition-shadow"
                    >
                        <MessageCircle className="w-6 h-6" />
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Chat Panel */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        transition={{ type: "spring", damping: 25, stiffness: 300 }}
                        className="fixed bottom-6 right-6 z-[9999] w-[420px] h-[600px] bg-white/95 dark:bg-[#0b1120]/95 backdrop-blur-2xl rounded-[1.5rem] border border-black/10 dark:border-white/10 shadow-[0_25px_100px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10 bg-white/50 dark:bg-white/5">
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center">
                                    <MessageCircle className="w-4 h-4 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-gray-900 dark:text-white">Shift AI</h3>
                                    <p className="text-[10px] text-gray-500 dark:text-white/50">15 Agentes · Legio Digitalis</p>
                                </div>
                            </div>
                            <button onClick={() => setIsOpen(false)} className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                                <X className="w-4 h-4 text-gray-400 dark:text-white/50" />
                            </button>
                        </div>

                        {/* Chat Body */}
                        <div className="flex-1 overflow-hidden px-3">
                            <AnimatedAiInput defaultTenantId={tenantId} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </ChatProvider>
    );
}

export default ShiftAIEmbed;
