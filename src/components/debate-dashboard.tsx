import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Brain, Target, Zap, Swords, User, MessageSquarePlus, ChevronDown, ChevronUp, Clock, Trophy } from 'lucide-react';
import { useChat, AGENT_CATEGORIES, AGENT_INFO } from '@/lib/chat-context';
import { MessageRenderer } from './message-renderer';
import { Component as AiLoader } from './ui/ai-loader';
import { cn } from '@/lib/utils';
import TextareaAutosize from 'react-textarea-autosize';
import { GATEWAY_URL } from '@/config';

interface DebateDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TranscriptEntry {
  turn: number;
  agent: string;
  agent_name: string;
  side: string;
  content: string;
}

export function DebateDashboard({ isOpen, onClose }: DebateDashboardProps) {
  const { createNewSession } = useChat();

  // Form state
  const [topic, setTopic] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [agentA, setAgentA] = useState("roberto");
  const [agentB, setAgentB] = useState("carmen");
  const [soulA, setSoulA] = useState("");
  const [soulB, setSoulB] = useState("");
  const [turns, setTurns] = useState(1);

  // Execution state
  const [isDebating, setIsDebating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [debatePhase, setDebatePhase] = useState<string>("Preparando agentes...");

  // ═══ CORE: Simple fetch → JSON (same pattern as chat) ═══
  const handleStartDebate = async () => {
    if (!topic || !expectedOutput) {
      setError("El tema y el objetivo son requeridos.");
      return;
    }

    setIsDebating(true);
    setError(null);
    setResult(null);
    setTranscript([]);
    setExpandedTurns(new Set());
    setDebatePhase("Conectando con los agentes...");

    const controller = new AbortController();
    const TIMEOUT_MS = 300_000; // 5 min for multi-turn debates
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const tenantId = localStorage.getItem('shift_tenant_id') || 'shift';
      const selectedModel = localStorage.getItem('shift_selected_model') || 'Claude Opus 4.6';

      const payload = {
        topic,
        expected_output: expectedOutput,
        agent_a_id: agentA,
        agent_b_id: agentB,
        soul_a: soulA,
        soul_b: soulB,
        turns,
        model: selectedModel,
        tenant_id: tenantId
      };

      console.log("[Debate v3] Starting debate:", payload.agent_a_id, "vs", payload.agent_b_id);

      // Phase animation
      const phases = [
        "Agente Alpha preparando argumento...",
        "Agente Beta analizando posición...",
        "Intercambio de argumentos en curso...",
        "El Juez está evaluando el debate...",
        "Sintetizando veredicto final..."
      ];
      let phaseIndex = 0;
      const phaseInterval = setInterval(() => {
        phaseIndex = Math.min(phaseIndex + 1, phases.length - 1);
        setDebatePhase(phases[phaseIndex]);
      }, 12000); // Every 12s advance phase text

      // ═══ SIMPLE FETCH — Use Express Gateway (not direct Railway) ═══
      const res = await fetch(`/api/debate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearInterval(phaseInterval);

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "Sin detalle");
        console.error("[Debate v3] Error:", res.status, errorBody);
        throw new Error(`Error del servidor (${res.status}): ${errorBody.slice(0, 300)}`);
      }

      const data = await res.json();
      console.log("[Debate v3] Success:", data.turns_completed, "turns,", data.transcript?.length, "entries");

      // Set results
      setResult(data);
      setTranscript(data.transcript || []);

    } catch (err: any) {
      if (err.name === "AbortError") {
        setError("El debate excedió el tiempo límite (5 min). Intenta reducir las rondas.");
      } else {
        setError(err.message || "Error desconocido al ejecutar el debate.");
      }
      console.error("[Debate v3] Error:", err);
    } finally {
      clearTimeout(timeoutId);
      setIsDebating(false);
    }
  };

  const handleUseConclusion = () => {
    if (!result?.content) return;
    createNewSession();
    const event = new CustomEvent('shift:use-debate-context', { detail: { text: result.content } });
    window.dispatchEvent(event);
    onClose();
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    setTranscript([]);
  };

  const toggleTurn = (turn: number) => {
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  };

  const renderAgentSelector = (currentValue: string, onChange: (val: string) => void, label: string) => (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-semibold text-white/60 uppercase tracking-wider">{label}</label>
      <select
        value={currentValue}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-white"
      >
        {Object.entries(AGENT_CATEGORIES).map(([cat, agents]) => (
          <optgroup label={cat.toUpperCase()} key={cat}>
            {Array.isArray(agents) && agents.map(a => (
              <option value={(AGENT_INFO as any)[a]?.id} key={a}>
                {(AGENT_INFO as any)[a]?.name} - {(AGENT_INFO as any)[a]?.role}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-md z-[100]"
            onClick={!isDebating ? onClose : undefined}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-x-4 top-[5%] bottom-[5%] md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[900px] bg-[#0b1120]/95 backdrop-blur-2xl border border-white/10 shadow-[0_30px_100px_rgba(0,0,0,0.8)] rounded-[2rem] z-[101] overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-8 py-5 border-b border-indigo-500/10">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-indigo-500/10 rounded-xl">
                  <Swords className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">The Debate Arena</h2>
                  <p className="text-xs font-medium text-white/50">Orquestación Multi-Agente Estratégica</p>
                </div>
              </div>
              <button onClick={onClose} className="p-2.5 rounded-full hover:bg-white/10 transition-colors" disabled={isDebating}>
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-6 md:p-8 scrollbar-hide flex flex-col gap-6">

              {/* ═══ FORM VIEW ═══ */}
              {!result && !isDebating && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-6">
                  {/* Topic & Output */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-white"><Target className="w-4 h-4 text-indigo-500" /> Tema de Debate</label>
                      <TextareaAutosize minRows={2} placeholder="Ej. ¿Deberíamos expandir a Brasil en Q3 o consolidar México primero?" value={topic} onChange={(e) => setTopic(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none text-white placeholder:text-white/30" />
                    </div>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-white"><Zap className="w-4 h-4 text-amber-500" /> Output Esperado</label>
                      <TextareaAutosize minRows={2} placeholder="Ej. Matriz de decisión con riesgos, costos y timeline por opción" value={expectedOutput} onChange={(e) => setExpectedOutput(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500 outline-none transition-all resize-none text-white placeholder:text-white/30" />
                    </div>
                  </div>

                  {/* Agent Selection */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5 relative">
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-[#0b1120] rounded-full border border-indigo-500/20 flex items-center justify-center z-10 hidden md:flex">
                      <span className="text-xs font-bold text-indigo-500">VS</span>
                    </div>
                    <div className="p-5 rounded-2xl bg-gradient-to-br from-blue-500/5 to-indigo-500/5 border border-blue-500/20 space-y-4">
                      {renderAgentSelector(agentA, setAgentA, "Participante Alpha")}
                      <div className="space-y-1.5 mt-3">
                        <label className="text-xs font-medium text-white/50">Directiva Especial (Opcional)</label>
                        <TextareaAutosize minRows={2} placeholder="Ej. Enfócate en el análisis financiero y riesgos de tipo de cambio..." value={soulA} onChange={(e) => setSoulA(e.target.value)} className="w-full bg-white/5 border border-transparent rounded-xl px-3 py-2 text-xs focus:border-blue-500/50 outline-none transition-all resize-none text-white placeholder:text-white/25" />
                      </div>
                    </div>
                    <div className="p-5 rounded-2xl bg-gradient-to-br from-rose-500/5 to-orange-500/5 border border-rose-500/20 space-y-4">
                      {renderAgentSelector(agentB, setAgentB, "Participante Beta")}
                      <div className="space-y-1.5 mt-3">
                        <label className="text-xs font-medium text-white/50">Directiva Especial (Opcional)</label>
                        <TextareaAutosize minRows={2} placeholder="Ej. Prioriza la velocidad de ejecución y oportunidad de mercado..." value={soulB} onChange={(e) => setSoulB(e.target.value)} className="w-full bg-white/5 border border-transparent rounded-xl px-3 py-2 text-xs focus:border-rose-500/50 outline-none transition-all resize-none text-white placeholder:text-white/25" />
                      </div>
                    </div>
                  </div>

                  {/* Turns Selector */}
                  <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                    <div>
                      <h4 className="text-sm font-semibold text-white">Rondas de Intercambio</h4>
                      <p className="text-xs text-white/50 mt-0.5">Más rondas = argumentos más profundos</p>
                    </div>
                    <div className="flex bg-black/40 p-1 rounded-xl border border-white/10">
                      {[1, 2, 3].map(num => (
                        <button key={num} onClick={() => setTurns(num)} className={cn("px-4 py-1.5 rounded-lg text-sm font-medium transition-all", turns === num ? "bg-indigo-600 text-white shadow-md" : "text-white/60 hover:text-white")}>
                          {num}
                        </button>
                      ))}
                    </div>
                  </div>

                  {error && <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm font-medium">{error}</div>}
                </motion.div>
              )}

              {/* ═══ LOADING VIEW ═══ */}
              {isDebating && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full gap-6 py-12">
                  <AiLoader size={60} text="" />
                  <div className="text-center space-y-2">
                    <h3 className="text-lg font-bold text-white">Debate en Progreso</h3>
                    <motion.p
                      key={debatePhase}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-indigo-400 font-medium"
                    >
                      {debatePhase}
                    </motion.p>
                    <p className="text-xs text-white/40 mt-4">
                      {turns} ronda{turns > 1 ? 's' : ''} × 2 agentes + síntesis del juez
                    </p>
                    <div className="flex items-center gap-2 justify-center mt-3 text-white/30">
                      <Clock className="w-3.5 h-3.5" />
                      <span className="text-xs">Esto puede tomar 30-90 segundos</span>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* ═══ RESULTS VIEW ═══ */}
              {result && !isDebating && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-5">

                  {/* Judge Synthesis — Main Result */}
                  <div className="p-6 bg-gradient-to-br from-emerald-500/5 to-teal-500/5 border border-emerald-500/20 rounded-2xl">
                    <div className="flex items-center gap-3 mb-4 pb-4 border-b border-white/10">
                      <div className="p-2 bg-emerald-500/10 rounded-lg">
                        <Trophy className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div>
                        <h3 className="font-bold text-white text-sm">Veredicto del Juez Estratégico</h3>
                        <p className="text-xs text-white/50">{result.turns_completed} ronda{result.turns_completed > 1 ? 's' : ''} • Modelo: {result.model_used}</p>
                      </div>
                    </div>
                    <div className="text-[14px] text-white/90 leading-relaxed">
                      <MessageRenderer content={result.content} />
                    </div>
                  </div>

                  {/* Transcript — Collapsible */}
                  {transcript.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider px-1">Transcripción del Debate</h4>
                      {transcript.map((entry, i) => {
                        const isExpanded = expandedTurns.has(i);
                        const isSideA = entry.side === "A";
                        return (
                          <div key={i} className={cn(
                            "rounded-xl border transition-all",
                            isSideA ? "border-blue-500/15 bg-blue-500/5" : "border-rose-500/15 bg-rose-500/5"
                          )}>
                            <button
                              onClick={() => toggleTurn(i)}
                              className="w-full flex items-center justify-between px-4 py-3 text-left"
                            >
                              <div className="flex items-center gap-2">
                                <span className={cn("text-xs font-bold px-2 py-0.5 rounded-full", isSideA ? "bg-blue-500/20 text-blue-400" : "bg-rose-500/20 text-rose-400")}>
                                  {entry.side}
                                </span>
                                <span className="text-sm font-medium text-white">{entry.agent_name}</span>
                                <span className="text-xs text-white/40">Turno {entry.turn}</span>
                              </div>
                              {isExpanded ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
                            </button>
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: "auto", opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="px-4 pb-4 text-[13px] text-white/80 leading-relaxed border-t border-white/5 pt-3">
                                    <MessageRenderer content={entry.content} />
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </motion.div>
              )}
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-indigo-500/10 flex justify-between gap-3 bg-black/20">
              <div>
                {result && !isDebating && (
                  <button onClick={handleReset} className="px-4 py-2.5 rounded-xl text-sm font-medium text-white/50 hover:bg-white/10 transition-colors">
                    ← Nuevo Debate
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-medium text-white/50 hover:bg-white/10 transition-colors" disabled={isDebating}>
                  {isDebating ? "Debatiendo..." : "Cancelar"}
                </button>
                {!result && !isDebating && (
                  <button onClick={handleStartDebate} className="px-6 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_15px_rgba(79,70,229,0.3)] transition-all flex items-center gap-2">
                    <Swords className="w-4 h-4" /> Iniciar Debate
                  </button>
                )}
                {result && !isDebating && (
                  <button onClick={handleUseConclusion} className="px-6 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all flex items-center gap-2">
                    <MessageSquarePlus className="w-4 h-4" /> Usar Veredicto en Chat
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
