/**
 * The alert template: present, clean, and then locked.
 *
 * BUILDERS.md §Terms, in bold: "Alert templates are locked after review. ⚑
 * Without this, a builder can smuggle *'text me directly at…'* into the alert
 * body and reach every subscriber daily."
 *
 * That sentence describes the only string in the whole system an agent's author
 * writes which reaches every subscriber, unedited, on a schedule. Everything
 * else a builder produces is read by us before anyone sees it. So there are two
 * mechanisms here and they do different jobs:
 *
 *   `scanTemplate`  — refuses copy that carries a contact route at submit time.
 *                     Catches the obvious one. It is a filter, not a proof.
 *   `fingerprint`   — what the lock is taken over. The trigger
 *                     `guard_alert_template_lock` then refuses any later change
 *                     to the alert block, which is the part that actually holds:
 *                     the copy that shipped is the copy that was read.
 *
 * The scan can be evaded by anyone trying. The lock cannot, because after review
 * the string is frozen in the database and changing it is a row an operator has
 * to delete. Non-circumvention is a term in the contract; this is the half of it
 * that does not depend on anybody honouring a contract.
 */

import { createHash } from 'node:crypto'
import type { AgentSpec } from '../runtime/types.ts'
import type { AlertTemplate } from './types.ts'

/**
 * sha256 over `title\nbody\naction_url`.
 *
 * Must stay identical to `alert_template_fingerprint(jsonb)` in
 * 20260824000100_submission.sql — the database compares hashes, and the two
 * sides computing them differently would mean either a lock that never fires or
 * one that fires on every deploy. Priority is deliberately excluded: it is
 * routing, and routing is ours to change.
 */
export function fingerprint(alert: { title?: string; body?: string; action_url?: string } | undefined): string {
  const parts = [alert?.title ?? '', alert?.body ?? '', alert?.action_url ?? '']
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
}

export function templateFrom(spec: AgentSpec): AlertTemplate {
  const alert = spec.alert
  return {
    title: alert?.title ?? '',
    body: alert?.body ?? '',
    actionUrl: alert?.action_url ?? null,
    hash: fingerprint(alert),
  }
}

export interface TemplateProblem {
  field: 'title' | 'body' | 'action_url'
  reason: string
}

/**
 * A contact route inside the copy: a phone number, an email address, a handle,
 * a chat app, or a bare invitation to go around us.
 *
 * `action_url` is exempt from the URL rule and only from that rule — an action
 * URL is the entire point of an alert, and it is a declared field we can see. A
 * URL inside the BODY is different: it is a link nobody reviewed, rendered
 * inside the sentence, next to the one that was.
 */
const CONTACT_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
    reason: 'it contains an email address',
  },
  {
    // +1 555 123 4567, (555) 123-4567, 555.123.4567 — seven digits or more,
    // separated however people separate them.
    pattern: /(?:\+\d[\d\s().-]{7,}\d)|(?:\(\d{3}\)[\s.-]*\d{3}[\s.-]*\d{4})|(?:\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/,
    reason: 'it contains something shaped like a phone number',
  },
  {
    pattern: /\b(?:whatsapp|telegram|signal|discord|dm me|text me|call me|email me|message me|reach me)\b/i,
    reason: 'it invites the subscriber to make contact off-platform',
  },
  {
    pattern: /(?:^|\s)@[A-Za-z0-9_]{3,}/,
    reason: 'it contains a social handle',
  },
]

const URL_PATTERN = /https?:\/\/\S+/i

export function scanTemplate(template: AlertTemplate): TemplateProblem[] {
  const problems: TemplateProblem[] = []

  for (const [field, value] of [
    ['title', template.title],
    ['body', template.body],
  ] as const) {
    for (const rule of CONTACT_RULES) {
      if (rule.pattern.test(value)) problems.push({ field, reason: rule.reason })
    }
    if (URL_PATTERN.test(value)) {
      problems.push({
        field,
        reason: 'it contains a literal URL — links belong in action_url, which is a declared field we can read',
      })
    }
  }

  return problems
}

/**
 * Placeholders the copy interpolates, e.g. `{course_name}`.
 *
 * Not checked against anything: what an agent puts in its State is the agent's
 * business, and a manifest cannot know what `normalize` will produce. They are
 * extracted so a reviewer can see at a glance which parts of the sentence are
 * variable, which is the part of alert copy that is hard to read cold.
 */
export function placeholders(template: AlertTemplate): string[] {
  const found = new Set<string>()
  for (const value of [template.title, template.body, template.actionUrl ?? '']) {
    for (const match of value.matchAll(/\{([a-z0-9_]+)\}/gi)) found.add(match[1])
  }
  return [...found].sort()
}
