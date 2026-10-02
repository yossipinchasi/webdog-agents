/**
 * PATTERN 1 — availability-watcher.
 *
 * "Something full becomes available." A course section, an MRI slot, a campsite,
 * a restaurant table, a visa appointment.
 *
 * The whole pattern is one idea: alert on the EDGE, never the level. An item
 * that has been open for three days is not news, and an item that was open
 * before we started watching is not news either. Only the crossing counts.
 *
 * A configuration, not a program:
 *
 *   export const match = availabilityWatcher({
 *     availabilityField: 'seats',
 *     watchConfigKey: 'sections',
 *     alert: { title: 'Seat open: {name}', body: '{name} ({id}) — {seats} seat(s) open.', urlField: 'registerUrl', priority: 'urgent' },
 *   })
 */

import { becameTruthy, indexById, truthy } from '../runtime/diff.ts'
import type { Alert, State, UserConfig } from '../runtime/types.ts'
import { buildAlert, passesFilters, type AlertTemplate, type FilterRule, type MatchFn } from './types.ts'

export interface AvailabilityWatcherConfig {
  /** Item field holding seats/slots remaining, or a boolean. Default 'available'. */
  availabilityField?: string
  /**
   * Config key holding the item ids this subscriber watches. Absent, empty or
   * 'all' means every item — the sensible default for a small catalogue.
   */
  watchConfigKey?: string
  /** Further declarative filters (campus, building, price ceiling). */
  filters?: FilterRule[]
  alert: AlertTemplate
  /**
   * Also alert when an already-open item gains capacity? Off by default: the
   * user wants to know it is possible, not to be pinged as the number moves.
   */
  alertOnIncrease?: boolean
}

export function availabilityWatcher(config: AvailabilityWatcherConfig): MatchFn {
  const field = config.availabilityField ?? 'available'
  // A seat can open, fill and open again next week, and the alerts unique index
  // is once-ever — so the key carries a day bucket unless the agent says other.
  const scope = config.alert.dedupeScope ?? 'daily'

  return function match(prev: State | null, curr: State, userConfig: UserConfig): Alert[] {
    // First run establishes the baseline. Everything currently open has been
    // open since before we were watching; none of it is a transition.
    if (!prev) return []

    const before = indexById(prev.items)
    const watched = watchedIds(userConfig, config.watchConfigKey)
    const at = new Date(curr.fetchedAt)
    const alerts: Alert[] = []

    for (const item of curr.items) {
      if (watched && !watched.has(item.id)) continue

      const was = before.get(item.id)
      // An item we have never seen before is not a transition to available.
      // It might be a brand new section that opened full; it might be a source
      // that changed its ids. Neither is worth a text message.
      if (!was) continue

      const opened = becameTruthy(was, item, field)
      const grew =
        config.alertOnIncrease === true &&
        truthy(was[field]) &&
        Number(item[field] ?? 0) > Number(was[field] ?? 0)

      if (!opened && !grew) continue
      if (config.filters && !passesFilters(item, userConfig, config.filters)) continue

      alerts.push(buildAlert(item, userConfig, config.alert, item.id, at, scope))
    }

    return alerts
  }
}

function watchedIds(userConfig: UserConfig, key: string | undefined): Set<string> | null {
  if (!key) return null
  const value = userConfig[key]
  if (value === undefined || value === null || value === 'all') return null
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) return null
  return new Set(list.map(String))
}
