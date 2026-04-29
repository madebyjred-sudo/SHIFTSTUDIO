import React, { useState, useCallback, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Bot, Settings2, Loader2, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useActiveGraphStore } from '../../store';

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

export function SpecialistNode({ id, data }: any) {
  const [agent, setAgent] = useState(data.agent || 'shiftai');
  const [prompt, setPrompt] = useState(data.prompt || '');
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);
  const status = data.status || 'IDLE';

  const handleAgentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAgent(val);
    updateNodeData(id, { agent: val });
  }, [id, updateNodeData]);

  const [expanded, setExpanded] = useState(false);

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

  return (
    <div className={`bg-white dark:bg-[#1A1A1A] border border-indigo-200 dark:border-indigo-900 shadow-sm rounded-xl w-80 transition-all hover:shadow-md ${ringClass}`}>
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-indigo-500 border-2 border-white dark:border-[#1A1A1A]" />

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
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Instrucción (Prompt)</label>
          <textarea
            value={prompt}
            onChange={handlePromptChange}
            placeholder="Ej: Resume los puntos clave y formatea como viñetas..."
            className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-2 min-h-[60px] text-[#0e1745] dark:text-gray-200 resize-none outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
          />
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

      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-indigo-500 border-2 border-white dark:border-[#1A1A1A]" />
    </div>
  );
}
