/**
 * Seasonal scheduling.
 *
 * "Registration agents polling every 60 seconds in July is pure waste — this
 * cuts compute ~90%" (ARCHITECTURE.md). Every agent declares an active_window;
 * out of season it drops to a heartbeat or sleeps.
 *
 * The windows are data, not code, and they are months — never a campus, a
 * country, or a user type (CLAUDE.md §7). An agent whose season does not fit
 * one of these declares `always` and the platform polls it at face value.
 *
 * Pure, apart from reading the month through Intl in the agent's timezone.
 */

export type SchedulePhase = 'active' | 'heartbeat' | 'asleep'

export interface SeasonWindow {
  /** 1-12, inclusive, wrapping across the new year (e.g. 8 → 2). */
  fromMonth: number
  toMonth: number
  /** What to do out of season. */
  offSeason: 'heartbeat' | 'asleep'
}

/**
 * Named windows. Add one here rather than putting a date in an agent.
 * `heartbeat` out of season means we keep proving the source still parses;
 * `asleep` means the source itself is gone until the season returns.
 */
export const SEASON_WINDOWS: Record<string, SeasonWindow> = {
  registration: { fromMonth: 3, toMonth: 5, offSeason: 'heartbeat' },
  recruiting: { fromMonth: 8, toMonth: 2, offSeason: 'heartbeat' },
  housing: { fromMonth: 1, toMonth: 6, offSeason: 'heartbeat' },
}

/** Out-of-season polling: once every six hours, just to catch a dead selector. */
export const HEARTBEAT_FREQUENCY_MS = 6 * 60 * 60 * 1000

export interface ResolvedSchedule {
  phase: SchedulePhase
  /** The frequency to actually use, after the season is applied. */
  frequencyMs: number
  reason: string
}

export function resolveSchedule(input: {
  frequency: string | number
  activeWindow?: string
  timezone?: string
  now: Date
}): ResolvedSchedule {
  const baseMs = parseFrequencyMs(input.frequency)
  const name = input.activeWindow ?? 'always'

  if (name === 'always' || !(name in SEASON_WINDOWS)) {
    return { phase: 'active', frequencyMs: baseMs, reason: 'always on' }
  }

  const window = SEASON_WINDOWS[name]
  const month = monthIn(input.now, input.timezone)

  if (inWindow(month, window)) {
    return { phase: 'active', frequencyMs: baseMs, reason: `in ${name} season` }
  }
  if (window.offSeason === 'asleep') {
    return { phase: 'asleep', frequencyMs: baseMs, reason: `outside ${name} season` }
  }
  return {
    phase: 'heartbeat',
    frequencyMs: Math.max(baseMs, HEARTBEAT_FREQUENCY_MS),
    reason: `outside ${name} season — heartbeat only`,
  }
}

export function inWindow(month: number, window: SeasonWindow): boolean {
  const { fromMonth, toMonth } = window
  return fromMonth <= toMonth
    ? month >= fromMonth && month <= toMonth
    : month >= fromMonth || month <= toMonth
}

/** 1-12 in the agent's timezone. A season boundary in the wrong zone is a day of silence. */
export function monthIn(now: Date, timezone?: string): number {
  if (!timezone) return now.getUTCMonth() + 1
  try {
    const formatted = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'numeric' }).format(now)
    return Number(formatted)
  } catch {
    return now.getUTCMonth() + 1
  }
}

/** '60s', '15m', '1h', 900000 → milliseconds. */
export function parseFrequencyMs(frequency: string | number): number {
  if (typeof frequency === 'number') return frequency
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(frequency.trim())
  if (!match) throw new Error(`unparseable poll frequency: ${frequency}`)
  const amount = Number(match[1])
  switch ((match[2] ?? 's').toLowerCase()) {
    case 'ms':
      return amount
    case 'm':
      return amount * 60_000
    case 'h':
      return amount * 3_600_000
    case 'd':
      return amount * 86_400_000
    default:
      return amount * 1000
  }
}

/** Which worker owns this agent: Vercel Cron, or the always-on race worker. */
export function schedulingTier(frequencyMs: number): 'race' | 'standard' | 'slow' {
  if (frequencyMs < 60_000) return 'race'
  if (frequencyMs < 3_600_000) return 'standard'
  return 'slow'
}
