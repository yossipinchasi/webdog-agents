/**
 * Owner exceptions to hard rules 1 and 2 live in the platform, never in an
 * agent and never in this kit. The list is empty here on purpose: an agent
 * that needs one is a conversation, not a manifest line.
 */

import type { SourceSpec } from './types.ts'

export interface SourceException {
  agentId: string
  sourceId: string
  host: string
  allowAdversarial: boolean
  headers: Record<string, string>
  decision: string
}

export const SOURCE_EXCEPTIONS: readonly SourceException[] = []

export function sourceExceptionFor(_agentId: string, _source: SourceSpec, _host: string): SourceException | null {
  return null
}

export function exceptionAllowsHeader(_exception: SourceException | null, _name: string, _value: unknown): boolean {
  return false
}
