/**
 * Pattern base types.
 *
 * "200 use cases are not 200 programs. They are ~14 patterns × configurations"
 * (CLAUDE.md §3). A pattern is a factory: hand it the shape of one agent's data
 * and it returns that agent's `match`. The agent contributes fetch, normalize,
 * and a config object — not logic.
 *
 * Everything here is pure and receives one user's config at a time, because
 * what it produces IS the agent's match function and inherits every rule that
 * applies to one (AGENT-SPEC.md §index.ts).
 */

import type { DedupeScope } from '../runtime/dedupe.ts'
import type { Alert, AlertPriority, JsonValue, State, StateItem, UserConfig } from '../runtime/types.ts'

export type MatchFn = (prev: State | null, curr: State, config: UserConfig) => Alert[]

export interface AlertTemplate {
  /** '{firm} — {title}'. Placeholders read item fields, then config values. */
  title: string
  body: string
  /** Item field holding the link a user should open. */
  urlField?: string
  priority?: AlertPriority
  /**
   * How often the same underlying thing may alert again. 'once' for ids that
   * are unique forever (a job posting); 'daily' for things that cycle (a seat
   * that opens, fills, and opens again). See runtime/dedupe.ts.
   */
  dedupeScope?: DedupeScope
  /** Extra text prefixed to the dedupe key, to namespace a term or a region. */
  dedupePrefix?: string
}

/**
 * A declarative filter between a user's config value and an item field.
 *
 * Declarative on purpose: a fork changes the rules in the config object, and
 * nobody writes a fourth near-identical filter loop.
 */
export interface FilterRule {
  /** Key in the subscriber's config. */
  configKey: string
  /** Field on the item. */
  itemField: string
  op: 'in' | 'equals' | 'any-of' | 'keyword' | 'exclude-keyword' | 'at-least' | 'at-most'
  /** What to do when the item's field is null/undefined. Default 'fail'. */
  onMissing?: 'pass' | 'fail'
  /** What to do when the user left the config value empty. Default 'pass'. */
  onEmptyConfig?: 'pass' | 'fail'
  /**
   * Match keyword terms at word boundaries. **Defaults to true**, because
   * substring matching on human-readable filter terms is a false-alert
   * generator and a false alert is the one thing this product cannot afford.
   *
   * Measured on 1,481 real job postings (internship-radar, Session 5): the
   * term "intern" matched at word boundaries found 132 internships. As a
   * substring it added 8 more, every one of them wrong — "International Trade
   * Support Associate", "Internal Audit Manager", "Software Developer -
   * Internal Compute Frameworks". A 6% false-alert rate from one character of
   * sloppiness.
   *
   * Set false only when you actually want substring semantics — matching
   * inside identifiers, part numbers, or concatenated text. Terms containing
   * non-word characters ("s&t", "sales & trading") always fall back to
   * substring, because a word boundary means nothing next to an ampersand.
   */
  wholeWord?: boolean
}

export function renderTemplate(template: string, item: StateItem, config: UserConfig): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (full, key: string) => {
    const fromItem = item[key]
    if (fromItem !== undefined && fromItem !== null) return String(fromItem)
    const fromConfig = config[key]
    if (fromConfig !== undefined && fromConfig !== null) return String(fromConfig)
    return full
  })
}

export function buildAlert(
  item: StateItem,
  config: UserConfig,
  template: AlertTemplate,
  dedupeBase: string,
  scopeAt: Date,
  scope: DedupeScope,
): Alert {
  const url = template.urlField ? item[template.urlField] : undefined
  const key = template.dedupePrefix ? `${template.dedupePrefix}:${dedupeBase}` : dedupeBase
  return {
    dedupeKey: scopedKey(key, scope, scopeAt),
    priority: template.priority ?? 'normal',
    title: renderTemplate(template.title, item, config),
    body: renderTemplate(template.body, item, config),
    ...(typeof url === 'string' && /^https?:\/\//i.test(url) ? { actionUrl: url } : {}),
  }
}

/** Re-exported through a thin wrapper so patterns never import runtime internals twice. */
export function scopedKey(base: string, scope: DedupeScope, at: Date): string {
  if (scope === 'once') return base
  const seconds = scope === 'daily' ? 86_400 : scope === 'hourly' ? 3_600 : scope
  return `${base}#${Math.floor(at.getTime() / (seconds * 1000))}`
}

export function passesFilters(item: StateItem, config: UserConfig, rules: FilterRule[]): boolean {
  return rules.every((rule) => passesFilter(item, config, rule))
}

export function passesFilter(item: StateItem, config: UserConfig, rule: FilterRule): boolean {
  const configValue = config[rule.configKey]
  const itemValue = item[rule.itemField]

  if (isEmpty(configValue) || configValue === 'all') {
    // "All firms" is the common default; an unanswered optional question must
    // not silently mute a subscriber.
    return (rule.onEmptyConfig ?? 'pass') === 'pass'
  }
  if (itemValue === undefined || itemValue === null) {
    // The source did not say. Filtering on a value we do not have is how a
    // real match gets dropped; the agent decides which way that falls.
    return (rule.onMissing ?? 'fail') === 'pass'
  }

  switch (rule.op) {
    case 'in':
      return toArray(configValue).some((v) => String(v) === String(itemValue))
    case 'equals':
      return String(configValue) === String(itemValue)
    case 'any-of': {
      const wanted = new Set(toArray(configValue).map(String))
      return toArray(itemValue).some((v) => wanted.has(String(v)))
    }
    case 'keyword':
      return matchesKeyword(String(itemValue), toArray(configValue).map(String), rule.wholeWord !== false)
    case 'exclude-keyword':
      return !matchesKeyword(String(itemValue), toArray(configValue).map(String), rule.wholeWord !== false)
    case 'at-least':
      return Number(itemValue) >= Number(configValue)
    case 'at-most':
      return Number(itemValue) <= Number(configValue)
  }
}

function matchesKeyword(haystack: string, needles: string[], wholeWord: boolean): boolean {
  const lower = haystack.toLowerCase()
  return needles.some((needle) => {
    const term = needle.toLowerCase()
    if (term === '') return false
    // A word boundary is only meaningful between word characters. "s&t" and
    // "sales & trading" fall back to substring rather than never matching.
    if (wholeWord && /^[\w ]+$/.test(term)) {
      return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)
    }
    return lower.includes(term)
  })
}

/**
 * Whole-word matching does not stem. "intern" will not match "internship" —
 * \b sits between word characters, not inside them. A filter that means both
 * must list both, which is why real agents enumerate intern / interns /
 * internship rather than relying on a prefix.
 */

function toArray(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function isEmpty(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return true
  return Array.isArray(value) && value.length === 0
}
