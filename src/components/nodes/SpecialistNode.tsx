import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Bot, Settings2, Loader2, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useActiveGraphStore } from '../../store';
import { useConnectionDrag } from '../../lib/connection-drag-context';
import { validateConnection } from '../../lib/graph-rules';

const AGENTS = [
  { id: 'shiftai', name: 'Shifty (General)' },
  { id: 'carmen', name: 'Carmen (CEO)' },
  { id: 'roberto', name: 'Roberto (CFO)' },
  { id: 'valentina', name: 'Valentina (CMO)' },
  { id: 'diego', name: 'Diego (CPO)' },
  { id: 'jorge', name: 'Jorge (Content)' },
  { id: 'lucia', name: 'Lucía (SEO)' },
  { id: 'isabella', name: 'Isabella (Paid Media)' },
  { id: 'mateo', name: 'Mateo (Social)' },
  { id: 'andres', name: 'Andrés (Analytics)' },
  { id: 'daniela', name: 'Daniela (Competitive Intel)' },
  { id: 'emilio', name: 'Emilio (Customer Success)' },
  { id: 'patricia', name: 'Patricia (Legal)' },
  { id: 'santiago', name: 'Santiago (RevOps)' },
  { id: 'catalina', name: 'Catalina (Project Mgr)' },
];

// Model menu — keep in sync with Cerebro's allowed list. Defaults to
// sonnet-4.6 (balance of cost/quality); opus is for strategic reasoning;
// gemini flash-lite and gpt-5-mini are the cheap/fast alternatives.
const MODELS = [
  { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet 4.6 · balance (default)' },
  { id: 'anthropic/claude-opus-4.7', name: 'Opus 4.7 · decisión estratégica' },
  { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini Flash Lite · rápido + barato' },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini · alt fast' },
];

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0.4;
const MAX_TOKENS_MIN = 100;
const MAX_TOKENS_MAX = 4000;

export function SpecialistNode({ id, data }: any) {
  const [agent, setAgent] = useState(data.agent || 'shiftai');
  const [prompt, setPrompt] = useState(data.prompt || '');
  const [label, setLabel] = useState<string>(data.label ?? '');
  const [model, setModel] = useState<string>(data.model || DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState<number>(
    typeof data.max_tokens === 'number' ? data.max_tokens : DEFAULT_MAX_TOKENS,
  );
  const [temperature, setTemperature] = useState<number>(
    typeof data.temperature === 'number' ? data.temperature : DEFAULT_TEMPERATURE,
  );
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);
  const status = data.status || 'IDLE';

  const handleAgentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAgent(val);
    updateNodeData(id, { agent: val });
  }, [id, updateNodeData]);

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLabel(val);
    updateNodeData(id, { label: val });
  }, [id, updateNodeData]);

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setModel(val);
    updateNodeData(id, { model: val });
  }, [id, updateNodeData]);

  const handleMaxTokensChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Clamp on commit so the server contract holds even if the user
    // pastes a non-numeric value. Empty input falls back to default.
    const raw = e.target.value;
    if (raw === '') {
      setMaxTokens(DEFAULT_MAX_TOKENS);
      updateNodeData(id, { max_tokens: DEFAULT_MAX_TOKENS });
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(MAX_TOKENS_MIN, Math.min(MAX_TOKENS_MAX, Math.round(parsed)));
    setMaxTokens(clamped);
    updateNodeData(id, { max_tokens: clamped });
  }, [id, updateNodeData]);

  const handleTemperatureChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number(e.target.value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0, Math.min(1, parsed));
    setTemperature(clamped);
    updateNodeData(id, { temperature: clamped });
  }, [id, updateNodeData]);

  const [expanded, setExpanded] = useState(false);
  // Advanced config (model + max_tokens + temperature) is collapsed by
  // default — keeps the node visually quiet for the 90% case where the
  // defaults are fine.
  const [configOpen, setConfigOpen] = useState(false);

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPrompt(val);
    updateNodeData(id, { prompt: val });
  }, [id, updateNodeData]);

  // Auto-expand when status becomes COMPLETED or FAILED and there is output
  useEffect(() => {
    if ((status === 'COMPLETED' || status === 'FAILED') && data.outputText) {
      setExpanded(true);
    }
  }, [status, data.outputText]);

  const ringClass = status === 'RUNNING' ? 'ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-[#1A1A1A] animate-pulse duration-1000'
    : status === 'COMPLETED' ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-[#1A1A1A]'
      : status === 'FAILED' ? 'ring-2 ring-red-500 ring-offset-2 dark:ring-offset-[#1A1A1A]'
        : '';

  const headerBgClass = status === 'FAILED' ? 'bg-red-50 dark:bg-red-900/30 border-b border-red-100 dark:border-red-800' : 'bg-indigo-50 dark:bg-indigo-900/30 border-b border-indigo-100 dark:border-indigo-800';
  const iconBgClass = status === 'FAILED' ? 'bg-red-100 dark:bg-red-800 text-red-600 dark:text-red-300' : 'bg-indigo-100 dark:bg-indigo-800 text-indigo-600 dark:text-indigo-300';
  const titleClass = status === 'FAILED' ? 'text-red-900 dark:text-red-100' : 'text-indigo-900 dark:text-indigo-100';

  // ─── Connection feedback (F2) ───
  const drag = useConnectionDrag();
  const isSource = drag.active && drag.sourceNodeId === id;
  // Target-handle validity = can drag.sourceNodeType connect to specialist?
  const targetHandleState = useMemo<'valid' | 'invalid' | 'none'>(() => {
    if (!drag.active || isSource) return 'none';
    const { valid } = validateConnection(drag.sourceNodeType, 'specialist');
    return valid ? 'valid' : 'invalid';
  }, [drag.active, drag.sourceNodeType, isSource]);

  return (
    <div className={`bg-white dark:bg-[#1A1A1A] border border-indigo-200 dark:border-indigo-900 shadow-sm rounded-xl w-80 transition-all hover:shadow-md ${ringClass}`}>
      <Handle
        id={`${id}-target`}
        type="target"
        position={Position.Top}
        className="shifty-handle w-3 h-3 bg-indigo-500 border-2 border-white dark:border-[#1A1A1A]"
        data-connection-target={targetHandleState === 'none' ? undefined : targetHandleState}
        aria-describedby={drag.active && !isSource ? `shifty-connection-tooltip` : undefined}
      />

      <div className={`${headerBgClass} px-4 py-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${iconBgClass}`}>
            <Bot className="w-3.5 h-3.5" />
          </div>
          <div className={`font-semibold text-sm ${titleClass}`}>Nodo Especialista</div>
        </div>
        <div className="flex items-center gap-2">
          {status === 'RUNNING' && <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />}
          {status === 'COMPLETED' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
          {status === 'FAILED' && <AlertTriangle className="w-4 h-4 text-red-500" />}
          <button className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300">
            <Settings2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Agente (Legio Digitalis)</label>
            <select
              value={agent}
              onChange={handleAgentChange}
              className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-1.5 text-[#0e1745] dark:text-gray-200 outline-none focus:border-indigo-400 appearance-none"
            >
              {AGENTS.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Etiqueta</label>
            <input
              type="text"
              value={label}
              onChange={handleLabelChange}
              placeholder="Análisis de mercado"
              className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-1.5 text-[#0e1745] dark:text-gray-200 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Instrucción (Prompt)</label>
          <textarea
            value={prompt}
            onChange={handlePromptChange}
            placeholder="Ej: Resume los puntos clave y formatea como viñetas..."
            className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-2 min-h-[60px] text-[#0e1745] dark:text-gray-200 resize-none outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
          />
        </div>

        {/* Collapsible advanced config — model + max_tokens + temperature.
            Cerebro executor REQUIRES these three fields. Defaults are
            populated in state init, so collapsed view still ships valid
            values; this UI is only for power users tweaking per-node. */}
        <div className="border-t border-indigo-100 dark:border-indigo-800/50 pt-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="flex items-center justify-between w-full text-left group outline-none"
          >
            <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 group-hover:text-indigo-700 dark:group-hover:text-indigo-300 uppercase tracking-wider transition-colors">
              Config avanzada
            </span>
            <div className="bg-indigo-50 dark:bg-indigo-900/30 text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 p-1 rounded-md transition-colors">
              {configOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </div>
          </button>

          <div
            className={`grid transition-all duration-300 ease-in-out ${
              configOpen ? 'grid-rows-[1fr] opacity-100 mt-2' : 'grid-rows-[0fr] opacity-0'
            }`}
          >
            <div className="overflow-hidden">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Modelo</label>
                  <select
                    value={model}
                    onChange={handleModelChange}
                    className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-1.5 text-[#0e1745] dark:text-gray-200 outline-none focus:border-indigo-400 appearance-none"
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Max tokens</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 normal-case tracking-normal">{maxTokens}</span>
                  </label>
                  <input
                    type="number"
                    min={MAX_TOKENS_MIN}
                    max={MAX_TOKENS_MAX}
                    step={50}
                    value={maxTokens}
                    onChange={handleMaxTokensChange}
                    className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-1.5 text-[#0e1745] dark:text-gray-200 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Temperature</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 normal-case tracking-normal">{temperature.toFixed(2)}</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={temperature}
                    onChange={handleTemperatureChange}
                    className="w-full accent-indigo-500"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {(status === 'COMPLETED' || status === 'FAILED') && data.outputText && (
          <div className={`border-t ${status === 'FAILED' ? 'border-red-100 dark:border-red-800/50' : 'border-indigo-100 dark:border-indigo-800/50'} pt-3 mt-1 overflow-hidden`}>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center justify-between w-full text-left group outline-none"
            >
              <span className={`text-[10px] font-semibold ${status === 'FAILED' ? 'text-red-600 dark:text-red-400 group-hover:text-red-700 dark:group-hover:text-red-300' : 'text-indigo-600 dark:text-indigo-400 group-hover:text-indigo-700 dark:group-hover:text-indigo-300'} uppercase tracking-wider transition-colors`}>
                {status === 'FAILED' ? 'Error de Ejecución' : 'Respuesta del Especialista'}
              </span>
              <div className={`${status === 'FAILED' ? 'bg-red-50 dark:bg-red-900/30 text-red-400 group-hover:text-red-600 dark:group-hover:text-red-300' : 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300'} p-1 rounded-md transition-colors`}>
                {expanded ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </div>
            </button>

            <div
              className={`grid transition-all duration-500 ease-in-out ${expanded ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0'
                }`}
            >
              <div className="overflow-hidden">
                <div className={`${status === 'FAILED' ? 'bg-red-50/50 dark:bg-red-900/20 border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300' : 'bg-indigo-50/50 dark:bg-black/30 border-indigo-100 dark:border-indigo-900/50 text-gray-700 dark:text-gray-300'} rounded-md p-3 border max-h-[250px] overflow-y-auto text-xs whitespace-pre-wrap leading-relaxed custom-scrollbar`}>
                  {data.outputText}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <Handle
        id={`${id}-source`}
        type="source"
        position={Position.Bottom}
        className="shifty-handle w-3 h-3 bg-indigo-500 border-2 border-white dark:border-[#1A1A1A]"
        data-connection-role={isSource ? 'source' : undefined}
        aria-describedby={isSource ? `shifty-connection-tooltip` : undefined}
      />
    </div>
  );
}
