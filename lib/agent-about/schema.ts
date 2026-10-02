/**
 * The About block — the same seven questions on every agent's page.
 *
 * WHY FIXED FIELDS AND NOT FREE PROSE. The first version of this was a
 * `detail` list of `{heading, body}` the builder invented. That fails twice.
 * Every page ends up a different shape, so a reader cannot compare two agents
 * or learn where to look — and a builder staring at an empty list writes
 * whatever comes to mind, which is never "how late can this be" and is often
 * three paragraphs of what the agent does. The things a subscriber actually
 * needs are the ones nobody volunteers.
 *
 * So the headings belong to the platform and the answers belong to the builder.
 * `runChecks` refuses a submission that leaves a required one blank
 * (`checkAbout`), which is the only reason a field like `how_current` ever gets
 * filled in honestly: it is asked before anybody can ship, not after somebody
 * complains.
 *
 * ORDER IS THE READING ORDER on /agents/[id] and it is deliberate: what it is,
 * who it is for, what it reads, when you hear from it, what arrives, how
 * current it is, what it needs from you. Limits come after all of it from
 * `not_covered`, which stays where it is because the scope contract reads the
 * same list.
 *
 * NOT EVERY AGENT IS A WATCHER, and the first version of these headings forgot
 * it — "What it watches", "When it tells you", "What you do when it fires".
 * Every one of those takes an event for granted, and a perfectly ordinary agent
 * has none:
 *
 *   > Every Monday, pull the new filings for these twelve companies into one
 *   > email.
 *
 * Nothing fires. It runs on a clock and always delivers. OPEN-ITEMS §11q found
 * exactly this in the request form on 2026-09-02 and settled the vocabulary:
 * `cadence` is `event | schedule`, ONE question — "when does this do its work?"
 * — serves both ("a seat opens in ECON 3025" / "every Monday at 8am"), and
 * "agents alert" became "agents deliver — an alert, a digest, a report". These
 * headings now use that vocabulary rather than a second one. The hints carry an
 * example of each shape so a builder of either can see themselves in the
 * question.
 */

import type { ScopeSection } from '../scope/types.ts'

export interface AboutField {
  key: string
  /**
   * The scope-contract section this answers, when it answers one.
   *
   * THIS IS THE POINT OF THE WHOLE BLOCK. A request is approved at Stage 3.5
   * with five promises — what it will watch, what counts as a hit, how fast
   * you'll know, how you'll be told, what it will not do — and a builder then
   * goes away and builds. Nothing afterwards put the promise and the delivery
   * on the same page, so "did we get what was asked for" was a question
   * somebody had to answer by reading two screens and remembering.
   *
   * Four of these fields answer four of those sections, one for one, and
   * `not_covered` answers the fifth. /agents/[id] renders them paired: asked
   * for, then delivered. A builder writing this block is writing a reply, not
   * a description, and a reader can check it line by line.
   */
  answers?: ScopeSection
  /** The heading a reader sees. The builder does not get to change it. */
  heading: string
  /** What the builder is being asked, in the form. */
  prompt: string
  /** One line of what a good answer looks like, shown under the prompt. */
  hint: string
  shape: 'text' | 'list'
  required: boolean
}

export const ABOUT_FIELDS: readonly AboutField[] = [
  {
    key: 'what_it_does',
    heading: 'What it does',
    prompt: 'In two or three sentences, what does this agent do?',
    hint: 'Plain language, no jargon. Someone who has never heard of it should get it in one read.',
    shape: 'text',
    required: true,
  },
  {
    key: 'who_its_for',
    heading: 'Who it is for',
    prompt: 'Who should turn this on, and who should not?',
    hint: 'Naming who it is NOT for saves more refunds than naming who it is for.',
    shape: 'text',
    required: true,
  },
  {
    key: 'what_it_reads',
    answers: 'watch',
    heading: 'What it reads',
    prompt: 'Which sources does it rely on? Name them the way a person would.',
    hint: '"Columbia’s public Directory of Classes", not "doc.sis.columbia.edu/subj/{subject}".',
    shape: 'list',
    required: true,
  },
  {
    key: 'when_you_hear_from_it',
    answers: 'hit',
    heading: 'When you hear from it',
    prompt: 'When does this do its work — on an event, or on a clock?',
    hint: 'One sentence, either shape: "the moment a section you picked stops being full", or "every Monday at 8am, whether or not anything changed".',
    shape: 'text',
    required: true,
  },
  {
    key: 'what_arrives',
    answers: 'told',
    heading: 'What arrives',
    prompt: 'What does it deliver, and what is the next thing the person does?',
    hint: 'An alert, a digest, a report — say which, say what is in it, and end with the action they take. It never takes that action for them.',
    shape: 'text',
    required: true,
  },
  {
    key: 'how_current',
    answers: 'speed',
    heading: 'How current it is',
    prompt: 'How old can the information be by the time they read it?',
    hint: 'Include the source’s own delay, not just your schedule — "within about an hour of the page publishing it", or "the filings are as of Sunday night". Overstating this is the fastest way to lose somebody.',
    shape: 'text',
    required: true,
  },
  {
    key: 'what_it_needs',
    heading: 'What it needs from you',
    prompt: 'What does someone have to set up or provide?',
    hint: 'Never a password or a portal login — that is refused platform-wide. Leave empty if it needs nothing.',
    shape: 'list',
    required: false,
  },
] as const

export interface AboutSection {
  key: string
  heading: string
  /** Paragraphs for a text field; bullets for a list field. */
  body: string[]
  shape: 'text' | 'list'
  /** What the approved scope promised for this section, when there was one. */
  promised?: string[]
}

/**
 * Pair each answer with the promise it answers.
 *
 * A first-party agent with no request behind it has no promises, and gets none
 * rather than blanks — an empty "asked for" beside a filled "delivered" reads
 * as an unmet promise rather than as an agent nobody asked for.
 */
export function pairWithScope(
  sections: AboutSection[],
  scope: Partial<Record<ScopeSection, string | string[]>> | null,
): AboutSection[] {
  if (!scope) return sections
  return sections.map((section) => {
    const field = ABOUT_FIELDS.find((f) => f.key === section.key)
    if (!field?.answers) return section
    const promised = toLines(scope[field.answers])
    return promised.length > 0 ? { ...section, promised } : section
  })
}

/**
 * Read `spec.about` into the fixed order, dropping anything the schema does not
 * name. A builder who invents a key gets it ignored rather than rendered — the
 * point of this block is that every page is the same shape.
 */
export function readAbout(raw: unknown): AboutSection[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const record = raw as Record<string, unknown>
  const out: AboutSection[] = []

  for (const field of ABOUT_FIELDS) {
    const value = record[field.key]
    const body = toLines(value)
    if (body.length === 0) continue
    out.push({ key: field.key, heading: field.heading, body, shape: field.shape })
  }
  return out
}

/** Which required fields are missing. Empty means the block is complete. */
export function missingAbout(raw: unknown): string[] {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  return ABOUT_FIELDS.filter((field) => field.required && toLines(record[field.key]).length === 0).map(
    (field) => field.key,
  )
}

function toLines(value: unknown): string[] {
  if (typeof value === 'string') {
    // A text field may still be several paragraphs; the YAML parser has no
    // block scalars, so builders write one string per paragraph in a list or
    // separate them with a blank line in one string.
    return value
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((s) => s.trim())
  }
  return []
}
