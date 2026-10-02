/**
 * The scope contract, as types.
 *
 * REQUESTS.md §3.5. Five sections, all mandatory, in plain language — the
 * shape below is deliberately five plain fields and not a generic
 * `sections: {title, body}[]`, because a generic bag lets a section go missing
 * without anything noticing, and "the exclusions section was empty" is the
 * exact failure this whole stage exists to prevent.
 *
 * Everything here is serialised into `requests.scope` as jsonb and read back by
 * people, so it stays flat, stays strings, and carries no ids.
 */

/** The five sections. Every field is required and every one is prose. */
export interface ScopeContract {
  /**
   * What it will watch — sources named individually. "26 job boards" is not a
   * scope; the list is. One entry per source, in the words someone would use
   * to describe it out loud.
   */
  watch: string[]
  /** What counts as a hit — the trigger, in words. */
  hit: string
  /** How fast you'll know — the promise the shadow test later verifies. */
  speed: string
  /** How you'll be told — channel and cadence, and why that one. */
  told: string
  /**
   * What it will not do. Mandatory: a contract with an empty exclusions
   * section is unfinished, because every real agent has boundaries and this is
   * the section that answers "it's too basic" before it is said.
   */
  wont: string[]
}

/** The contract plus who wrote it and when. What actually lands in the column. */
export interface StoredScope extends ScopeContract {
  version: number
  draftedAt: string
  draftedBy: string | null
  /** Set on a revision so the request page can say what changed and when. */
  revisedFrom?: number
}

export type ScopeSection = keyof ScopeContract

export const SECTIONS: ScopeSection[] = ['watch', 'hit', 'speed', 'told', 'wont']

/** The headings, exactly as the requester reads them. REQUESTS.md §3.5. */
export const SECTION_HEADINGS: Record<ScopeSection, string> = {
  watch: 'WHAT IT WILL WATCH',
  hit: 'WHAT COUNTS AS A HIT',
  speed: "HOW FAST YOU'LL KNOW",
  told: "HOW YOU'LL BE TOLD",
  wont: 'WHAT IT WILL NOT DO',
}

/** The one-line prompt shown to whoever is drafting each section. */
export const SECTION_PROMPTS: Record<ScopeSection, string> = {
  watch: 'Name every source individually. A count is not a scope.',
  hit: 'The trigger, in words. What has to be true for this to be worth telling them about?',
  speed: 'The promise. Shadow verifies this later, so do not promise faster than it polls.',
  told: 'Channel and cadence — and why that one rather than the other.',
  wont: 'Mandatory. The boundaries, named before anyone commits money or time.',
}

export interface ScopeProblem {
  section: ScopeSection | null
  /** Index within a list section, when the problem is one entry rather than all. */
  index: number | null
  message: string
}

export interface ScopeValidation {
  ok: boolean
  problems: ScopeProblem[]
}
