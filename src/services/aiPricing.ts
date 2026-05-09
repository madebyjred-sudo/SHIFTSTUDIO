/**
 * @file services/aiPricing.ts
 * @description Per-model pricing for cost attribution.
 *
 * Numbers are USD per 1M tokens. Refresh when OpenRouter rates change.
 * Cache-read is the discounted rate Anthropic charges for prompt-cached
 * input tokens (typically 10% of base input).
 *
 * If a model is missing here, cost_usd_* fields fall back to NULL.
 * Logging still works; the operator can backfill cost from raw token
 * counts later by joining with an updated rate sheet.
 *
 * Phase 3.B telemetry — companion to studio_ai_call_log. Used by
 * callOpenRouter (services/openRouterDirect.ts) to compute the cost
 * snapshot at call time.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
}

const PRICING_USD_PER_M: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-4.6': { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.30 },
  'anthropic/claude-sonnet-4':   { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.30 },
  'anthropic/claude-opus-4.7':   { inputPerMillion: 5.00, outputPerMillion: 25.00, cacheReadPerMillion: 0.50 },
  'google/gemini-3-flash-preview':            { inputPerMillion: 0.50, outputPerMillion: 3.00, cacheReadPerMillion: 0.50 },
  'google/gemini-3.1-flash-lite-preview':     { inputPerMillion: 0.25, outputPerMillion: 1.50, cacheReadPerMillion: 0.25 },
  'google/gemini-3.1-pro-preview':            { inputPerMillion: 2.00, outputPerMillion: 12.00, cacheReadPerMillion: 2.00 },
  'google/gemini-2.5-flash':                  { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.30 },
};

export interface UsageInput {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface CostBreakdown {
  cost_usd_input: number | null;
  cost_usd_output: number | null;
  cost_usd_total: number | null;
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

export function computeCost(model: string, usage: UsageInput): CostBreakdown {
  const rates = PRICING_USD_PER_M[model];
  if (!rates) return { cost_usd_input: null, cost_usd_output: null, cost_usd_total: null };
  const cachedIn = usage.cache_read_input_tokens ?? 0;
  const newIn = Math.max(0, (usage.input_tokens ?? 0) - cachedIn);
  const out = usage.output_tokens ?? 0;
  const costIn = (newIn * rates.inputPerMillion + cachedIn * rates.cacheReadPerMillion) / 1_000_000;
  const costOut = (out * rates.outputPerMillion) / 1_000_000;
  return {
    cost_usd_input: round6(costIn),
    cost_usd_output: round6(costOut),
    cost_usd_total: round6(costIn + costOut),
  };
}
