/**
 * example-releases — the kit's worked example.
 *
 * Three functions. The platform owns scheduling, retries, dedup, delivery and
 * health. What is here is only what nobody else can know: which call to make,
 * how to read the answer, and what counts as news.
 */

import { newListingWatcher } from '../../lib/patterns/index.ts'
import type { AgentContext, State, StateItem } from '../../lib/runtime/types.ts'

interface Release {
  id: number
  tag_name: string
  name: string | null
  html_url: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
}

// ---------- 1. fetch ----------

/** One call per project per poll — never one per subscriber. */
export async function fetch(ctx: AgentContext): Promise<unknown> {
  const repos = (ctx.params.repos ?? []) as string[]
  const results: Record<string, unknown> = {}
  for (const repo of repos) {
    try {
      const [owner, name] = repo.split('/')
      results[repo] = await ctx.fetch('releases', { owner, name })
    } catch (error) {
      // One project failing is not every project failing. Record it and keep
      // going; normalize() decides whether what is left is enough.
      ctx.log.warn(`releases for ${repo} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (Object.keys(results).length === 0) throw new Error('every project failed — no snapshot taken')
  return { results, fetchedAt: ctx.now.toISOString() }
}

// ---------- 2. normalize ----------

/** Pure. Throws on anything it does not understand rather than guessing. */
export function normalize(raw: unknown): State {
  const { results, fetchedAt } = raw as { results: Record<string, unknown>; fetchedAt: string }
  const items: StateItem[] = []

  for (const [repo, body] of Object.entries(results)) {
    if (!Array.isArray(body)) throw new Error(`normalize: ${repo} did not answer with a list`)
    for (const release of body as Release[]) {
      if (release.draft || release.prerelease) continue
      items.push({
        id: `${repo}#${release.id}`,
        repo,
        version: release.name || release.tag_name,
        url: release.html_url,
        postedAt: release.published_at ?? undefined,
      })
    }
  }

  if (items.length === 0) throw new Error('normalize: parsed to zero releases — the source format changed')
  return { items, fetchedAt }
}

// ---------- 3. match ----------

/**
 * A release is news exactly once — the first time its id appears — and only
 * for someone who picked that project. The pattern does the diff, the
 * first-run silence and the dedupe key.
 */
export const match = newListingWatcher({
  filters: [{ configKey: 'repos', itemField: 'repo', op: 'in' }],
  alert: {
    title: '{repo} {version}',
    body: '{repo} published {version}. The release notes are linked; upgrading is up to you.',
    urlField: 'url',
  },
  maxAgeHours: 24 * 14,
  postedAtField: 'postedAt',
})
