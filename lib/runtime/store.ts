/**
 * The ports the execution loop talks to.
 *
 * The loop never imports the Supabase client. It gets a RuntimeStore, and the
 * two implementations — Postgres in production, in-memory in tests and in the
 * fixture harness — satisfy the same shape. That is what makes the ten steps
 * testable end to end without a database, which is the only way the guard tests
 * are worth anything.
 */

import type { AgentSpec, PendingAlert, RunRecord, RunStatus, State, Subscriber } from './types.ts'
import type { FailureKind } from './errors.ts'

export type AgentStatus = 'draft' | 'shadow' | 'live' | 'degraded' | 'disabled'

export interface StoredAgent {
  id: string
  status: AgentStatus
  spec: AgentSpec
}

export interface RunSummary {
  status: RunStatus
  startedAt: string
}

/** Last time each dedupe key was alerted, per user. */
export type SeenKeys = ReadonlyMap<string, ReadonlyMap<string, string>>

export interface RuntimeStore {
  loadAgent(agentId: string): Promise<StoredAgent | null>
  /** Active subscribers only. Config values, never identity beyond the user id the platform needs to route. */
  loadSubscribers(agentId: string): Promise<Subscriber[]>
  loadState(agentId: string): Promise<State | null>
  /** Invariant 3: only ever called after a run with status ok. */
  saveState(agentId: string, state: State): Promise<void>
  /** Newest first. */
  recentRuns(agentId: string, limit: number): Promise<RunSummary[]>
  recordRun(run: RunRecord): Promise<void>
  recentDedupeKeys(agentId: string, userIds: string[], sinceIso: string): Promise<SeenKeys>
  /** Returns how many rows were actually inserted; duplicates are dropped by the unique index. */
  enqueueAlerts(alerts: PendingAlert[]): Promise<number>
  /** Returns a lease token, or null when another worker holds the agent. */
  acquireLock(agentId: string, ttlSeconds: number): Promise<string | null>
  releaseLock(agentId: string, token: string): Promise<void>
  setAgentStatus(agentId: string, status: AgentStatus): Promise<void>
}

export type AdminEvent =
  | {
      type: 'burst_cap'
      agentId: string
      events: number
      alerts: number
      limit: number
      sample: string[]
    }
  | { type: 'degraded'; agentId: string; consecutiveFailures: number; lastError: string }
  | { type: 'agent_error'; agentId: string; kind: FailureKind; message: string }
  | { type: 'alerts_truncated'; agentId: string; users: number; truncated: number }

export interface AdminNotifier {
  notify(event: AdminEvent): Promise<void>
}

/** Default notifier: the run log plus stderr. Session 6 routes these to a human. */
export const consoleNotifier: AdminNotifier = {
  async notify(event) {
    // eslint-disable-next-line no-console
    console.error(`[runtime:admin] ${JSON.stringify(event)}`)
  },
}
