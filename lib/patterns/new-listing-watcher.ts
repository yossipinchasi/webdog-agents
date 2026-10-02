/**
 * PATTERN 2 — new-listing-watcher.
 *
 * "New items appear on a feed, filtered." Job postings, apartments, grants,
 * tenders, tickets, filings.
 *
 * One idea again: an item is news exactly once, the first time we see its id.
 * Everything else is filtering, and filtering is declarative so a fork is a
 * config change.
 *
 *   export const match = newListingWatcher({
 *     filters: [
 *       { configKey: 'firms', itemField: 'firm', op: 'in' },
 *       { configKey: 'track', itemField: 'track', op: 'in' },
 *       { configKey: 'year',  itemField: 'year',  op: 'equals', onMissing: 'pass' },
 *     ],
 *     alert: { title: 'New posting: {firm} — {title}', body: '{firm} posted {title} ({location}).', urlField: 'url' },
 *   })
 */

import { diffStates } from '../runtime/diff.ts'
import type { Alert, State, StateItem, UserConfig } from '../runtime/types.ts'
import { buildAlert, passesFilters, type AlertTemplate, type FilterRule, type MatchFn } from './types.ts'

export interface NewListingWatcherConfig {
  filters?: FilterRule[]
  alert: AlertTemplate
  /**
   * Ignore items older than this many hours, by `postedAtField`. Protects
   * against a source that backfills history and makes it all look new.
   */
  maxAgeHours?: number
  postedAtField?: string
  /** Newest first by this field before the per-user cap truncates. */
  sortField?: string
}

export function newListingWatcher(config: NewListingWatcherConfig): MatchFn {
  // A listing id is unique forever, so once-ever dedup is exactly right here.
  const scope = config.alert.dedupeScope ?? 'once'

  return function match(prev: State | null, curr: State, userConfig: UserConfig): Alert[] {
    // No previous state means every listing on the board looks new. It is not.
    if (!prev) return []

    const diff = diffStates(prev, curr)
    const at = new Date(curr.fetchedAt)
    const cutoff = config.maxAgeHours ? at.getTime() - config.maxAgeHours * 3_600_000 : null

    const candidates = config.sortField ? [...diff.added].sort(byFieldDesc(config.sortField)) : diff.added
    const alerts: Alert[] = []

    for (const item of candidates) {
      if (cutoff !== null && !isRecent(item, config.postedAtField ?? 'postedAt', cutoff)) continue
      if (config.filters && !passesFilters(item, userConfig, config.filters)) continue
      alerts.push(buildAlert(item, userConfig, config.alert, item.id, at, scope))
    }

    return alerts
  }
}

function isRecent(item: StateItem, field: string, cutoffMs: number): boolean {
  const value = item[field]
  if (typeof value !== 'string') return true // no timestamp is not evidence of age
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? true : parsed >= cutoffMs
}

function byFieldDesc(field: string) {
  return (a: StateItem, b: StateItem): number => {
    const av = String(a[field] ?? '')
    const bv = String(b[field] ?? '')
    return av < bv ? 1 : av > bv ? -1 : 0
  }
}
