/**
 * AnimatedEdge — Custom edge that pulses when the source node is RUNNING
 * and turns green when COMPLETED. Falls back to a smooth default otherwise.
 */
import React from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { useActiveGraphStore } from '../../store';

export function AnimatedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  style = {},
  markerEnd,
  label,
}: EdgeProps) {
  const nodes = (useActiveGraphStore as any)((s: any) => s.nodes) as any[];
  const sourceNode = nodes.find((n: any) => n.id === source);
  const status = (sourceNode?.data as any)?.status || 'IDLE';

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Dynamic styling based on source node status
  let strokeColor = 'rgba(148, 163, 184, 0.5)'; // slate-400/50
  let strokeWidth = 1.5;
  let animated = false;
  let dashArray = 'none';

  if (status === 'RUNNING') {
    strokeColor = '#6366f1'; // indigo-500
    strokeWidth = 2.5;
    animated = true;
    dashArray = '8 4';
  } else if (status === 'COMPLETED') {
    strokeColor = '#10b981'; // emerald-500
    strokeWidth = 2;
  } else if (status === 'FAILED') {
    strokeColor = '#ef4444'; // red-500
    strokeWidth = 2;
    dashArray = '4 4';
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray: dashArray,
          transition: 'stroke 0.4s ease, stroke-width 0.3s ease',
        }}
      />
      {/* Animated particle along the edge when running */}
      {animated && (
        <circle r="4" fill="#6366f1" filter="drop-shadow(0 0 3px #6366f1)">
          <animateMotion
            dur="1.5s"
            repeatCount="indefinite"
            path={edgePath}
          />
        </circle>
      )}
      {/* Optional label */}
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="px-2 py-0.5 text-[10px] font-semibold bg-white dark:bg-[#1A1A1A] border border-gray-200 dark:border-gray-700 rounded-full text-gray-500 dark:text-gray-400 shadow-sm"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
