/**
 * The failure taxonomy.
 *
 * Everything that can go wrong between "call the source" and "we have a State"
 * lands in one of these kinds, and every one of them means the same thing to
 * the loop: log an error run and exit before diff. The kinds exist so an
 * operator reading the runs table at 2am can tell a dead source from a changed
 * selector from a rate limit, not so the loop can be clever about any of them.
 */

export type FailureKind =
  /** Network refused, DNS, socket reset — we never got a response. */
  | 'fetch_failed'
  /** We gave up waiting. Slow is indistinguishable from down, and both are not-a-change. */
  | 'timeout'
  /** 429, or a body that says slow down. Back off; do not interpret. */
  | 'rate_limited'
  /** CAPTCHA, bot challenge, WAF block. The source is defending itself. */
  | 'blocked'
  /** A sign-in page where data used to be. Classic "everything disappeared" impostor. */
  | 'login_wall'
  /** Any other non-2xx. */
  | 'http_error'
  /** normalize() threw. The shape changed under us. */
  | 'parse_error'
  /** normalize() returned something that is not a valid State. */
  | 'malformed_state'
  /** Zero items. Almost always a broken selector, never an empty world. */
  | 'empty_state'
  /** Most of the items vanished at once. A partial outage looks exactly like this. */
  | 'item_cliff'
  /** The source is serving us a frozen snapshot. */
  | 'stale_state'
  /** ctx.fetch was asked for a source or host the manifest does not declare. */
  | 'allowlist_violation'
  /** Agent code misbehaved in a way that is not the source's fault. */
  | 'agent_error'
  /** More distinct events than a healthy run can produce. Quarantined for a human. */
  | 'burst_cap'
  /** Another worker holds the lock. */
  | 'locked'

/** Thrown by ctx.fetch. Carries enough to debug the source without the body. */
export class SourceError extends Error {
  readonly kind: FailureKind
  readonly sourceId: string
  readonly status?: number
  readonly url?: string

  constructor(
    kind: FailureKind,
    sourceId: string,
    message: string,
    detail?: { status?: number; url?: string; cause?: unknown },
  ) {
    super(message, detail?.cause ? { cause: detail.cause } : undefined)
    this.name = 'SourceError'
    this.kind = kind
    this.sourceId = sourceId
    this.status = detail?.status
    this.url = detail?.url
  }
}

/** Thrown by the platform when agent code does something it is not allowed to do. */
export class AgentError extends Error {
  readonly kind: FailureKind

  constructor(message: string, kind: FailureKind = 'agent_error', cause?: unknown) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AgentError'
    this.kind = kind
  }
}

/**
 * Map any thrown value to a failure kind.
 *
 * The default is 'fetch_failed', not 'ok'. Every unknown failure is treated as
 * "we did not see the world", because the alternative — treating it as "the
 * world is empty" — is the one failure this product cannot recover from.
 */
export function classifyError(err: unknown): { kind: FailureKind; message: string } {
  if (err instanceof SourceError) {
    return { kind: err.kind, message: describe(err) }
  }
  if (err instanceof AgentError) {
    return { kind: err.kind, message: err.message }
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return { kind: 'timeout', message: err.message || 'timed out' }
  }
  if (err instanceof Error) {
    const name = err.name
    const text = `${name}: ${err.message}`
    if (name === 'TimeoutError' || /timed? ?out|ETIMEDOUT/i.test(text)) {
      return { kind: 'timeout', message: err.message }
    }
    if (name === 'AbortError' || /aborted/i.test(text)) {
      return { kind: 'timeout', message: err.message || 'aborted' }
    }
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(text)) {
      return { kind: 'fetch_failed', message: err.message }
    }
    return { kind: 'fetch_failed', message: err.message || name }
  }
  return { kind: 'fetch_failed', message: String(err) }
}

function describe(err: SourceError): string {
  const parts = [err.message]
  if (err.status !== undefined) parts.push(`status=${err.status}`)
  if (err.sourceId) parts.push(`source=${err.sourceId}`)
  return parts.join(' ')
}

/** True for failures where trying again shortly is reasonable. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'fetch_failed' || kind === 'timeout' || kind === 'http_error'
}
