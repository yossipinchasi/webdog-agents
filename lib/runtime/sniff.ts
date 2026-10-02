/**
 * Response sniffing — the guard's first line, run before anything is parsed.
 *
 * A source under stress rarely has the courtesy to return a 5xx. It returns 200
 * with a login page, a bot challenge, a maintenance notice, or an empty shell
 * that renders its content in JavaScript we do not run. Every one of those
 * parses to "zero items" if you let it through, and zero items reaching diff is
 * how a platform blasts every subscriber at once.
 *
 * So: classify the body BEFORE normalize ever sees it.
 *
 * Pure, and deliberately conservative — a false "blocked" costs one skipped
 * poll, and the run log says exactly why.
 */

import type { FailureKind } from './errors.ts'

/** A bot wall / challenge page. */
const CHALLENGE = [
  /just a moment\s*\.{0,3}\s*<\/title>/i,
  /<title>[^<]*attention required[^<]*<\/title>/i,
  /cf[-_]?(chl|challenge)[-_]?(opt|jsch|form)/i,
  /(enable (javascript|js) and cookies to continue)/i,
  /(g-)?recaptcha|hcaptcha|px-captcha|captcha-delivery/i,
  /access denied.{0,80}(request id|reference number|akamai|incapsula|perimeterx)/is,
  /<title>[^<]*(are you a (robot|human)|bot verification)[^<]*<\/title>/i,
]

/** A sign-in page where data used to be. */
const LOGIN_WALL = [
  /<input[^>]+type=["']?password["']?/i,
  /<form[^>]+(action|id|name)=["'][^"']*(login|signin|sign-in|auth)[^"']*["']/i,
  /<title>[^<]*(sign in|log in|login|authentication required)[^<]*<\/title>/i,
  /"error"\s*:\s*"(unauthorized|unauthenticated|invalid[_ ]token|forbidden)"/i,
  /please (log ?in|sign ?in) to (continue|view|access)/i,
]

/** The source telling us to slow down, in a 200. */
const RATE_LIMIT_BODY = [
  /rate limit(ed| exceeded)?/i,
  /too many requests/i,
  /"error"\s*:\s*"(rate_limited|throttled)"/i,
]

/** A maintenance page. Real, temporary, and not a change in the world. */
const MAINTENANCE = [
  /<title>[^<]*(maintenance|temporarily unavailable|be right back)[^<]*<\/title>/i,
  /(scheduled|planned) maintenance/i,
]

export interface SniffResult {
  kind: FailureKind
  message: string
}

/**
 * Classify an HTTP status. `null` means the status itself is fine.
 */
export function sniffStatus(status: number): SniffResult | null {
  if (status >= 200 && status < 300) return null
  if (status === 429) return { kind: 'rate_limited', message: 'source returned 429' }
  if (status === 401 || status === 407) {
    return { kind: 'login_wall', message: `source returned ${status} — it wants credentials we do not have and will never store` }
  }
  if (status === 403) {
    return { kind: 'blocked', message: 'source returned 403 — blocked, not empty' }
  }
  if (status === 404 || status === 410) {
    // The URL moved. That is a broken agent, not a world where nothing exists.
    return { kind: 'http_error', message: `source returned ${status} — the endpoint is gone, check the manifest url` }
  }
  return { kind: 'http_error', message: `source returned ${status}` }
}

/**
 * Classify a 200 body. `null` means it looks like real data.
 *
 * `expectJson` comes from the source's declared type: an HTML document where
 * JSON was promised is by itself enough to stop, whatever it contains.
 */
export function sniffBody(
  body: string,
  opts: { expectJson: boolean; contentType?: string | null },
): SniffResult | null {
  const head = body.slice(0, 8192)

  if (body.trim() === '') {
    return { kind: 'empty_state', message: 'source returned an empty body with a 2xx' }
  }

  for (const pattern of CHALLENGE) {
    if (pattern.test(head)) return { kind: 'blocked', message: 'response looks like a bot challenge page' }
  }
  for (const pattern of RATE_LIMIT_BODY) {
    if (pattern.test(head)) return { kind: 'rate_limited', message: 'response body says we are rate limited' }
  }
  for (const pattern of LOGIN_WALL) {
    if (pattern.test(head)) return { kind: 'login_wall', message: 'response looks like a sign-in page, not data' }
  }
  for (const pattern of MAINTENANCE) {
    if (pattern.test(head)) return { kind: 'http_error', message: 'response looks like a maintenance page' }
  }

  if (opts.expectJson) {
    const type = opts.contentType ?? ''
    const looksHtml = /^\s*(<!doctype|<html|<\?xml)/i.test(head)
    if (looksHtml || /text\/html/i.test(type)) {
      return { kind: 'blocked', message: `expected JSON, got ${looksHtml ? 'an HTML document' : type} — the endpoint is answering something other than data` }
    }
  }

  return null
}
