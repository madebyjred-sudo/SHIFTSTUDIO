import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, Check, X, Loader2, Play } from 'lucide-react';
import { useActiveGraphStore } from '../store';

export function HITLModal() {
  const { hitlState, resumeHitl } = useActiveGraphStore();
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  if (!hitlState || hitlState.status !== 'paused') return null;

  const handleDecision = async (decision: 'approve' | 'reject') => {
    setSubmitting(decision);
    try {
      await resumeHitl(decision);
    } catch (error) {
      console.error("Resume failed", error);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-[#0e1745]/40 dark:bg-black/60 backdrop-blur-md"
        />
        
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="relative max-w-lg w-full mx-4 bg-white dark:bg-[#1A1A1A] border border-blue-100 dark:border-white/10 rounded-modal shadow-modal overflow-hidden"
        >
          {/* Header */}
          <div className="bg-amber-50 dark:bg-amber-500/10 px-6 py-4 border-b border-amber-100 dark:border-amber-500/20 flex flex-col items-center justify-center text-center gap-2">
            <div className="w-12 h-12 rounded-pill bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center text-amber-600 dark:text-amber-400">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-amber-900 dark:text-amber-300 tracking-tight">Atención Requerida</h3>
              <p className="text-caption text-amber-700/80 dark:text-amber-400/80 font-medium">
                El flujo se ha pausado y demanda revisión humana
              </p>
            </div>
          </div>

          {/* Body */}
          <div className="p-6">
            <div className="bg-gray-50 dark:bg-black/20 border border-gray-100 dark:border-white/5 rounded-xl p-4 text-body text-gray-800 dark:text-gray-200 font-medium leading-relaxed mb-6">
              {hitlState.prompt || "¿Autorizas la continuación del proceso?"}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleDecision('reject')}
                disabled={submitting !== null}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
              >
                {submitting === 'reject' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <X className="w-4 h-4" />
                )}
                Rechazar
              </button>
              
              <button
                onClick={() => handleDecision('approve')}
                disabled={submitting !== null}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-semibold transition-colors disabled:opacity-50 shadow-raised"
              >
                {submitting === 'approve' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Aprobar y Continuar
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
