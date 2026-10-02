/**
 * `options_from` — live options, pulled from the source.
 *
 *   user_config:
 *     - key: sections
 *       type: multiselect
 *       options_from: course_data.sections    # never make users type
 *
 * Where the options come from is the decision worth explaining. They are read
 * from the agent's stored State (`agent_state`) and its manifest params, NOT by
 * fetching the source when someone opens the form.
 *
 * That is not a shortcut. "One fetch serves all subscribers. Never fetch
 * per-user" is the line in ARCHITECTURE.md that makes the marginal cost of
 * subscriber N+1 approximately zero, and a config page that fetches on load
 * breaks it in the most embarrassing possible way: the busiest page during
 * registration week, hitting a registrar once per visitor. The stored State is
 * the same data, is at most one poll old — sixty seconds for a race agent — and
 * costs nothing. It is also the same snapshot `match()` will run against, so the
 * options a user picks from are exactly the things the agent can actually see.
 *
 * The reference grammar:
 *
 *   params.<path>        a list in the manifest        params.firms
 *   items.<field>        distinct values across State  items.subject
 *   meta.<path>          a list in State.meta          meta.terms
 *   <sourceId>.<field>   distinct values from items    course_data.sections
 *                        that came from that source
 *
 * WHEN THE LIST HOLDS OBJECTS, one of their keys is the value and another is
 * the label. `value`, `id`, `key` and `name` are recognised without being
 * asked for, because most manifests use one of them. A manifest whose objects
 * use a domain word instead says so:
 *
 *   - key: libraries
 *     options_from: params.libraries
 *     option_value: lid                 # LibCal's word for a library
 *     option_label: label
 *
 * This is not a nicety. Before it existed, an object list with no recognised
 * key resolved to NOTHING, and the only symptom was a required multiselect
 * rendering with zero choices — a form nobody can submit, on an agent that had
 * passed every submission check. columbia-study-rooms shipped into shadow that
 * way. `lib/submission/checks.ts` now refuses that shape outright; this is the
 * other half, which lets the manifest be right instead of merely caught.
 */

import type { ConfigOption } from './schema.ts'
import { humanise } from './schema.ts'
import type { JsonObject, JsonValue, State } from '../runtime/types.ts'

/** A form with more choices than this is not selection, it is a search problem. */
export const MAX_OPTIONS = 500

export interface OptionSource {
  /** spec.params, verbatim. */
  params: JsonObject
  /** The agent's last good snapshot, or null before the first run. */
  state: State | null
}

/**
 * Which key of an object entry is the value, and which is the label. Both are
 * optional; each falls back to the recognised names.
 */
export interface OptionMapping {
  valueKey?: string
  labelKey?: string
}

/** One field's request for options: where from, and how to read each entry. */
export interface OptionRequest extends OptionMapping {
  ref: string
}

export function resolveOptions(ref: string, source: OptionSource, mapping: OptionMapping = {}): ConfigOption[] {
  const [head, ...rest] = ref.split('.')
  const path = rest.join('.')
  if (!head) return []

  if (head === 'params') return cap(fromList(readPath(source.params, path), mapping))

  const state = source.state
  if (!state) return []

  if (head === 'meta') return cap(fromList(readPath((state.meta ?? {}) as JsonObject, path), mapping))

  if (head === 'items' || head === 'state') {
    const field = head === 'state' && path.startsWith('items.') ? path.slice('items.'.length) : path
    return cap(distinctField(state.items ?? [], field))
  }

  // `<sourceId>.<field>`: items carrying a matching `source` field first, and
  // every item otherwise. An agent whose State does not label its items by
  // source still gets usable options rather than an empty form.
  const scoped = (state.items ?? []).filter((item) => item.source === head || item.source_id === head)
  const items = scoped.length > 0 ? scoped : (state.items ?? [])
  return cap(distinctField(items, path))
}

/**
 * Resolve every reference a spec makes, in one pass. Keyed by the reference as
 * written, which is what `parseUserConfig` looks up.
 *
 * Accepts bare strings so a caller that has no mapping to pass stays simple.
 */
export function resolveAllOptions(
  refs: ReadonlyArray<string | OptionRequest>,
  source: OptionSource,
): Map<string, ConfigOption[]> {
  const out = new Map<string, ConfigOption[]>()
  for (const entry of refs) {
    const request: OptionRequest = typeof entry === 'string' ? { ref: entry } : entry
    out.set(request.ref, resolveOptions(request.ref, source, request))
  }
  return out
}

// ---------- internals ----------

function readPath(root: JsonObject, path: string): JsonValue | undefined {
  if (!path) return root as JsonValue
  let current: JsonValue | undefined = root as JsonValue
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as JsonObject)[segment]
  }
  return current
}

/** A list of scalars or objects becomes a list of {value,label}. */
function fromList(value: JsonValue | undefined, mapping: OptionMapping = {}): ConfigOption[] {
  if (!Array.isArray(value)) return []
  const out: ConfigOption[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    let option: ConfigOption | null = null
    if (typeof entry === 'string' || typeof entry === 'number') {
      option = { value: String(entry), label: humanise(String(entry)) }
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as JsonObject
      // A key the manifest named comes first; the recognised names are the
      // fallback, not the rule.
      const raw = pick(record, withNamed(mapping.valueKey, ['value', 'id', 'key', 'name']))
      if (raw === undefined) continue
      // The label is what a person reads: "Point72", not "point72". The value
      // is what reaches match(), and it never changes to suit the label.
      option = {
        value: raw,
        label: pick(record, withNamed(mapping.labelKey, ['label', 'title', 'text', 'name'])) ?? humanise(raw),
      }
    }
    if (!option || seen.has(option.value)) continue
    seen.add(option.value)
    out.push(option)
  }
  return out
}

/** Distinct values of one field across State items, in first-seen order. */
function distinctField(items: ReadonlyArray<Record<string, JsonValue | undefined>>, field: string): ConfigOption[] {
  if (!field) return []
  const out: ConfigOption[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const value = readPath(item as JsonObject, field)
    // A field holding a list contributes each of its entries: an item tagged
    // with three subjects belongs in all three.
    const candidates = Array.isArray(value) ? value : [value]
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue
      if (typeof candidate === 'object') continue
      const asString = String(candidate)
      if (!asString || seen.has(asString)) continue
      seen.add(asString)
      out.push({ value: asString, label: humanise(asString) })
    }
  }
  return out
}

/** The manifest's own key first, then the ones recognised without asking. */
function withNamed(named: string | undefined, fallbacks: string[]): string[] {
  return named ? [named, ...fallbacks.filter((key) => key !== named)] : fallbacks
}

function pick(record: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function cap(options: ConfigOption[]): ConfigOption[] {
  return options.length > MAX_OPTIONS ? options.slice(0, MAX_OPTIONS) : options
}
