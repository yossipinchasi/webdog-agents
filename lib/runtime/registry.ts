/**
 * STEP 1 (half of it) — resolving agent code.
 *
 * The loop is handed a registry rather than importing agents itself, so the
 * same loop runs a real agent from /agents, a fixture replay, and a synthetic
 * agent in a test. In v2 this is also the seam where "load a module" becomes
 * "call an isolated function", with nothing above it changing.
 */

import { pathToFileURL } from 'node:url'
import { AgentError } from './errors.ts'
import type { AgentModule } from './types.ts'

export interface AgentRegistry {
  load(agentId: string): Promise<AgentModule>
}

/**
 * Reject anything that is not the frozen interface before it can run. A module
 * missing `match` should fail at load, not halfway through a run with the lock
 * held — and an `enrich` that is present but not callable should fail here too,
 * rather than after the fetch has been paid for.
 */
export function assertAgentModule(agentId: string, candidate: unknown): AgentModule {
  const m = candidate as Partial<AgentModule> | null
  if (!m || typeof m !== 'object') {
    throw new AgentError(`agent "${agentId}" did not export a module`)
  }
  for (const fn of ['fetch', 'normalize', 'match'] as const) {
    if (typeof m[fn] !== 'function') {
      throw new AgentError(
        `agent "${agentId}" is missing export "${fn}" — the interface is fetch/normalize/match, plus an optional enrich`,
      )
    }
  }
  if (m.enrich !== undefined && typeof m.enrich !== 'function') {
    throw new AgentError(`agent "${agentId}" exports "enrich" but it is not a function`)
  }
  return m as AgentModule
}

export function createStaticRegistry(modules: Record<string, unknown>): AgentRegistry {
  return {
    async load(agentId) {
      if (!(agentId in modules)) throw new AgentError(`agent "${agentId}" is not registered`)
      return assertAgentModule(agentId, modules[agentId])
    },
  }
}

/** Loads /agents/<id>/index.ts. Used by the worker and by `npm run agent:test`. */
export function createDirectoryRegistry(baseDir: string): AgentRegistry {
  return {
    async load(agentId) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        throw new AgentError(`invalid agent id: ${agentId}`)
      }
      const url = pathToFileURL(`${baseDir}/${agentId}/index.ts`).href
      const module = (await import(url)) as Record<string, unknown>
      return assertAgentModule(agentId, module.default ?? module)
    },
  }
}
