/**
 * STEP 5 — DIFF.
 *
 * Compare two guarded snapshots. Runs once per agent per run, never per user:
 * one fetch, one diff, then match per subscriber against the shared result.
 *
 * Pure. The only rule with teeth here is the baseline rule: with no previous
 * state, NOTHING is new. Not "everything is new" — the whole world already
 * existed, we simply had not looked yet. Getting this wrong is the classic
 * new-agent failure, where launch day blasts every subscriber with every item
 * the source has ever had.
 */

import type { State, StateItem } from './types.ts'

export interface ChangedItem {
  prev: StateItem
  curr: StateItem
  /** Field names whose values differ, sorted. */
  fields: string[]
}

export interface StateDiff {
  /** True when there was no previous state: the run establishes the baseline. */
  baseline: boolean
  added: StateItem[]
  removed: StateItem[]
  changed: ChangedItem[]
  unchanged: number
}

export interface DiffOptions {
  /** Only these fields count as a change. Default: every field. */
  fields?: string[]
  /** Never counted as a change. Timestamps that tick on their own belong here. */
  ignoreFields?: string[]
}

const ALWAYS_IGNORED = ['fetchedAt', 'seenAt', 'observedAt']

export function diffStates(prev: State | null, curr: State, opts: DiffOptions = {}): StateDiff {
  if (prev === null) {
    // The baseline run. Every item is pre-existing by definition.
    return { baseline: true, added: [], removed: [], changed: [], unchanged: curr.items.length }
  }

  const ignore = new Set([...ALWAYS_IGNORED, ...(opts.ignoreFields ?? [])])
  const watched = opts.fields ? new Set(opts.fields) : null

  const before = indexById(prev.items)
  const after = indexById(curr.items)

  const added: StateItem[] = []
  const changed: ChangedItem[] = []
  let unchanged = 0

  for (const item of curr.items) {
    const was = before.get(item.id)
    if (!was) {
      added.push(item)
      continue
    }
    const fields = changedFields(was, item, watched, ignore)
    if (fields.length > 0) changed.push({ prev: was, curr: item, fields })
    else unchanged++
  }

  const removed: StateItem[] = []
  for (const item of prev.items) {
    if (!after.has(item.id)) removed.push(item)
  }

  return { baseline: false, added, removed, changed, unchanged }
}

/** Item lookup by id. Guard has already rejected duplicate ids. */
export function indexById(items: readonly StateItem[]): Map<string, StateItem> {
  const map = new Map<string, StateItem>()
  for (const item of items) map.set(item.id, item)
  return map
}

function changedFields(
  a: StateItem,
  b: StateItem,
  watched: Set<string> | null,
  ignore: Set<string>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: string[] = []
  for (const key of keys) {
    if (key === 'id' || ignore.has(key)) continue
    if (watched && !watched.has(key)) continue
    if (!deepEqual(a[key], b[key])) out.push(key)
  }
  return out.sort()
}

/**
 * Structural equality over JSON values, with object keys order-insensitive.
 * A reordered source response is not a change, and treating it as one would
 * alert every subscriber every poll.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((value, i) => deepEqual(value, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
}

/**
 * True when an item crossed from "not available" to "available".
 *
 * Shared by availability-watcher and by anything else asking the same question,
 * because the edge — not the level — is what an alert means. An item that has
 * been open for three days is not news.
 */
export function becameTruthy(
  prev: StateItem | undefined,
  curr: StateItem,
  field: string,
): boolean {
  if (!prev) return false // unknown before → not a transition we can vouch for
  return !truthy(prev[field]) && truthy(curr[field])
}

/** Availability is a number of seats or a boolean flag, depending on the source. */
export function truthy(value: unknown): boolean {
  if (typeof value === 'number') return value > 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false'
  return false
}
