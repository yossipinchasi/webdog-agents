/**
 * What a submission is, and what it produces.
 *
 * AGENT-SPEC.md §Publish pipeline step 2 is a list of automated checks. This is
 * that list as a type: every check reports separately, with the sentence a
 * builder acts on, and `passed` is only ever "nothing blocking" — the same
 * shape as lib/subscriptions/ship-gate.ts, deliberately, because an operator
 * reading a refusal in either place needs the same thing from it.
 */

import type { AgentSpec } from '../runtime/types.ts'

export type SubmissionCheckId =
  | 'schema'
  | 'axes'
  | 'criteria'
  | 'about'
  | 'interface'
  | 'bundled'
  | 'config-form'
  | 'network'
  | 'credentials'
  | 'sources'
  | 'lease'
  | 'harness'
  | 'templates'
  | 'cost'

export interface SubmissionCheck {
  id: SubmissionCheckId
  label: string
  passed: boolean
  /** The sentence shown to whoever has to act on it. One line, specific. */
  detail: string
}

export interface SubmissionReport {
  agentId: string
  passed: boolean
  checks: SubmissionCheck[]
  /** The failed checks' details, for a one-line refusal. */
  blockers: string[]
  /** The alert copy this submission carries, and its fingerprint. */
  template: AlertTemplate
}

/**
 * The three strings that reach a subscriber unedited. Priority is routing and
 * is ours; these are the builder's, and they are what gets locked.
 */
export interface AlertTemplate {
  title: string
  body: string
  actionUrl: string | null
  /** sha256 of `title\nbody\nactionUrl`, matching alert_template_fingerprint(). */
  hash: string
}

/**
 * The agent as it exists in the repository: a manifest, a module, and the
 * recorded responses its harness replays.
 *
 * v1's code path is a pull request (BUILDERS.md §The code path). Nothing here
 * downloads, unpacks or evaluates anything: `sources` is the text of the files
 * that are already checked in, read so the checks can look at them, and the
 * module is imported by the same directory registry the worker uses.
 */
export interface SubmissionInput {
  agentId: string
  spec: AgentSpec
  /** Every .ts file under /agents/<id>, as text, for the static scan. */
  sources: Array<{ path: string; text: string }>
  /** Result of the offline fixture harness, or null when it was not run. */
  harness: { passed: boolean; detail: string } | null
  /**
   * Ids the DEPLOYED runtime can actually load — `agents/registry.ts`.
   *
   * Separate from what is on disk, because those are different questions and
   * the difference is invisible until production. See `checkBundled`.
   */
  bundledIds?: readonly string[]
  /**
   * What the module actually exports, from loading it through the same registry
   * the worker uses. Null when it could not be loaded at all.
   */
  exports: { fetch: boolean; normalize: boolean; match: boolean; enrich: 'absent' | 'function' | 'not-a-function' } | null
}
