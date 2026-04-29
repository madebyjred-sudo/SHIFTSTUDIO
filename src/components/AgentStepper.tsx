/**
 * AgentStepper — Multi-agent workflow progress visualization
 *
 * Shows a linear horizontal stepper of agent nodes and their execution status.
 * Auto-hides when no agent nodes are present.
 *
 * Attribution: Onyx Deep Research + LobeChat progress patterns (MIT)
 * See THIRD_PARTY_NOTICES.md
 */
import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X } from 'lucide-react';
import { useActiveGraphStore } from '@/store';
import { resolveAgent } from '@/config/agentRegistry';
import { cn } from '@/lib/utils';

export function AgentStepper() {
  const nodes = useActiveGraphStore((s) => s.nodes);
  
  // Filter only agent/specialist nodes
  const agentNodes = nodes.filter(n => 
    ['specialist', 'agente'].includes(n.type ?? '')
  );

  if (agentNodes.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white/90 dark:bg-[#1A1A1A]/90 backdrop-blur-md border border-slate-200 dark:border-white/10 rounded-bubble px-6 py-3 shadow-raised max-w-full overflow-x-auto scrollbar-hide flex items-center"
    >
      <div className="flex items-center gap-0">
        <AnimatePresence>
          {agentNodes.map((node, i) => {
            const agentId = (node.data?.agentId || node.data?.agent) as string;
            const status = (node.data?.status as string) || 'IDLE';
            const agent = resolveAgent(agentId);
            
            const isRunning = status === 'RUNNING';
            const isCompleted = status === 'COMPLETED';
            const isFailed = status === 'FAILED';
            const isIdle = status === 'IDLE';

            // Connector style to the NEXT node
            const nextNode = agentNodes[i + 1];
            const isConnectorActive = isCompleted && nextNode && ['RUNNING', 'COMPLETED'].includes(nextNode.data?.status as string || 'IDLE');

            return (
              <React.Fragment key={node.id}>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.08, duration: 0.2 }}
                  className="flex flex-col items-center gap-1.5 relative min-w-[60px]"
                >
                  <div className="relative">
                    <div
                      className={cn(
                        "w-8 h-8 rounded-pill flex items-center justify-center text-body border-2 transition-colors z-10 relative bg-white dark:bg-[#1A1A1A]",
                        isIdle && "border-slate-300 dark:border-white/20",
                        isRunning && "border-shift-status-running",
                        isCompleted && "border-shift-status-completed",
                        isFailed && "border-shift-status-failed"
                      )}
                      style={{ color: agent.color }}
                    >
                      {agent.emoji}
                    </div>
                    
                    {isRunning && (
                      <div className="absolute inset-0 rounded-pill border-2 border-shift-status-running animate-ping opacity-30" />
                    )}

                    {/* Status Badge Bottom Right */}
                    {!isIdle && (
                      <div className={cn(
                        "absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-pill flex items-center justify-center border border-white dark:border-[#1A1A1A] z-20",
                        isRunning ? "bg-shift-status-running text-white" : 
                        isCompleted ? "bg-shift-status-completed text-white" : 
                        "bg-shift-status-failed text-white"
                      )}>
                        {isRunning && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                        {isCompleted && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                        {isFailed && <X className="w-2.5 h-2.5" strokeWidth={3} />}
                      </div>
                    )}
                  </div>
                  
                  <span className="text-micro font-medium text-slate-600 dark:text-slate-300 truncate max-w-[70px] text-center">
                    {agent.name}
                  </span>
                </motion.div>

                {/* Connector Line */}
                {i < agentNodes.length - 1 && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.08 + 0.1 }}
                    className={cn(
                      "w-8 h-[2px] -mt-5 mx-0 rounded-pill transition-colors duration-slow",
                      isConnectorActive ? "bg-shift-status-running/50 dark:bg-shift-status-running/50" : (isCompleted ? "bg-shift-status-completed/50 dark:bg-shift-status-completed/50" : "bg-slate-200 dark:bg-white/10")
                    )}
                  />
                )}
              </React.Fragment>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
