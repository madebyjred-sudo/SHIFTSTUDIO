/**
 * @file routes/index.ts
 * @description Barrel re-export so server.ts has a single import line per
 * mount. Add new routers here as they land.
 */
export { workspaceRouter } from './workspace.js';
export { adminRouter } from './admin.js';
export { createNeuronProxyRouter } from './neuron-proxy.js';
