/**
 * THE TEN-STEP EXECUTION LOOP.
 *
 *   1. LOAD      → spec + every active subscriber config, under a lock
 *   2. FETCH     → declared sources, once per agent, with timeout and retry
 *   3. NORMALIZE → raw into a typed State
 *   4. GUARD     → if anything is wrong, log an error run and EXIT before diff
 *   5. DIFF      → curr against prev
 *  5b. ENRICH    → optional, once per agent, on the new items only
 *   6. MATCH     → per subscriber, against the shared State
 *   7. DEDUPE    → drop keys already sent inside the cooldown
 *   8. ENQUEUE   → write alerts, status pending
 *   9. PERSIST   → save curr as prev, only on an ok run
 *  10. LOG       → the run record an operator reads at 2am
 *
 * Every exit path from step 4 onward goes through `finish`, which writes the
 * run record and releases the lock. There is no path that produces an alert
 * without having passed the guard, and that is the property the whole file is
 * arranged to make obvious.
 *
 * Step 5b sits where it does for a reason. It is after the diff so it only ever
 * sees what is new, and before match so every subscriber shares one enriched
 * snapshot. Move it inside the per-subscriber loop and an agent with a thousand
 * subscribers pays a thousand times for one translation.
 *
 * Delivery is not here. Alerts are written and a separate worker drains them —
 * a slow SMS API must not delay the next poll.
 */

import { AgentError, classifyError, type FailureKind } from './errors.ts'
import { backoffDelayMs, consecutiveFailuresFrom, isDegraded, isDue } from './backoff.ts'
import { applyCooldown, capPerUser, dedupeWithinRun, parseDuration, validateAlerts } from './dedupe.ts'
import { diffStates, type StateDiff } from './diff.ts'
import { createSourceFetch, type Transport } from './fetcher.ts'
import { guard, guardPolicyFromSpec } from './guard.ts'
import { isComparable, sourceFingerprint } from './fingerprint.ts'
import { createLimiterPool } from './rate-limit.ts'
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_ENRICH_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  LOCK_TTL_SECONDS,
  MAX_ALERTS_PER_AGENT_PER_RUN,
  MAX_ALERTS_PER_USER_PER_RUN,
  MAX_ENRICH_PER_RUN,
  MAX_EVENTS_PER_AGENT_PER_RUN,
  MAX_QUARANTINE_ROWS,
} from './limits.ts'
import type { AgentRegistry } from './registry.ts'
import { resolveSchedule } from './schedule.ts'
import { consoleNotifier, type AdminNotifier, type RuntimeStore } from './store.ts'
import type {
  Alert,
  AgentContext,
  AgentLogger,
  AgentModule,
  AgentSpec,
  ModelCall,
  ModelReply,
  ModelRequest,
  PendingAlert,
  RunStatus,
  State,
  StateItem,
  Subscriber,
} from './types.ts'
import { ModelBudgetError } from './types.ts'

/**
 * The platform's side of `ctx.model`: the key, the price and the meter. The
 * loop never holds a key or a price itself — tests inject a fake, production
 * injects lib/runtime/model-gateway.ts.
 */
export interface ModelGateway {
  /** Dollars this agent's model calls have cost the platform this calendar month. */
  spentThisMonth(agentId: string): Promise<number>
  /** The agent's monthly budget in dollars. */
  budgetFor(agentId: string): number
  /** One call, recorded against the agent. */
  call(args: { agentId: string; model: string; request: ModelRequest; maxTokens: number; signal: AbortSignal }): Promise<ModelReply>
}

export interface RuntimeDeps {
  store: RuntimeStore
  registry: AgentRegistry
  notifier?: AdminNotifier
  /** Present in production; absent in the offline harness, where ctx.model is simply not offered. */
  model?: ModelGateway
  /** Injected so tests and the fixture harness never touch the network. */
  transport?: Transport
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface RunOptions {
  /** Run even if the agent is not due or is out of season. */
  force?: boolean
  /** Shadow mode: alerts are written suppressed and never delivered (AGENT-SPEC §Publish). */
  shadow?: boolean
  /** 'ignore' only when replaying fixtures offline. */
  robots?: 'enforce' | 'ignore'
}

export interface RunResult {
  agentId: string
  status: RunStatus
  startedAt: string
  durationMs: number
  itemsSeen: number | null
  alertsProduced: number
  /** Alerts that reached the alerts table (dedupe may drop some at insert). */
  alertsWritten: number
  /**
   * Alerts that entered the delivery queue as `pending` — what a person will
   * actually receive. Zero for a shadow run and for a quarantined one, both of
   * which write suppressed rows. This is the number written to
   * runs.alerts_produced, because that column feeds silent-death detection: an
   * agent whose alerts are all deduped away IS silent, and a run record that
   * counts them would hide exactly the failure that check exists to find.
   */
  queuedForDelivery: number
  failureKind?: FailureKind
  error?: string
  warnings: string[]
  notes: string[]
  diff?: { added: number; removed: number; changed: number; baseline: boolean }
  /** Items handed to enrich() and merged back. Absent when the agent has no enrich. */
  enriched?: number
  /** True when the burst cap fired: nothing was delivered and a human is needed. */
  quarantined?: boolean
  degraded?: boolean
  nextAttemptAfterMs?: number
}

export async function runAgent(
  deps: RuntimeDeps,
  agentId: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date())
  const notifier = deps.notifier ?? consoleNotifier
  const startedAt = now()
  const started = startedAt.getTime()

  const warnings: string[] = []
  const notes: string[] = []
  const log: AgentLogger = {
    info: (m) => notes.push(m),
    warn: (m) => warnings.push(m),
  }

  /**
   * Mark the agent degraded — unless it is in a shadow window.
   *
   * `agents.status` is doing two jobs: it says where an agent is in its
   * lifecycle (`draft` → `shadow` → `live`) AND it carries a health flag
   * (`degraded`). Writing the second over the first destroys the first, and
   * then something downstream has to reconstruct it.
   *
   * That reconstruction is where the bug was. `tickShadow` put a degraded agent
   * back into `shadow` before polling — but it could only find one to put back
   * if a REQUEST in shadow pointed at it, so a first-party agent (CRITERIA §10's
   * free tier, an agent with no request behind it) dropped out of the tick set
   * the moment four polls in a row failed and never came back. Observed: during
   * a four-hour network outage `internship-radar` degraded, `ticked` went 3 → 2,
   * and its shadow window froze with nothing reporting that it had stopped —
   * a silent death occurring inside the mechanism built to catch silent deaths.
   *
   * So the status is not overwritten in shadow, and the reconstruction is not
   * needed. NOTHING ELSE CHANGES: the failures are in `runs`, the flag is on
   * `source_health`, the operator gets the same `degraded` alert on the same
   * worklist, backoff is unaffected, and the ship gate reads all three. The only
   * thing not written is the one field whose other meaning we would lose.
   */
  async function markDegraded(reason: () => Promise<void>): Promise<void> {
    if (options.shadow !== true) await deps.store.setAgentStatus(agentId, 'degraded').catch(() => {})
    await reason()
  }

  let lockToken: string | null = null
  // Declared up here because the failure path (failRun, hoisted below) reads it,
  // and a run can fail before a single item has been counted.
  let itemsSeenRaw: number | null = null

  /** The single exit. Writes the run record, releases the lock, returns. */
  const finish = async (
    partial: Omit<
      RunResult,
      'agentId' | 'startedAt' | 'durationMs' | 'warnings' | 'notes' | 'alertsWritten' | 'queuedForDelivery'
    > & { alertsWritten?: number; queuedForDelivery?: number },
  ): Promise<RunResult> => {
    const durationMs = now().getTime() - started
    const { alertsWritten = 0, queuedForDelivery = 0, ...rest } = partial
    const result: RunResult = {
      agentId,
      startedAt: startedAt.toISOString(),
      durationMs,
      warnings,
      notes,
      alertsWritten,
      queuedForDelivery,
      ...rest,
    }

    // STEP 10 — LOG. Enough context to debug a broken source at 2am.
    try {
      await deps.store.recordRun({
        agentId,
        startedAt: result.startedAt,
        durationMs,
        status: result.status,
        itemsSeen: result.itemsSeen,
        alertsProduced: result.queuedForDelivery,
        error: result.error ? `${result.failureKind ?? 'error'}: ${result.error}` : null,
      })
    } finally {
      if (lockToken) await deps.store.releaseLock(agentId, lockToken).catch(() => {})
    }

    return result
  }

  // ---------------- STEP 1 — LOAD ----------------

  const agent = await deps.store.loadAgent(agentId)
  if (!agent) {
    // No run row: runs.agent_id is a foreign key, and inventing one for an
    // agent that does not exist would fail anyway. The caller gets the reason.
    return {
      agentId,
      status: 'skipped',
      startedAt: startedAt.toISOString(),
      durationMs: now().getTime() - started,
      itemsSeen: null,
      alertsProduced: 0,
      alertsWritten: 0,
      queuedForDelivery: 0,
      error: `no such agent: ${agentId}`,
      warnings,
      notes,
    }
  }

  const spec = agent.spec
  const schedule = resolveSchedule({
    frequency: spec.poll?.frequency ?? '1h',
    activeWindow: spec.poll?.active_window,
    timezone: spec.poll?.timezone,
    now: startedAt,
  })

  if (!options.force) {
    if (agent.status === 'disabled' || agent.status === 'draft') {
      return finish({ status: 'skipped', itemsSeen: null, alertsProduced: 0, error: `agent status is ${agent.status}` })
    }
    if (schedule.phase === 'asleep') {
      return finish({ status: 'skipped', itemsSeen: null, alertsProduced: 0, error: schedule.reason })
    }
    const recent = await deps.store.recentRuns(agentId, 10)
    const failures = consecutiveFailuresFrom(recent)
    // The last ATTEMPT, not the last row. `consecutiveFailuresFrom` has always
    // skipped over `skipped` — a skip is not an attempt — and the due
    // calculation has to apply the same rule or it feeds on its own output.
    const lastAttempt = recent.find((run) => run.status !== 'skipped')
    const lastStartedAt = lastAttempt ? new Date(lastAttempt.startedAt) : null
    if (!isDue({ lastStartedAt, consecutiveFailures: failures, frequencyMs: schedule.frequencyMs, now: startedAt })) {
      // NOT RECORDED, and this is the one skip reason that is not.
      //
      // Every other exit above says something happened: the agent is disabled,
      // it is out of season, another worker holds it. "Not due yet" says only
      // that a scheduler asked a question and arithmetic answered it. Written
      // to `runs` it is worse than noise, because three things read that table
      // and cannot tell the difference:
      //
      //   - `agent_health.uptime_7d` averages ok over ALL rows, so a healthy
      //     15-minute agent on a 1-minute cron would publish ~7% uptime.
      //   - `shadowReviews` counts runs the same way, so the ship gate's
      //     success floor would fail every agent that ever shipped.
      //   - and the row became the next tick's `lastStartedAt`, so the agent
      //     ran once and was never due again — found by pointing the real cron
      //     at a production build and watching internship-radar stop.
      //
      // The caller still gets `skipped`; nothing is hidden from whoever asked.
      return {
        agentId,
        status: 'skipped',
        startedAt: startedAt.toISOString(),
        durationMs: now().getTime() - started,
        itemsSeen: null,
        alertsProduced: 0,
        alertsWritten: 0,
        queuedForDelivery: 0,
        error: 'not due yet',
        warnings,
        notes,
      }
    }
  }

  // The advisory lock. Two workers must never run the same agent at once: they
  // would fetch twice, diff against the same prev, and alert everyone twice.
  lockToken = await deps.store.acquireLock(agentId, LOCK_TTL_SECONDS)
  if (!lockToken) {
    return finish({ status: 'skipped', itemsSeen: null, alertsProduced: 0, error: 'another worker holds this agent' })
  }

  let module: AgentModule
  try {
    module = await deps.registry.load(agentId)
  } catch (err) {
    return failRun(err)
  }

  const subscribers = await deps.store.loadSubscribers(agentId)

  /**
   * The baseline — unless the manifest has moved since it was written.
   *
   * A state produced by a different set of sources cannot be diffed against
   * one produced by this set: the items that are gone are gone because we
   * stopped asking, not because the world changed. Dropping it here makes the
   * run a first run, and a first run establishes the baseline and alerts
   * nobody. See fingerprint.ts for what counts as a different set.
   */
  const fingerprint = sourceFingerprint(spec)
  const loaded = await deps.store.loadState(agentId)
  const prev = isComparable(loaded, fingerprint) ? loaded : null
  if (loaded !== null && prev === null) {
    notes.push('the manifest changed since the last run — treating this as a new baseline rather than as items disappearing')
  }

  // ---------------- STEPS 2 & 3 — FETCH, NORMALIZE ----------------
  // Both inside one wall-clock budget, and both inside one try: a throw from
  // either is a failed run, never an empty world.

  const timeoutMs = spec.limits?.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS

  // One limiter pool for the whole run. fetch() and enrich() both reach the
  // network through ctx.fetch, and a source's declared rate limit belongs to
  // the source, not to whichever step happens to be calling it.
  //
  // IT TAKES THE INJECTED SLEEP, which it did not before and which nobody
  // noticed while every wait was theoretical. A rate limit of 6/min rarely
  // makes anything wait; a `crawl_delay` always does, and the moment one was
  // declared, `agent:test` went from about a second to two minutes ten —
  // sleeping ten real seconds between bytes read off disk. A replay has no
  // server to be polite to, and the caller that supplies the clock is the one
  // that should decide what waiting means.
  const limiters = createLimiterPool({ sleep: deps.sleep ? (ms) => deps.sleep!(ms) : undefined })

  /**
   * Agent code gets a context, never anything else. Built here rather than
   * inline because step 5b needs its own one: a model call runs on a separate,
   * longer budget than the fetch, and each step must be abortable alone.
   */
  const makeContext = (signal: AbortSignal, requestTimeoutMs: number, model?: ModelCall) => {
    const { fetch: sourceFetch, stats } = createSourceFetch({
      agentId,
      sources: spec.sources ?? [],
      transport: deps.transport,
      signal,
      log,
      robots: options.robots,
      sleep: deps.sleep,
      limiters,
      timeoutMs: requestTimeoutMs,
    })

    const ctx: AgentContext = {
      agentId,
      params: (spec.params ?? {}) as AgentContext['params'],
      now: startedAt,
      fetch: sourceFetch,
      log,
      signal,
      // The agent's own last snapshot, so a source it polls less often than it
      // runs can be carried forward instead of vanishing. `prev` is already
      // null when the manifest changed (see fingerprint.ts), which is right:
      // a carry-forward across a different source set is exactly the stale
      // comparison that reset is there to prevent.
      previous: prev,
      ...(model ? { model } : {}),
    }

    return { ctx, stats }
  }

  const controller = new AbortController()
  const budget = setTimeout(() => controller.abort(new DOMException('run budget exceeded', 'TimeoutError')), timeoutMs)

  let candidate: unknown
  try {
    const { ctx, stats } = makeContext(controller.signal, timeoutMs)

    // One fetch serves every subscriber. This call happens once per run no
    // matter how many people are subscribed — the whole cost model rests on it.
    const raw = await module.fetch(ctx)
    notes.push(`${stats.requests} source request(s)`)
    candidate = module.normalize(raw)
  } catch (err) {
    clearTimeout(budget)
    return failRun(err)
  }
  clearTimeout(budget)

  // ---------------- STEP 4 — GUARD ----------------
  // Nothing below this line runs unless the snapshot is trustworthy.

  const verdict = guard({
    outcome: 'normalized',
    candidate,
    prev,
    policy: guardPolicyFromSpec(spec.guard),
    now: startedAt,
  })

  if (!verdict.ok) {
    itemsSeenRaw = verdict.itemsSeen
    return failRun(new AgentError(verdict.message, verdict.kind), verdict.itemsSeen)
  }

  // Stamped here, once, so both saveState paths below persist it and the diff,
  // match and enrich steps all see the same object.
  let curr: State = { ...verdict.state, platform: { sourceFingerprint: fingerprint } }
  warnings.push(...verdict.warnings)
  itemsSeenRaw = verdict.itemsSeen

  // ---------------- STEP 5 — DIFF ----------------
  // Once per agent, not once per subscriber.

  const stateDiff: StateDiff = diffStates(prev, curr)
  const diffCounts = {
    added: stateDiff.added.length,
    removed: stateDiff.removed.length,
    changed: stateDiff.changed.length,
    baseline: stateDiff.baseline,
  }

  // The baseline run. The world already existed; we simply had not looked.
  // Enforced here as well as in every agent's match(), because a single agent
  // getting this wrong on launch day blasts every subscriber with everything.
  if (prev === null) {
    await deps.store.saveState(agentId, curr)
    notes.push(`baseline established with ${verdict.itemsSeen} item(s) — first run never alerts`)
    return finish({
      status: 'ok',
      itemsSeen: verdict.itemsSeen,
      alertsProduced: 0,
      alertsWritten: 0,
      diff: diffCounts,
      // Reported as zero rather than left blank: the baseline of an
      // enrich-capable agent is the run most likely to be suspected of having
      // quietly translated the source's whole back catalogue. It did not.
      enriched: module.enrich ? 0 : undefined,
    })
  }

  // ---------------- STEP 5b — ENRICH (optional) ----------------
  //
  // The one place in the loop for work that is post-diff, once-per-agent and
  // async at the same time: translation, fuzzy parsing, classification. It runs
  // AFTER the baseline branch above, so a first run never enriches — launch day
  // does not pay to translate the source's entire back catalogue. It runs on
  // diff.added only, so each item is enriched exactly once in its life: on the
  // next poll that item is in prev, not in added, and a hundred quiet polls
  // cost nothing. And it runs HERE, outside the subscriber loop below, because
  // one enriched snapshot serves everybody.

  let enriched: number | undefined
  let enrichSkipped = false

  if (module.enrich && stateDiff.added.length > 0) {
    // The cost cap. The burst cap further down counts alerts, which match()
    // produces — after enrichment has already been billed. Enrichment is the
    // only step in this loop that spends money per item, so it is checked
    // before the call, not after it. An added-set this large is a restored
    // backlog, and a backlog is never news.
    const maxEnrich = spec.limits?.max_enrich_per_run ?? MAX_ENRICH_PER_RUN
    if (stateDiff.added.length > maxEnrich) {
      await markDegraded(async () => {
        await notifier.notify({
          type: 'burst_cap',
          agentId,
          events: stateDiff.added.length,
          alerts: 0,
          limit: maxEnrich,
          sample: stateDiff.added.slice(0, 10).map((item) => item.id),
        })
      })
      return finish({
        status: 'error',
        failureKind: 'burst_cap',
        error: `enrich cap: ${stateDiff.added.length} new item(s) exceeds ${maxEnrich} — held for review, nothing enriched, nothing delivered, state not advanced`,
        itemsSeen: verdict.itemsSeen,
        alertsProduced: 0,
        diff: diffCounts,
        enriched: 0,
        quarantined: true,
      })
    }

    // THE MODEL BUDGET (2026-09-30). An agent that declares a model gets
    // ctx.model on the platform's key; once its month is spent, enrich() is
    // skipped and the run carries on — alerts still go out, without the AI
    // part, and say so. Checked before the call, like the cap above: this is
    // the step that costs money.
    const declared = spec.cost?.enrich
    const gateway = declared ? deps.model : undefined
    if (gateway && (await gateway.spentThisMonth(agentId)) >= gateway.budgetFor(agentId)) {
      enrichSkipped = true
      notes.push(`model budget for the month reached — enrich() skipped for ${stateDiff.added.length} new item(s), alerts sent without it`)
    }
  }

  if (module.enrich && stateDiff.added.length > 0 && !enrichSkipped) {
    const declared = spec.cost?.enrich
    const gateway = declared ? deps.model : undefined
    const enrichTimeoutMs = spec.limits?.enrich_timeout_ms ?? DEFAULT_ENRICH_TIMEOUT_MS
    const enrichController = new AbortController()
    const enrichBudget = setTimeout(
      () => enrichController.abort(new DOMException('enrich budget exceeded', 'TimeoutError')),
      enrichTimeoutMs,
    )

    let returned: unknown
    try {
      // ctx.model: the declared model only, output clamped, and the budget
      // re-checked before every call so a month cannot be overspent mid-run.
      // Crossing it throws ModelBudgetError — the run fails and retries, and
      // the retry takes the skip branch above.
      const model: ModelCall | undefined =
        gateway && declared
          ? async (request) => {
              if ((await gateway.spentThisMonth(agentId)) >= gateway.budgetFor(agentId)) throw new ModelBudgetError(agentId)
              const cap = Math.max(1, Math.round(Number(declared.output_tokens_per_item) * 2))
              const maxTokens = Math.min(Math.max(1, Number(request.max_tokens ?? cap)), cap)
              return gateway.call({ agentId, model: String(declared.model), request, maxTokens, signal: enrichController.signal })
            }
          : undefined
      const { ctx, stats } = makeContext(enrichController.signal, enrichTimeoutMs, model)
      // Copies, not the snapshot's own objects: agent code mutating what it was
      // handed must not edit the State behind the merge's back.
      returned = await module.enrich(stateDiff.added.map((item) => ({ ...item })), ctx)
      if (stats.requests > 0) notes.push(`${stats.requests} enrich source request(s)`)
    } catch (err) {
      clearTimeout(enrichBudget)
      // A failed enrichment is a failed run. Half-enriched data must never
      // reach match — an untranslated posting delivered as a translated one is
      // worse than silence. State is not advanced, so these items are still
      // `added` on the next poll and the work is retried, not lost.
      return failRun(err, verdict.itemsSeen)
    }
    clearTimeout(enrichBudget)

    let merged
    try {
      merged = mergeEnriched(curr, stateDiff.added, returned)
    } catch (err) {
      return failRun(err, verdict.itemsSeen)
    }

    curr = merged.state
    enriched = merged.enriched
    warnings.push(...merged.warnings)
    notes.push(`enriched ${merged.enriched} of ${stateDiff.added.length} new item(s)`)
  } else if (module.enrich) {
    // Nothing new, or the month's model budget is spent. Either way the hook
    // cost nothing this run.
    enriched = 0
  }

  // ---------------- STEP 6 — MATCH ----------------

  const cooldownSeconds = parseDuration(spec.trigger?.cooldown, DEFAULT_COOLDOWN_SECONDS)
  const active = subscribers.filter((s) => !isPaused(s, startedAt))
  const seen = await deps.store.recentDedupeKeys(
    agentId,
    active.map((s) => s.userId),
    new Date(startedAt.getTime() - cooldownSeconds * 1000).toISOString(),
  )

  /** One entry per subscriber: what they would be told, after dedupe. */
  const perUser: Array<{ subscriber: Subscriber; alerts: Alert[] }> = []
  const distinctEvents = new Set<string>()
  let matchFailures = 0
  let totalProduced = 0

  for (const subscriber of active) {
    let produced: unknown
    try {
      // Agent code receives config VALUES and nothing else. There is no user id
      // in scope here by construction (hard rule 5).
      produced = module.match(prev, curr, subscriber.config)
    } catch (err) {
      // One subscriber's config breaking match() is a bug in the agent, not a
      // reason to drop everyone else's alerts. It produces silence for them,
      // which is always the safe direction.
      matchFailures++
      warnings.push(`match() threw for one subscriber: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const { alerts, rejected } = validateAlerts(produced)
    for (const problem of rejected) {
      warnings.push(`dropped alert #${problem.index}: ${problem.reason}`)
    }

    // ---------------- STEP 7 — DEDUPE ----------------
    const withinRun = dedupeWithinRun(alerts)
    if (withinRun.dropped > 0) notes.push(`${withinRun.dropped} duplicate key(s) within one match() result`)

    const cooled = applyCooldown(
      withinRun.kept,
      seen.get(subscriber.userId) ?? new Map<string, string>(),
      startedAt,
      cooldownSeconds,
    )
    if (cooled.dropped.length > 0) {
      notes.push(`${cooled.dropped.length} alert(s) inside the ${cooldownSeconds}s cooldown`)
    }

    for (const alert of cooled.kept) distinctEvents.add(alert.dedupeKey)
    totalProduced += cooled.kept.length
    perUser.push({ subscriber, alerts: cooled.kept })
  }

  if (matchFailures > 0 && matchFailures === active.length && active.length > 0) {
    // Every subscriber failed: that is the agent, not one odd config.
    return failRun(new AgentError('match() threw for every subscriber', 'agent_error'), verdict.itemsSeen)
  }

  // ---------------- THE BURST CAP ----------------
  // A source that comes back after an outage, or a selector that starts
  // matching the whole page, produces a backlog. A backlog must never be
  // delivered as news. The run stops, a bounded sample is written suppressed so
  // a human can see what it would have said, state is NOT advanced, and the
  // agent waits.
  //
  // Measured BEFORE the per-user cap. Truncating first would hide exactly the
  // burst this check exists to catch.

  const maxEvents = spec.limits?.max_events_per_run ?? MAX_EVENTS_PER_AGENT_PER_RUN
  const maxAlerts = spec.limits?.max_alerts_per_run ?? MAX_ALERTS_PER_AGENT_PER_RUN

  if (distinctEvents.size > maxEvents || totalProduced > maxAlerts) {
    const sample: PendingAlert[] = []
    for (const { subscriber, alerts } of perUser) {
      for (const alert of alerts) {
        if (sample.length >= MAX_QUARANTINE_ROWS) break
        sample.push({ ...toPendingAlert(agentId, subscriber, alert, true), status: 'suppressed' })
      }
    }
    const written = await deps.store.enqueueAlerts(sample)
    await markDegraded(async () => {
      await notifier.notify({
        type: 'burst_cap',
        agentId,
        events: distinctEvents.size,
        alerts: totalProduced,
        limit: distinctEvents.size > maxEvents ? maxEvents : maxAlerts,
        sample: [...distinctEvents].slice(0, 10),
      })
    })
    if (totalProduced > sample.length) {
      notes.push(`${totalProduced - sample.length} further alert(s) were not even written for review`)
    }
    return finish({
      status: 'error',
      failureKind: 'burst_cap',
      error: `burst cap: ${distinctEvents.size} distinct event(s) across ${totalProduced} alert(s) exceeds the limit — held for review, nothing delivered, state not advanced`,
      itemsSeen: verdict.itemsSeen,
      alertsProduced: 0,
      alertsWritten: written,
      diff: diffCounts,
      enriched,
      quarantined: true,
    })
  }

  // The per-user cap: one subscriber's over-broad filter is their problem to
  // narrow, not a reason to hold everyone else's alerts.
  const pending: PendingAlert[] = []
  let truncatedTotal = 0
  let truncatedUsers = 0

  for (const { subscriber, alerts } of perUser) {
    const capped = capPerUser(alerts, spec.limits?.max_alerts_per_user_per_run ?? MAX_ALERTS_PER_USER_PER_RUN)
    if (capped.truncated > 0) {
      truncatedTotal += capped.truncated
      truncatedUsers++
    }
    for (const alert of capped.kept) {
      pending.push(toPendingAlert(agentId, subscriber, enrichSkipped ? withBudgetNote(alert) : alert, options.shadow === true))
    }
  }

  if (truncatedTotal > 0) {
    await notifier.notify({ type: 'alerts_truncated', agentId, users: truncatedUsers, truncated: truncatedTotal })
    warnings.push(`${truncatedTotal} alert(s) truncated across ${truncatedUsers} subscriber(s) at the per-user cap`)
  }

  // ---------------- STEP 8 — ENQUEUE ----------------
  // Write only. Delivery drains this table on its own schedule.

  const alertsWritten = pending.length > 0 ? await deps.store.enqueueAlerts(pending) : 0
  if (alertsWritten < pending.length) {
    notes.push(`${pending.length - alertsWritten} alert(s) already existed for their user (unique index)`)
  }

  // ---------------- STEP 9 — PERSIST ----------------
  // Invariant 3: agent_state is only written after an ok run.

  await deps.store.saveState(agentId, curr)

  // ---------------- STEP 10 — LOG (in finish) ----------------

  return finish({
    status: 'ok',
    itemsSeen: verdict.itemsSeen,
    alertsProduced: pending.length,
    alertsWritten,
    // A shadow run writes suppressed rows: it runs live for days and is
    // compared against reality before one alert ever reaches a person.
    queuedForDelivery: options.shadow === true ? 0 : alertsWritten,
    diff: diffCounts,
    enriched,
  })

  // ---------------- failure path ----------------

  /**
   * Every failure lands here: log an error run, count consecutive failures,
   * back off, and mark the agent degraded at four. No alert is ever produced on
   * this path — that is the whole point of it existing.
   */
  async function failRun(err: unknown, itemsSeen: number | null = itemsSeenRaw): Promise<RunResult> {
    const { kind, message } = classifyError(err)

    const recent = await deps.store.recentRuns(agentId, 10).catch(() => [])
    const failures = consecutiveFailuresFrom(recent) + 1
    const degraded = isDegraded(failures)

    if (degraded && agent && agent.status !== 'degraded') {
      await markDegraded(async () => {
        await notifier.notify({ type: 'degraded', agentId, consecutiveFailures: failures, lastError: message })
      })
    } else {
      await notifier.notify({ type: 'agent_error', agentId, kind, message })
    }

    return finish({
      status: 'error',
      failureKind: kind,
      error: message,
      itemsSeen,
      alertsProduced: 0,
      alertsWritten: 0,
      degraded,
      nextAttemptAfterMs: backoffDelayMs(failures),
    })
  }
}

/**
 * Fold enrich()'s output back into the snapshot, before match and before persist.
 *
 * Additive, and only onto items the diff already said were new. Three rules
 * have teeth here:
 *
 *   - An id that was not in `added` is DROPPED, not inserted. Everything in a
 *     State got there by passing the guard; an enrichment step that could add
 *     items would be a way around it, and a translator is not allowed to invent
 *     a job posting.
 *   - The original `id` is restored last. An enrich that rewrote one would make
 *     the item look new again on the next poll — enriched again, alerted again,
 *     forever.
 *   - Fields the returned item omits survive. Enrichment adds; it does not
 *     quietly delete the title it did not think to copy.
 *
 * Item count and id set are unchanged by construction, so the guarded snapshot
 * stays guarded and does not need re-checking.
 */
export function mergeEnriched(
  curr: State,
  added: readonly StateItem[],
  returned: unknown,
): { state: State; enriched: number; warnings: string[] } {
  const warnings: string[] = []

  if (!Array.isArray(returned)) {
    throw new AgentError('enrich() must return an array of StateItem', 'agent_error')
  }

  const allowed = new Set(added.map((item) => item.id))
  const patches = new Map<string, StateItem>()

  returned.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`enrich() returned a non-object at #${index}`)
      return
    }
    const item = entry as StateItem
    if (typeof item.id !== 'string' || item.id === '') {
      warnings.push(`enrich() returned an item without an id at #${index}`)
      return
    }
    if (!allowed.has(item.id)) {
      warnings.push(`enrich() returned "${item.id}", which was not in diff.added — dropped`)
      return
    }
    if (patches.has(item.id)) {
      warnings.push(`enrich() returned "${item.id}" twice — the first result is kept`)
      return
    }
    patches.set(item.id, item)
  })

  if (patches.size === 0) return { state: curr, enriched: 0, warnings }

  const items = curr.items.map((item) => {
    const patch = patches.get(item.id)
    return patch ? { ...item, ...patch, id: item.id } : item
  })

  return { state: { ...curr, items }, enriched: patches.size, warnings }
}

function isPaused(subscriber: Subscriber, now: Date): boolean {
  return subscriber.pausedUntil !== null && Date.parse(subscriber.pausedUntil) > now.getTime()
}

/**
 * The platform's own sentence, on alerts sent while enrich() was skipped for
 * budget: the subscriber is told why the alert is plainer than usual, and
 * that it is temporary. The agent does not write it and cannot remove it.
 */
export const BUDGET_NOTE = "(AI details are paused until the 1st — this agent reached its monthly budget.)"

function withBudgetNote(alert: Alert): Alert {
  return { ...alert, body: `${alert.body} ${BUDGET_NOTE}` }
}

function toPendingAlert(agentId: string, subscriber: Subscriber, alert: Alert, shadow: boolean): PendingAlert {
  return {
    agentId,
    userId: subscriber.userId,
    dedupeKey: alert.dedupeKey,
    priority: alert.priority,
    title: alert.title,
    body: alert.body,
    actionUrl: alert.actionUrl ?? null,
    // Shadow runs write suppressed rows: the agent runs live for days and is
    // compared against reality before one alert ever reaches a person.
    status: shadow ? 'suppressed' : 'pending',
  }
}

/** Exported for the harness and for tests that want the spec's effective knobs. */
export function effectiveLimits(spec: AgentSpec) {
  return {
    maxEvents: spec.limits?.max_events_per_run ?? MAX_EVENTS_PER_AGENT_PER_RUN,
    maxAlerts: spec.limits?.max_alerts_per_run ?? MAX_ALERTS_PER_AGENT_PER_RUN,
    maxPerUser: spec.limits?.max_alerts_per_user_per_run ?? MAX_ALERTS_PER_USER_PER_RUN,
    timeoutMs: spec.limits?.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS,
    cooldownSeconds: parseDuration(spec.trigger?.cooldown, DEFAULT_COOLDOWN_SECONDS),
  }
}

export type { State }
