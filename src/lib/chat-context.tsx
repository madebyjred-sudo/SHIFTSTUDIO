import React, { createContext, useContext, useState, useEffect } from 'react';

export type Model = "Shifty 2.0 by Shift AI" | "Claude Sonnet 4.6" | "Gemini 3.1 Flash Lite" | "DeepSeek V3.2" | "Gemini 3.1 Pro" | "Claude Opus 4.6" | "Moonshot Kimi K2.5";

// ═══════════════════════════════════════════════════════════════
// AGENT ROSTER v2.0 - Business/Marketing Focus
// 15 Agentes organizados en 4 PODs
// ═══════════════════════════════════════════════════════════════

export type Agent =
  | "Shift AI"
  | "Debate Swarm"
  // POD 1: C-SUITE & ESTRATEGIA (4)
  | "Carmen - CEO"
  | "Roberto - CFO"
  | "Valentina - CMO"
  | "Diego - CPO"
  // POD 2: MARKETING & CONTENIDO (4)
  | "Jorge - Content"
  | "Lucía - SEO/Growth"
  | "Isabella - Paid Media"
  | "Mateo - Social"
  // POD 3: DATA & INTELIGENCIA (3)
  | "Andrés - Analytics"
  | "Daniela - Competitive Intel"
  | "Emilio - Customer Success"
  // POD 4: OPERACIONES & GOVERNANCE (4)
  | "Patricia - Legal"
  | "Santiago - RevOps"
  | "Catalina - Project Mgr";

// Categorías de agentes para el UI - 4 PODs
export const AGENT_CATEGORIES = {
  general: ["Shift AI"] as Agent[],
  "c-suite": ["Carmen - CEO", "Roberto - CFO", "Valentina - CMO", "Diego - CPO"] as Agent[],
  marketing: ["Jorge - Content", "Lucía - SEO/Growth", "Isabella - Paid Media", "Mateo - Social"] as Agent[],
  inteligencia: ["Andrés - Analytics", "Daniela - Competitive Intel", "Emilio - Customer Success"] as Agent[],
  operaciones: ["Patricia - Legal", "Santiago - RevOps", "Catalina - Project Mgr"] as Agent[],
};

// Información de cada agente
export const AGENT_INFO: Record<Agent, { id: string; name: string; role: string; skills: string; color: string; icon: string }> = {
  "Shift AI": { id: "shiftai", name: "Shifty", role: "Orquestador General", skills: "Tareas generales, redacción, análisis básico, routing inteligente", color: "#00A651", icon: "Bot" },
  "Debate Swarm": { id: "debate_swarm", name: "Debate Estratégico", role: "Orquestador de Swarm", skills: "Análisis crítico, múltiples perspectivas, síntesis", color: "#6366F1", icon: "Brain" },
  // POD 1: C-SUITE
  "Carmen - CEO": { id: "carmen", name: "Carmen", role: "CEO & Estrategia", skills: "Vision, Fundraising, OKRs, Pitch Decks, Cultura organizacional", color: "#1E40AF", icon: "Target" },
  "Roberto - CFO": { id: "roberto", name: "Roberto", role: "CFO & Finanzas", skills: "Burn Rate, Runway, Unit Economics, LTV/CAC, SaaS Metrics", color: "#059669", icon: "DollarSign" },
  "Valentina - CMO": { id: "valentina", name: "Valentina", role: "CMO & Marketing", skills: "Brand Strategy, Growth Models, CAC/LTV, Demand Gen", color: "#EC4899", icon: "TrendingUp" },
  "Diego - CPO": { id: "diego", name: "Diego", role: "CPO & Producto", skills: "Product Strategy, PMF, Roadmapping, North Star, Retention", color: "#7C3AED", icon: "Layers" },
  // POD 2: MARKETING
  "Jorge - Content": { id: "jorge", name: "Jorge", role: "Content Strategist", skills: "Storytelling, SEO Content, Editorial Calendar, Topic Clusters", color: "#F97316", icon: "PenTool" },
  "Lucía - SEO/Growth": { id: "lucia", name: "Lucía", role: "SEO & Growth", skills: "AI SEO, GEO, Perplexity Optimization, Generative Search", color: "#14B8A6", icon: "BarChart3" },
  "Isabella - Paid Media": { id: "isabella", name: "Isabella", role: "Paid Media Specialist", skills: "LinkedIn Ads, Google Ads, ROAS, Attribution, Funnel Analysis", color: "#8B5CF6", icon: "Target" },
  "Mateo - Social": { id: "mateo", name: "Mateo", role: "Social Media Manager", skills: "Brand Voice, Community, LinkedIn, Instagram, TikTok, Engagement", color: "#3B82F6", icon: "Smartphone" },
  // POD 3: INTELIGENCIA
  "Andrés - Analytics": { id: "andres", name: "Andrés", role: "Data & Analytics", skills: "Funnel Analysis, ROI, Attribution, Cohort Analysis, Metrics", color: "#6366F1", icon: "BarChart3" },
  "Daniela - Competitive Intel": { id: "daniela", name: "Daniela", role: "Competitive Intelligence", skills: "Battlecards, Win/Loss, SWOT, Feature Gap, Market Intel", color: "#991B1B", icon: "Shield" },
  "Emilio - Customer Success": { id: "emilio", name: "Emilio", role: "Customer Success", skills: "Health Score, Churn, NRR/GRR, Expansion, At-Risk Accounts", color: "#10B981", icon: "CheckCircle" },
  // POD 4: OPERACIONES
  "Patricia - Legal": { id: "patricia", name: "Patricia", role: "Legal Counsel", skills: "GDPR, LGPD, CCPA, Privacy Policy, DPA, Compliance", color: "#B45309", icon: "Scale" },
  "Santiago - RevOps": { id: "santiago", name: "Santiago", role: "Revenue Operations", skills: "Pipeline, Forecast, GTM, SQL/SLA, Payback Period", color: "#F59E0B", icon: "Cloud" },
  "Catalina - Project Mgr": { id: "catalina", name: "Catalina", role: "Project Manager", skills: "Agile, OKRs, RICE, MoSCoW, Sprint Planning, Velocity", color: "#EC4899", icon: "Layers" },
};

import {
  Bot, Code, Server, Cloud, Smartphone, Shield, Palette, PenTool,
  TrendingUp, BarChart3, Target, DollarSign, Layers, Scale, CheckCircle, Brain
} from "lucide-react";

// Icon mapping for agents
export const AGENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Bot, Code, Server, Cloud, Smartphone, Shield, Palette, PenTool,
  TrendingUp, BarChart3, Target, DollarSign, Layers, Scale, CheckCircle, Brain
};

// Mapeo de agentes a modelos recomendados
export const AGENT_MODEL_MAP: Record<Agent, Model> = {
  "Shift AI": "Shifty 2.0 by Shift AI",
  "Debate Swarm": "Claude Opus 4.6",
  // C-Suite
  "Carmen - CEO": "Claude Opus 4.6",
  "Roberto - CFO": "Gemini 3.1 Pro",
  "Valentina - CMO": "Claude Sonnet 4.6",
  "Diego - CPO": "Claude Sonnet 4.6",
  // Marketing
  "Jorge - Content": "Claude Opus 4.6",
  "Lucía - SEO/Growth": "Gemini 3.1 Pro",
  "Isabella - Paid Media": "Gemini 3.1 Pro",
  "Mateo - Social": "Claude Sonnet 4.6",
  // Inteligencia
  "Andrés - Analytics": "Moonshot Kimi K2.5",
  "Daniela - Competitive Intel": "Claude Sonnet 4.6",
  "Emilio - Customer Success": "Gemini 3.1 Flash Lite",
  // Operaciones
  "Patricia - Legal": "Claude Opus 4.6",
  "Santiago - RevOps": "Gemini 3.1 Pro",
  "Catalina - Project Mgr": "Claude Sonnet 4.6",
};

export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  content: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  agent?: Agent;
  model?: Model;
  agentActive?: string;
  attachments?: Attachment[];
  // Modelo upstream que respondió (si el backend lo devuelve). Se
  // pasa al widget <cerebro-feedback> para que el dataset de fine-tune
  // pueda filtrar por legal_status (kimi/llama=unrestricted vs claude/
  // openai=tos_restricted).
  upstreamModel?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  model: Model;
  agent: Agent;
};

interface ChatContextType {
  sessions: ChatSession[];
  currentSessionId: string | null;
  currentMessages: Message[];
  selectedModel: Model;
  selectedAgent: Agent;
  isLoading: boolean;
  hasInteracted: boolean;
  searchEnabled: boolean;
  tenantId: string;

  setCurrentSessionId: (id: string | null) => void;
  setSelectedModel: (model: Model) => void;
  setSelectedAgent: (agent: Agent) => void;
  setIsLoading: (loading: boolean) => void;
  setHasInteracted: (interacted: boolean) => void;
  setSearchEnabled: (enabled: boolean) => void;
  setTenantId: (tenantId: string) => void;

  addMessage: (message: Message, explicitSessionId?: string) => void;
  createNewSession: () => void;
  deleteSession: (id: string) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

interface ChatProviderProps {
  children: React.ReactNode;
  defaultTenantId?: string;
}

export function ChatProvider({ children, defaultTenantId = "shift" }: ChatProviderProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState<Model>("Shifty 2.0 by Shift AI");
  const [selectedAgent, setSelectedAgent] = useState<Agent>("Shift AI");
  const [isLoading, setIsLoading] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [tenantId, setTenantId] = useState<string>(defaultTenantId);

  const handleSetSelectedAgent = (agent: Agent) => {
    setSelectedAgent(agent);
    setSelectedModel(AGENT_MODEL_MAP[agent]);
  };

  useEffect(() => {
    const saved = localStorage.getItem('shiftai_embed_sessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSessions(parsed);
      } catch (e) {
        console.error("Failed to parse chat sessions", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('shiftai_embed_sessions', JSON.stringify(sessions));
  }, [sessions]);

  const currentSession = sessions.find(s => s.id === currentSessionId);
  const currentMessages = currentSession?.messages || [];

  useEffect(() => {
    if (currentSessionId && currentMessages.length > 0) {
      setHasInteracted(true);
    } else if (currentSessionId === null) {
      setHasInteracted(false);
    }
  }, [currentSessionId, currentMessages.length]);

  const createNewSession = () => {
    setCurrentSessionId(null);
    setHasInteracted(false);
    setSelectedModel("Shifty 2.0 by Shift AI");
    setSelectedAgent("Shift AI");
  };

  const addMessage = (message: Message, explicitSessionId?: string) => {
    const targetSessionId = explicitSessionId || currentSessionId;

    setSessions(prev => {
      let updatedSessions = [...prev];
      let sessionIndex = updatedSessions.findIndex(s => s.id === targetSessionId);

      if (sessionIndex === -1) {
        const newSessionId = targetSessionId || Date.now().toString();
        const newSession: ChatSession = {
          id: newSessionId,
          title: message.role === 'user' ? message.content.slice(0, 40) + (message.content.length > 40 ? '...' : '') : 'Nuevo Chat',
          updatedAt: Date.now(),
          messages: [message],
          model: selectedModel,
          agent: selectedAgent
        };
        updatedSessions.unshift(newSession);
        setTimeout(() => setCurrentSessionId(newSessionId), 0);
      } else {
        const session = { ...updatedSessions[sessionIndex] };
        session.messages = [...session.messages, message];
        session.updatedAt = Date.now();
        session.model = selectedModel;
        session.agent = selectedAgent;

        if (session.messages.length === 1 && message.role === 'user') {
          session.title = message.content.slice(0, 40) + (message.content.length > 40 ? '...' : '');
        }

        updatedSessions[sessionIndex] = session;
        updatedSessions.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      return updatedSessions;
    });
  };

  const deleteSession = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) {
      createNewSession();
    }
  };

  const handleSetCurrentSessionId = (id: string | null) => {
    setCurrentSessionId(id);
    if (id) {
      const session = sessions.find(s => s.id === id);
      if (session) {
        setSelectedModel(session.model);
        setSelectedAgent(session.agent);
      }
    }
  };

  return (
    <ChatContext.Provider value={{
      sessions,
      currentSessionId,
      currentMessages,
      selectedModel,
      selectedAgent,
      isLoading,
      hasInteracted,
      searchEnabled,
      tenantId,
      setCurrentSessionId: handleSetCurrentSessionId,
      setSelectedModel,
      setSelectedAgent: handleSetSelectedAgent,
      setIsLoading,
      setHasInteracted,
      setSearchEnabled,
      setTenantId,
      addMessage,
      createNewSession,
      deleteSession
    }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
