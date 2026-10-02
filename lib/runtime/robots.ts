/**
 * robots.txt, minimally and honestly.
 *
 * "Respect robots.txt and send an honest User-Agent with a contact URL. We are
 * a good citizen; it's cheaper than the alternative" (ARCHITECTURE.md).
 *
 * Supports the parts that actually appear in the wild: User-agent groups,
 * Allow, Disallow, and `*`/`$` wildcards, longest-match-wins. Crawl-delay is
 * read but the declared rate_limit governs — a source that asks for slower than
 * we declared should have its manifest changed, visibly, not be silently slowed.
 */

export interface RobotsRules {
  /** Longest matching rule wins; ties go to Allow. */
  rules: Array<{ allow: boolean; pattern: string }>
  crawlDelaySeconds: number | null
}

export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelaySeconds: null }

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase()
  const groups: Array<{ agents: string[]; rules: RobotsRules['rules']; crawlDelay: number | null }> = []
  let current: (typeof groups)[number] | null = null
  let lastLineWasAgent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastLineWasAgent = true
      continue
    }
    lastLineWasAgent = false
    if (!current) continue
    if (field === 'disallow') current.rules.push({ allow: false, pattern: value })
    else if (field === 'allow') current.rules.push({ allow: true, pattern: value })
    else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n)) current.crawlDelay = n
    }
  }

  // Most specific group wins: a group naming us beats the wildcard group.
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)))
  const wildcard = groups.find((g) => g.agents.includes('*'))
  const chosen = named ?? wildcard
  if (!chosen) return ALLOW_ALL
  return { rules: chosen.rules, crawlDelaySeconds: chosen.crawlDelay }
}

export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { allow: boolean; length: number } | null = null

  for (const rule of rules.rules) {
    // An empty Disallow means "allow everything" and matches nothing.
    if (rule.pattern === '') continue
    if (!matches(rule.pattern, pathWithQuery)) continue
    const length = rule.pattern.length
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length }
    }
  }

  return best ? best.allow : true
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path)
}
