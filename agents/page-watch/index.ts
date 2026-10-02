/**
 * page-watch — webdog's page-content monitor, as three functions.
 *
 * What survived the port is the part only webdog knew: read the page's main
 * content as text, compare it with last time, and say which lines were added
 * and which removed. The scheduler, the snapshot table, the dispatcher, the
 * Slack/email/webhook senders and Context.dev are gone — the platform does the
 * first four, and the fifth is not allowed (see agent.yaml).
 */

import type { Alert, AgentContext, State, StateItem, UserConfig } from '../../lib/runtime/types.ts'

interface Page {
  id: string
  label: string
  url: string
}

/** How many changed lines an alert shows. webdog's preview capped at a handful too. */
const PREVIEW_LINES = 3

// ---------- 1. fetch ----------

/** One request per listed page per poll, never one per subscriber. */
export async function fetch(ctx: AgentContext): Promise<unknown> {
  const pages = (ctx.params.pages ?? []) as unknown as Page[]
  const html: Record<string, string> = {}
  for (const page of pages) {
    try {
      html[page.id] = String(await ctx.fetch(page.id))
    } catch (error) {
      // One page down is not every page down. normalize() refuses a run with
      // nothing in it; a page missing from one run is simply not compared.
      ctx.log.warn(`${page.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (Object.keys(html).length === 0) throw new Error('every page failed — no snapshot taken')
  return { html, fetchedAt: ctx.now.toISOString() }
}

// ---------- 2. normalize ----------

/**
 * The page as the lines a person reads. webdog asked Context.dev for "main
 * content only"; this does the same by hand: <main> if the page has one, the
 * body otherwise, with scripts, styles, navigation, headers and footers gone.
 */
export function normalize(raw: unknown): State {
  const { html, fetchedAt } = raw as { html: Record<string, string>; fetchedAt: string }
  const items: StateItem[] = []

  for (const [id, page] of Object.entries(html)) {
    const lines = toLines(page)
    // A page that reads as nothing is a broken fetch or a changed layout, never
    // "everything was deleted". Throwing fails the run instead of alerting.
    if (lines.length < 3) throw new Error(`normalize: ${id} has ${lines.length} line(s) of text — not reading it as a change`)
    const text = lines.join('\n')
    items.push({ id, text, hash: fnv1a(text), lines: lines.length })
  }

  if (items.length === 0) throw new Error('normalize: no pages')
  return { items, fetchedAt }
}

export function toLines(page: string): string[] {
  const main = /<main[\s\S]*<\/main>/i.exec(page)?.[0]
  // Inside <main>, a <header> is a post's title (WordPress wraps every one),
  // so only scripts and widgets go. Without <main>, the page's own header and
  // footer are navigation and go too.
  const chrome = main ? 'script|style|noscript|svg|nav|form|iframe|template' : 'script|style|noscript|svg|nav|header|footer|form|iframe|template'
  const stripped = (main ?? /<body[\s\S]*<\/body>/i.exec(page)?.[0] ?? page)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<(${chrome})\\b[\\s\\S]*?<\\/\\1>`, 'gi'), ' ')
    .replace(/<\/?(?:p|div|li|h[1-6]|tr|br|section|article|dd|dt|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decode(stripped)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1)
    // Client-side template text ({{title}} and the like) is markup a browser
    // fills in, not something the page says — the CS homepage carries some.
    .filter((line) => !/\{\{[^}]*\}\}/.test(line))
}

function decode(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' }
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole)
}

/** A short stable fingerprint for the dedupe key. node:crypto is not available to agents. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------- 3. match ----------

/** A page this subscriber chose, whose text is not what it was last time. */
export function match(prev: State | null, curr: State, config: UserConfig): Alert[] {
  if (prev === null) return [] // the first run is the baseline — hard rule 8

  const chosen = new Set((config.pages ?? []) as string[])
  const before = new Map(prev.items.map((item) => [item.id, item]))
  const alerts: Alert[] = []

  for (const item of curr.items) {
    if (!chosen.has(item.id)) continue
    const was = before.get(item.id)
    if (!was || was.hash === item.hash) continue

    const { added, removed } = lineDiff(String(was.text), String(item.text))
    if (added.length === 0 && removed.length === 0) continue // reordered only

    alerts.push({
      dedupeKey: `${item.id}:${item.hash}`,
      priority: 'normal',
      title: `${labelFor(item.id)} changed`,
      body: `${summarise(added, removed)} The page is linked; this agent only reports changes.`,
      actionUrl: urlFor(item.id),
    })
  }
  return alerts
}

/** Lines present on one side and not the other — webdog's line-level diff, without the positions. */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const was = new Set(before.split('\n'))
  const now = new Set(after.split('\n'))
  return {
    added: [...now].filter((line) => !was.has(line)),
    removed: [...was].filter((line) => !now.has(line)),
  }
}

function summarise(added: string[], removed: string[]): string {
  const clip = (line: string) => (line.length > 140 ? `${line.slice(0, 139)}…` : line)
  const end = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)
  const parts: string[] = []
  if (added.length > 0) {
    parts.push(end(`Added (${added.length}): ${added.slice(0, PREVIEW_LINES).map(clip).join(' / ')}${added.length > PREVIEW_LINES ? ' …' : ''}`))
  }
  if (removed.length > 0) {
    parts.push(end(`Removed (${removed.length}): ${removed.slice(0, PREVIEW_LINES).map(clip).join(' / ')}${removed.length > PREVIEW_LINES ? ' …' : ''}`))
  }
  return parts.join(' ')
}

// The labels and links live in the manifest's params, which match() does not
// receive — so they are repeated here. A page added to the manifest must be
// added to this table too; a page missing here still alerts, titled by its id
// and without a link.
export const PAGES: Record<string, { label: string; url: string }> = {
  'cs-home': { label: 'Computer Science — department home and news', url: 'https://www.cs.columbia.edu/' },
  'library-news': { label: 'Columbia Libraries — news', url: 'https://library.columbia.edu/about/news.html' },
}
const labelFor = (id: string) => PAGES[id]?.label ?? id
const urlFor = (id: string) => PAGES[id]?.url
