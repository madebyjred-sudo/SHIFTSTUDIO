import React from 'react';
import { useActiveGraphStore } from '../store';
import { Clock, History } from 'lucide-react';

export function TimeTravelTimeline() {
  const { snapshots, activeSnapshotId, restoreSnapshot } = useActiveGraphStore();

  if (snapshots.length === 0) return null;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
      <div className="bg-white/70 dark:bg-[#0b1120]/70 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-full px-4 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mr-2 border-r border-black/10 dark:border-white/10 pr-3">
          <History className="w-4 h-4" />
          <span className="text-[11px] font-bold uppercase tracking-wider">Time Travel</span>
        </div>
        
        <div className="flex items-center gap-2 overflow-x-auto max-w-[400px] scrollbar-hide py-1 px-1">
          {snapshots.map((snap, index) => {
            const isActive = snap.id === activeSnapshotId;
            const date = new Date(snap.timestamp);
            const timeString = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            
            return (
              <button
                key={snap.id}
                onClick={() => restoreSnapshot(snap.id)}
                className={`relative group flex items-center justify-center w-8 h-8 rounded-full transition-all duration-300 flex-shrink-0
                  ${isActive 
                    ? 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30 scale-110' 
                    : 'bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10'
                  }
                `}
              >
                <span className="text-[10px] font-bold">{index + 1}</span>
                
                {/* Tooltip */}
                <div className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                  <div className="bg-gray-900 dark:bg-black text-white text-[10px] py-1.5 px-3 rounded-lg shadow-xl flex items-center gap-2 border border-white/10">
                    <Clock className="w-3 h-3 text-indigo-400" />
                    <span>
                      <span className="font-bold">Run {index + 1}</span> ({timeString})
                      <br/>
                      <span className="text-gray-400">{Math.round(snap.metadata.executionTimeMs)}ms execution</span>
                    </span>
                  </div>
                  {/* Tooltip Arrow */}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900 dark:border-t-black"></div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
