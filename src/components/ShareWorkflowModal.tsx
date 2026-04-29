import React, { useState } from 'react';
import { X, Copy, Check, FileCode2, History, Loader2 } from 'lucide-react';
import { Snapshot, AppNode } from '../store/useGraphStore';
import { useActiveGraphStore } from '../store';

type ShareType = 'template' | 'snapshot';

export function ShareWorkflowModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { nodes, edges, snapshots, activeSnapshotId } = useActiveGraphStore();
  const [generating, setGenerating] = useState<ShareType | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  if (!isOpen) return null;

  // Determine what to share. If viewing a snapshot, share that. If live canvas, share current state.
  const activeSnapshot = snapshots.find(s => s.id === activeSnapshotId);
  const targetNodes = activeSnapshot ? activeSnapshot.nodes : nodes;
  const targetEdges = activeSnapshot ? activeSnapshot.edges : edges;

  const generateSharePayload = (type: ShareType) => {
    // 1. Clone the topology
    const clonedSnapshot = {
      id: `share_${Date.now()}`,
      timestamp: Date.now(),
      nodes: JSON.parse(JSON.stringify(targetNodes)) as AppNode[],
      edges: JSON.parse(JSON.stringify(targetEdges)),
      metadata: { shared: true, type }
    };

    // 2. Payload Sanitization Logic
    if (type === 'template') {
      clonedSnapshot.nodes = clonedSnapshot.nodes.map(node => {
        if (node.data) {
          // Keep prompts and config, strip explicit outputs
          node.data.outputText = undefined;
          node.data.status = 'IDLE';
        }
        return node;
      });
    }

    if (type === 'snapshot') {
      clonedSnapshot.metadata = { ...clonedSnapshot.metadata, isReadOnly: true } as any;
    }

    return clonedSnapshot;
  };

  const handleShare = async (type: ShareType) => {
    setGenerating(type);
    setCopiedUrl(null);
    
    const payload = generateSharePayload(type);
    console.log(`[Cognitive Link] Payload Generated (${type}):`, payload);

    // Simulate API Call delay
    await new Promise(resolve => setTimeout(resolve, 1200));

    const mockUrl = `https://shifty.studio/share/${type}-${Math.random().toString(36).substring(7)}`;
    navigator.clipboard.writeText(mockUrl);
    
    setCopiedUrl(mockUrl);
    setGenerating(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-gray-900 border border-black/10 dark:border-white/10 shadow-2xl rounded-2xl w-full max-w-md overflow-hidden relative slide-in-from-bottom-4 duration-300">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">Cognitive Links</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/10 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 font-medium">
            Comparte la topología de la inteligencia generada. Selecciona la modalidad funcional:
          </p>

          {/* Template Card */}
          <button 
            onClick={() => handleShare('template')}
            disabled={generating !== null}
            className="w-full relative group p-4 bg-gray-50 hover:bg-indigo-50 dark:bg-white/5 dark:hover:bg-indigo-500/10 border border-gray-200 hover:border-indigo-300 dark:border-white/10 dark:hover:border-indigo-500/50 rounded-xl transition-all text-left flex items-start gap-4"
          >
            <div className="p-2.5 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 rounded-lg shrink-0">
              <FileCode2 className="w-5 h-5" />
            </div>
            <div>
              <h4 className="font-bold text-gray-900 dark:text-white mb-1">Template Link (Builder)</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                Comparte la estructura en blanco. Sanitiza cualquier output generado o documento subido, dejando solo la configuración base.
              </p>
            </div>
            {generating === 'template' && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
              </div>
            )}
          </button>

          {/* Snapshot Card */}
          <button 
            onClick={() => handleShare('snapshot')}
            disabled={generating !== null}
            className="w-full relative group p-4 bg-gray-50 hover:bg-emerald-50 dark:bg-white/5 dark:hover:bg-emerald-500/10 border border-gray-200 hover:border-emerald-300 dark:border-white/10 dark:hover:border-emerald-500/50 rounded-xl transition-all text-left flex items-start gap-4"
          >
            <div className="p-2.5 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-lg shrink-0">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h4 className="font-bold text-gray-900 dark:text-white mb-1">Snapshot Link (Auditor)</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                El estado inmutable exacto. Bloquea la edición pero permite analizar la respuesta de la Legio Digitalis en este instante del tiempo.
              </p>
            </div>
            {generating === 'snapshot' && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
              </div>
            )}
          </button>
        </div>

        {/* Success Banner */}
        {copiedUrl && (
          <div className="px-6 py-4 bg-emerald-50 dark:bg-emerald-500/10 border-t border-emerald-100 dark:border-emerald-500/20 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
            <div className="bg-emerald-100 dark:bg-emerald-500/20 p-1.5 rounded-full shrink-0">
              <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 truncate">
              <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300">¡Enlace Copiado al Portapapeles!</p>
              <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 truncate">{copiedUrl}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
