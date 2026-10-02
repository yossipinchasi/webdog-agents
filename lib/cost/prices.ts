/**
 * Claude list prices, dollars per million tokens, as of 2026-09-25.
 *
 * One table for everything that estimates or records model spend: the Resy
 * chat's usage accounting (lib/resy/usage.ts) and the submission gate's cost
 * estimate (lib/submission/cost.ts). A model not listed here is refused by the
 * gate rather than guessed at — an estimate with a made-up price is not one.
 *
 * Input and output prices are the published ones. Cache prices are published
 * for Opus 5.5, Sonnet 5.5 and Fable 5.1; the rest assume the usual 0.1× input
 * for a read and 1.25× for a write. The gate uses input and output only.
 */

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export function priceOf(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null
}
