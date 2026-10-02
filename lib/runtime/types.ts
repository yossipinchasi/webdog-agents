/**
 * The frozen agent interface.
 *
 * Sessions 5 and 6 build against this file. Changing a signature here breaks
 * every agent in the catalogue, so treat it as a public API: add optional
 * fields, never rename or remove.
 *
 * The three functions an agent implements are `fetch`, `normalize`, `match`,
 * plus an optional fourth, `enrich`, for post-diff work that is expensive and
 * asynchronous. Nothing else. Everything below exists to describe their inputs
 * and outputs.
 *
 * Isolation rules these types encode (ARCHITECTURE.md §Isolation model):
 *   - An agent receives an AgentContext and a UserConfig. Never a DB client,
 *     never process.env, never a user record, never a subscriber list.
 *   - ctx.fetch is the only network access, and it enforces the source
 *     allowlist declared in agent.yaml.
 *   - match() receives ONE user's config values at a time and nothing that
 *     identifies them. There is no user id in UserConfig by construction.
 *   - match() returns Alert[]. It never sends anything. The platform delivers.
 *   - enrich() receives items, never a subscriber. It runs once per run for the
 *     whole agent, like fetch — not once per subscriber. That is not a
 *     performance note: enrichment is the expensive call, and running it per
 *     subscriber would multiply its cost by the subscriber count and destroy
 *     the one-fetch-serves-everyone economics the whole runtime is built on.
 */

// ---------- JSON ----------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// ---------- State: the shared, comparable shape ----------

/**
 * One thing the agent watches: a course section, a job posting, an appointment
 * slot, a single tracked number.
 *
 * `id` must be stable across runs and unique within a State. The platform diffs,
 * dedupes and guards on it — an unstable id means every run looks like the whole
 * world changed, and a duplicate id means the diff silently loses an item, so
 * the guard rejects both.
 */
export interface StateItem {
  id: string
  [field: string]: JsonValue | undefined
}

/**
 * The output of normalize(): one snapshot of the world, shared by every
 * subscriber. There is exactly one State per agent per run — this is what keeps
 * the marginal cost of subscriber N+1 at approximately zero.
 */
export interface State {
  items: StateItem[]
  /** ISO 8601. When the snapshot was taken, per the agent (use ctx.now). */
  fetchedAt: string
  /** Anything agent-specific that isn't an item: totals, term, page hash. */
  meta?: JsonObject
  /**
   * Platform-owned. Stamped on the way to the store, never written by an agent
   * — `validateState` rebuilds a State from items, fetchedAt and meta alone, so
   * anything normalize() puts here is dropped before it can be persisted.
   *
   * `sourceFingerprint` is how the next run knows whether this snapshot came
   * from the same set of sources it is about to fetch. See fingerprint.ts.
   */
  platform?: { sourceFingerprint?: string }
}

// ---------- Alerts: what an agent returns ----------

export type AlertPriority = 'urgent' | 'normal'

/**
 * What the agent asks the platform to tell one user.
 *
 * `dedupeKey` is mandatory (hard rule 7). The platform drops repeats within the
 * cooldown window and the `alerts` unique index makes (user, agent, key) a
 * once-ever guarantee — so a key for a repeatable event must carry a cycle
 * discriminator. See dedupe.ts §scopedDedupeKey.
 */
export interface Alert {
  dedupeKey: string
  priority: AlertPriority
  title: string
  body: string
  actionUrl?: string
}

// ---------- The context handed to fetch() ----------

/**
 * Fetch one declared source. `sourceId` must match a `sources[].id` in
 * agent.yaml; `params` fill the `{placeholders}` in that source's url template.
 * Anything else — an undeclared source, a host swapped in through a param, a
 * redirect that leaves the allowlist — throws. See fetcher.ts.
 */
export type SourceFetch = (
  sourceId: string,
  params?: Record<string, string | number>,
) => Promise<unknown>

/**
 * Warnings and notes from inside agent code. Captured into the run record.
 * Deliberately not a route to anything external — an agent cannot log to a
 * third-party service, and it cannot alert this way either (hard rule 4).
 */
export interface AgentLogger {
  info(message: string): void
  warn(message: string): void
}

/**
 * One model call from inside enrich(). Plain text in, plain text out: the
 * platform chooses nothing about the prompt, and the agent chooses nothing
 * about the key, the model (the manifest's `cost.enrich.model`) or the bill.
 */
export interface ModelRequest {
  system?: string
  prompt: string
  /** Output cap. The platform clamps it to twice the declared output_tokens_per_item. */
  max_tokens?: number
}

export interface ModelReply {
  text: string
}

export type ModelCall = (request: ModelRequest) => Promise<ModelReply>

/** Thrown by ctx.model when the agent's month is spent. The run retries, and the retry skips enrich(). */
export class ModelBudgetError extends Error {
  constructor(agentId: string) {
    super(`${agentId}: this month's model budget is spent`)
    this.name = 'ModelBudgetError'
  }
}

export interface AgentContext {
  readonly agentId: string
  /**
   * A model, on the platform's key — present ONLY inside enrich(), and only
   * for an agent that declares `cost.enrich`. Every call is priced and
   * recorded against the agent. When the agent's monthly budget is spent,
   * enrich() is skipped for the run: write match() so an item without its
   * enrichment still makes a sensible alert (docs/BUILDERS.md).
   */
  readonly model?: ModelCall
  /** `params` from agent.yaml. Config, never code — adding a firm is an edit here. */
  readonly params: Readonly<JsonObject>
  /** Injected clock. Agents must not call Date.now() — it makes them untestable. */
  readonly now: Date
  readonly fetch: SourceFetch
  readonly log: AgentLogger
  /** Aborted when the run exceeds its wall-clock budget. */
  readonly signal: AbortSignal
  /**
   * The last snapshot this agent persisted, or null on a baseline run.
   *
   * WHY fetch() can see it. A source may be rate-limited far below the agent's
   * poll frequency — The Trackr allows **10 requests a day** against an agent
   * that runs every fifteen minutes — and the only honest way to hold both is
   * to fetch that source occasionally and carry its items forward in between.
   * Carrying forward is impossible without knowing what was there, and
   * normalize() is pure and must stay that way, so the knowledge belongs here.
   *
   * Without it the alternative is worse than it looks: a slow source's items
   * vanish from State on 95 runs out of 96, and every one of them looks brand
   * new the moment it comes back. That is a mass false alert, which is the one
   * failure this runtime is built around.
   *
   * SAFE TO EXPOSE. A State contains postings, not people — no subscriber, no
   * config, no identity — so hard rule 5 is untouched. It is the agent's own
   * previous output handed back to it.
   */
  readonly previous: State | null
}

/**
 * One subscriber's answers to the agent's `user_config` form. Values only.
 * There is no user id, email, phone or channel here, and there never will be:
 * builder code never sees user identity (hard rule 5).
 */
export type UserConfig = Readonly<JsonObject>

// ---------- The module every agent exports ----------

export interface AgentModule<S extends State = State> {
  /**
   * 1. FETCH — call declared sources through ctx.fetch. One fetch serves every
   * subscriber; never fetch per-user. Throw if every source failed: the runtime
   * logs an error run and never reaches diff.
   */
  fetch(ctx: AgentContext): Promise<unknown>

  /**
   * 2. NORMALIZE — pure. Parse raw into a stable comparable State.
   * Throw on malformed input. NEVER return an empty State to "handle" a parse
   * failure: an empty State that reaches diff looks exactly like "every item
   * was taken down."
   */
  normalize(raw: unknown): S

  /**
   * 3. ENRICH — OPTIONAL. Post-diff, once-per-agent, asynchronous work.
   *
   * The only place in the interface where all three of those are true at once.
   * `normalize` is pure and synchronous, so it cannot translate a posting or
   * ask a model to classify one; `match` is pure, synchronous and runs per
   * subscriber, so it cannot either — and could not afford to. Translation,
   * fuzzy date and salary parsing, and classification all have exactly this
   * shape, and before this hook existed they had nowhere to live.
   *
   * The platform calls it once per run, between diff and match, with
   * `diff.added` and nothing else. Not `changed`, not `removed`, not the whole
   * State. Return the same items with fields added; the platform merges the
   * result into `curr` before match sees it and before the state is persisted.
   *
   * Contract:
   *   - Called with the NEW items only, so an item is enriched once in its
   *     life. It is in `curr` on the next poll, not in `added`, so a hundred
   *     quiet polls cost nothing. Cost tracks changes, never poll frequency.
   *   - NEVER called on a baseline run: `prev === null` returns before this
   *     point, so launch day does not enrich the source's entire back
   *     catalogue.
   *   - NEVER called per subscriber. It does not receive a UserConfig and
   *     never will — the same enriched State serves all of them.
   *   - Return one entry per item you enriched, each carrying the `id` it came
   *     in with. Unknown ids are dropped: enrich adds fields to items that got
   *     past the guard, it does not smuggle new ones in behind it.
   *   - Items you leave out come through unenriched. Returning `added`
   *     untouched is always valid.
   *   - Throwing fails the run. Nothing is delivered and the state is not
   *     advanced, so the same items are still `added` on the next poll and are
   *     retried. Half-enriched data must never reach match: a translation that
   *     silently failed reads as a posting in a language the user never asked
   *     for, and they unsubscribe.
   *   - Network still goes through `ctx.fetch` and the manifest allowlist. A
   *     model endpoint is a declared source like any other.
   */
  enrich?(added: StateItem[], ctx: AgentContext): Promise<StateItem[]>

  /**
   * 4. MATCH — pure. What changed, and should THIS user hear about it?
   * `prev === null` must return [] (first run establishes the baseline). The
   * platform enforces that too, but the rule lives here.
   */
  match(prev: S | null, curr: S, config: UserConfig): Alert[]
}

// ---------- The manifest (parsed agent.yaml) ----------

export type SourceType = 'http_json' | 'http_html' | 'rss' | 'api'
export type SourceTier = 'cooperative' | 'indifferent' | 'adversarial'

export interface SourceSpec {
  id: string
  type: SourceType
  /** Template. `{placeholders}` are filled from params — never in the host. */
  url: string
  /** MUST be 'none' in v1. We never store a credential (hard rule 1). */
  auth?: 'none'
  /** e.g. '60/min', '30/min', '1/s'. Enforced globally, not per subscriber. */
  rate_limit?: string
  /**
   * A MINIMUM GAP BETWEEN TWO REQUESTS, which is not the same promise as a
   * rate. `robots.txt` says `Crawl-delay: 10`, and a token bucket of 6/min
   * honours that in the aggregate while still firing all six inside one
   * second — which is exactly what a crawl delay asks you not to do.
   *
   * columbia-study-rooms declared `rate_limit: 6/min` with a comment saying it
   * was "exactly the ten seconds asked for". It was not: its five library
   * grids went out in about a second, every poll, at a source whose tier is
   * `cooperative` precisely because its operator asked politely rather than
   * blocking us. Declare `crawl_delay: 10s` and the runtime spaces them.
   *
   * Applies alongside `rate_limit`, never instead of it: whichever waits
   * longer wins.
   */
  crawl_delay?: string
  tier: SourceTier
  /**
   * GET unless declared otherwise. POST exists for the one shape of public
   * endpoint that needs it — Workday's careers search takes its query as a
   * JSON body — and for nothing else: the body is a literal declared here,
   * never interpolated, and the host rule is exactly what it is for GET.
   */
  method?: 'GET' | 'POST'
  /**
   * A short allowlist of headers that say WHERE a request came from or WHAT
   * answer is wanted — never WHO is making it.
   *
   * Hotlink protection is the reason: Columbia's study room grid answers 403
   * "Invalid Referrer" without a same-site `Referer`, and it is a completely
   * public endpoint. Only `referer`, `origin`, `accept`, `accept-language` and
   * `x-requested-with` may be set; anything that could carry a credential is
   * refused both at review and again in the fetcher, because hard rule 1 is
   * not a thing to enforce in one place.
   */
  headers?: Record<string, string>
  /** The literal JSON body a POST sends. Declared, reviewed, and never built from params. */
  body?: JsonObject
  /**
   * Dollars one call to this source costs the platform, for a paid API. Absent
   * means free. Read by the submission gate's cost estimate, never at runtime.
   */
  cost_per_call_usd?: number
  /** How many times one run calls this source (five library grids = 5). Default 1. */
  calls_per_run?: number
}

/**
 * What an agent's model use costs, declared so the gate can estimate it
 * before it ships. Required when the agent exports `enrich()`.
 */
export interface CostSpec {
  enrich?: {
    /** A model id from lib/cost/prices.ts. */
    model: string
    input_tokens_per_item: number
    output_tokens_per_item: number
    /** Expected new items a month that reach enrich(). The worst case is computed too. */
    items_per_month: number
  }
}

export interface PollSpec {
  /** '60s', '15m', '1h'. */
  frequency: string
  /** Named season. Out of season an agent drops to a heartbeat or sleeps. */
  active_window?: string
  timezone?: string
  /**
   * ISO instant the current `frequency` took effect. The shadow latency check
   * judges only runs from then on — runs made under an earlier cadence cannot
   * speak to this one's promise — and says in its evidence how many it set
   * aside, so the exclusion is read by whoever judges, never silent.
   */
  cadence_since?: string
}

export interface TriggerSpec {
  condition?: string
  dedupe_key?: string
  /** '300s', '86400s'. Platform-enforced. */
  cooldown?: string
}

export interface GuardPolicySpec {
  /** Only ever true for a source where zero items is genuinely normal. */
  allow_empty_state?: boolean
  /** Fraction of items that may vanish in one run before we call it an outage. */
  max_drop_ratio?: number
  min_items_for_drop_check?: number
}

export interface LimitsSpec {
  max_alerts_per_run?: number
  max_events_per_run?: number
  max_alerts_per_user_per_run?: number
  /** Wall-clock budget for fetch + normalize. */
  timeout_ms?: number
  /**
   * Items one run may hand to enrich(). More added items than this is a
   * backlog, not news — the run is quarantined BEFORE the money is spent.
   */
  max_enrich_per_run?: number
  /** Wall-clock budget for enrich(), separate because a model call is slow. */
  enrich_timeout_ms?: number
}

export interface AgentSpec {
  id: string
  name: string
  /**
   * `on_demand` is an agent a person uses by asking — the Resy Booker chat —
   * rather than one that polls. It is listed, claimed and credited like any
   * other agent, and the scheduler and the polling health check skip it:
   * it has nothing to poll, so never running is correct, not a fault.
   * Absent means `scheduled`, which is every agent before 2026-09-30.
   */
  kind?: 'scheduled' | 'on_demand'
  /** For an `on_demand` agent: the page where it is used, e.g. "/resy". */
  app_url?: string
  /** Model and paid-source spend, declared for the gate's estimate. */
  cost?: CostSpec
  tagline?: string
  category?: string
  pattern: string
  region?: string
  claude_cant_axes: string[]
  sources: SourceSpec[]
  params?: JsonObject
  poll: PollSpec
  trigger?: TriggerSpec
  guard?: GuardPolicySpec
  limits?: LimitsSpec
  alert?: { priority?: AlertPriority; title?: string; body?: string; action_url?: string }
  [extra: string]: unknown
}

// ---------- Platform-side types ----------

/** One row of agent_subscriptions, minus everything agent code may not see. */
export interface Subscriber {
  /** agent_subscriptions.id — the platform's handle, never passed to match(). */
  subscriptionId: string
  userId: string
  config: UserConfig
  channels: string[]
  pausedUntil: string | null
}

/** An Alert plus the routing the platform added after match() returned. */
export interface PendingAlert {
  agentId: string
  userId: string
  dedupeKey: string
  priority: AlertPriority
  title: string
  body: string
  actionUrl: string | null
  status: 'pending' | 'suppressed'
}

export type RunStatus = 'ok' | 'error' | 'skipped'

export interface RunRecord {
  agentId: string
  startedAt: string
  durationMs: number
  status: RunStatus
  itemsSeen: number | null
  alertsProduced: number
  error: string | null
}
