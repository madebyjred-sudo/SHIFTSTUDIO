import React, { useState, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Download, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useActiveGraphStore } from '../../store';

const FORMATS = ['DOCX', 'PPTX', 'PDF', 'XLSX'];

export function ExportNode({ id, data }: any) {
  const [format, setFormat] = useState(data.format || 'DOCX');
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);
  const status = data.status || 'IDLE';

  const handleFormatChange = useCallback((f: string) => {
    setFormat(f);
    updateNodeData(id, { format: f });
  }, [id, updateNodeData]);

  const ringClass = status === 'RUNNING' ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-[#1A1A1A] animate-pulse duration-1000'
    : status === 'COMPLETED' ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-[#1A1A1A]'
      : status === 'FAILED' ? 'ring-2 ring-red-500 ring-offset-2 dark:ring-offset-[#1A1A1A]'
        : '';

  const headerBgClass = status === 'FAILED' ? 'bg-red-50 dark:bg-red-900/30 border-b border-red-100 dark:border-red-800' : 'bg-emerald-50 dark:bg-emerald-900/30 border-b border-emerald-100 dark:border-emerald-800';
  const iconBgClass = status === 'FAILED' ? 'bg-red-100 dark:bg-red-800 text-red-600 dark:text-red-300' : 'bg-emerald-100 dark:bg-emerald-800 text-emerald-600 dark:text-emerald-300';
  const titleClass = status === 'FAILED' ? 'text-red-900 dark:text-red-100' : 'text-emerald-900 dark:text-emerald-100';

  return (
    <div className={`bg-white dark:bg-[#1A1A1A] border ${status === 'FAILED' ? 'border-red-200 dark:border-red-900' : 'border-emerald-200 dark:border-emerald-900'} shadow-sm rounded-xl w-64 overflow-hidden transition-all hover:shadow-md ${ringClass}`}>
      <Handle type="target" position={Position.Top} className={`w-3 h-3 ${status === 'FAILED' ? 'bg-red-500' : 'bg-emerald-500'} border-2 border-white dark:border-[#1A1A1A]`} />

      <div className={`${headerBgClass} px-4 py-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${iconBgClass}`}>
            <Download className="w-3.5 h-3.5" />
          </div>
          <div className={`font-semibold text-sm ${titleClass}`}>Exportador Nativo</div>
        </div>
        <div className="flex items-center gap-2">
          {status === 'RUNNING' && <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />}
          {status === 'COMPLETED' && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
          {status === 'FAILED' && <AlertTriangle className="w-4 h-4 text-red-500" />}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Formato de Salida</label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {FORMATS.map(f => (
              <button
                key={f}
                onClick={() => handleFormatChange(f)}
                className={`py-1.5 text-xs font-semibold rounded-md transition-colors ${format === f
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10'
                  }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
