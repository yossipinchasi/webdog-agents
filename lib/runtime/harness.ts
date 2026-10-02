/**
 * The fixture harness — `agent:record` and `agent:test`.
 *
 * `agent:record` hits the real sources once and writes what came back to
 * /agents/<id>/fixtures. `agent:test` replays those bytes through the SAME
 * execution loop a production run uses, with a transport that throws on any URL
 * it does not have on disk. Fully offline: if the test passes on a plane, the
 * agent's logic is genuinely deterministic.
 *
 * Running the real loop rather than calling the three functions directly is the
 * point. It means the guard, the baseline rule, dedup and the burst cap are all
 * exercised by every agent's test run, not just by the runtime's own tests.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createSourceFetch, type Transport } from './fetcher.ts'
import { assertLeaseBudget } from './limits.ts'
import { runAgent, type RunResult } from './loop.ts'
import { createMemoryStore, createRecordingNotifier } from './store-memory.ts'
import { createStaticRegistry } from './registry.ts'
import { parseYaml } from './spec-yaml.ts'
import type { AgentContext, AgentModule, AgentSpec, SourceSpec, State, Subscriber, UserConfig } from './types.ts'

export interface RecordedResponse {
  sourceId: string
  url: string
  status: number
  contentType: string | null
  body: string
}

export interface FixtureBundle {
  agentId: string
  name: string
  recordedAt: string
  responses: RecordedResponse[]
}

// ---------- loading a spec ----------

export async function loadSpec(agentDir: string): Promise<AgentSpec> {
  const text = await readFile(`${agentDir}/agent.yaml`, 'utf8')
  const parsed = parseYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${agentDir}/agent.yaml did not parse to a mapping`)
  }
  const spec = parsed as unknown as AgentSpec
  // Schema checks go here, at load, where a bad manifest stops before it can
  // reach a worker. The lease invariant is the first of them: budgets that sum
  // past the lock's TTL are how one agent ends up running twice.
  assertLeaseBudget(spec)
  return spec
}

// ---------- recording ----------

/**
 * Wrap a real transport so every response is kept verbatim.
 *
 * Verbatim matters: the bug we most need a fixture for is the day the source
 * returns a login page with a 200, and a prettified or re-serialised copy would
 * no longer reproduce it.
 */
/**
 * Which declared source a URL belongs to, by matching it against each source's
 * URL template with the placeholders widened. The old rule — "the first source
 * id that is a substring of the URL" — labelled every Workday response
 * `mastodon-tag-aliyah` in one agent and every response after the first with
 * the first id in another. Replay never cared (it matches on URL); the check
 * below does, because it counts responses per declared source.
 */
export function sourceIdForUrl(sources: readonly SourceSpec[], url: string): string | null {
  for (const source of sources) {
    const pattern = source.url
      .split(/\{[a-z_]+\}/i)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/?&#]+')
    if (new RegExp(`^${pattern}$`).test(url)) return source.id
  }
  return null
}

export function createRecordingTransport(
  inner: Transport,
  sink: RecordedResponse[],
  sourceIdFor: (url: string) => string,
): Transport {
  return async (url, init) => {
    const response = await inner(url, init)
    const body = await response.clone().text()
    if (!url.endsWith('/robots.txt')) {
      sink.push({
        sourceId: sourceIdFor(url),
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
      })
    }
    return response
  }
}

export async function recordFixture(opts: {
  agentId: string
  agentDir: string
  spec: AgentSpec
  module: AgentModule
  name?: string
  now?: Date
  transport?: Transport
}): Promise<{ bundle: FixtureBundle; path: string; state: State }> {
  const now = opts.now ?? new Date()
  const responses: RecordedResponse[] = []
  const sourceIds = (opts.spec.sources ?? []).map((s) => s.id)

  const transport = createRecordingTransport(
    opts.transport ?? ((url, init) => globalThis.fetch(url, init)),
    responses,
    (url) => sourceIdForUrl(opts.spec.sources ?? [], url) ?? sourceIds.find((id) => url.includes(id)) ?? 'unknown',
  )

  const { fetch: sourceFetch } = createSourceFetch({
    agentId: opts.agentId,
    sources: opts.spec.sources ?? [],
    transport,
  })

  const ctx: AgentContext = {
    agentId: opts.agentId,
    params: (opts.spec.params ?? {}) as AgentContext['params'],
    now,
    // Recording and replay start from nothing; a carry-forward source has
    // no history in a fixture and fetches every time, which is what a
    // fixture should capture.
    previous: null,
    fetch: sourceFetch,
    log: { info: (m) => console.log(`  ${m}`), warn: (m) => console.warn(`  ! ${m}`) },
    signal: AbortSignal.timeout(60_000),
  }

  const raw = await opts.module.fetch(ctx)
  const state = opts.module.normalize(raw)

  const bundle: FixtureBundle = {
    agentId: opts.agentId,
    name: opts.name ?? 'baseline',
    recordedAt: now.toISOString(),
    responses,
  }

  const dir = `${opts.agentDir}/fixtures`
  await mkdir(dir, { recursive: true })
  const path = `${dir}/${bundle.name}.json`
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')

  return { bundle, path, state }
}

/**
 * Replay waits for nothing.
 *
 * `rate_limit` and `crawl_delay` exist to be kind to somebody else's server.
 * A replay reads bytes off disk, so there is nobody to be kind to, and making
 * a builder sit through forty seconds of deliberate politeness per run against
 * recorded fixtures would only teach them to stop running the harness.
 *
 * The SPACING IS STILL EXERCISED — the limiter runs, takes its turn and asks
 * to wait; only the waiting costs nothing. A manifest whose delay would break
 * its own budget is caught by assertLeaseBudget, not by a stopwatch here.
 */
const NO_WAIT = async () => {}

// ---------- replay ----------

/**
 * A transport with no network behind it. A URL that was never recorded throws,
 * which is what makes `agent:test` an honest offline test rather than a live
 * run wearing a costume.
 */
export function createReplayTransport(bundles: FixtureBundle[]): Transport {
  const byUrl = new Map<string, RecordedResponse>()
  for (const bundle of bundles) {
    for (const response of bundle.responses) byUrl.set(response.url, response)
  }

  return async (url) => {
    if (url.endsWith('/robots.txt')) {
      return new Response('', { status: 404 })
    }
    const recorded = byUrl.get(url)
    if (!recorded) {
      throw new Error(
        `no fixture for ${url} — record one with \`npm run agent:record <id>\`. The harness never touches the network.`,
      )
    }
    return new Response(recorded.body, {
      status: recorded.status,
      headers: recorded.contentType ? { 'content-type': recorded.contentType } : {},
    })
  }
}

/**
 * Load recorded bundles, in name order.
 *
 * Not every .json in fixtures/ is a bundle — an agent may keep sample configs
 * or notes alongside the recordings, and treating one of those as a bundle
 * fails deep inside the replay transport with a message that says nothing
 * useful. Anything without a `responses` array is skipped here instead.
 */
export async function loadFixtures(agentDir: string, names?: string[]): Promise<FixtureBundle[]> {
  const dir = `${agentDir}/fixtures`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const wanted = names ? files.filter((f) => names.includes(f.replace(/\.json$/, ''))) : files
  const bundles: FixtureBundle[] = []
  for (const file of wanted.sort()) {
    const parsed = JSON.parse(await readFile(`${dir}/${file}`, 'utf8')) as unknown
    if (!isBundle(parsed)) continue
    bundles.push(parsed)
  }
  return bundles
}

function isBundle(value: unknown): value is FixtureBundle {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { responses?: unknown }).responses)
  )
}

// ---------- the offline test run ----------

export interface HarnessCheck {
  name: string
  passed: boolean
  detail: string
}

export interface HarnessReport {
  agentId: string
  checks: HarnessCheck[]
  runs: RunResult[]
  passed: boolean
}

export interface HarnessOptions {
  agentId: string
  spec: AgentSpec
  module: AgentModule
  /** Ordered. The first is the baseline; each subsequent one is a later poll. */
  bundles: FixtureBundle[]
  /** One entry per simulated subscriber. Defaults to a single empty config. */
  subscribers?: UserConfig[]
  /**
   * The clock the replay runs at. Defaults to WHEN THE FIRST BUNDLE WAS
   * RECORDED, not to a fixed date — see the note in `testAgent`.
   */
  now?: Date
}

/**
 * Run an agent end to end against fixtures and check the properties every agent
 * must have, whatever it watches.
 *
 * THE CLOCK DEFAULTS TO THE RECORDING, and it used to default to a fixed
 * 2026-01-01. That silently excluded a whole shape of agent from ever passing
 * the gate: any agent whose REQUEST depends on the date. Columbia's room grid
 * takes `start` and `end` and answers 400 "Invalid Date" without them, so the
 * agent builds a URL containing today. Recorded on the 23rd and replayed on the
 * 1st of January, the URL no longer matched anything in the bundle, every
 * source "failed", and the harness reported the agent as broken — when what was
 * broken was the idea that a recording could be replayed at a different moment.
 *
 * A fixture is a recording of a moment. Replaying it at some other moment is
 * incoherent for anything that asks its source about "now". `recordedAt` is
 * already on every bundle; this just believes it.
 */
export async function testAgent(opts: HarnessOptions): Promise<HarnessReport> {
  const recorded = opts.bundles[0]?.recordedAt
  const fromBundle = recorded ? new Date(recorded) : null
  const now =
    opts.now ??
    (fromBundle && !Number.isNaN(fromBundle.getTime())
      ? fromBundle
      : new Date('2026-01-01T12:00:00.000Z'))
  const checks: HarnessCheck[] = []
  const runs: RunResult[] = []

  const configs = opts.subscribers ?? [{}]
  const subscribers: Subscriber[] = configs.map((config, i) => ({
    subscriptionId: `sub-${i}`,
    userId: `user-${i}`,
    config,
    channels: ['email'],
    pausedUntil: null,
  }))

  const store = createMemoryStore(
    {
      agent: { id: opts.agentId, status: 'live', spec: opts.spec },
      subscribers,
      state: null,
    },
    () => now,
  )
  const notifier = createRecordingNotifier()
  const registry = createStaticRegistry({ [opts.agentId]: opts.module })

  if (opts.bundles.length === 0) {
    checks.push({ name: 'fixtures exist', passed: false, detail: 'no fixtures — run `npm run agent:record` first' })
    return { agentId: opts.agentId, checks, runs, passed: false }
  }
  checks.push({ name: 'fixtures exist', passed: true, detail: `${opts.bundles.length} bundle(s)` })

  // --- every declared source is recorded ---
  // Agents that let boards fail one at a time (the honest design for forty
  // boards) also let a fixture that lacks most of them pass every check below:
  // the runs succeed on whatever answered. A bundle that has no response at all
  // for a declared source is not a fixture of this agent, and it says so here
  // rather than in shadow. A recorded 500 counts — that is a fixture of the
  // day the source failed, which is exactly the kind worth having.
  {
    const declared = (opts.spec.sources ?? []).map((s) => s.id)
    const recorded = new Set(
      opts.bundles[0].responses.map((r) => sourceIdForUrl(opts.spec.sources ?? [], r.url) ?? r.sourceId),
    )
    const missing = declared.filter((id) => !recorded.has(id))
    checks.push({
      name: 'every declared source is recorded',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `${declared.length} source(s), each with at least one recorded response in "${opts.bundles[0].name}"`
          : `${missing.length} of ${declared.length} declared source(s) have no recorded response in "${opts.bundles[0].name}": ${missing.join(', ')} — re-record; a fixture missing a source is not a fixture of this agent`,
    })
  }

  // --- normalize is deterministic ---
  // An id derived from an array index, a timestamp, or Math.random makes every
  // run look like the whole source changed. Catch it here, not in production.
  try {
    const transport = createReplayTransport([opts.bundles[0]])
    const { fetch: sourceFetch } = createSourceFetch({
      agentId: opts.agentId,
      sources: opts.spec.sources ?? [],
      transport,
      robots: 'ignore',
      sleep: NO_WAIT,
    })
    const ctx = (): AgentContext => ({
      agentId: opts.agentId,
      params: (opts.spec.params ?? {}) as AgentContext['params'],
      now,
      // Recording and replay start from nothing; a carry-forward source has
      // no history in a fixture and fetches every time, which is what a
      // fixture should capture.
      previous: null,
      fetch: sourceFetch,
      log: { info: () => {}, warn: () => {} },
      signal: AbortSignal.timeout(30_000),
    })
    const a = opts.module.normalize(await opts.module.fetch(ctx()))
    const b = opts.module.normalize(await opts.module.fetch(ctx()))
    const same = JSON.stringify(a.items) === JSON.stringify(b.items)
    checks.push({
      name: 'normalize is deterministic',
      passed: same,
      detail: same ? `${a.items.length} item(s), stable` : 'two passes over identical bytes produced different items — check for index-based or time-based ids',
    })
  } catch (err) {
    checks.push({ name: 'normalize is deterministic', passed: false, detail: String(err) })
  }

  // --- run 1: the baseline. Must never alert. ---
  const first = await runAgent(
    { store, registry, notifier, transport: createReplayTransport([opts.bundles[0]]), now: () => now, sleep: NO_WAIT },
    opts.agentId,
    { force: true, robots: 'ignore' },
  )
  runs.push(first)
  checks.push({
    name: 'first run establishes a baseline and never alerts',
    passed: first.status === 'ok' && first.alertsProduced === 0,
    detail: `status=${first.status} items=${first.itemsSeen} alerts=${first.alertsProduced}${first.error ? ` error=${first.error}` : ''}`,
  })

  // --- run 2: identical bytes. Must produce nothing. ---
  const second = await runAgent(
    { store, registry, notifier, transport: createReplayTransport([opts.bundles[0]]), now: () => now, sleep: NO_WAIT },
    opts.agentId,
    { force: true, robots: 'ignore' },
  )
  runs.push(second)
  checks.push({
    name: 'an unchanged source produces zero alerts',
    passed: second.status === 'ok' && second.alertsProduced === 0,
    detail: `status=${second.status} alerts=${second.alertsProduced} diff=+${second.diff?.added}/-${second.diff?.removed}/~${second.diff?.changed}`,
  })

  // --- runs 3..n: each later bundle is a real change. Report what fires. ---
  //
  // EACH AT ITS OWN MOMENT. The baseline's moment was all this used, so a later
  // fixture recorded on another day was replayed at the baseline's: an agent
  // whose request carries the date asked for the wrong day, no recorded
  // response matched, and a Sunday-night recording of Desk Finder read as
  // "every library grid failed". The same rule as above, applied per bundle —
  // unless the caller pinned `now`, which still wins everywhere.
  for (const bundle of opts.bundles.slice(1)) {
    const own = bundle.recordedAt ? new Date(bundle.recordedAt) : null
    const at = opts.now ?? (own && !Number.isNaN(own.getTime()) ? own : now)
    const run = await runAgent(
      { store, registry, notifier, transport: createReplayTransport([bundle]), now: () => at, sleep: NO_WAIT },
      opts.agentId,
      { force: true, robots: 'ignore' },
    )
    runs.push(run)
    checks.push({
      name: `fixture "${bundle.name}" runs clean`,
      passed: run.status === 'ok',
      detail: `status=${run.status} items=${run.itemsSeen} alerts=${run.alertsProduced}${run.error ? ` error=${run.error}` : ''}`,
    })
  }

  // --- every alert written carries a dedupe key (belt and braces on hard rule 7) ---
  const keyless = store.alerts.filter((a) => !a.dedupeKey || a.dedupeKey.trim() === '')
  checks.push({
    name: 'every alert carries a dedupe key',
    passed: keyless.length === 0,
    detail: `${store.alerts.length} alert(s) written, ${keyless.length} without a key`,
  })

  return { agentId: opts.agentId, checks, runs, passed: checks.every((c) => c.passed) }
}

export function formatReport(report: HarnessReport): string {
  const lines = [`agent: ${report.agentId}`, '']
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`)
    lines.push(`        ${check.detail}`)
  }
  lines.push('')
  lines.push(report.passed ? 'all checks passed' : 'FAILED')
  return lines.join('\n')
}
