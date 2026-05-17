import React, { useCallback, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileText, Paperclip, Loader2, CheckCircle2 } from 'lucide-react';
import { useActiveGraphStore } from '../../store';
import { useConnectionDrag } from '../../lib/connection-drag-context';

export function ContextNode({ id, data }: any) {
  // Field rename: Cerebro executor reads `data.content` for context nodes.
  // Keep `data.text` fallback for backwards-compat with graphs persisted
  // before this rename. New writes always go to `data.content`.
  //
  // Note: text is derived directly from `data` — NO local useState. Local
  // useState would skip re-init when ReactFlow reuses the component
  // instance (same node id) across a template apply, leaving stale text
  // in the textarea while the store has the new content. The store is
  // the single source of truth; the textarea reads from it.
  const text: string = data.content ?? data.text ?? '';
  const updateNodeData = useActiveGraphStore((s) => s.updateNodeData);
  const status = data.status || 'IDLE';

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateNodeData(id, { content: e.target.value });
  }, [id, updateNodeData]);

  const ringClass = status === 'RUNNING' ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-[#1A1A1A] animate-pulse duration-1000' : status === 'COMPLETED' ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-[#1A1A1A]' : '';

  // ─── Connection feedback (F2) ───
  // During a drag, decide whether THIS node's source handle is a valid
  // origin (only relevant when it IS the source) or whether attenuation
  // applies because the user is dragging from another node and this
  // node has no relevant target handle.
  const drag = useConnectionDrag();
  const isSource = drag.active && drag.sourceNodeId === id;
  // ContextNode has no target handle — when another node is dragging,
  // this node's source handle is irrelevant (atenuar).
  const sourceHandleState = useMemo(() => {
    if (!drag.active) return 'none';
    if (isSource) return 'source';
    // Another node is the source — ContextNode source can never be a target.
    return 'invalid';
  }, [drag.active, isSource]);

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

      <Handle
        id={`${id}-source`}
        type="source"
        position={Position.Bottom}
        className="shifty-handle w-3 h-3 bg-blue-500 border-2 border-white dark:border-[#1A1A1A]"
        data-connection-role={isSource ? 'source' : undefined}
        data-connection-target={sourceHandleState === 'invalid' ? 'invalid' : undefined}
        aria-describedby={drag.active ? `shifty-connection-tooltip` : undefined}
      />
    </div>
  );
}
