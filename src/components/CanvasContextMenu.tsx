import React, { useEffect, useRef } from 'react';
import { Copy, Navigation, Trash2, Cpu, FileBox } from 'lucide-react';
import { useActiveGraphStore } from '../store';
import { useReactFlow } from '@xyflow/react';

export type ContextMenuProps = {
  id: string | null;
  top: number;
  left: number;
  type: 'node' | 'edge' | 'pane';
  onClose: () => void;
};

export function CanvasContextMenu({ id, top, left, type, onClose }: ContextMenuProps) {
  const { addNode, deleteNode, deleteEdge, nodes } = useActiveGraphStore();
  const { screenToFlowPosition } = useReactFlow();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleAddNode = (nodeType: 'specialist' | 'context' | 'export') => {
    const position = screenToFlowPosition({ x: left, y: top });
    const newNodeId = `node_${Date.now()}`;
    
    let baseData: Record<string, any> = { label: 'Nuevo Nodo', status: 'IDLE' };
    
    if (nodeType === 'specialist') {
      baseData = { ...baseData, agent: 'Jorge - Content', prompt: '' };
    }
    
    addNode({
      id: newNodeId,
      type: nodeType,
      position,
      data: baseData,
      selectable: true,
      draggable: true,
    });
    onClose();
  };

  const handleDuplicate = () => {
    if (!id || type !== 'node') return;
    const nodeToCopy = nodes.find(n => n.id === id);
    if (!nodeToCopy) return;
    
    const newNodeId = `${nodeToCopy.id}_copy_${Date.now()}`;
    const offset = 50;
    
    addNode({
      ...nodeToCopy,
      id: newNodeId,
      position: { x: nodeToCopy.position.x + offset, y: nodeToCopy.position.y + offset },
      selected: false,
    });
    onClose();
  };

  const handleDelete = () => {
    if (!id) return;
    if (type === 'node') deleteNode(id);
    if (type === 'edge') deleteEdge(id);
    onClose();
  };

  // Generamos un menú Glassmorphism
  return (
    <div
      ref={menuRef}
      style={{ top, left }}
      className="absolute z-50 flex flex-col min-w-[180px] bg-white/70 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-xl overflow-hidden p-1 text-sm font-medium animate-in fade-in zoom-in-95 duration-200"
    >
      {type === 'pane' && (
        <>
          <div className="px-3 py-1.5 text-[10px] sm:text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-bold mb-1 border-b border-black/5 dark:border-white/5">
            Añadir Nodo
          </div>
          <button onClick={() => handleAddNode('specialist')} className="flex items-center gap-2 px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 text-gray-700 dark:text-gray-200 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-lg transition-colors text-left">
            <Cpu className="w-4 h-4" /> Especialista
          </button>
          <button onClick={() => handleAddNode('context')} className="flex items-center gap-2 px-3 py-2 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 text-gray-700 dark:text-gray-200 hover:text-emerald-600 dark:hover:text-emerald-400 rounded-lg transition-colors text-left">
            <FileBox className="w-4 h-4" /> Contexto Data
          </button>
          <button onClick={() => handleAddNode('export')} className="flex items-center gap-2 px-3 py-2 hover:bg-orange-50 dark:hover:bg-orange-500/10 text-gray-700 dark:text-gray-200 hover:text-orange-600 dark:hover:text-orange-400 rounded-lg transition-colors text-left">
            <Navigation className="w-4 h-4" /> Exportador UI
          </button>
        </>
      )}

      {type === 'node' && (
        <>
          <button onClick={handleDuplicate} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-700 dark:text-gray-200 rounded-lg transition-colors text-left">
            <Copy className="w-4 h-4" /> Duplicar Nodo
          </button>
          <div className="h-px bg-black/5 dark:bg-white/5 my-1" />
          <button onClick={handleDelete} className="flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 rounded-lg transition-colors text-left">
            <Trash2 className="w-4 h-4" /> Eliminar Nodo
          </button>
        </>
      )}

      {type === 'edge' && (
        <>
          <button onClick={handleDelete} className="flex items-center gap-2 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 rounded-lg transition-colors text-left">
            <Trash2 className="w-4 h-4" /> Eliminar Conexión
          </button>
        </>
      )}
    </div>
  );
}
