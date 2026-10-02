/**
 * Everything a submission decides WITHOUT a database: read the agent, run the
 * harness offline, run every check.
 *
 * Split out of submit.ts so it imports nothing that talks to Supabase. That is
 * what lets the public builder kit (scripts/kit-sync.ts) ship this exact file:
 * a builder's `npm run check` and our gate are the same code, not two copies
 * that drift.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createDirectoryRegistry } from '../runtime/registry.ts'
import { loadFixtures, testAgent, type HarnessReport } from '../runtime/harness.ts'
import { parseYaml } from '../runtime/spec-yaml.ts'
import type { AgentSpec, UserConfig } from '../runtime/types.ts'
import { runChecks } from './checks.ts'
import type { SubmissionInput, SubmissionReport } from './types.ts'

// ------------------------------------------------------------------ reading

/**
 * Parse agent.yaml WITHOUT asserting anything about it.
 *
 * `harness.loadSpec` throws on a bad lease budget, which is right for a worker
 * about to run the thing and wrong here: a submission that throws on the first
 * problem reports one problem. A builder gets the whole list, once, and fixes
 * it in one pass.
 */
export async function readSpec(agentDir: string): Promise<AgentSpec> {
  const text = await readFile(`${agentDir}/agent.yaml`, 'utf8')
  const parsed = parseYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${agentDir}/agent.yaml did not parse to a mapping`)
  }
  return parsed as unknown as AgentSpec
}

/**
 * The agent's own source, for the static scan.
 *
 * Tests are excluded deliberately: a test legitimately reads the clock, builds
 * fixtures and asserts against them, and flagging it teaches people to ignore
 * the scanner. What ships is index.ts and whatever it imports from its own
 * directory.
 */
export async function readAgentSources(agentDir: string): Promise<Array<{ path: string; text: string }>> {
  // Recursive, and every script extension. Top-level `.ts` only meant a
  // `helpers/net.ts` or an `./escape.js` imported from index.ts was never
  // scanned at all — the scan passed on the file that did nothing.
  const entries = await readdir(agentDir, { withFileTypes: true, recursive: true })
  const files = entries
    .filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => relative(agentDir, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split(sep).includes('fixtures') && !path.split(sep).includes('node_modules'))
    .sort()

  return Promise.all(files.map(async (path) => ({ path, text: await readFile(join(agentDir, path), 'utf8') })))
}

async function readSubscribers(agentDir: string): Promise<UserConfig[] | undefined> {
  try {
    return JSON.parse(await readFile(`${agentDir}/subscribers.json`, 'utf8')) as UserConfig[]
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------ the check run

export interface PrepareOptions {
  agentId: string
  agentDir: string
  agentsRoot: string
  /**
   * What the DEPLOYED worker can load (agents/registry.ts), which is not the
   * same as what is on disk. The caller supplies it so this file never imports
   * every agent's code — and so the public builder kit, which has no registry,
   * runs the same function with the check reported as not applicable.
   */
  bundledIds?: readonly string[]
  /** Skip the offline harness. Reported as a failed check, never as a pass. */
  skipHarness?: boolean
  now?: Date
}

export interface PreparedSubmission {
  report: SubmissionReport
  spec: AgentSpec
  harness: HarnessReport | null
}

/**
 * Everything that can be decided without a database: parse, run, check.
 *
 * Runs on a laptop with no network and no Supabase — which is the whole
 * builder developer loop (BUILDERS.md §The developer loop). The database only
 * enters at `submitAgent` below.
 */
export async function prepareSubmission(options: PrepareOptions): Promise<PreparedSubmission> {
  const spec = await readSpec(options.agentDir)
  const sources = await readAgentSources(options.agentDir)

  let harness: HarnessReport | null = null
  let harnessResult: SubmissionInput['harness'] = null
  let exports: SubmissionInput['exports'] = null

  // Loaded once, through the same registry the worker uses, so what is checked
  // is what would run. `assertAgentModule` throws on a module that is not the
  // frozen interface, and that throw is the interface check's answer.
  let module: Awaited<ReturnType<ReturnType<typeof createDirectoryRegistry>['load']>> | null = null
  try {
    module = await createDirectoryRegistry(options.agentsRoot).load(options.agentId)
    exports = {
      fetch: typeof module.fetch === 'function',
      normalize: typeof module.normalize === 'function',
      match: typeof module.match === 'function',
      enrich: module.enrich === undefined ? 'absent' : typeof module.enrich === 'function' ? 'function' : 'not-a-function',
    }
  } catch {
    exports = null
  }

  if (options.skipHarness || module === null) {
    harnessResult = null
  } else {
    try {
      const bundles = await loadFixtures(options.agentDir)
      const subscribers = await readSubscribers(options.agentDir)
      harness = await testAgent({ agentId: options.agentId, spec, module, bundles, subscribers, now: options.now })

      const failed = harness.checks.filter((check) => !check.passed)
      harnessResult = {
        passed: harness.passed,
        detail: harness.passed
          ? `${harness.checks.length} harness check(s) passed over ${harness.runs.length} replayed run(s), fully offline.`
          : failed.map((check) => `${check.name}: ${check.detail}`).join(' · '),
      }
    } catch (error) {
      harnessResult = {
        passed: false,
        detail: `the harness could not run: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const report = runChecks({
    agentId: options.agentId,
    spec,
    sources,
    harness: harnessResult,
    exports,
    bundledIds: options.bundledIds,
  })
  return { report, spec, harness }
}
