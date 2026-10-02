/**
 * What an agent will cost the platform a month, before it ships.
 *
 * WHY THIS IS A GATE ON A FREE PLATFORM. Nothing pays for an agent but the
 * platform, so the bill has to be known — and bounded — at submission, not
 * discovered on the invoice. Pure: the manifest and what the module exports
 * in, numbers and problems out.
 *
 * THREE KINDS, BY HOW COST GROWS (docs/DECISIONS.md, 2026-09-30):
 *   1. No model, no paid source: cost does not grow with subscribers. Free.
 *   2. A model in enrich(): once per NEW item for everyone, capped per run by
 *      `limits.max_enrich_per_run`. Must declare model and tokens; the expected
 *      month must fit the per-agent budget, and the worst case is shown.
 *   3. Per-person model work cannot exist in a scheduled agent: match() runs
 *      per subscriber but is pure, with no network. It lives only in
 *      on-demand agents, which run under the daily free allowance and a
 *      person's own key (lib/resy/usage.ts).
 */

import { priceOf } from '../cost/prices.ts'
import { MAX_ENRICH_PER_RUN } from '../runtime/limits.ts'
import { parseFrequencyMs } from '../runtime/schedule.ts'
import type { AgentSpec } from '../runtime/types.ts'

const MONTH_MS = 30 * 86_400_000

/** The most one scheduled agent may be expected to cost a month, in dollars. Configurable. */
export function agentBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.AGENT_MONTHLY_BUDGET_USD ?? 10)
  return Number.isFinite(value) && value >= 0 ? value : 10
}

export interface CostEstimate {
  kind: 'on-demand' | 'free' | 'paid'
  runsPerMonth: number
  dataUsd: number
  modelExpectedUsd: number
  modelWorstUsd: number
  expectedUsd: number
  worstUsd: number
  problems: string[]
}

const round = (usd: number) => Math.round(usd * 100) / 100

export function estimateCost(spec: AgentSpec, enrich: 'absent' | 'function' | 'not-a-function' | null): CostEstimate {
  const empty = { runsPerMonth: 0, dataUsd: 0, modelExpectedUsd: 0, modelWorstUsd: 0, expectedUsd: 0, worstUsd: 0 }
  if (spec.kind === 'on_demand') return { kind: 'on-demand', ...empty, problems: [] }

  const problems: string[] = []
  let frequencyMs: number | null = null
  try {
    frequencyMs = spec.poll?.frequency ? parseFrequencyMs(spec.poll.frequency) : null
  } catch {
    frequencyMs = null
  }
  // A cadence the manifest check already refuses; the estimate simply cannot run.
  if (!frequencyMs) return { kind: 'free', ...empty, problems: ['poll.frequency is missing or unreadable, so cost cannot be estimated'] }
  const runsPerMonth = MONTH_MS / frequencyMs

  // Paid sources: per call, times calls per run, times runs.
  let dataPerRun = 0
  for (const source of spec.sources ?? []) {
    const perCall = source?.cost_per_call_usd
    if (perCall === undefined) continue
    if (typeof perCall !== 'number' || !Number.isFinite(perCall) || perCall < 0) {
      problems.push(`sources "${source.id}": cost_per_call_usd must be a number of dollars, 0 or more`)
      continue
    }
    const calls = source.calls_per_run ?? 1
    if (!Number.isInteger(calls) || calls < 1) {
      problems.push(`sources "${source.id}": calls_per_run must be a whole number, 1 or more`)
      continue
    }
    dataPerRun += perCall * calls
  }
  const dataUsd = dataPerRun * runsPerMonth

  // The model in enrich(), if there is one.
  let modelExpectedUsd = 0
  let modelWorstUsd = 0
  const declared = spec.cost?.enrich
  if (enrich === 'function') {
    if (!declared) {
      problems.push(
        'it has enrich(), so it must declare cost.enrich: model, input_tokens_per_item, output_tokens_per_item and items_per_month',
      )
    } else {
      const price = priceOf(String(declared.model))
      const inTok = Number(declared.input_tokens_per_item)
      const outTok = Number(declared.output_tokens_per_item)
      const items = Number(declared.items_per_month)
      if (!price) problems.push(`cost.enrich.model "${String(declared.model)}" is not a model with a known price (lib/cost/prices.ts)`)
      if (![inTok, outTok, items].every((n) => Number.isFinite(n) && n >= 0)) {
        problems.push('cost.enrich token counts and items_per_month must be numbers, 0 or more')
      } else if (price) {
        const perItem = (inTok * price.input + outTok * price.output) / 1_000_000
        const cap = Math.min(spec.limits?.max_enrich_per_run ?? MAX_ENRICH_PER_RUN, MAX_ENRICH_PER_RUN)
        const worstItems = runsPerMonth * cap
        modelExpectedUsd = perItem * Math.min(items, worstItems)
        modelWorstUsd = perItem * worstItems
      }
    }
  } else if (declared) {
    problems.push('cost.enrich is declared but the module has no enrich() — remove it, or add the function')
  }

  const expectedUsd = dataUsd + modelExpectedUsd
  const worstUsd = dataUsd + modelWorstUsd
  return {
    kind: expectedUsd > 0 || worstUsd > 0 ? 'paid' : 'free',
    runsPerMonth: Math.round(runsPerMonth),
    dataUsd: round(dataUsd),
    modelExpectedUsd: round(modelExpectedUsd),
    modelWorstUsd: round(modelWorstUsd),
    expectedUsd: round(expectedUsd),
    worstUsd: round(worstUsd),
    problems,
  }
}
