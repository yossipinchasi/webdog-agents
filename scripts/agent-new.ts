/**
 * npm run agent:new <agent-id>
 *
 * The first step of the builder loop, which did not exist.
 *
 * WHY A SCAFFOLD AND NOT A TEMPLATE IN THE DOCS. Starting an agent meant
 * opening `agents/columbia-seat-watcher/` and reading 300 lines of manifest to
 * work out which keys were required, which were conventional, and which were
 * that agent's own problem. That is archaeology, and everybody who does it
 * draws a slightly different conclusion. Worse, the things easiest to miss are
 * the ones the submission gate refuses for: `about` needs six answers,
 * `not_covered` cannot be empty, `claude_cant_axes` needs two.
 *
 * So this writes a manifest that ALREADY PASSES the structural checks and fails
 * only on the parts a person genuinely has to think about — the prose. A
 * builder's first `agent:submit --dry` then tells them something useful
 * ("about.what_it_does still says TODO") instead of a wall of schema errors.
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const id = process.argv[2]
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('usage: npm run agent:new <agent-id>    (lowercase, hyphens, e.g. columbia-study-rooms)')
  process.exit(2)
}

const dir = fileURLToPath(new URL(`../agents/${id}`, import.meta.url))
if (await access(dir).then(() => true, () => false)) {
  console.error(`agents/${id} already exists — pick another id or delete it first.`)
  process.exit(2)
}

const MANIFEST = `# ${id}
#
# Write the WHY at the top. Every manifest in this repo opens with the thing a
# reader six months from now cannot reconstruct: why this source and not the
# obvious one, what was refused and on what grounds, what the limitation is
# that you would otherwise be asked about by somebody wanting a refund.

id: ${id}
name: "TODO — what a person calls it"
tagline: "TODO — one line that sells it"
card_subtitle: "TODO — one line that says plainly what it does"

# THE LIMITATION LEADS. The first sentence a subscriber reads should be the one
# that would otherwise make them ask for their money back.
description: "TODO — what it watches, what arrives, and the one thing it cannot do."

# NOT OPTIONAL, and the gate refuses an empty list. Every source has limits;
# the ones you do not write down are the ones people discover.
not_covered:
  - "TODO — something it genuinely will not do, said plainly"
  - "TODO — the latency or coverage gap you would rather not mention"

before_you_join:
  - "TODO — the fact somebody should read BEFORE paying, not after"

# All six are required. The headings are the platform's; the answers are yours.
about:
  what_it_does: "TODO"
  who_its_for: "TODO — and who it is NOT for"
  what_it_reads:
    - "TODO — the source, described as a person would recognise it"
  when_you_hear_from_it: "TODO — an event, or a clock? Say which."
  what_arrives: "TODO — and what the person still has to do themselves"
  how_current: "TODO — the honest ceiling, not the poll interval"
  what_it_needs:
    - "TODO — config they supply"
    - "Never a password or a login. This platform never holds one."

category: TODO
pattern: availability-watcher
region: "us-ny-columbia"

# Two of five required. Which of these is true of your agent?
#   time   — runs without being asked
#   access — reaches a source a chat window does not have
#   speed  — the value collapses if it is late
#   state  — needs memory of last time
#   output — hands you something you act on
claude_cant_axes: [time, access]

display: board

sources:
  # One request per POLL, never one per subscriber. A source may declare
  # headers that say WHERE a request came from, never WHO is making it.
  - id: TODO-source
    type: api
    url: "https://example.com/api?q={param}"
    auth: none          # must be none — hard rule 1, we never hold a credential
    rate_limit: 10/min  # check robots.txt and be slower than it asks
    tier: cooperative

params: {}

poll:
  frequency: 15m

user_config:
  - key: TODO
    label: "TODO — a question a person can answer"
    type: multiselect
    required: true

trigger:
  # The EDGE, not the level. Something that has been true all week is not news.
  condition: "prev.item(id).available == false AND curr.item(id).available == true"
  dedupe_key: "{id}"
  cooldown: 21600s

guard:
  # An empty State reaching the diff looks exactly like everything being
  # deleted at once. normalize() must throw instead — hard rule 6.
  allow_empty_state: false
  max_drop_ratio: 0.34
  min_items_for_drop_check: 10

limits:
  max_alerts_per_run: 20
  max_alerts_per_user_per_run: 5
  timeout_ms: 30000

alert:
  priority: normal
  title: "TODO: {field}"
  body: "TODO — what happened, and what the person does next. This agent cannot act."
  action_url: "{url}"

# The written definition of done. Each is judged separately in shadow, and the
# ones a machine cannot decide go to a person with the evidence attached.
acceptance_criteria:
  - "Alerts within one poll cycle of the change appearing at the source"
  - "Never alerts on the first run — that establishes the baseline"
  - "An unrecognised value reads as NOT available, so an unknown never becomes an alert"
  - "A source returning zero items fails the run rather than reading as everything changing"
  - "Never books, applies, submits or acts — alert only"
  - "Never sends a credential, and declares no source that could accept one"

sla:
  max_detection_latency: 30m
`

const INDEX = `/**
 * ${id}
 *
 * Three functions. The platform owns scheduling, retries, dedup, delivery,
 * billing and health — see CLAUDE.md §3. What belongs here is only the part
 * nobody else can know: which call to make, how to read the answer, and what
 * counts as news.
 */

import type { Alert, AgentContext, State, StateItem, UserConfig } from '../../lib/runtime/types.ts'

// ---------- 1. fetch ----------

/** One fetch serves every subscriber. Never fetch per user. */
export async function fetch(ctx: AgentContext): Promise<unknown> {
  const raw = await ctx.fetch('TODO-source', { param: 'TODO' })
  // Throw if EVERY source failed. An empty result that reaches normalize
  // becomes an empty State, and an empty State reaching the diff reads as
  // every item being deleted at once.
  if (!raw) throw new Error('source returned nothing — no snapshot taken')
  return { raw, fetchedAt: ctx.now.toISOString() }
}

// ---------- 2. normalize ----------

/**
 * Pure, and throws on anything it does not understand.
 *
 * Never return an empty State to "handle" a parse failure. The safe direction
 * for anything unrecognised is NOT available — only one of the two directions
 * can invent an alert.
 */
export function normalize(raw: unknown): State {
  const { raw: body, fetchedAt } = raw as { raw: unknown; fetchedAt: string }
  const items: StateItem[] = []

  // TODO: parse \`body\` into one item per thing you are watching.
  void body

  if (items.length === 0) {
    throw new Error('normalize: parsed to zero items — the source format changed')
  }
  return { items, fetchedAt }
}

// ---------- 3. match ----------

/** Which of this subscriber's items just became news? */
export function match(prev: State | null, curr: State, config: UserConfig): Alert[] {
  // The first run establishes the baseline and never alerts — hard rule 8.
  if (prev === null) return []
  void curr
  void config
  // TODO: compare prev to curr and return one Alert per genuine change.
  return []
}
`

const README = `# ${id}

## Before you submit

\`\`\`bash
npm run agent:record ${id}          # hit each declared source once, save the bytes
npm run agent:test   ${id}          # run the three functions against those bytes, offline
npm run agent:check  ${id}          # every automated check, writing nothing
\`\`\`

The third one is the gate — the same code the platform runs on your
submission, so a green check here is a green gate there.

## Submitting

Push this repository somewhere public, then paste its link and the commit
from your builder page (/build). We read the code, import it at exactly that
commit, and run the gate again.

## What passing does not mean

It does not make the agent live. A passing submission moves it to **shadow**:
seven days against the real source, alerts suppressed, then a report where the
criteria a machine cannot decide go to a person with the evidence attached.
The builder guide is at /build/guide.
`

await mkdir(`${dir}/fixtures`, { recursive: true })
await writeFile(`${dir}/agent.yaml`, MANIFEST)
await writeFile(`${dir}/index.ts`, INDEX)
await writeFile(`${dir}/README.md`, README)

console.log(`
Created agents/${id}/
  agent.yaml   the manifest — every TODO is something only you can answer
  index.ts     fetch, normalize, match
  README.md    the loop, and what shipping actually means
  fixtures/    npm run agent:record ${id} fills this

Next:  npm run agent:check ${id}
`)
