import React, { useRef, useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot, Box, TrendingUp, Loader2, Info, Square, ArrowUp,
  Code, Server, Cloud, Smartphone, Shield, Palette, PenTool,
  BarChart3, Target, DollarSign, Layers, Scale, CheckCircle, Brain,
  ChevronDown, X, Users, Sparkles, Zap, Paperclip, FileText
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { TextLoop } from "@/components/ui/text-loop";
import { useChat, Agent, AGENT_INFO, AGENT_CATEGORIES, AGENT_MODEL_MAP, AGENT_ICONS, Attachment } from "@/lib/chat-context";
import { MessageRenderer } from "./message-renderer";
import { AgentBadge } from "./AgentBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { SuggestChips } from "./SuggestChips";
import { DebateDashboard } from "./debate-dashboard";
import { GATEWAY_URL } from "@/config";
import { parseAndApplyGraphTopology } from "@/lib/graph-parser";
import { useActiveGraphStore } from "@/store";
import { isV2Enabled } from "@/store";

function useAutoResizeTextarea(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value, ref]);
}

const ALL_AGENTS: Agent[] = [
  ...AGENT_CATEGORIES.general,
  ...AGENT_CATEGORIES["c-suite"],
  ...AGENT_CATEGORIES.marketing,
  ...AGENT_CATEGORIES.inteligencia,
  ...AGENT_CATEGORIES.operaciones,
];

const CATEGORY_LABELS: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  general: { label: "General", color: "#00A651", icon: Bot },
  "c-suite": { label: "C-Suite & Estrategia", color: "#1E40AF", icon: Target },
  marketing: { label: "Marketing & Contenido", color: "#EC4899", icon: TrendingUp },
  inteligencia: { label: "Data & Inteligencia", color: "#6366F1", icon: BarChart3 },
  operaciones: { label: "Operaciones & Governance", color: "#991B1B", icon: Scale },
};

function getAgentCategory(agent: Agent): string {
  for (const [cat, agents] of Object.entries(AGENT_CATEGORIES)) {
    if (agents.includes(agent)) return cat;
  }
  return "general";
}

const getAgentBestUses = (agent: Agent) => {
  switch (getAgentCategory(agent)) {
    case "c-suite": return ["un Pitch Deck", "un Financial Model", "una Estrategia de Marca", "un Roadmap"];
    case "marketing": return ["una Estrategia SEO", "un Copy Persuasivo", "una Campaña de Ads", "un Calendario Editorial"];
    case "inteligencia": return ["un Análisis de Funnel", "un Battlecard Competitivo", "un Health Score", "un ROI Report"];
    case "operaciones": return ["una Política de Privacidad", "un Pipeline Forecast", "una Sprint Planning", "Compliance GDPR"];
    default: return ["un Análisis General", "una Investigación", "una Idea Creativa", "una Solución Rápida"];
  }
};

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface AnimatedAiInputProps {
  defaultTenantId?: string;
  onOpenHistory?: () => void;
  compact?: boolean;
}

export function AnimatedAiInput({ defaultTenantId = "shift", onOpenHistory, compact = false }: AnimatedAiInputProps) {
  const {
    currentMessages: messages, currentSessionId, selectedModel, selectedAgent,
    setSelectedModel, setSelectedAgent, isLoading, setIsLoading, hasInteracted,
    setHasInteracted, searchEnabled, setSearchEnabled, tenantId, addMessage, createNewSession
  } = useChat();

  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);
  useAutoResizeTextarea(textareaRef, value);

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (underlayRef.current) {
      underlayRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  const renderUnderlay = () => {
    if (!value) return null;

    const agentMap: Record<string, string> = {};
    Object.keys(AGENT_INFO).forEach(agentKey => {
      const info = AGENT_INFO[agentKey as Agent];
      const firstName = info.name.split(' ')[0].toLowerCase();
      agentMap[firstName] = info.color;
    });

    const parts = value.split(/(@\w+)/g);
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        const name = part.slice(1).toLowerCase();
        if (agentMap[name] || name === 'shifty' || name === 'debate') {
          const color = agentMap[name] || '#6366F1';
          return <span key={i} style={{ color, fontWeight: 700, backgroundColor: `${color}20`, borderRadius: '4px', padding: '0 2px' }}>{part}</span>;
        }
      }
      return <span key={i}>{part}</span>;
    });
  };

  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isAdvancedDropdownOpen, setIsAdvancedDropdownOpen] = useState(false);
  const [isDebateMode, setIsDebateMode] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const activeMode = useActiveGraphStore((state) => state.activeMode);
  const isCanvasMode = activeMode === 'canvas';
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!compact || !isCanvasMode) return;

    const panel = panelRef.current;
    if (!panel) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
        return;
      }

      if (e.key === 'Escape') {
        setIsAgentSelectorOpen(false);
        setIsModelDropdownOpen(false);
        setIsAdvancedDropdownOpen(false);
      }

      if (e.key !== 'Tab') return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener('keydown', onKeyDown);
    return () => panel.removeEventListener('keydown', onKeyDown);
  }, [compact, isCanvasMode]);

  // File handling functions
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newAttachments: Attachment[] = [];
    const maxSize = 10 * 1024 * 1024; // 10MB
    const allowedTypes = [
      'text/plain', 'text/csv', 'application/json', 'text/markdown',
      'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    for (const file of Array.from(files)) {
      if (file.size > maxSize) {
        console.warn(`File ${file.name} exceeds 10MB limit`);
        continue;
      }

      try {
        const content = await readFileAsBase64(file);
        newAttachments.push({
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          name: file.name,
          type: file.type,
          size: file.size,
          content
        });
      } catch (err) {
        console.error(`Failed to read file ${file.name}:`, err);
      }
    }

    setAttachments(prev => [...prev, ...newAttachments].slice(0, 5)); // Max 5 files
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix, keep only base64
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const effectiveAgent = isDebateMode ? "Debate Swarm" : isCanvasMode ? "Shift AI" : selectedAgent;
  const agentInfo = AGENT_INFO[effectiveAgent];
  const isAgentSelected = effectiveAgent !== "Shift AI";
  const AgentIcon = AGENT_ICONS[agentInfo.icon] || Bot;

  useEffect(() => {
    if (value.trim().length > 0 && !hasInteracted) setHasInteracted(true);
  }, [value, hasInteracted]);

  const handleUseAsContext = (contextText: string) => {
    createNewSession();
    setValue(`Basado en la siguiente conclusión del debate, necesito iterar sobre esto:\n\n${contextText}\n\nMi pregunta es: `);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      if (ce.detail?.text) handleUseAsContext(ce.detail.text);
    };
    window.addEventListener('shift:use-debate-context', handler);
    return () => window.removeEventListener('shift:use-debate-context', handler);
  }, [createNewSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    const close = () => { setIsAgentSelectorOpen(false); setIsModelDropdownOpen(false); setIsAdvancedDropdownOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const models = ["Shifty 2.0 by Shift AI", "Claude Sonnet 4.6", "Gemini 3.1 Flash Lite", "DeepSeek V3.2"] as const;
  const advancedModels = ["Gemini 3.1 Pro", "Claude Opus 4.6", "Moonshot Kimi K2.5"] as const;

  const handleStop = () => { abortControllerRef.current?.abort(); setIsLoading(false); abortControllerRef.current = null; };

  const handleSubmit = async () => {
    if (isLoading) { handleStop(); return; }
    if (!value.trim()) return;

    const userMessage = {
      id: Date.now().toString(),
      role: "user" as const,
      content: value.trim(),
      attachments: attachments.length > 0 ? attachments : undefined
    };
    const activeSessionId = currentSessionId || Date.now().toString();
    addMessage(userMessage, activeSessionId);
    setValue("");
    setIsLoading(true);
    abortControllerRef.current = new AbortController();

    try {
      const allMessages = [
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: isCanvasMode ? `${userMessage.content}\n\n[SYSTEM INSTRUCTION: EL USUARIO HA ACTIVADO EL MODO NODOS. DEBES RESPONDER INVARIABLEMENTE CON UN ARREGLO JSON QUE CONTENGA LA TOPOLOGIA DEL WORKFLOW SECUENCIAL SOLICITADO, USANDO LOS NODOS ESPECIALISTAS. NO RESPONDAS CON TEXTO CONVERSACIONAL, SOLO EL BLOQUE \`\`\`json.]` : userMessage.content }
      ];

      if (isV2Enabled && isCanvasMode) {
        const { generateGraph } = useActiveGraphStore.getState();
        const response = await generateGraph(userMessage.content, messages, tenantId || defaultTenantId);
        
        const finalContent = response.mode === 'graph' 
            ? (response.narrative || "He actualizado el workflow en el Canvas visual.")
            : (response.message || "No pude generar un grafo para esta solicitud.");

        addMessage({
          id: (Date.now() + 1).toString(),
          role: "assistant" as const,
          content: finalContent,
          agent: effectiveAgent,
          model: selectedModel,
        }, activeSessionId);
        
        // Skip the legacy V1 /api/chat processing
        return;
      }

      const res = await fetch(`/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: allMessages,
          preferred_agent: AGENT_INFO[effectiveAgent].id,
          model: selectedModel,
          tenant_id: tenantId || defaultTenantId,
          session_id: activeSessionId,
          search_enabled: searchEnabled,
          attachments: attachments,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.detail || "Failed to fetch response");
      }

      const data = await res.json();

      const { success: graphFound, cleanContent } = parseAndApplyGraphTopology(data.content);
      let finalContent = cleanContent;

      if (graphFound) {
        // Use a clean message - the JSON has already been stripped from cleanContent
        finalContent = finalContent || "✅ He generado el workflow en el lienzo visual. Puedes ver y editar los nodos en la vista Canvas.";
      } else if (isCanvasMode) {
        // Guardrail: if parser fails while in Canvas mode, never dump raw JSON into chat
        const rawContent = String(data.content || '').trim();
        const looksLikeTopologyJson =
          (rawContent.startsWith('{') || rawContent.startsWith('```json')) &&
          rawContent.includes('"topology"');

        if (looksLikeTopologyJson) {
          finalContent = "⚠️ Recibí una topología JSON inválida y no pude pintarla en el canvas. Intenta de nuevo y lo vuelvo a generar automáticamente.";
        }
      }

      addMessage({
        // Si el backend devolvió message_id (post-multi-app v3), lo
        // usamos como id estable para el turn — ese mismo id está en
        // cerebro_training_pairs y se lo pasamos al widget para que
        // los likes/dislikes caigan al row correcto. Fallback a
        // timestamp local si el backend no lo expone aún.
        id: data.message_id || (Date.now() + 1).toString(),
        role: "assistant" as const,
        content: finalContent,
        agent: effectiveAgent,
        model: selectedModel,
        agentActive: data.agent_active,
        // upstream_model viene del backend cuando éste lo expone.
        // Es lo que determina legal_status del training_pair.
        upstreamModel: data.upstream_model || data.model_used,
      }, activeSessionId);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        addMessage({
          id: (Date.now() + 1).toString(),
          role: "assistant" as const,
          content: error.message === "Failed to fetch response"
            ? "Hubo un error al procesar tu solicitud. Por favor, inténtalo de nuevo."
            : `Error: ${error.message}`,
          agent: effectiveAgent,
          model: selectedModel,
        });
      }
    } finally {
      setIsLoading(false);
      setAttachments([]); // Clear attachments after sending
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  return (
    <div
      ref={panelRef}
      className={cn(
        "w-full flex flex-col relative z-10 h-full transition-all duration-500",
        (!hasInteracted && !isCanvasMode && !compact) ? "justify-center items-center" : "justify-end"
      )}
      role={compact && isCanvasMode ? "region" : undefined}
      aria-label={compact && isCanvasMode ? "Panel de chat para modo nodos" : undefined}
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn(
            "w-2 h-2 rounded-full",
            isCanvasMode ? "bg-indigo-500" : "bg-emerald-500"
          )} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#0e1745] dark:text-white truncate">
              {compact ? "Chat de Nodos" : "Workspace Chat"}
            </p>
            <p className="text-[10px] text-[#0e1745]/45 dark:text-white/45 truncate">
              {isCanvasMode ? "Orquestador activo para construcción de workflows" : "Conversación estratégica con Legio Digitalis"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isCanvasMode && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">
              <Layers className="w-3 h-3" />
              Nodes
            </span>
          )}
          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label="Historial de chats"
            >
              <Info className="w-4 h-4 text-[#0e1745]/50 dark:text-white/50" />
            </button>
          )}
        </div>
      </div>
      <AnimatePresence>
        {messages.length === 0 && !value && !isCanvasMode && (
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full flex flex-col items-center gap-4 px-4">
            <motion.h1
              initial={{ opacity: 0, y: 15, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -15, filter: "blur(6px)" }}
              className="text-xl font-medium text-[#0e1745]/60 dark:text-white/60 text-center tracking-tight flex flex-col items-center justify-center gap-2"
            >
              <span>¿Querés que creemos</span>
              <TextLoop
                className={cn("font-semibold", isAgentSelected ? "" : "text-[#0e1745] dark:text-white")}
                style={isAgentSelected ? { color: agentInfo.color } : {}}
              >
                {getAgentBestUses(effectiveAgent).map((text) => <span key={text}>{text}</span>)}
              </TextLoop>
              <span>?</span>
            </motion.h1>
          </div>
        )}
        {messages.length === 0 && !value && isCanvasMode && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[60%] w-full flex flex-col items-center gap-4 px-4 text-center">
            <motion.div
              initial={{ opacity: 0, y: 15, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -15, filter: "blur(6px)" }}
              className="flex flex-col items-center gap-3"
            >
              <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 rounded-2xl flex items-center justify-center mb-1">
                <Bot className="w-6 h-6" />
              </div>
              <h1 className="text-[17px] font-bold text-[#0e1745] dark:text-white tracking-tight">
                Instruye al Orquestador
              </h1>
              <p className="text-[13px] leading-relaxed text-[#0e1745]/60 dark:text-white/60 max-w-[280px]">
                Describe el objetivo del flujo o comienza con un caso preconfigurado para generar una topología adaptativa.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="flex flex-col gap-2 w-full max-w-[320px] mt-2"
            >
              <button 
                onClick={() => { setValue("Crea una secuencia para analizar churn de usuarios en nuestra base SQL y mandar un reporte ejecutivo"); textareaRef.current?.focus(); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-xs font-medium text-left bg-white/60 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-[#0e1745]/10 dark:border-white/10 rounded-xl transition-all shadow-sm group"
              >
                <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">📊</div>
                <span className="text-[#0e1745] dark:text-white/90">Analizar Churn & Reporte</span>
              </button>
              <button 
                onClick={() => { setValue("Diseña un plan de onboarding transaccional validando documentos legales del cliente"); textareaRef.current?.focus(); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-xs font-medium text-left bg-white/60 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-[#0e1745]/10 dark:border-white/10 rounded-xl transition-all shadow-sm group"
              >
                <div className="w-6 h-6 rounded-md bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">🚀</div>
                <span className="text-[#0e1745] dark:text-white/90">B2B Onboarding KYC</span>
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Chat Messages */}
      {hasInteracted && (
        <div className="flex-1 w-full relative mb-2 px-3 flex flex-col min-h-0">
          {messages.length > 0 && (
            <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-5 pb-6 pt-2">
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className={cn("w-full flex", msg.role === "user" ? "justify-end" : "justify-start")}
                  >
                    {msg.role === "user" ? (
                      <div className="max-w-[80%] bg-blue-600/20 border border-blue-500/30 text-[#0e1745] dark:text-white rounded-2xl rounded-tr-sm p-chat-bubble text-[14px] leading-relaxed">
                        <MessageRenderer content={msg.content} isUser={true} />
                      </div>
                    ) : (
                      <div className="w-full flex flex-col items-start gap-4">
                        <div className="w-full bg-white/60 dark:bg-white/5 backdrop-blur-md border border-white/50 dark:border-white/10 rounded-2xl p-chat-bubble text-[#0e1745] dark:text-white/90 leading-relaxed shadow-sm">
                          <div className="mb-4">
                            <AgentBadge agentId={msg.agent || msg.agentActive} />
                          </div>
                          <div className="text-[14px] opacity-90">
                            <MessageRenderer
                              content={msg.content}
                              onUseAsContext={(msg.agent === "Debate Swarm" && msg === messages[messages.length - 1] && !isLoading) ? () => handleUseAsContext(msg.content) : undefined}
                              feedback={{
                                messageId: msg.id,
                                sessionId: currentSessionId || `session-${msg.id}`,
                                tenantId: tenantId || defaultTenantId,
                                agentId: msg.agentActive || (msg.agent ? AGENT_INFO[msg.agent]?.id : undefined),
                                upstreamModel: msg.upstreamModel,
                              }}
                            />
                          </div>
                        </div>
                        <SuggestChips 
                          visible={msg === messages[messages.length - 1] && msg.role === "assistant" && !isLoading && !value.trim()} 
                          onSelect={(question) => { 
                            setValue(question); 
                            textareaRef.current?.focus(); 
                          }} 
                        />
                      </div>
                    )}
                  </motion.div>
                ))}
                {isLoading && (
                  <ThinkingIndicator agentId={effectiveAgent} />
                )}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Input Area */}
      <div className="w-full mt-auto shrink-0 relative px-4 pb-6">
        <div className="relative w-full rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10">
          <div className="relative z-10 flex flex-col w-full">
            {/* Attachment Chips */}
            {attachments.length > 0 && (
              <div className="px-5 pt-4 pb-2 flex flex-wrap gap-2">
                {attachments.map((att) => (
                  <motion.div
                    key={att.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="flex items-center gap-1.5 px-2 py-1 bg-blue-100 dark:bg-blue-500/20 border border-blue-200 dark:border-blue-500/30 rounded-lg text-micro text-blue-700 dark:text-blue-300"
                  >
                    <FileText className="w-3 h-3" />
                    <span className="max-w-[120px] truncate">{att.name}</span>
                    <span className="text-blue-400 dark:text-blue-400/60">({formatFileSize(att.size)})</span>
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="ml-1 p-0.5 hover:bg-blue-200 dark:hover:bg-blue-500/30 rounded"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </motion.div>
                ))}
              </div>
            )}
            <div className="relative w-full overflow-hidden">
              <div
                ref={underlayRef}
                aria-hidden="true"
                className={cn(
                  "absolute inset-0 pointer-events-none whitespace-pre-wrap break-words overflow-hidden p-5 pb-3 text-body leading-relaxed",
                  isCanvasMode ? "text-[#0e1745] dark:text-white" : "invisible"
                )}
              >
                {renderUnderlay()}
                {value.endsWith('\n') ? <br /> : null}
              </div>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => { if (!hasInteracted) setHasInteracted(true); setIsFocused(true); }}
                onBlur={() => setIsFocused(false)}
                onKeyDown={handleKeyDown}
                onScroll={handleScroll}
                placeholder={isCanvasMode ? "Instruye al Orquestador (Usa @ para asignar especialistas)..." : `Escribe tu mensaje para ${agentInfo.name}...`}
                className={cn(
                  "w-full resize-none outline-none min-h-[48px] max-h-[200px] text-body leading-relaxed p-5 pb-3 relative z-10 scrollbar-hide",
                  isCanvasMode
                    ? "bg-transparent text-transparent caret-[#0e1745] dark:caret-white placeholder-black/30 dark:placeholder-white/30"
                    : "bg-transparent text-[#0e1745] dark:text-white placeholder-black/30 dark:placeholder-white/30"
                )}
                rows={1}
                disabled={isLoading}
                spellCheck={false}
              />
            </div>
            <div className="flex items-center justify-between px-5 pb-4 pt-2 w-full">
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Attach File — compact icon */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.csv,.json,.md,.pdf,.docx"
                  onChange={handleFileSelect}
                  className="sr-only"
                  tabIndex={-1}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  title={attachments.length > 0 ? `${attachments.length} adjunto${attachments.length > 1 ? 's' : ''}` : 'Adjuntar archivo'}
                  className={cn(
                    "p-1.5 rounded-lg transition-all",
                    attachments.length > 0
                      ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                      : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60 hover:bg-gray-100 dark:hover:bg-white/5"
                  )}
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                {/* Web Search — compact icon */}
                <button
                  onClick={() => setSearchEnabled(!searchEnabled)}
                  title={searchEnabled ? 'Búsqueda web activa' : 'Activar búsqueda web'}
                  className={cn(
                    "p-1.5 rounded-lg transition-all",
                    searchEnabled
                      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10"
                      : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60 hover:bg-gray-100 dark:hover:bg-white/5"
                  )}
                >
                  <TrendingUp className="w-4 h-4" />
                </button>

                {/* Separator */}
                <div className="w-px h-4 bg-gray-200 dark:bg-white/10 mx-1" />

                {/* Model Selector — prominent */}
                <div className="relative">
                  <button onClick={(e) => { e.stopPropagation(); setIsModelDropdownOpen(!isModelDropdownOpen); setIsAgentSelectorOpen(false); setIsAdvancedDropdownOpen(false); }} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-pill text-gray-600 dark:text-white/60 bg-gray-100 dark:bg-white/5 border border-transparent hover:bg-gray-200 dark:hover:bg-white/10 transition-colors">
                    <Box className="w-3.5 h-3.5" />{selectedModel.split(' ')[0]}<ChevronDown className="w-3 h-3 opacity-50" />
                  </button>
                  <AnimatePresence>
                    {isModelDropdownOpen && (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="absolute left-0 bottom-full mb-2 w-56 bg-white dark:bg-[#0e1745] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 p-1">
                        {[...models, ...advancedModels].map((model) => (
                          <button key={model} onClick={(e) => { e.stopPropagation(); setSelectedModel(model); setIsModelDropdownOpen(false); }} className={cn("w-full text-left px-3 py-2 text-caption rounded-lg transition-colors", selectedModel === model ? "bg-blue-50 dark:bg-white/10 font-medium" : "hover:bg-gray-50 dark:hover:bg-white/5")}>
                            {model}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {/* Agent Selector — prominent */}
                {isCanvasMode ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-pill cursor-default text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30">
                    <Bot className="w-3.5 h-3.5" /><span>Orchestrator</span>
                  </div>
                ) : (
                  <div className="relative">
                    <button onClick={(e) => { e.stopPropagation(); setIsAgentSelectorOpen(!isAgentSelectorOpen); setIsModelDropdownOpen(false); setIsAdvancedDropdownOpen(false); }}
                      className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-pill transition-all border", isAgentSelected ? "text-white border-transparent" : "text-gray-500 dark:text-white/50 bg-gray-100 dark:bg-white/5 border-transparent hover:bg-gray-200 dark:hover:bg-white/10")}
                      style={isAgentSelected ? { backgroundColor: agentInfo.color } : {}}
                    >
                      {React.createElement(AgentIcon, { className: "w-3.5 h-3.5" })}
                      <span className="max-w-[80px] truncate">{agentInfo.name}</span>
                      <ChevronDown className="w-3 h-3 opacity-70" />
                    </button>
                    <AnimatePresence>
                      {isAgentSelectorOpen && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="absolute left-0 bottom-full mb-2 w-72 max-h-[400px] overflow-y-auto bg-white dark:bg-[#0e1745] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 p-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-white/10 mb-2">
                            <span className="text-[10px] font-semibold text-gray-400 dark:text-white/40 uppercase tracking-wider">Legio Digitalis - 15 Agentes</span>
                            <Users className="w-3 h-3 text-gray-400 dark:text-white/40" />
                          </div>
                          {Object.entries(AGENT_CATEGORIES).map(([category, agents]) => {
                            const catInfo = CATEGORY_LABELS[category];
                            const CatIcon = catInfo.icon;
                            return (
                              <div key={category} className="mb-2">
                                <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-semibold rounded-lg mb-1" style={{ color: catInfo.color, backgroundColor: `${catInfo.color}15` }}>
                                  <CatIcon className="w-3 h-3" />{catInfo.label}
                                </div>
                                {agents.map((agent) => {
                                  const info = AGENT_INFO[agent];
                                  const AIcomp = AGENT_ICONS[info.icon] || Bot;
                                  const isSel = selectedAgent === agent;
                                  return (
                                    <button key={agent} onClick={(e) => { e.stopPropagation(); setSelectedAgent(agent); setIsAgentSelectorOpen(false); }}
                                      className={cn("w-full flex items-center gap-2 px-3 py-2 text-[12px] rounded-lg transition-all", isSel ? "bg-gray-100 dark:bg-white/10 font-medium" : "hover:bg-gray-50 dark:hover:bg-white/5")}
                                    >
                                      <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ backgroundColor: `${info.color}20`, color: info.color }}>
                                        <AIcomp className="w-3 h-3" />
                                      </div>
                                      <div className="flex-1 text-left">
                                        <div className={cn("font-medium text-[12px]", isSel ? "text-gray-900 dark:text-white" : "text-gray-700 dark:text-white/70")}>{info.name}</div>
                                        <div className="text-[10px] text-gray-400 dark:text-white/40 truncate">{info.role}</div>
                                      </div>
                                      {isSel && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: info.color }} />}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
              <button onClick={handleSubmit} className={cn("p-2.5 rounded-pill transition-all duration-base", (value.trim() || isLoading) ? "bg-shift-primary text-white hover:scale-105 shadow-raised" : "bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed")} disabled={!value.trim() && !isLoading}>
                {isLoading ? <Square className="w-4 h-4 fill-current" /> : <ArrowUp className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

      </div>

      <DebateDashboard isOpen={isDebateMode} onClose={() => setIsDebateMode(false)} />
    </div>
  );
}
