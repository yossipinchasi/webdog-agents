/**
 * In-memory RuntimeStore.
 *
 * Backs the loop tests and the offline fixture harness. It reproduces the
 * constraints that matter, not the schema: the alerts unique index on
 * (user_id, agent_id, dedupe_key), and a lock that a second caller cannot take.
 * A test that passes here would pass against Postgres for the same reasons.
 */

import type { AdminEvent, AdminNotifier, AgentStatus, RuntimeStore, RunSummary, SeenKeys, StoredAgent } from './store.ts'
import type { PendingAlert, RunRecord, State, Subscriber } from './types.ts'

export interface MemoryStoreSeed {
  agent: StoredAgent
  subscribers?: Subscriber[]
  state?: State | null
  runs?: RunSummary[]
  alerts?: PendingAlert[]
}

export interface MemoryStore extends RuntimeStore {
  readonly alerts: Array<PendingAlert & { detectedAt: string }>
  readonly runs: RunRecord[]
  readonly statusChanges: AgentStatus[]
  state: State | null
  /** Set true to simulate another worker already running this agent. */
  lockHeld: boolean
  lockAcquisitions: number
}

export function createMemoryStore(seed: MemoryStoreSeed, clock: () => Date = () => new Date()): MemoryStore {
  const alerts: Array<PendingAlert & { detectedAt: string }> = (seed.alerts ?? []).map((a) => ({
    ...a,
    detectedAt: clock().toISOString(),
  }))
  const runs: RunRecord[] = []
  const priorRuns: RunSummary[] = [...(seed.runs ?? [])]
  const statusChanges: AgentStatus[] = []
  const agent = { ...seed.agent }

  const store: MemoryStore = {
    alerts,
    runs,
    statusChanges,
    state: seed.state ?? null,
    lockHeld: false,
    lockAcquisitions: 0,

    async loadAgent(agentId) {
      return agentId === agent.id ? agent : null
    },
    async loadSubscribers() {
      return (seed.subscribers ?? []).map((s) => ({ ...s }))
    },
    async loadState() {
      return store.state
    },
    async saveState(_agentId, state) {
      store.state = state
    },
    async recentRuns(_agentId, limit) {
      return [...runs.map((r) => ({ status: r.status, startedAt: r.startedAt })).reverse(), ...priorRuns].slice(0, limit)
    },
    async recordRun(run) {
      runs.push(run)
    },
    async recentDedupeKeys(agentId, userIds, sinceIso) {
      const since = Date.parse(sinceIso)
      const out = new Map<string, Map<string, string>>()
      for (const userId of userIds) out.set(userId, new Map())
      for (const alert of alerts) {
        if (alert.agentId !== agentId) continue
        const bucket = out.get(alert.userId)
        if (!bucket) continue
        if (Date.parse(alert.detectedAt) < since) continue
        const existing = bucket.get(alert.dedupeKey)
        if (!existing || existing < alert.detectedAt) bucket.set(alert.dedupeKey, alert.detectedAt)
      }
      return out as SeenKeys
    },
    async enqueueAlerts(pending) {
      let inserted = 0
      for (const alert of pending) {
        // The unique index. Once ever, per (user, agent, key).
        const duplicate = alerts.some(
          (a) => a.userId === alert.userId && a.agentId === alert.agentId && a.dedupeKey === alert.dedupeKey,
        )
        if (duplicate) continue
        alerts.push({ ...alert, detectedAt: clock().toISOString() })
        inserted++
      }
      return inserted
    },
    async acquireLock() {
      if (store.lockHeld) return null
      store.lockHeld = true
      store.lockAcquisitions++
      return `token-${store.lockAcquisitions}`
    },
    async releaseLock() {
      store.lockHeld = false
    },
    async setAgentStatus(_agentId, status) {
      agent.status = status
      statusChanges.push(status)
    },
  }

  return store
}

export function createRecordingNotifier(): AdminNotifier & { events: AdminEvent[] } {
  const events: AdminEvent[] = []
  return {
    events,
    async notify(event) {
      events.push(event)
    },
  }
}
