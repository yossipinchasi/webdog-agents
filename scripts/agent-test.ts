/**
 * npm run agent:test <agent-id>
 *
 * Runs an agent's three functions through the real execution loop against the
 * fixtures in /agents/<id>/fixtures. No network: the replay transport throws on
 * any URL that was not recorded, so this passes or fails the same way on a
 * plane as it does in CI.
 *
 * Optional /agents/<id>/subscribers.json is an array of user_config objects —
 * one simulated subscriber each. Without it, one subscriber with an empty
 * config is used. It sits BESIDE fixtures/, not inside it: loadFixtures treats
 * every .json in fixtures/ as a recorded bundle.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDirectoryRegistry } from '../lib/runtime/registry.ts'
import { formatReport, loadFixtures, loadSpec, testAgent } from '../lib/runtime/harness.ts'
import type { UserConfig } from '../lib/runtime/types.ts'

const agentId = process.argv[2]
if (!agentId) {
  console.error('usage: npm run agent:test <agent-id>')
  process.exit(2)
}

// fileURLToPath, not .pathname: a repo path containing a space comes back
// percent-encoded from .pathname and every subsequent open() fails.
const agentDir = fileURLToPath(new URL(`../agents/${agentId}`, import.meta.url))
const agentsRoot = fileURLToPath(new URL('../agents', import.meta.url))

const spec = await loadSpec(agentDir)
const module = await createDirectoryRegistry(agentsRoot).load(agentId)
const bundles = await loadFixtures(agentDir)

let subscribers: UserConfig[] | undefined
try {
  subscribers = JSON.parse(await readFile(`${agentDir}/subscribers.json`, 'utf8')) as UserConfig[]
  console.log(`simulating ${subscribers.length} subscriber config(s)`)
} catch {
  console.log('no subscribers.json — simulating one subscriber with an empty config')
}

const report = await testAgent({ agentId, spec, module, bundles, subscribers })
console.log(`\n${formatReport(report)}`)
process.exit(report.passed ? 0 : 1)
