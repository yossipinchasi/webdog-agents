/**
 * The pattern library. `/lib/patterns` is where the leverage lives — a new
 * agent should be a config on a pattern, not new logic (ARCHITECTURE.md).
 *
 * Implemented: availability-watcher (1), new-listing-watcher (2).
 * The remaining twelve in AGENT-SPEC.md §The 14 patterns are added the same
 * way, each when a second agent needs it — never speculatively.
 */

export { availabilityWatcher, type AvailabilityWatcherConfig } from './availability-watcher.ts'
export { newListingWatcher, type NewListingWatcherConfig } from './new-listing-watcher.ts'
export {
  buildAlert,
  passesFilter,
  passesFilters,
  renderTemplate,
  scopedKey,
  type AlertTemplate,
  type FilterRule,
  type MatchFn,
} from './types.ts'

/** Pattern ids from the manifest, so a spec can be checked against reality. */
export const IMPLEMENTED_PATTERNS = ['availability-watcher', 'new-listing-watcher'] as const
export type ImplementedPattern = (typeof IMPLEMENTED_PATTERNS)[number]
