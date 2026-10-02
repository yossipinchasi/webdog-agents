/**
 * Failure accounting: backoff and the degraded flag.
 *
 * The schedule is 1m → 5m → 15m → 1h (ARCHITECTURE.md §Source fetching rules),
 * and four consecutive failures mark the agent degraded and page a human.
 *
 * Consecutive failures are derived from the runs table rather than kept in a
 * counter column. A counter drifts the first time a worker dies mid-run; the
 * run log cannot, because it is the same evidence an operator reads.
 *
 * Pure.
 */

import { DEGRADED_AFTER_FAILURES } from './limits.ts'
import type { RunStatus } from './types.ts'

export const BACKOFF_SCHEDULE_MS = [60_000, 300_000, 900_000, 3_600_000] as const

/** Delay before the next attempt after `consecutiveFailures` failed runs. */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  const index = Math.min(consecutiveFailures, BACKOFF_SCHEDULE_MS.length) - 1
  return BACKOFF_SCHEDULE_MS[index]
}

export function isDegraded(consecutiveFailures: number): boolean {
  return consecutiveFailures >= DEGRADED_AFTER_FAILURES
}

/**
 * Count failures back from the most recent run.
 *
 * `runs` must be newest-first. A 'skipped' run is not evidence either way —
 * out of season or lock-contended — so it is stepped over rather than counted
 * or treated as a recovery.
 */
export function consecutiveFailuresFrom(
  runs: ReadonlyArray<{ status: RunStatus }>,
): number {
  let count = 0
  for (const run of runs) {
    if (run.status === 'skipped') continue
    if (run.status === 'error') count++
    else break
  }
  return count
}

/**
 * When this agent may next be attempted.
 *
 * With no failures it is simply lastStartedAt + the poll frequency. With
 * failures the backoff replaces the frequency whenever it is longer — a 60s
 * race agent hammering a source that is already 500ing helps no one.
 */
export function nextRunAt(input: {
  lastStartedAt: Date | null
  consecutiveFailures: number
  frequencyMs: number
}): Date | null {
  if (input.lastStartedAt === null) return null // never run: due now
  const delay = Math.max(input.frequencyMs, backoffDelayMs(input.consecutiveFailures))
  return new Date(input.lastStartedAt.getTime() + delay)
}

export function isDue(input: {
  lastStartedAt: Date | null
  consecutiveFailures: number
  frequencyMs: number
  now: Date
}): boolean {
  const next = nextRunAt(input)
  return next === null || next.getTime() <= input.now.getTime() + dueGraceMs(input.frequencyMs)
}

/**
 * How early a run may be and still count as due.
 *
 * THE CLOCK AND THE CADENCE CAN BE THE SAME NUMBER. The database clock ticks
 * every five minutes and Desk Finder polls every five. A run that started at
 * :01:03 is 4m57s old at the :06:00 tick — three seconds short — so it was
 * skipped, and the agent that promised five minutes ran every ten, with
 * nothing anywhere saying so. Ticks land within seconds of their minute; this
 * absorbs that and nothing more: at most a minute, and never more than a fifth
 * of the cadence, so a one-minute agent cannot be run twice in a tick's time.
 */
export function dueGraceMs(frequencyMs: number): number {
  return Math.min(60_000, Math.floor(frequencyMs / 5))
}
