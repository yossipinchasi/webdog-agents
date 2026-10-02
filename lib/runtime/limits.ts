import type { AgentSpec } from './types.ts'

/**
 * Platform limits. Every one of these is a circuit breaker, not a tuning knob.
 *
 * The numbers are deliberately conservative: an agent that stops early and asks
 * a human costs us one late alert, and an agent that blasts every subscriber
 * costs us the platform's credibility. Those are not the same mistake.
 */

/**
 * Distinct events (distinct dedupe keys) one run may produce before the run is
 * quarantined. This is the cap that actually fires: a source that comes back
 * after an outage, or a selector that starts matching the whole page, produces
 * hundreds of "new" things at once. A healthy watcher produces a handful.
 */
export const MAX_EVENTS_PER_AGENT_PER_RUN = 25

/**
 * Absolute ceiling on alert rows written by one run, across all subscribers.
 * Legitimately large: one real event on an agent with 4,000 subscribers is
 * 4,000 rows and that is fine. This catches fan-out arithmetic going wrong.
 */
export const MAX_ALERTS_PER_AGENT_PER_RUN = 5000

/**
 * Per-subscriber ceiling for one run. Exceeding it usually means that user's
 * filter is too broad, not that the source broke — so we truncate their alerts
 * and tell the admin, rather than quarantining everyone else's.
 */
export const MAX_ALERTS_PER_USER_PER_RUN = 10

/**
 * Wall-clock budget for fetch + normalize, unless the manifest lowers it.
 *
 * 45s, NOT 60s, AND THE DIFFERENCE IS THE REST OF THE RUN. This was 60s — the
 * same number as the serverless invocation that contains it — which is a
 * budget no agent could ever spend: the diff, match across every subscriber,
 * the enqueue and the writes all happen after fetch returns and inside the
 * same 60 seconds. An agent on the default did not abort its fetch at the
 * budget and carry on; it was killed by the platform partway through, which
 * loses the run record too.
 *
 * Chosen against CRON_FUNCTION_MAX_SECONDS below, and they move together.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 45_000

/**
 * Items one run may hand to enrich(). The burst cap upstream of it counts
 * alerts, which are produced by match — after enrich has already been paid for.
 * Enrichment is the only step in the loop that costs real money per item, so it
 * gets its own cap, checked before the call rather than after it.
 *
 * Set just above MAX_EVENTS_PER_AGENT_PER_RUN: an added-set larger than the
 * number of events a healthy run may produce is the same backlog condition, one
 * step earlier, and is quarantined the same way.
 */
export const MAX_ENRICH_PER_RUN = 30

/**
 * Wall-clock budget for enrich(), separate from the fetch budget because a
 * model call is slow in a way an HTTP GET is not, and one shared timeout would
 * either strangle enrichment or let a dead source hold the lock for minutes.
 */
export const DEFAULT_ENRICH_TIMEOUT_MS = 120_000

/** Per-request timeout inside ctx.fetch. */
export const DEFAULT_SOURCE_TIMEOUT_MS = 15_000

/** Retries per source request. Retried failures are transport-level only. */
export const DEFAULT_SOURCE_RETRIES = 2

/** Response body ceiling. A source that hands us 50MB has already gone wrong. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Redirect hops ctx.fetch will follow, each re-checked against the allowlist. */
export const MAX_REDIRECTS = 3

/** How long one worker may hold an agent's lock before the lease expires. */
export const LOCK_TTL_SECONDS = 300

/**
 * Slack between the budgets a manifest may declare and the lock's lease.
 *
 * The declared budgets cover fetch and enrich. Everything else in a run — the
 * load, the diff, match across every subscriber, the enqueue, the state write,
 * the run record — happens outside them and still inside the lease.
 */
export const LOCK_BUDGET_MARGIN_SECONDS = 60

/**
 * The wall clock the run actually dies on.
 *
 * THE LOCK IS 300s AND THE FUNCTION IS 60s, and for a long time only the first
 * was checked. `maxDuration = 60` on app/api/cron/{run,shadow} is Vercel's
 * ceiling on a serverless invocation, and it is five times tighter than the
 * lease: a manifest declaring `timeout_ms: 120000` fits inside the lock with
 * room to spare and is killed by the platform every single run.
 *
 * It is not a number we choose. Raising it means Vercel Pro, and then this
 * constant and the `maxDuration` on each cron route move together or not at
 * all.
 */
export const CRON_FUNCTION_MAX_SECONDS = 60

/**
 * What the run needs after fetch returns: the diff, match across every
 * subscriber, the enqueue, the state write, the run record.
 */
export const CRON_FUNCTION_MARGIN_SECONDS = 10

/** Consecutive failed runs before the agent is marked degraded. */
export const DEGRADED_AFTER_FAILURES = 4

/** Default cooldown when the manifest does not set one. */
export const DEFAULT_COOLDOWN_SECONDS = 86_400

/** Honest User-Agent with a contact URL. We are a good citizen; it is cheaper. */
export const USER_AGENT =
  'WatchtowerBot/1.0 (+https://watchtower.app/bot; agent monitoring on behalf of subscribers)'

/**
 * Alert rows written for review when the burst cap fires. Bounded: a burst on
 * an agent with thousands of subscribers must not turn into a table scan's
 * worth of suppressed rows. The admin event carries the true totals.
 */
export const MAX_QUARANTINE_ROWS = 500

/**
 * THE LEASE INVARIANT: fetch budget + enrich budget < the lock's TTL.
 *
 * A run that outlives its lease does not fail. It keeps going while a second
 * worker, seeing an expired lock, starts the same agent: two fetches, two
 * diffs against the same prev, every subscriber alerted twice, and a race on
 * which snapshot gets persisted as prev. It surfaces only under load and is
 * near-impossible to reproduce afterwards, because by then both runs have
 * finished and the state looks plausible.
 *
 * Nothing about a raised timeout looks dangerous at the moment it is raised,
 * which is exactly why this is a check and not a comment. Manifests are the
 * part of the system that changes most often and gets reviewed least.
 *
 * The enrich budget counts even for an agent that has no enrich function: a
 * manifest cannot know what index.ts exports, and the safe direction is a loud
 * rejection at load rather than a lease expiring in production.
 */
export function assertLeaseBudget(spec: AgentSpec): void {
  const fetchMs = spec.limits?.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS
  const enrichMs = spec.limits?.enrich_timeout_ms ?? DEFAULT_ENRICH_TIMEOUT_MS

  /**
   * A CRAWL DELAY IS TIME THE RUN SPENDS DOING NOTHING, and it has to be
   * budgeted like any other. `crawl_delay: 10s` on a source the agent fetches
   * five ways is forty seconds of deliberate waiting before a single byte of
   * the fifth response arrives.
   *
   * ONE DELAY PER DECLARED SOURCE IS WHAT CAN BE COUNTED HERE, and it is a
   * floor rather than the true cost: how many ways a templated URL expands is
   * decided by the agent's own fetch() against its params, and a manifest
   * cannot be read for it. The real guard against the long tail is the run
   * deadline, which fails the run cleanly and — hard rule 6 — alerts nobody.
   * This catches the manifest that cannot possibly fit even once.
   */
  const spacingMs = (spec.sources ?? []).reduce((total, source) => {
    const delay = parseDelayMs((source as { crawl_delay?: string }).crawl_delay)
    return total + (delay ?? 0)
  }, 0)

  const declaredMs = fetchMs + enrichMs + spacingMs
  const availableMs = (LOCK_TTL_SECONDS - LOCK_BUDGET_MARGIN_SECONDS) * 1000

  if (declaredMs > availableMs) {
    throw new Error(
      `agent "${spec.id}" declares budgets that outlive its lock: ` +
        `timeout_ms ${fetchMs / 1000}s + enrich_timeout_ms ${enrichMs / 1000}s` +
        (spacingMs > 0 ? ` + ${spacingMs / 1000}s of declared crawl delay` : '') +
        ` = ${declaredMs / 1000}s, ` +
        `which exceeds ${availableMs / 1000}s (LOCK_TTL_SECONDS ${LOCK_TTL_SECONDS}s ` +
        `minus a ${LOCK_BUDGET_MARGIN_SECONDS}s margin for the rest of the run). ` +
        `A run that outlives its lease lets a second worker start the same agent: ` +
        `duplicate alerts for every subscriber, and a race on which snapshot is persisted. ` +
        `Lower the budgets, or raise LOCK_TTL_SECONDS deliberately and together.`,
    )
  }

  /**
   * AND THE TIGHTER CEILING, which is the one runs actually die on. The lock
   * gives 240s; the serverless function gives 60. Checking only the lock let a
   * manifest declare a fetch budget four times longer than the invocation that
   * has to contain it.
   */
  const invocationMs = (CRON_FUNCTION_MAX_SECONDS - CRON_FUNCTION_MARGIN_SECONDS) * 1000
  if (fetchMs > invocationMs) {
    throw new Error(
      `agent "${spec.id}" declares timeout_ms ${fetchMs / 1000}s, which cannot fit in the cron ` +
        `invocation that runs it: ${CRON_FUNCTION_MAX_SECONDS}s minus a ${CRON_FUNCTION_MARGIN_SECONDS}s ` +
        `margin for the diff, the match and the writes. The lock's lease is not the binding limit here — ` +
        `the function is, and it kills the run rather than failing it. Lower timeout_ms.`,
    )
  }

  if (spacingMs > fetchMs) {
    throw new Error(
      `agent "${spec.id}" declares ${spacingMs / 1000}s of crawl delay inside a ${fetchMs / 1000}s fetch budget. ` +
        `The delay is time the fetch spends waiting, so the budget has to contain it — and this counts ONE ` +
        `delay per declared source, which is a floor: a templated URL fetched five ways costs five. ` +
        `Raise timeout_ms, or lower crawl_delay if the source did not ask for it.`,
    )
  }
}

/**
 * '10s', '500ms', '1m' — the same grammar `parseCrawlDelay` reads.
 *
 * Duplicated rather than imported because limits.ts is the module every other
 * runtime file depends on, and pointing it at rate-limit.ts would make that
 * cycle. An unreadable value returns null here: this function budgets, and
 * refusing a malformed manifest is `parseCrawlDelay`'s job, on the path that
 * actually has to obey it.
 */
function parseDelayMs(spec: string | undefined): number | null {
  if (!spec) return null
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|second|m|min|minute)$/i.exec(spec.trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  const ms = unit === 'ms' ? value : unit.startsWith('s') ? value * 1000 : value * 60_000
  return ms > 0 ? ms : null
}
