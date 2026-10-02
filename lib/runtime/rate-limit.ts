/**
 * Per-source rate limiting.
 *
 * "Every source declares a rate_limit. The runtime enforces it globally, not
 * per-subscriber" (ARCHITECTURE.md). Since one fetch serves every subscriber,
 * the limiter is per (agent, source) and lives with the worker process.
 *
 * A token bucket, not a sleep-between-calls: bursts are what a fan-out fetch
 * across 26 firm boards actually looks like, and a source that publishes
 * 30/min means thirty in a minute, not one every two seconds.
 */

export interface RateLimit {
  /** Tokens added per second. */
  rate: number
  /** Bucket depth — the largest burst allowed. */
  burst: number
}

/** '60/min', '30/min', '1/s', '1000/hour'. */
export function parseRateLimit(spec: string | undefined): RateLimit | null {
  if (!spec) return null
  const match = /^(\d+(?:\.\d+)?)\s*\/\s*(s|sec|second|m|min|minute|h|hour)$/i.exec(spec.trim())
  if (!match) throw new Error(`unparseable rate_limit: ${spec}`)
  const count = Number(match[1])
  const unit = match[2].toLowerCase()
  const seconds = unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : 3600
  return { rate: count / seconds, burst: Math.max(1, count) }
}

export interface Limiter {
  /** Resolves when a token is available. Rejects if the signal aborts first. */
  take(signal?: AbortSignal): Promise<void>
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted while waiting for rate limit', 'AbortError'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new DOMException('aborted while waiting for rate limit', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * A minimum gap between two requests: '10s', '500ms', '1m'.
 *
 * Separate from `parseRateLimit` because they are different promises. A rate
 * is "no more than N in a window" and permits a burst; a crawl delay is "not
 * again for N seconds" and forbids one.
 */
export function parseCrawlDelay(spec: string | undefined): number | null {
  if (!spec) return null
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|second|m|min|minute)$/i.exec(spec.trim())
  if (!match) throw new Error(`unparseable crawl_delay: ${spec}`)
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  const ms = unit === 'ms' ? value : unit.startsWith('s') ? value * 1000 : value * 60_000
  return ms > 0 ? ms : null
}

/** Injectable clock and sleep so tests never wait on real time. */
export function createLimiter(
  limit: RateLimit | null,
  deps: { now?: () => number; sleep?: Sleep; crawlDelayMs?: number | null } = {},
): Limiter {
  const crawlDelayMs = deps.crawlDelayMs ?? null
  if (!limit && crawlDelayMs === null) return { take: async () => {} }

  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? realSleep

  let tokens = limit ? limit.burst : 0
  let last = now()
  // No request has gone out yet, so the first one waits for nothing. The delay
  // is between two requests, not in front of the first.
  let lastRequestAt: number | null = null

  return {
    async take(signal) {
      // THE SPACING FLOOR, CHECKED ONCE AND THEN TRUSTED.
      //
      // Computed, slept, done — deliberately not re-checked in a loop. The
      // bucket below loops because it is a budget that refills and the clock
      // is the only thing that can grant a token. A gap is not a budget: the
      // wait is known exactly the moment it is asked for.
      //
      // Re-checking it cost 169 seconds of 100% CPU in the fixture harness,
      // which injects a sleep that returns immediately. The loop asked the
      // real clock, saw no time had passed, slept for nothing and asked again
      // — a busy-wait for the full ten seconds, per request. A caller that
      // supplies its own sleep is telling us what waiting means, and this
      // takes it at its word.
      if (crawlDelayMs !== null && lastRequestAt !== null) {
        const since = now() - lastRequestAt
        if (since < crawlDelayMs) await sleep(Math.ceil(crawlDelayMs - since), signal)
      }

      if (limit) {
        const t = now()
        tokens = Math.min(limit.burst, tokens + ((t - last) / 1000) * limit.rate)
        last = t

        if (tokens < 1) {
          // Sleep exactly as long as the missing fraction of a token needs,
          // then take the sleep at its word — for the same reason the gap
          // above does. Looping here re-read a clock the caller may be
          // holding still, and spun.
          await sleep(Math.ceil(((1 - tokens) / limit.rate) * 1000), signal)
          const after = now()
          tokens = Math.min(limit.burst, tokens + ((after - last) / 1000) * limit.rate)
          last = after
          tokens = Math.max(tokens, 1)
        }

        tokens -= 1
      }

      lastRequestAt = now()
    },
  }
}

/** One limiter per (agent, source), created lazily and shared for the process. */
export function createLimiterPool(deps: { now?: () => number; sleep?: Sleep } = {}) {
  const pool = new Map<string, Limiter>()
  return {
    for(key: string, limit: RateLimit | null, crawlDelayMs: number | null = null): Limiter {
      const existing = pool.get(key)
      if (existing) return existing
      const limiter = createLimiter(limit, { ...deps, crawlDelayMs })
      pool.set(key, limiter)
      return limiter
    },
  }
}
