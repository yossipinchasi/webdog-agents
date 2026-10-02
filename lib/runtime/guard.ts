/**
 * STEP 4 — THE GUARD.
 *
 * This is the most important code in the product (ARCHITECTURE.md).
 *
 * Everything upstream of here — a refused connection, a timeout, a 429, a
 * Cloudflare interstitial, a login page, a parser that threw, a parser that
 * quietly returned nothing — arrives looking like ONE thing: we do not have a
 * trustworthy picture of the world. Downstream of here, diff assumes it does.
 *
 * So the guard has exactly one job: decide whether the snapshot is real. If it
 * is not, the run ends here as an error, agent_state is left untouched, and no
 * user hears anything. A failed fetch is not "everything disappeared."
 *
 * The asymmetry that justifies every decision below: a false negative costs one
 * late alert. A false positive costs every subscriber's trust at once, and they
 * do not come back. When the two are in tension, we stop.
 *
 * Pure. No IO, no clock of its own, no logging. Fully testable.
 */

import { classifyError, type FailureKind } from './errors.ts'
import type { GuardPolicySpec, State, StateItem } from './types.ts'

export interface GuardPolicy {
  /**
   * Whether zero items is a legitimate answer from this source.
   *
   * Default false, and think hard before flipping it. Zero items is almost
   * always a broken selector or a source erroring with a 200. Note that it is
   * an error EVEN ON THE FIRST RUN: persisting an empty baseline means the next
   * run sees the entire world as new and alerts every subscriber about all of it.
   */
  allowEmptyState: boolean
  /**
   * Fraction of the previous run's items that may disappear in one run before
   * we call it an outage rather than a change. Default 0.5.
   *
   * A partial outage — three of six upstream boards 500ing, one region of a
   * multi-region feed dropping out — is indistinguishable from a real mass
   * removal, and only one of those two readings is safe.
   */
  maxDropRatio: number
  /** Below this many previous items the drop check is noise, so it is skipped. */
  minItemsForDropCheck: number
  /** If set, a snapshot whose fetchedAt is older than this is a frozen source. */
  maxStateAgeMs?: number
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  allowEmptyState: false,
  maxDropRatio: 0.5,
  minItemsForDropCheck: 5,
}

export function guardPolicyFromSpec(spec?: GuardPolicySpec): GuardPolicy {
  return {
    allowEmptyState: spec?.allow_empty_state ?? DEFAULT_GUARD_POLICY.allowEmptyState,
    maxDropRatio: spec?.max_drop_ratio ?? DEFAULT_GUARD_POLICY.maxDropRatio,
    minItemsForDropCheck:
      spec?.min_items_for_drop_check ?? DEFAULT_GUARD_POLICY.minItemsForDropCheck,
  }
}

/** What the guard is handed: either the run already failed, or we have a candidate. */
export type GuardInput =
  | { outcome: 'failed'; error: unknown }
  | {
      outcome: 'normalized'
      /** Deliberately `unknown`: agent code returns this, so it is not trusted. */
      candidate: unknown
      prev: State | null
      policy?: Partial<GuardPolicy>
      now?: Date
    }

export type GuardVerdict =
  | { ok: true; state: State; itemsSeen: number; warnings: string[] }
  | { ok: false; kind: FailureKind; message: string; itemsSeen: number | null }

/**
 * The gate. Nothing reaches diff without a `{ ok: true }` from here.
 */
export function guard(input: GuardInput): GuardVerdict {
  if (input.outcome === 'failed') {
    // We never saw the world. There is nothing to compare and nothing to say.
    const { kind, message } = classifyError(input.error)
    return { ok: false, kind, message, itemsSeen: null }
  }

  const policy = { ...DEFAULT_GUARD_POLICY, ...input.policy }
  const shape = validateState(input.candidate)
  if (!shape.ok) {
    return { ok: false, kind: 'malformed_state', message: shape.message, itemsSeen: null }
  }

  const state = shape.state
  const itemsSeen = state.items.length
  const warnings: string[] = []
  const prev = input.prev

  // --- Empty. The impostor this whole file exists for. ---
  if (itemsSeen === 0 && !policy.allowEmptyState) {
    return {
      ok: false,
      kind: 'empty_state',
      message:
        prev === null
          ? 'normalize() produced zero items on the baseline run — refusing to persist an empty baseline, because the next run would treat the entire source as new'
          : `normalize() produced zero items (previous run saw ${prev.items.length}) — treating as a source outage, not as everything disappearing`,
      itemsSeen: 0,
    }
  }

  // --- The cliff. A partial outage looks exactly like a mass removal. ---
  if (prev !== null && prev.items.length >= policy.minItemsForDropCheck) {
    const floor = prev.items.length * (1 - policy.maxDropRatio)
    if (itemsSeen < floor) {
      const lost = prev.items.length - itemsSeen
      const pct = Math.round((lost / prev.items.length) * 100)
      return {
        ok: false,
        kind: 'item_cliff',
        message: `${lost} of ${prev.items.length} items (${pct}%) vanished in one run — beyond the ${Math.round(policy.maxDropRatio * 100)}% drop threshold, so this is read as a partial source outage. Raise guard.max_drop_ratio only if this source genuinely churns that hard.`,
        itemsSeen,
      }
    }
    // Under the threshold but still worth a human noticing in the run log.
    const lost = prev.items.length - itemsSeen
    if (lost > 0 && lost / prev.items.length >= 0.2) {
      warnings.push(
        `${lost} of ${prev.items.length} items disappeared (${Math.round((lost / prev.items.length) * 100)}%) — under the outage threshold, proceeding`,
      )
    }
  }

  // --- A source serving a frozen snapshot is not a source that agrees with us. ---
  if (policy.maxStateAgeMs !== undefined && input.now) {
    const age = input.now.getTime() - Date.parse(state.fetchedAt)
    if (age > policy.maxStateAgeMs) {
      return {
        ok: false,
        kind: 'stale_state',
        message: `snapshot is ${Math.round(age / 1000)}s old, past the ${Math.round(policy.maxStateAgeMs / 1000)}s freshness budget — the source is serving a cached response`,
        itemsSeen,
      }
    }
  }

  // --- Identical snapshots are the normal case, not a fault. Just note it. ---
  if (prev !== null && itemsSeen > 0 && prev.items.length === itemsSeen) {
    warnings.push(`item count unchanged at ${itemsSeen}`)
  }

  return { ok: true, state, itemsSeen, warnings }
}

/**
 * Shape validation for whatever agent code returned.
 *
 * Written as if `normalize` were hostile, because in v2 it will be third-party
 * code and the isolation boundary should not need rewriting then.
 */
export function validateState(
  candidate: unknown,
): { ok: true; state: State } | { ok: false; message: string } {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, message: `normalize() returned ${describe(candidate)}, expected a State object` }
  }

  const obj = candidate as Record<string, unknown>

  if (!Array.isArray(obj.items)) {
    return { ok: false, message: `State.items is ${describe(obj.items)}, expected an array` }
  }

  if (typeof obj.fetchedAt !== 'string' || Number.isNaN(Date.parse(obj.fetchedAt))) {
    return { ok: false, message: `State.fetchedAt is ${describe(obj.fetchedAt)}, expected an ISO timestamp` }
  }

  const seen = new Set<string>()
  const items: StateItem[] = []

  for (let i = 0; i < obj.items.length; i++) {
    const item = obj.items[i] as unknown
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `State.items[${i}] is ${describe(item)}, expected an object` }
    }
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, message: `State.items[${i}].id is ${describe(id)}, expected a non-empty string` }
    }
    if (seen.has(id)) {
      // A duplicate id silently loses an item in every Map-based diff, which
      // shows up later as an alert that never fires. Fail loudly instead.
      return { ok: false, message: `State.items[${i}].id "${id}" is a duplicate — ids must be unique within a State` }
    }
    seen.add(id)
    items.push(item as StateItem)
  }

  const meta = obj.meta
  if (meta !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
    return { ok: false, message: `State.meta is ${describe(meta)}, expected an object` }
  }

  return {
    ok: true,
    state: { items, fetchedAt: obj.fetchedAt, ...(meta ? { meta: meta as State['meta'] } : {}) },
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array(${value.length})`
  if (typeof value === 'string') return `a string(${JSON.stringify(value.slice(0, 40))})`
  return `a ${typeof value}`
}
