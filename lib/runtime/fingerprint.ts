/**
 * A fingerprint of the surface a run fetches from.
 *
 * WHY THIS EXISTS. `guard.ts` refuses a snapshot that lost more than half its
 * items in one run, because a partial source outage and a mass removal look
 * identical from here and one of them must never alert. That is right for a
 * source that changed under us and wrong for a manifest that changed under the
 * state: when internship-radar dropped 22 firms that were not investment banks,
 * the next run saw 814 items where the last had seen 1,960 and the run failed
 * as `item_cliff` — an outage report about a decision we made ourselves.
 *
 * The missing idea is that **a state produced by a different set of sources is
 * not a baseline**. It cannot be compared with, so it should not be compared
 * with: the run after a manifest change is a first run, and hard rule 8 already
 * says what a first run does — establishes the baseline and alerts nobody.
 *
 * WHAT GOES IN. Everything that decides which items can appear: the sources as
 * declared (id, url, method, body) and `params`, which is where a manifest puts
 * board tokens and firm lists. A params-only edit that could not change the
 * item set costs one poll of alerting, and that is the safe direction — the
 * alternative is a false outage on the run after every edit.
 *
 * WHAT STAYS OUT. Name, tagline, description, display, schedule, alert copy,
 * criteria. None of them touch what a fetch returns, and an agent should not
 * lose a poll because somebody fixed a typo in its tagline.
 */

import { canonical } from './manifest-sync.ts'
import type { AgentSpec } from './types.ts'

export function sourceFingerprint(spec: AgentSpec): string {
  return canonical({ sources: spec.sources ?? [], params: spec.params ?? {} })
}

/**
 * Whether a loaded state can serve as the baseline for a run of this spec.
 *
 * A state with no fingerprint — written before this existed — is ADOPTED, not
 * discarded. Every agent already running would otherwise lose a poll of
 * alerting on the deploy that introduced this file, which is a worse bug than
 * the one being fixed.
 */
export function isComparable(prev: { platform?: { sourceFingerprint?: string } } | null, fingerprint: string): boolean {
  if (prev === null) return false
  const stamped = prev.platform?.sourceFingerprint
  return stamped === undefined || stamped === fingerprint
}
