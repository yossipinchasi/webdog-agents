/**
 * STEP 7 — DEDUPE, and the alert validation that precedes it.
 *
 * Dedup is the platform's job, never the agent's (hard rule 7). An agent
 * returns what it believes is true right now; the platform decides whether the
 * user has already heard it. That split is what makes a buggy agent survivable:
 * the worst a repeated match() can do is produce alerts that get dropped here.
 *
 * Three layers, in order:
 *   1. within-run     — the same key twice in one match() result
 *   2. cooldown       — the same key again inside the manifest's cooldown window
 *   3. the database   — unique (user_id, agent_id, dedupe_key), once ever
 *
 * Layer 3 is absolute, which is why a repeatable event needs a cycle
 * discriminator in its key. See scopedDedupeKey.
 *
 * Pure. The caller supplies the clock and the recently-seen keys.
 */

import type { Alert, AlertPriority } from './types.ts'

/**
 * How often the same underlying thing may alert again.
 *
 *   'once'   — an id that is unique forever: a job posting, a filing, a release.
 *   'daily'  — a repeatable event: a seat that opens, fills, and opens again.
 *   'hourly' — a fast-cycling repeatable event.
 *   number   — bucket width in seconds, for anything else.
 *
 * The discriminator is derived from the snapshot's own timestamp, never from
 * wall-clock time at insert, so a replayed fixture produces identical keys.
 */
export type DedupeScope = 'once' | 'daily' | 'hourly' | number

export function scopedDedupeKey(base: string, scope: DedupeScope, at: Date): string {
  if (scope === 'once') return base
  const seconds = scope === 'daily' ? 86_400 : scope === 'hourly' ? 3_600 : scope
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid dedupe scope: ${String(scope)}`)
  }
  const bucket = Math.floor(at.getTime() / (seconds * 1000))
  return `${base}#${bucket}`
}

// ---------- Validation of what agent code returned ----------

export interface AlertRejection {
  index: number
  reason: string
}

const MAX_TITLE = 200
const MAX_BODY = 1000
const MAX_KEY = 200

/**
 * Validate and normalise one match() result.
 *
 * An alert without a dedupe key is dropped, not fixed up with a generated one:
 * a generated key would defeat every layer above and let the same event fire
 * forever. Silence is safe; a repeating alert is not.
 */
export function validateAlerts(
  raw: unknown,
): { alerts: Alert[]; rejected: AlertRejection[] } {
  const rejected: AlertRejection[] = []
  if (!Array.isArray(raw)) {
    return { alerts: [], rejected: [{ index: -1, reason: `match() returned ${typeof raw}, expected an array` }] }
  }

  const alerts: Alert[] = []
  raw.forEach((candidate, index) => {
    const problem = alertProblem(candidate)
    if (problem) {
      rejected.push({ index, reason: problem })
      return
    }
    const a = candidate as Alert
    alerts.push({
      dedupeKey: a.dedupeKey.trim().slice(0, MAX_KEY),
      priority: (a.priority === 'urgent' ? 'urgent' : 'normal') as AlertPriority,
      title: a.title.trim().slice(0, MAX_TITLE),
      body: a.body.trim().slice(0, MAX_BODY),
      ...(a.actionUrl ? { actionUrl: a.actionUrl } : {}),
    })
  })

  return { alerts, rejected }
}

function alertProblem(candidate: unknown): string | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'not an object'
  }
  const a = candidate as Record<string, unknown>
  if (typeof a.dedupeKey !== 'string' || a.dedupeKey.trim() === '') {
    return 'missing dedupeKey — hard rule 7, every alert carries one'
  }
  if (typeof a.title !== 'string' || a.title.trim() === '') return 'missing title'
  if (typeof a.body !== 'string' || a.body.trim() === '') return 'missing body'
  if (a.actionUrl !== undefined && typeof a.actionUrl !== 'string') return 'actionUrl is not a string'
  if (typeof a.actionUrl === 'string' && !/^https?:\/\//i.test(a.actionUrl)) {
    // javascript: and data: URLs end up in an email. Not on our watch.
    return `actionUrl must be http(s), got ${a.actionUrl.slice(0, 30)}`
  }
  return null
}

// ---------- Layer 1: within one run ----------

export function dedupeWithinRun(alerts: Alert[]): { kept: Alert[]; dropped: number } {
  const seen = new Set<string>()
  const kept: Alert[] = []
  for (const alert of alerts) {
    if (seen.has(alert.dedupeKey)) continue
    seen.add(alert.dedupeKey)
    kept.push(alert)
  }
  return { kept, dropped: alerts.length - kept.length }
}

// ---------- Layer 2: the cooldown window ----------

export interface CooldownDrop {
  dedupeKey: string
  lastSeenAt: string
}

/**
 * Drop alerts whose key this user has already been told inside the cooldown.
 *
 * `seen` maps dedupe key → ISO timestamp of the last alert with that key for
 * THIS user. A key absent from the map has never been sent.
 */
export function applyCooldown(
  alerts: Alert[],
  seen: ReadonlyMap<string, string>,
  now: Date,
  cooldownSeconds: number,
): { kept: Alert[]; dropped: CooldownDrop[] } {
  const kept: Alert[] = []
  const dropped: CooldownDrop[] = []
  const windowStart = now.getTime() - cooldownSeconds * 1000

  for (const alert of alerts) {
    const last = seen.get(alert.dedupeKey)
    if (last !== undefined && Date.parse(last) >= windowStart) {
      dropped.push({ dedupeKey: alert.dedupeKey, lastSeenAt: last })
      continue
    }
    kept.push(alert)
  }
  return { kept, dropped }
}

/**
 * Deterministic truncation for a subscriber whose filter matched too much.
 *
 * Sorted by key so the same overflow truncates the same way on a retry —
 * otherwise a re-run delivers a different ten and the user gets twenty.
 */
export function capPerUser(alerts: Alert[], max: number): { kept: Alert[]; truncated: number } {
  if (alerts.length <= max) return { kept: alerts, truncated: 0 }
  const sorted = [...alerts].sort(compareAlerts)
  return { kept: sorted.slice(0, max), truncated: alerts.length - max }
}

function compareAlerts(a: Alert, b: Alert): number {
  // Urgent first — if we can only send ten, send the ten that decay fastest.
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1
  return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0
}

/** '300s', '15m', '24h', '86400' → seconds. */
export function parseDuration(value: string | number | undefined, fallbackSeconds: number): number {
  if (value === undefined || value === null || value === '') return fallbackSeconds
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim())
  if (!match) throw new Error(`unparseable duration: ${value}`)
  const amount = Number(match[1])
  switch ((match[2] ?? 's').toLowerCase()) {
    case 'ms':
      return amount / 1000
    case 'm':
      return amount * 60
    case 'h':
      return amount * 3600
    case 'd':
      return amount * 86_400
    default:
      return amount
  }
}
