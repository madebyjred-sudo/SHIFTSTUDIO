import React, { useState, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileText, Paperclip, Loader2, CheckCircle2 } from 'lucide-react';
import { useActiveGraphStore } from '../../store';

export function ContextNode({ id, data }: any) {
  const [text, setText] = useState(data.text || '');
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);
  const status = data.status || 'IDLE';

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    updateNodeData(id, { text: val });
  }, [id, updateNodeData]);

  const ringClass = status === 'RUNNING' ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-[#1A1A1A] animate-pulse duration-1000' : status === 'COMPLETED' ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-[#1A1A1A]' : '';

  return (
    <div className={`bg-white dark:bg-[#1A1A1A] border border-blue-200 dark:border-blue-900 shadow-sm rounded-xl w-72 overflow-hidden transition-all hover:shadow-md ${ringClass}`}>
      <div className="bg-blue-50 dark:bg-blue-900/30 px-4 py-2 border-b border-blue-100 dark:border-blue-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-300">
            <FileText className="w-3.5 h-3.5" />
          </div>
          <div className="font-semibold text-sm text-blue-900 dark:text-blue-100">Caja de Contexto</div>
        </div>
        <div className="flex items-center gap-2">
          {status === 'RUNNING' && <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />}
          {status === 'COMPLETED' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <textarea
          value={text}
          onChange={handleTextChange}
          placeholder="Pega el brief, contexto o instrucciones iniciales aquí..."
          className="w-full text-xs font-medium bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-gray-800 rounded-md p-2 min-h-[80px] text-[#0e1745] dark:text-gray-200 resize-none outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        />
        <button className="flex items-center justify-center gap-1 w-full py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md border border-dashed border-gray-300 dark:border-gray-700 transition-colors">
          <Paperclip className="w-3 h-3" />
          Adjuntar Archivo
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-blue-500 border-2 border-white dark:border-[#1A1A1A]" />
    </div>
  );
}
