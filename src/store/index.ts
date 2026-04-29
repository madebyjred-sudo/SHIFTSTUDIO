import { useGraphStore as useGraphStoreV1 } from './useGraphStore';
import { useGraphStoreV2 } from './useGraphStoreV2';

// Leer el flag una única vez al montar el módulo, para que las llamadas a hooks de React sean estables.
export const isV2Enabled = import.meta.env.VITE_USE_GRAPH_V2 === 'true';

/**
 * useActiveGraphStore es el único punto de entrada para los hooks del store del canvas.
 * Internamente devuelve la implementación V1 (simulada) o la V2 (backend real)
 * dependiendo de si el feature flag está activo.
 */
export const useActiveGraphStore = isV2Enabled ? useGraphStoreV2 : useGraphStoreV1;
