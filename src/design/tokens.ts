// ─── Motion ─────────────────────────────────────────
export const motion = {
  duration: {
    instant: 100,   // click feedback, toggles
    fast: 150,      // hover, focus
    base: 200,      // modal entrance, tooltip
    slow: 400,      // layout change, page transition
  },
  easing: {
    standard: [0.4, 0, 0.2, 1] as const,   // material-like
    emphasized: [0.2, 0, 0, 1] as const,   // enter
    decelerate: [0, 0, 0.2, 1] as const,   // exit
  },
} as const;

// ─── Agent brand palette (referencia, canónica en agentRegistry) ───
// No duplicar — agentRegistry.ts es la fuente de verdad.
