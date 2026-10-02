/**
 * The subscriber's setup form, derived from the agent's `user_config` block.
 *
 * AGENT-SPEC.md promises a builder that the platform renders their config form.
 * That promise is this file: a manifest declares fields, and the UI is a
 * consequence rather than a second thing to write and keep in sync.
 *
 * DESIGN.md states the rule the whole module exists to enforce —
 * **configuration is selection**. A user must never paste a URL or type a
 * course code. So a free-text field that is really asking for one is not
 * rendered awkwardly; it is a spec error, reported at parse time, in the same
 * place the publish pipeline's automated checks live. The alternative is a
 * catalogue that slowly fills with forms asking people to paste links, one
 * reasonable-seeming exception at a time.
 *
 * The second job is validation. `validateConfig` is what an untrusted POST goes
 * through, and it accepts only values that appear in the resolved option set —
 * config reaches builder code, and "whatever the client sent" is not a
 * defensible input to someone else's `match()`.
 */

import type { OptionRequest } from './options.ts'
import type { JsonObject, JsonValue } from '../runtime/types.ts'

export type FieldType = 'select' | 'multiselect' | 'text' | 'number' | 'range' | 'toggle'

export interface ConfigOption {
  value: string
  label: string
}

export interface ConfigField {
  key: string
  label: string
  type: FieldType
  help?: string
  required: boolean
  /** Resolved and ready to render. Empty for text/number/range/toggle. */
  options: ConfigOption[]
  /** The unresolved reference, kept so the UI can say where options come from. */
  optionsFrom?: string
  default?: JsonValue
  min?: number
  max?: number
  step?: number
  /** Selection ceiling for a multiselect. */
  maxSelections?: number
  unit?: string
}

export interface ParsedUserConfig {
  fields: ConfigField[]
  /**
   * Spec errors, not user errors. A field with a problem is dropped rather than
   * rendered: half a form is recoverable, a form that asks for a password is not.
   */
  problems: string[]
}

const FIELD_TYPES = new Set<FieldType>(['select', 'multiselect', 'text', 'number', 'range', 'toggle'])

/**
 * Hard rule 1: we never store a password or portal credential, so we never ask
 * for one. Matched against the key and the label, because a field named
 * `portal_pin` and one labelled "Your SSOL PIN" are the same field.
 */
const CREDENTIAL_WORDS = [
  'password',
  'passwd',
  'passcode',
  'credential',
  'secret',
  'api key',
  'apikey',
  'api_key',
  'token',
  'ssn',
  'social security',
  'login',
  'sign in',
  'username',
  'pin',
]

/**
 * The selection rule. A field asking for a URL, a link or a pasted identifier
 * is asking the user to do the platform's job — the value should come from
 * `options_from`, pointed at the source that already knows every valid answer.
 */
const PASTE_WORDS = ['url', 'link', 'http', 'endpoint', 'feed', 'paste', 'rss']

export function parseUserConfig(spec: { user_config?: unknown }, resolved?: Map<string, ConfigOption[]>): ParsedUserConfig {
  const problems: string[] = []
  const fields: ConfigField[] = []

  const raw = spec.user_config
  if (raw === undefined || raw === null) return { fields, problems }
  if (!Array.isArray(raw)) return { fields, problems: ['user_config must be a list of fields'] }

  const seen = new Set<string>()

  for (const [index, entry] of raw.entries()) {
    const where = `user_config[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${where}: not a field object`)
      continue
    }
    const field = entry as Record<string, unknown>

    const key = typeof field.key === 'string' ? field.key.trim() : ''
    if (!key) {
      problems.push(`${where}: missing key`)
      continue
    }
    if (seen.has(key)) {
      problems.push(`${where}: duplicate key "${key}"`)
      continue
    }
    seen.add(key)

    const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim() : key
    const haystack = `${key} ${label}`.toLowerCase()

    const credential = CREDENTIAL_WORDS.find((word) => haystack.includes(word))
    if (credential) {
      problems.push(
        `${where} "${key}": asks for a credential ("${credential}"). Agents use public data, user-supplied config, or forwarded email — never a password (hard rule 1).`,
      )
      continue
    }

    const type = typeof field.type === 'string' ? (field.type as FieldType) : 'text'
    if (!FIELD_TYPES.has(type)) {
      problems.push(`${where} "${key}": unknown type "${String(field.type)}"`)
      continue
    }

    const optionsFrom = typeof field.options_from === 'string' ? field.options_from : undefined
    const inline = Array.isArray(field.options) ? toOptions(field.options) : []
    const options = optionsFrom ? (resolved?.get(optionsFrom) ?? []) : inline

    if (type === 'select' || type === 'multiselect') {
      if (!optionsFrom && inline.length === 0) {
        problems.push(`${where} "${key}": a ${type} needs options or options_from — configuration is selection.`)
        continue
      }
    } else if (type === 'text') {
      const paste = PASTE_WORDS.find((word) => haystack.includes(word))
      if (paste) {
        problems.push(
          `${where} "${key}": free text asking for a ${paste}. Point it at the source with options_from — a user must never paste a URL (DESIGN.md).`,
        )
        continue
      }
    }

    fields.push({
      key,
      label,
      type,
      help: typeof field.help === 'string' ? field.help : undefined,
      required: field.required === true,
      options,
      optionsFrom,
      default: (field.default ?? undefined) as JsonValue | undefined,
      min: numberOrUndefined(field.min),
      max: type === 'multiselect' ? undefined : numberOrUndefined(field.max),
      step: numberOrUndefined(field.step),
      // `max` on a multiselect is a selection ceiling, not a numeric bound —
      // the seat watcher's "max: 10" means ten sections, not the number ten.
      maxSelections: type === 'multiselect' ? numberOrUndefined(field.max) : undefined,
      unit: typeof field.unit === 'string' ? field.unit : undefined,
    })
  }

  return { fields, problems }
}

/**
 * Every `options_from` reference a spec makes, WITH the keys that field named
 * for reading each entry. This is what the resolver wants; `optionRefs` below
 * is the same thing without the mapping, kept for callers that have no use
 * for it.
 */
export function optionRequests(spec: { user_config?: unknown }): OptionRequest[] {
  const raw = spec.user_config
  if (!Array.isArray(raw)) return []
  const out: OptionRequest[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const field = entry as Record<string, unknown>
    const ref = field.options_from
    if (typeof ref !== 'string' || seen.has(ref)) continue
    seen.add(ref)
    out.push({
      ref,
      valueKey: typeof field.option_value === 'string' ? field.option_value : undefined,
      labelKey: typeof field.option_label === 'string' ? field.option_label : undefined,
    })
  }
  return out
}

/** Every `options_from` reference a spec makes, for the resolver to fill. */
export function optionRefs(spec: { user_config?: unknown }): string[] {
  const raw = spec.user_config
  if (!Array.isArray(raw)) return []
  const refs = new Set<string>()
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).options_from === 'string') {
      refs.add((entry as Record<string, string>).options_from)
    }
  }
  return [...refs]
}

export interface ValidationResult {
  values: JsonObject
  /** Keyed by field. Copy voice: say what happened and what to do. */
  errors: Record<string, string>
}

/**
 * Coerce and check one submission.
 *
 * Selected values must appear in the resolved option set. This is not belt and
 * braces: the result is written to `agent_subscriptions.config` and handed
 * straight to a builder's `match()`, so anything this function lets through is
 * something someone else's code has to survive.
 */
export function validateConfig(fields: ConfigField[], input: Record<string, unknown>): ValidationResult {
  const values: JsonObject = {}
  const errors: Record<string, string> = {}

  for (const field of fields) {
    const raw = input[field.key]

    switch (field.type) {
      case 'multiselect': {
        const allowed = new Set(field.options.map((o) => o.value))
        const submitted = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map(String)
        const chosen = submitted.filter((value) => allowed.has(value))
        const rejected = submitted.filter((value) => !allowed.has(value))

        if (rejected.length > 0) errors[field.key] = `Not something we can watch: ${rejected.slice(0, 3).join(', ')}`
        else if (field.required && chosen.length === 0) errors[field.key] = 'Pick at least one.'
        else if (field.maxSelections !== undefined && chosen.length > field.maxSelections) {
          errors[field.key] = `Pick at most ${field.maxSelections}.`
        }

        values[field.key] = chosen
        break
      }

      case 'select': {
        const allowed = new Set(field.options.map((o) => o.value))
        const value = raw === undefined || raw === null ? '' : String(raw)
        if (!value) {
          if (field.required) errors[field.key] = 'Pick one.'
          values[field.key] = null
        } else if (!allowed.has(value)) {
          errors[field.key] = 'Not something we can watch.'
          values[field.key] = null
        } else {
          values[field.key] = value
        }
        break
      }

      case 'toggle': {
        values[field.key] = raw === true || raw === 'true' || raw === 'on' || raw === '1'
        break
      }

      case 'number':
      case 'range': {
        const value = raw === undefined || raw === null || raw === '' ? null : Number(raw)
        if (value === null) {
          if (field.required) errors[field.key] = 'Enter a number.'
          values[field.key] = null
        } else if (!Number.isFinite(value)) {
          errors[field.key] = 'Enter a number.'
          values[field.key] = null
        } else if (field.min !== undefined && value < field.min) {
          errors[field.key] = `${field.min} or more.`
          values[field.key] = null
        } else if (field.max !== undefined && value > field.max) {
          errors[field.key] = `${field.max} or fewer.`
          values[field.key] = null
        } else {
          values[field.key] = value
        }
        break
      }

      case 'text': {
        const value = raw === undefined || raw === null ? '' : String(raw).trim()
        if (!value && field.required) errors[field.key] = 'Fill this in.'
        // Bounded because it is stored, re-read every run, and shown back.
        values[field.key] = value.slice(0, 200)
        break
      }
    }
  }

  return { values, errors }
}

/** The form's starting values: what they saved, else the field's default. */
export function defaultValues(fields: ConfigField[], saved: JsonObject = {}): JsonObject {
  const values: JsonObject = {}
  for (const field of fields) {
    const existing = saved[field.key]
    if (existing !== undefined) {
      values[field.key] = existing
      continue
    }
    if (field.default !== undefined) {
      values[field.key] = field.default
      continue
    }
    values[field.key] = field.type === 'multiselect' ? [] : field.type === 'toggle' ? false : null
  }
  return values
}

// ---------- internals ----------

function toOptions(list: unknown[]): ConfigOption[] {
  const out: ConfigOption[] = []
  for (const entry of list) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      out.push({ value: String(entry), label: humanise(String(entry)) })
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      const value = firstString(record, ['value', 'id', 'key', 'name'])
      if (!value) continue
      out.push({ value, label: firstString(record, ['label', 'title', 'text', 'name']) ?? humanise(value) })
    }
  }
  return out
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

/** `hedge_fund` reads as "Hedge fund". The label is what the subscriber sees. */
export function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim()
  if (!spaced) return value
  // Leave anything already carrying capitals or punctuation alone: "ECON 3025"
  // and "Point72" are names, not slugs.
  if (/[A-Z0-9]/.test(spaced) && spaced !== spaced.toLowerCase()) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
