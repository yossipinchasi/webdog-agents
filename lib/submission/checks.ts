/**
 * The automated checks, AGENT-SPEC.md §Publish pipeline step 2.
 *
 * Every one of them is pure: manifest in, verdict out. That is what makes them
 * runnable offline from `npm run agent:submit` on a builder's laptop, in CI, and
 * again server-side before a shadow run starts, with the same answer each time.
 *
 * The list is not arbitrary — each check is a hard rule from CLAUDE.md §6 or a
 * gate from AGENT-SPEC.md, and each one is here because the cost of finding out
 * later is measured in something other than time:
 *
 *   schema       a manifest that does not parse fails at 3am, not at submit
 *   axes         fewer than two and it should not exist (invariant 1)
 *   criteria     nothing to shadow-test against, so nothing can ever pass
 *   interface    a module missing `match` is not an agent
 *   network      the one escape the runtime cannot see (scan.ts explains why)
 *   credentials  hard rule 1 — we never hold a portal login, ever
 *   sources      hard rule 2 — an adversarial source is a permanent arms race
 *   lease        budgets past the lock's TTL run one agent twice (limits.ts)
 *   harness      it has never run against real recorded bytes
 *   templates    the one string that reaches every subscriber unedited
 *
 * The order is the order a builder should read them in: what the manifest says,
 * then what it is allowed to touch, then what it costs, then whether it works.
 */

import {
  assertLeaseBudget,
  DEFAULT_ENRICH_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from '../runtime/limits.ts'
import { resolveAllOptions } from '../config/options.ts'
import { optionRequests, parseUserConfig } from '../config/schema.ts'
import { parseFrequencyMs } from '../runtime/schedule.ts'
import { agentBudgetUsd, estimateCost } from './cost.ts'
import { exceptionAllowsHeader, sourceExceptionFor } from '../runtime/source-exceptions.ts'
import { ABOUT_FIELDS, missingAbout } from '../agent-about/schema.ts'
import type { AgentSpec, JsonObject, SourceSpec } from '../runtime/types.ts'
import { formatFinding, scanSources } from './scan.ts'
import { placeholders, scanTemplate, templateFrom } from './templates.ts'
import type { SubmissionCheck, SubmissionCheckId, SubmissionInput, SubmissionReport } from './types.ts'

/** CLAUDE.md §2. Two of these is the floor for existing at all. */
export const CLAUDE_CANT_AXES = ['time', 'access', 'speed', 'action', 'state'] as const

/** AGENT-SPEC.md §The 14 patterns. Declaring one that has no implementation is
 *  allowed — twelve of them are unwritten and the first agent to need one writes
 *  it — but declaring a name that is not on the list is a typo. */
export const PATTERNS = [
  'availability-watcher',
  'new-listing-watcher',
  'threshold-watcher',
  'status-change-watcher',
  'page-diff-watcher',
  'multi-source-aggregator',
  'keyword-sentinel',
  'deadline-sentinel',
  'conditional-trigger',
  'scheduled-digest',
  'auto-action',
  'personal-data',
  'domain-rules',
  'race-agent',
] as const

const SOURCE_TYPES = ['http_json', 'http_html', 'rss', 'api']

/**
 * Config keys and labels that mean "give us a credential".
 *
 * Hard rule 1 is absolute and it is the rule most likely to be broken with good
 * intentions: the agent that would work so much better if it could just log in.
 * It never can. Agents use public data, user-supplied config, or user-forwarded
 * email — and a field called `password` is the visible end of a design that has
 * already gone wrong somewhere upstream.
 */
const CREDENTIAL_WORDS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'api_key',
  'apikey',
  'access_key',
  'token',
  'credential',
  'login',
  'username',
  'user_name',
  'pin',
  'otp',
  'two_factor',
  '2fa',
  'ssn',
  'card_number',
  'cvv',
  'session_id',
  'cookie',
  'auth',
]

/**
 * Word boundaries, not substrings — the lesson AGENT-SPEC.md §Anti-patterns
 * paid for once already. "pin" as a substring matches *shipping*, and a check
 * that cries wolf on a legitimate field is a check people learn to skip.
 */
function looksLikeCredential(value: string): string | null {
  const normalised = value.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
  for (const word of CREDENTIAL_WORDS) {
    if (new RegExp(`(^|_)${word}(_|$)`).test(normalised)) return word
  }
  return null
}

interface UserConfigField {
  key?: unknown
  label?: unknown
  type?: unknown
  required?: unknown
}

function userConfigFields(spec: AgentSpec): UserConfigField[] {
  const raw = (spec as { user_config?: unknown }).user_config
  return Array.isArray(raw) ? (raw as UserConfigField[]) : []
}

function acceptanceCriteria(spec: AgentSpec): string[] {
  const raw = (spec as { acceptance_criteria?: unknown }).acceptance_criteria
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

// ------------------------------------------------------------------- checks

function checkSchema(spec: AgentSpec): SubmissionCheck {
  const problems: string[] = []

  if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) {
    problems.push(`id "${spec.id}" is not kebab-case`)
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') problems.push('name is missing')
  if (typeof spec.tagline !== 'string' || spec.tagline.trim() === '') problems.push('tagline is missing')
  if (!PATTERNS.includes(spec.pattern as (typeof PATTERNS)[number])) {
    problems.push(`pattern "${spec.pattern}" is not one of the 14`)
  }
  if (!Array.isArray(spec.sources) || spec.sources.length === 0) {
    problems.push('no sources declared — ctx.fetch can reach nothing')
  } else {
    spec.sources.forEach((source: SourceSpec, index) => {
      if (!source?.id) problems.push(`sources[${index}] has no id`)
      if (!SOURCE_TYPES.includes(source?.type)) problems.push(`sources[${index}].type "${source?.type}" is not a source type`)
      if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) {
        problems.push(`sources[${index}].url is not an http(s) url`)
      } else if (/^https?:\/\/[^/]*\{/.test(source.url)) {
        // A placeholder in the HOST is a source allowlist that a param can
        // rewrite, which is the allowlist not existing.
        problems.push(`sources[${index}].url interpolates its host — placeholders belong in the path or query, never the host`)
      }
      if (!source?.tier) problems.push(`sources[${index}] declares no tier`)
      // POST is for a declared, literal JSON body and nothing else. A body on a
      // GET is a manifest that does not mean what it says; a placeholder inside
      // a body would be a query an agent can rewrite at run time.
      if (source?.method !== undefined && source.method !== 'GET' && source.method !== 'POST') {
        problems.push(`sources[${index}].method "${String(source.method)}" is not GET or POST`)
      }
      if (source?.headers !== undefined) {
        // The same allowlist the fetcher enforces, checked here so a manifest
        // that would be refused at runtime is refused at review instead — and
        // so the reason arrives as a review comment rather than a failed run.
        const allowed = new Set(['referer', 'origin', 'accept', 'accept-language', 'x-requested-with'])
        if (typeof source.headers !== 'object' || source.headers === null || Array.isArray(source.headers)) {
          problems.push(`sources[${index}].headers must be a map of header names to values`)
        } else {
          const exception = sourceExceptionFor(spec.id, source, hostOf(source.url))
          for (const [name, value] of Object.entries(source.headers as Record<string, unknown>)) {
            if (!allowed.has(name.toLowerCase()) && !exceptionAllowsHeader(exception, name, value)) {
              problems.push(
                `sources[${index}].headers declares "${name}" — a source may only set ${[...allowed].join(', ')}. ` +
                  'A header that says who is making the request is a credential, and v1 never holds one (hard rule 1).',
              )
            }
          }
        }
      }
      if (source?.body !== undefined) {
        if (source.method !== 'POST') problems.push(`sources[${index}] declares a body without method: POST`)
        if (typeof source.body !== 'object' || source.body === null || Array.isArray(source.body)) {
          problems.push(`sources[${index}].body must be a JSON object`)
        } else if (/\{[a-z_]+\}/i.test(JSON.stringify(source.body))) {
          problems.push(`sources[${index}].body contains a placeholder — a POST body is declared, never interpolated`)
        }
      }
    })
  }
  if (!spec.poll?.frequency) {
    problems.push('poll.frequency is missing')
  } else {
    try {
      parseFrequencyMs(spec.poll.frequency)
    } catch (error) {
      problems.push(`poll.frequency: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    id: 'schema',
    label: 'The manifest is a manifest',
    passed: problems.length === 0,
    detail: problems.length === 0 ? 'Every required field is present and typed.' : problems.join('; '),
  }
}

function checkAxes(spec: AgentSpec): SubmissionCheck {
  const declared = Array.isArray(spec.claude_cant_axes) ? spec.claude_cant_axes : []
  const unknown = declared.filter((axis) => !CLAUDE_CANT_AXES.includes(axis as (typeof CLAUDE_CANT_AXES)[number]))
  const valid = declared.filter((axis) => CLAUDE_CANT_AXES.includes(axis as (typeof CLAUDE_CANT_AXES)[number]))

  const passed = unknown.length === 0 && valid.length >= 2

  return {
    id: 'axes',
    label: 'Two of the five Claude-Can’t axes',
    passed,
    detail: unknown.length > 0
      ? `"${unknown.join('", "')}" is not an axis. They are: ${CLAUDE_CANT_AXES.join(', ')}.`
      : valid.length >= 2
        ? `${valid.join(', ')} — ${valid.length} of five.`
        : `${valid.length} axis. "If Claude can do it in one chat, it isn't here" — two is the floor for existing at all.`,
  }
}

function checkCriteria(spec: AgentSpec): SubmissionCheck {
  const criteria = acceptanceCriteria(spec)

  return {
    id: 'criteria',
    label: 'A written definition of done',
    passed: criteria.length > 0,
    detail:
      criteria.length > 0
        ? `${criteria.length} acceptance criterion(s), each evaluated separately in shadow.`
        : 'No acceptance_criteria. They are written BEFORE anyone builds and they are what the shadow test judges against — without them there is nothing for the agent to pass and nothing a dispute can be settled by.',
  }
}

/**
 * The frozen interface: fetch, normalize, match, plus an optional enrich.
 *
 * Checked as its own line rather than left to the harness, because the two fail
 * for different reasons and a builder needs to know which. A module missing
 * `match` is not a broken fixture; it is not an agent. `assertAgentModule` in
 * the registry is what actually decides — this reports what it found, so the
 * sentence names the export instead of naming a stack trace.
 */
/**
 * Can the deployed runtime actually load this agent?
 *
 * ON DISK AND IN THE BUNDLE ARE DIFFERENT QUESTIONS. Everything else here reads
 * `/agents/<id>/` directly, which is right — that is the code being reviewed.
 * But the deployed worker does not read the disk. It imports
 * `agents/registry.ts`, because nothing else puts agent code into Next's module
 * graph and the tracer follows nothing it cannot see.
 *
 * `registry.ts` has warned about this in a comment since it was written: "a
 * pull request that adds /agents/<id>/ and forgets this file produces an agent
 * that submits, passes every check, enters shadow, and never runs." That is
 * exactly what happened to columbia-study-rooms — eleven checks green, into
 * shadow, and then `agent "columbia-study-rooms" is not registered` on the
 * first tick. Shadow would have filled with seven days of failures that look
 * like a broken agent rather than a missing import.
 *
 * A comment is not a gate. This is.
 */
function checkBundled(input: SubmissionInput): SubmissionCheck {
  const label = 'The deployed runtime can load it'
  if (!input.bundledIds) {
    return {
      id: 'bundled',
      label,
      passed: true,
      detail: 'Not checked here — the caller did not say what the deployed bundle contains.',
    }
  }
  const bundled = input.bundledIds.includes(input.agentId)
  return {
    id: 'bundled',
    label,
    passed: bundled,
    detail: bundled
      ? `Imported by agents/registry.ts, so the build traces it into the worker.`
      : `agents/registry.ts does not import "${input.agentId}". On disk is not the same as in the bundle: the deployed cron loads agents from that file, so this would enter shadow and then error on every tick with "not registered". Add two lines — the import and the AGENT_MODULES entry.`,
  }
}

/**
 * The config form a subscriber will actually see.
 *
 * EVERY OTHER CHECK HERE READS THE MANIFEST. This one RENDERS it — it runs the
 * same `parseUserConfig` the config page runs, against the same option
 * resolver, and asks whether a person could fill the result in and press save.
 *
 * WHY IT HAD TO EXIST. `parseUserConfig` already reported spec problems and
 * already dropped a bad field rather than render it, which is the right
 * behaviour on a page and the wrong behaviour as the last word. Nothing read
 * `problems`. columbia-study-rooms declared `type: timerange`, which is not a
 * field type; the parser dropped the field, the manifest went on promising in
 * `what_it_needs` that it would ask, and `match()` went on reading a
 * `config.hours` no form could ever set. Twelve checks green.
 *
 * AND THE EMPTY-OPTIONS CASE, which is worse because nothing is dropped. Its
 * `libraries` multiselect pointed at `params.libraries`, a list of objects
 * keyed by `lid` — a word the resolver did not recognise — so it resolved to
 * zero options. A required multiselect with no choices is a form that cannot
 * be submitted: the agent was, in the most literal sense, impossible to turn
 * on, and it had passed submission and entered shadow.
 *
 * Only `params.*` references are judged. `items.*` and `<source>.*` are filled
 * from the agent's stored State, which does not exist before the first run, and
 * an empty list there is the agent being new rather than the manifest being
 * wrong.
 */
function checkConfigForm(input: SubmissionInput): SubmissionCheck {
  const id: SubmissionCheckId = 'config-form'
  const label = 'A form a subscriber can actually fill in'
  const spec = input.spec as { user_config?: unknown; params?: unknown }

  const requests = optionRequests(spec)
  const resolved = resolveAllOptions(requests, {
    params: (spec.params ?? {}) as JsonObject,
    // Submission time is before the first run by definition.
    state: null,
  })
  const { fields, problems } = parseUserConfig(spec, resolved)

  if (problems.length > 0) {
    return {
      id,
      label,
      passed: false,
      detail: `The config form does not parse, so the field is dropped and never rendered: ${problems.join('; ')}. A field the form cannot show is a value match() will never receive.`,
    }
  }

  const empty = fields.filter(
    (field) =>
      (field.type === 'select' || field.type === 'multiselect') &&
      field.optionsFrom !== undefined &&
      field.optionsFrom.startsWith('params.') &&
      field.options.length === 0,
  )
  if (empty.length > 0) {
    return {
      id,
      label,
      passed: false,
      detail: `${empty
        .map((field) => `"${field.key}" reads its options from ${field.optionsFrom} and got none`)
        .join('; ')}. The list is in the manifest, so this is not "no data yet" — it is entries the resolver cannot read. Name the keys with option_value and option_label, or give each entry a value/id/key/name.`,
    }
  }

  const required = fields.filter((field) => field.required).length
  return {
    id,
    label,
    passed: true,
    detail: `${fields.length} field(s) render, ${required} of them required; every options_from over manifest params resolves to at least one choice.`,
  }
}

function checkInterface(input: SubmissionInput): SubmissionCheck {
  const exports = input.exports

  if (!exports) {
    return {
      id: 'interface',
      label: 'Three functions, and a fourth if it needs one',
      passed: false,
      detail: 'The module could not be loaded, so nothing could be checked against the interface. index.ts has to export fetch, normalize and match.',
    }
  }

  const missing = (['fetch', 'normalize', 'match'] as const).filter((name) => !exports[name])
  const enrichBroken = exports.enrich === 'not-a-function'

  return {
    id: 'interface',
    label: 'Three functions, and a fourth if it needs one',
    passed: missing.length === 0 && !enrichBroken,
    detail:
      missing.length > 0
        ? `missing export(s): ${missing.join(', ')}. The interface is fetch/normalize/match, plus an optional enrich — nothing else, ever.`
        : enrichBroken
          ? 'It exports `enrich` but it is not a function. A half-declared hook fails after the fetch has already been paid for.'
          : `fetch, normalize, match${exports.enrich === 'function' ? ', enrich' : ''} — all callable.`,
  }
}

function checkNetwork(input: SubmissionInput): SubmissionCheck {
  const findings = scanSources(input.sources)

  return {
    id: 'network',
    label: 'No way out except ctx.fetch',
    passed: findings.length === 0,
    detail:
      findings.length === 0
        ? `${input.sources.length} file(s) scanned; every network call goes through ctx.fetch and the manifest allowlist.`
        : findings.map((finding) => `${formatFinding(finding)} (${finding.why})`).join(' · '),
  }
}

function checkCredentials(spec: AgentSpec): SubmissionCheck {
  const problems: string[] = []

  for (const field of userConfigFields(spec)) {
    const key = typeof field.key === 'string' ? field.key : ''
    const label = typeof field.label === 'string' ? field.label : ''
    const hit = looksLikeCredential(key) ?? looksLikeCredential(label)
    if (hit) problems.push(`user_config "${key || label}" reads as a credential ("${hit}")`)
    if (field.type === 'password') problems.push(`user_config "${key}" is type password`)
  }

  for (const source of spec.sources ?? []) {
    if (source?.auth && source.auth !== 'none') {
      problems.push(`source "${source.id}" declares auth: ${source.auth} — v1 sources are auth: none`)
    }
  }

  return {
    id: 'credentials',
    label: 'No credential ever reaches us',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? 'No credential-shaped config field and no authenticated source. Hard rule 1 holds.'
        : `${problems.join('; ')}. Hard rule 1: we never store a password or a portal credential — public data, user-supplied config, or user-forwarded email, no exceptions.`,
  }
}

/**
 * A source url's host, lowercased — or '' when it has none. Never throws: a
 * malformed url is reported by the manifest check, and an empty host matches
 * no exception.
 */
function hostOf(url: unknown): string {
  return typeof url === 'string' ? (/^https?:\/\/([^/?#]+)/i.exec(url.trim())?.[1] ?? '').toLowerCase() : ''
}

function checkSources(spec: AgentSpec): SubmissionCheck {
  // An adversarial source passes only under an exception the owner granted to
  // this agent, this source and this host — see lib/runtime/source-exceptions.ts.
  const excepted = (spec.sources ?? []).filter(
    (source) => source?.tier === 'adversarial' && sourceExceptionFor(spec.id, source, hostOf(source.url))?.allowAdversarial,
  )
  const adversarial = (spec.sources ?? []).filter((source) => source?.tier === 'adversarial' && !excepted.includes(source))
  const untiered = (spec.sources ?? []).filter((source) => !source?.tier)

  const passed = adversarial.length === 0 && untiered.length === 0

  return {
    id: 'sources',
    label: 'No adversarial source',
    passed,
    detail: passed
      ? `${(spec.sources ?? []).length} source(s): ${(spec.sources ?? []).map((s) => `${s.id} (${s.tier})`).join(', ')}.` +
        (excepted.length > 0
          ? ` ${excepted.map((s) => s.id).join(', ')} adversarial by owner exception: ${excepted
              .map((s) => sourceExceptionFor(spec.id, s, hostOf(s.url))?.decision)
              .join('; ')}.`
          : '')
      : adversarial.length > 0
        ? `${adversarial.map((s) => s.id).join(', ')} declared adversarial. Hard rule 2 — that is a permanent arms race and a moving target. The pattern is usually fine; point it at a different source.`
        : `${untiered.map((s) => s.id).join(', ')} declare no tier. Deciding the tier is the work; leaving it blank defers it to whoever is on call.`,
  }
}

function checkLease(spec: AgentSpec): SubmissionCheck {
  try {
    assertLeaseBudget(spec)
    return {
      id: 'lease',
      label: 'Budgets fit inside the lock',
      passed: true,
      detail: `fetch ${(spec.limits?.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS) / 1000}s + enrich ${
        (spec.limits?.enrich_timeout_ms ?? DEFAULT_ENRICH_TIMEOUT_MS) / 1000
      }s fits inside the lock's lease with margin to spare.`,
    }
  } catch (error) {
    return {
      id: 'lease',
      label: 'Budgets fit inside the lock',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function checkHarness(input: SubmissionInput): SubmissionCheck {
  if (!input.harness) {
    return {
      id: 'harness',
      label: 'It runs against recorded bytes',
      passed: false,
      detail: 'The offline harness was not run. `npm run agent:test <id>` replays the recorded fixtures through the real execution loop — a submission that skipped it has never been run at all.',
    }
  }

  return {
    id: 'harness',
    label: 'It runs against recorded bytes',
    passed: input.harness.passed,
    detail: input.harness.detail,
  }
}

function checkTemplates(spec: AgentSpec): SubmissionCheck {
  const template = templateFrom(spec)
  const problems: string[] = []

  if (template.title.trim() === '') problems.push('alert.title is missing')
  if (template.body.trim() === '') problems.push('alert.body is missing')

  for (const problem of scanTemplate(template)) {
    problems.push(`alert.${problem.field}: ${problem.reason}`)
  }

  const vars = placeholders(template)

  return {
    id: 'templates',
    label: 'Alert copy present, and lockable',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `"${template.title}" / "${template.body}"${vars.length > 0 ? ` — interpolates ${vars.join(', ')}` : ''}. Locked on submit; changing it afterwards is a review, not a deploy.`
        : `${problems.join('; ')}. The alert body is the one string that reaches every subscriber unedited, every time it fires.`,
  }
}

/**
 * What it will cost the platform a month — known before it ships.
 *
 * On a free platform nothing else pays, so an agent that would run up an
 * open-ended bill is refused here, with the levers that fix it. The expected
 * month must fit the per-agent budget, and the worst case (every run
 * enriching its per-run maximum) may be at most five times that — past it,
 * `max_enrich_per_run` is the cap to lower. See lib/submission/cost.ts.
 */
function checkCost(input: SubmissionInput): SubmissionCheck {
  const { spec } = input
  const estimate = estimateCost(spec, input.exports?.enrich ?? null)
  const budget = agentBudgetUsd()
  const usd = (n: number) => `$${n.toFixed(2)}`
  const problems = [...estimate.problems]

  if (estimate.kind === 'on-demand') {
    return {
      id: 'cost',
      label: 'What it costs to run',
      passed: true,
      detail: 'On demand: it runs only when somebody asks, under the daily free allowance and their own key after that — never on a clock.',
    }
  }
  if (problems.length === 0 && estimate.expectedUsd > budget) {
    problems.push(
      `expected ${usd(estimate.expectedUsd)}/month is over the ${usd(budget)} per-agent budget — poll less often, lower cost.enrich.items_per_month or tokens, or use a cheaper model`,
    )
  }
  if (problems.length === 0 && estimate.worstUsd > budget * 5) {
    problems.push(
      `worst case ${usd(estimate.worstUsd)}/month (every run enriching its maximum) is over five times the ${usd(budget)} budget — lower limits.max_enrich_per_run or poll less often`,
    )
  }

  const breakdown =
    estimate.kind === 'free'
      ? `No model and no paid source: about ${estimate.runsPerMonth.toLocaleString('en-US')} runs a month at no data cost, and one fetch serves every subscriber.`
      : `${estimate.runsPerMonth.toLocaleString('en-US')} runs/month · data ${usd(estimate.dataUsd)} · model ${usd(estimate.modelExpectedUsd)} expected, ${usd(estimate.modelWorstUsd)} worst · total ${usd(estimate.expectedUsd)} expected, ${usd(estimate.worstUsd)} worst, against ${usd(budget)}.`

  return {
    id: 'cost',
    label: 'What it costs to run',
    passed: problems.length === 0,
    detail: problems.length === 0 ? breakdown : `${problems.join('; ')}. ${breakdown}`,
  }
}

// ------------------------------------------------------------------- report

/**
 * The About block, complete.
 *
 * THE ONLY REASON `how_fast` EVER GETS AN HONEST ANSWER is that it is asked
 * before anything ships. Nobody volunteers "this can be an hour late" after
 * launch, and a subscriber who finds it out from experience does not file a
 * bug, they cancel. So the seven questions on every agent's page are a
 * submission gate, not a suggestion — same standing as the acceptance criteria
 * and for the same reason: written down before anyone can be disappointed by
 * the gap between them and reality.
 *
 * `not_covered` is checked alongside them. An agent that claims no limits at
 * all has not thought about its limits; every real source has some.
 */
/**
 * Every field a subscriber reads that still carries the scaffold's TODO.
 *
 * `agent:new` writes "TODO — …" into each of them, promising that the first
 * check would say so. It did not: the check counted answers and "TODO" is an
 * answer, so a manifest with every judgement left blank passed this check —
 * found by scaffolding one in the public kit and running it.
 */
function placeholderFields(spec: AgentSpec): string[] {
  const s = spec as unknown as Record<string, unknown>
  const about = (s.about ?? {}) as Record<string, unknown>
  const alert = (s.alert ?? {}) as Record<string, unknown>
  const fields: Array<[string, unknown]> = [
    ['name', s.name],
    ['tagline', s.tagline],
    ['card_subtitle', s.card_subtitle],
    ['description', s.description],
    ['not_covered', s.not_covered],
    ['before_you_join', s.before_you_join],
    ['category', s.category],
    ['alert.title', alert.title],
    ['alert.body', alert.body],
    ...Object.entries(about).map(([key, value]): [string, unknown] => [`about.${key}`, value]),
  ]
  const hasTodo = (value: unknown): boolean =>
    typeof value === 'string' ? /\bTODO\b/.test(value) : Array.isArray(value) ? value.some(hasTodo) : false
  return fields.filter(([, value]) => hasTodo(value)).map(([name]) => name)
}

function checkAbout(spec: AgentSpec): SubmissionCheck {
  const missing = missingAbout((spec as { about?: unknown }).about)
  const notCovered = Array.isArray((spec as { not_covered?: unknown }).not_covered)
    ? ((spec as { not_covered?: unknown[] }).not_covered ?? []).filter((l) => typeof l === 'string' && l.trim() !== '')
    : []

  const problems: string[] = []
  if (missing.length > 0) problems.push(`about is missing: ${missing.join(', ')}`)
  if (notCovered.length === 0) problems.push('not_covered is empty — every source has limits, and the ones you do not write down are the ones people discover')
  const placeholders = placeholderFields(spec)
  if (placeholders.length > 0) problems.push(`still says TODO: ${placeholders.join(', ')}`)

  const required = ABOUT_FIELDS.filter((f) => f.required).length

  return {
    id: 'about',
    label: 'The page a subscriber reads before paying',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `All ${required} About answers present, plus ${notCovered.length} stated limit(s).`
        : `${problems.join('. ')}. These render on /agents/${spec.id} and are what somebody decides on.`,
  }
}

export function runChecks(input: SubmissionInput): SubmissionReport {
  const { spec } = input

  const checks: SubmissionCheck[] = [
    checkSchema(spec),
    checkAxes(spec),
    checkCriteria(spec),
    checkAbout(spec),
    checkInterface(input),
    checkBundled(input),
    checkConfigForm(input),
    checkNetwork(input),
    checkCredentials(spec),
    checkSources(spec),
    checkLease(spec),
    checkHarness(input),
    checkTemplates(spec),
    checkCost(input),
  ]

  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail)

  return {
    agentId: input.agentId,
    passed: blockers.length === 0,
    checks,
    blockers,
    template: templateFrom(spec),
  }
}

/** One line for a refusal message or a log. */
export function submissionSummary(report: SubmissionReport): string {
  return report.passed
    ? `${report.agentId} passed all ${report.checks.length} checks.`
    : `${report.agentId} failed ${report.blockers.length} of ${report.checks.length} checks: ${report.blockers.join(' ')}`
}

export function formatSubmission(report: SubmissionReport): string {
  const lines = [`agent: ${report.agentId}`, '']
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.label}`)
    lines.push(`        ${check.detail}`)
  }
  lines.push('')
  lines.push(report.passed ? 'all checks passed' : 'FAILED')
  return lines.join('\n')
}

export { acceptanceCriteria }
