/**
 * ctx.fetch — the only network access agent code has.
 *
 * Written as if the agent were untrusted, because in v2 it will be and this
 * boundary should not need rewriting then (ARCHITECTURE.md §Isolation model).
 * What that means concretely:
 *
 *   - Only source ids declared in agent.yaml can be called at all.
 *   - The host comes from the manifest template and can never come from a
 *     parameter. A config value cannot redirect a fetch to another server.
 *   - Redirects are followed manually, and every hop is re-checked against the
 *     allowlist. An open redirect on a declared host is not an escape hatch.
 *   - The response is classified before it is parsed: a login wall, a bot
 *     challenge or a 429 becomes a typed error here, never data that normalize
 *     turns into "zero items".
 *
 * The transport is injectable so the whole file is testable without a network,
 * and so the fixture harness can replay recorded responses through exactly the
 * same code path a live run uses.
 */

import {
  DEFAULT_SOURCE_RETRIES,
  DEFAULT_SOURCE_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  USER_AGENT,
} from './limits.ts'
import { SourceError, isRetryable } from './errors.ts'
import { createLimiterPool, parseCrawlDelay, parseRateLimit } from './rate-limit.ts'
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from './robots.ts'
import { sniffBody, sniffStatus } from './sniff.ts'
import { exceptionAllowsHeader, sourceExceptionFor, type SourceException } from './source-exceptions.ts'
import type { AgentLogger, SourceFetch, SourceSpec } from './types.ts'

export type Transport = (url: string, init: RequestInit) => Promise<Response>

export interface SourceFetchOptions {
  agentId: string
  sources: SourceSpec[]
  /** Defaults to global fetch. Tests and the fixture harness supply their own. */
  transport?: Transport
  /** Aborts the whole run. Composed with the per-request timeout. */
  signal?: AbortSignal
  log?: AgentLogger
  timeoutMs?: number
  retries?: number
  /** 'ignore' is for replaying fixtures offline, never for a live run. */
  robots?: 'enforce' | 'ignore'
  sleep?: (ms: number) => Promise<void>
  limiters?: ReturnType<typeof createLimiterPool>
}

export interface FetchStats {
  requests: number
  bytes: number
  bySource: Record<string, number>
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g

/**
 * Build the fetch handed to agent code, plus the stats the run record wants.
 */
export function createSourceFetch(opts: SourceFetchOptions): {
  fetch: SourceFetch
  stats: FetchStats
} {
  const transport = opts.transport ?? ((url, init) => globalThis.fetch(url, init))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // A pool built here inherits this caller's sleep. Without that, a fetcher
  // given an injected clock still waited on the real one the moment a source
  // declared a crawl_delay.
  const limiters = opts.limiters ?? createLimiterPool({ sleep: (ms) => sleep(ms) })
  const enforceRobots = (opts.robots ?? 'enforce') === 'enforce'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_SOURCE_RETRIES

  const bySourceId = new Map<string, SourceSpec>()
  const allowedHosts = new Set<string>()

  for (const source of opts.sources) {
    const host = templateHost(source)
    bySourceId.set(source.id, source)
    allowedHosts.add(host)
  }

  const robotsCache = new Map<string, Promise<RobotsRules>>()
  const stats: FetchStats = { requests: 0, bytes: 0, bySource: {} }

  const fetchSource: SourceFetch = async (sourceId, params = {}) => {
    const source = bySourceId.get(sourceId)
    if (!source) {
      throw new SourceError(
        'allowlist_violation',
        sourceId,
        `source "${sourceId}" is not declared in the manifest — declared: ${[...bySourceId.keys()].join(', ') || 'none'}`,
      )
    }
    // An owner-granted exception, pinned to this agent, this source and this
    // host. Null for every source but the ones named in source-exceptions.ts.
    const exception = sourceExceptionFor(opts.agentId, source, templateHost(source))
    if (source.tier === 'adversarial' && !exception?.allowAdversarial) {
      // Should never reach here: publish checks reject it. Belt and braces.
      throw new SourceError('allowlist_violation', sourceId, 'adversarial-tier source — rejected in v1 (hard rule 2)')
    }
    if (source.auth && source.auth !== 'none') {
      throw new SourceError('allowlist_violation', sourceId, 'source declares auth — v1 never holds a credential (hard rule 1)')
    }

    const url = buildUrl(source, params, allowedHosts)
    const expectJson = source.type === 'http_json' || source.type === 'api'
    const method = source.method ?? 'GET'
    // A body travels only with a POST, and only the one the manifest declares.
    // Nothing an agent passes at call time can become a request body.
    const postBody = method === 'POST' && source.body ? JSON.stringify(source.body) : undefined

    /**
     * HEADERS THE MANIFEST DECLARES, and a very short list of what may be one.
     *
     * The case this exists for is hotlink protection: Columbia's room grid —
     * and a great many other public endpoints — answers 403 "Invalid Referrer"
     * to a request with no same-site `Referer`, so a source that is genuinely
     * public is unreachable without one. That is a header about WHERE the
     * request came from, not WHO is making it, and the difference is the whole
     * rule below.
     *
     * A header that could carry a credential is refused here even though the
     * submission checks refuse it too. This is the last gate before the socket,
     * and hard rule 1 is not a thing to enforce in one place — a manifest that
     * never passed review still cannot smuggle an Authorization header through
     * a running worker.
     */
    const declaredHeaders = sourceHeaders(source, sourceId, exception)
    const limiter = limiters.for(
      `${opts.agentId}:${sourceId}`,
      parseRateLimit(source.rate_limit),
      parseCrawlDelay(source.crawl_delay),
    )

    let lastError: SourceError | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Jittered backoff between attempts at the same source. This is the
        // small in-run retry; the 1m/5m/15m/1h schedule is between runs.
        await sleep(Math.round(250 * 2 ** (attempt - 1) * (1 + Math.random())))
      }

      await limiter.take(opts.signal)

      try {
        const { body, contentType, finalUrl } = await request(url, {
          transport,
          signal: opts.signal,
          timeoutMs,
          sourceId,
          allowedHosts,
          robots: enforceRobots ? { cache: robotsCache, transport, signal: opts.signal, timeoutMs, log: opts.log } : null,
          expectJson,
          method,
          requestBody: postBody,
          extraHeaders: declaredHeaders,
        })

        stats.requests++
        stats.bytes += body.length
        stats.bySource[sourceId] = (stats.bySource[sourceId] ?? 0) + 1

        if (finalUrl !== url) opts.log?.info(`${sourceId}: followed redirect to ${finalUrl}`)

        if (!expectJson) return body
        try {
          return JSON.parse(body) as unknown
        } catch (cause) {
          throw new SourceError('parse_error', sourceId, 'declared JSON but the body is not JSON', { url, cause })
        }
      } catch (err) {
        const error =
          err instanceof SourceError
            ? err
            : toSourceError(err, sourceId, url)
        lastError = error
        if (attempt < retries && isRetryable(error.kind)) {
          opts.log?.warn(`${sourceId}: ${error.message} — retrying (${attempt + 1}/${retries})`)
          continue
        }
        throw error
      }
    }

    throw lastError ?? new SourceError('fetch_failed', sourceId, 'exhausted retries')
  }

  return { fetch: fetchSource, stats }
}

// ---------- URL construction ----------

/**
 * Extract and validate the host of a source template.
 *
 * A placeholder anywhere in the scheme, host or port is rejected outright: that
 * is the one substitution that would let configuration choose a server, which
 * is exactly the hole the allowlist exists to close.
 */
export function templateHost(source: SourceSpec): string {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(source.url.trim())
  if (!match) {
    throw new Error(`source "${source.id}": url must be an absolute http(s) URL, got ${source.url}`)
  }
  const [, scheme, authority] = match
  if (/[{}]/.test(authority)) {
    throw new Error(`source "${source.id}": the host may not contain a placeholder — a parameter must never choose the server`)
  }
  if (authority.includes('@')) {
    throw new Error(`source "${source.id}": credentials in a URL are never allowed (hard rule 1)`)
  }
  if (scheme.toLowerCase() === 'http') {
    // Allowed, but it is worth a line in the log every time we do it.
    // eslint-disable-next-line no-console
    console.warn(`[runtime] source "${source.id}" is plain http — prefer https`)
  }
  return authority.toLowerCase()
}

export function buildUrl(
  source: SourceSpec,
  params: Record<string, string | number>,
  allowedHosts: ReadonlySet<string>,
): string {
  const used = new Set<string>()

  const substituted = source.url.replace(PLACEHOLDER, (_full, name: string) => {
    if (!(name in params)) {
      throw new SourceError('allowlist_violation', source.id, `missing parameter "${name}" for source url`)
    }
    used.add(name)
    // Encoded, always. A value containing "/../" or "?x=1" must stay a value.
    return encodeURIComponent(String(params[name]))
  })

  const unknown = Object.keys(params).filter((k) => !used.has(k))
  if (unknown.length > 0) {
    // A typo'd param would otherwise silently do nothing, which reads as a
    // filter that quietly stopped applying.
    throw new SourceError('allowlist_violation', source.id, `unused parameter(s): ${unknown.join(', ')}`)
  }

  const url = new URL(substituted)
  assertAllowed(url, source.id, allowedHosts)
  return url.toString()
}

function assertAllowed(url: URL, sourceId: string, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceError('allowlist_violation', sourceId, `blocked protocol ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new SourceError('allowlist_violation', sourceId, 'credentials in a URL are never allowed')
  }
  if (!allowedHosts.has(url.host.toLowerCase())) {
    throw new SourceError(
      'allowlist_violation',
      sourceId,
      `host ${url.host} is not declared by this agent — allowed: ${[...allowedHosts].join(', ')}`,
      { url: url.toString() },
    )
  }
}

// ---------- One request, including redirects and classification ----------

async function request(
  startUrl: string,
  opts: {
    transport: Transport
    signal?: AbortSignal
    timeoutMs: number
    sourceId: string
    allowedHosts: ReadonlySet<string>
    robots: { cache: Map<string, Promise<RobotsRules>>; transport: Transport; signal?: AbortSignal; timeoutMs: number; log?: AgentLogger } | null
    expectJson: boolean
    method?: 'GET' | 'POST'
    requestBody?: string
    extraHeaders?: Record<string, string>
  },
): Promise<{ body: string; contentType: string | null; finalUrl: string }> {
  let url = startUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(url)

    if (opts.robots) {
      const rules = await robotsFor(target, opts.robots)
      if (!isAllowed(rules, target.pathname + target.search)) {
        throw new SourceError('allowlist_violation', opts.sourceId, `robots.txt disallows ${target.pathname}`, { url })
      }
    }

    const signal = composeSignal(opts.signal, opts.timeoutMs)
    const method = opts.method ?? 'GET'
    const response = await opts.transport(url, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.expectJson ? 'application/json, text/plain;q=0.5' : 'text/html, application/xml;q=0.9, text/plain;q=0.5',
        'accept-language': 'en',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        // Last, so a manifest can correct `accept` for a picky endpoint — and
        // never `user-agent`, which identifies us and is not a source's to set.
        ...(opts.extraHeaders ?? {}),
      },
      ...(method === 'POST' && opts.requestBody !== undefined ? { body: opts.requestBody } : {}),
    })

    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new SourceError('http_error', opts.sourceId, `${response.status} with no Location header`, { status: response.status, url })
      }
      const next = new URL(location, url)
      // Every hop is re-checked. An open redirect on a declared host does not
      // become a way out of the allowlist.
      assertAllowed(next, opts.sourceId, opts.allowedHosts)
      url = next.toString()
      continue
    }

    const statusProblem = sniffStatus(response.status)
    if (statusProblem) {
      // A 404 says "check the manifest url", so say which URL. Placeholders are
      // percent-encoded (a param must never rewrite the path), and "owner/name"
      // in one param becomes owner%2Fname — invisible without this.
      const message =
        response.status === 404 || response.status === 410
          ? `${statusProblem.message} (asked for ${url})`
          : statusProblem.message
      throw new SourceError(statusProblem.kind, opts.sourceId, message, { status: response.status, url })
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new SourceError('http_error', opts.sourceId, `response is ${declaredLength} bytes, over the ${MAX_RESPONSE_BYTES} cap`, { url })
    }

    const body = await response.text()
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new SourceError('http_error', opts.sourceId, `response is ${body.length} bytes, over the ${MAX_RESPONSE_BYTES} cap`, { url })
    }

    const contentType = response.headers.get('content-type')
    const bodyProblem = sniffBody(body, { expectJson: opts.expectJson, contentType })
    if (bodyProblem) {
      throw new SourceError(bodyProblem.kind, opts.sourceId, bodyProblem.message, { status: response.status, url })
    }

    return { body, contentType, finalUrl: url }
  }

  throw new SourceError('http_error', opts.sourceId, `more than ${MAX_REDIRECTS} redirects`, { url: startUrl })
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function robotsFor(
  url: URL,
  deps: { cache: Map<string, Promise<RobotsRules>>; transport: Transport; signal?: AbortSignal; timeoutMs: number; log?: AgentLogger },
): Promise<RobotsRules> {
  const origin = url.origin
  const cached = deps.cache.get(origin)
  if (cached) return cached

  const pending = (async () => {
    try {
      const response = await deps.transport(`${origin}/robots.txt`, {
        method: 'GET',
        redirect: 'follow',
        signal: composeSignal(deps.signal, Math.min(deps.timeoutMs, 5000)),
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
      })
      if (response.status === 404 || response.status === 410) return ALLOW_ALL
      if (!response.ok) return ALLOW_ALL
      return parseRobots(await response.text(), USER_AGENT)
    } catch {
      // Fail open on robots itself: a robots.txt we cannot reach is not a
      // refusal, and refusing to poll on it would take an agent down for a
      // reason no operator would ever guess from the run log.
      deps.log?.warn(`could not read ${origin}/robots.txt — proceeding`)
      return ALLOW_ALL
    }
  })()

  deps.cache.set(origin, pending)
  return pending
}

function toSourceError(err: unknown, sourceId: string, url: string): SourceError {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new SourceError('timeout', sourceId, err.message || 'request timed out', { url, cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/timed? ?out|ETIMEDOUT/i.test(message)) {
    return new SourceError('timeout', sourceId, message, { url, cause: err })
  }
  return new SourceError('fetch_failed', sourceId, message, { url, cause: err })
}


/**
 * Headers a source may set, and the ones nothing may.
 *
 * `referer` and `origin` say where a request came from; `accept` and
 * `accept-language` say what shape of answer is wanted. None of them says who
 * anybody is. Everything that could — authorization, cookie, an api key under
 * any of its usual names — is refused, because a source declaring one would be
 * holding a credential, and v1 never holds a credential.
 */
const HEADERS_A_SOURCE_MAY_SET = new Set(['referer', 'origin', 'accept', 'accept-language', 'x-requested-with'])

function sourceHeaders(
  source: SourceSpec,
  sourceId: string,
  exception: SourceException | null = null,
): Record<string, string> | undefined {
  const declared = source.headers
  if (declared === undefined) return undefined
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    throw new SourceError('allowlist_violation', sourceId, 'source.headers must be a map of header names to values')
  }

  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(declared as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    // The exception names the header AND its one value; anything else still
    // falls through to the refusal below.
    if (!HEADERS_A_SOURCE_MAY_SET.has(name) && !exceptionAllowsHeader(exception, name, rawValue)) {
      throw new SourceError(
        'allowlist_violation',
        sourceId,
        `source declares header "${rawName}" — a source may only set ${[...HEADERS_A_SOURCE_MAY_SET].join(', ')} (hard rule 1)`,
      )
    }
    if (typeof rawValue !== 'string') {
      throw new SourceError('allowlist_violation', sourceId, `source header "${rawName}" must be a string`)
    }
    out[name] = rawValue
  }
  return Object.keys(out).length > 0 ? out : undefined
}
