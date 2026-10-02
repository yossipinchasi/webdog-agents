/**
 * npm run agent:record <agent-id> [fixture-name]
 *
 * Hits the agent's real declared sources once and writes exactly what came back
 * to /agents/<id>/fixtures/<name>.json. Those bytes are what `agent:test`
 * replays, so record the interesting moments: a normal day, the day the source
 * is half down, the day it returns a login page.
 *
 * This is the only script here that touches the network, and it goes through
 * the same allowlisted ctx.fetch a production run uses.
 */

import { fileURLToPath } from 'node:url'
import { createDirectoryRegistry } from '../lib/runtime/registry.ts'
import { loadSpec, recordFixture } from '../lib/runtime/harness.ts'

const agentId = process.argv[2]
const name = process.argv[3] ?? 'baseline'
if (!agentId) {
  console.error('usage: npm run agent:record <agent-id> [fixture-name]')
  process.exit(2)
}

// fileURLToPath, not .pathname: a repo path containing a space comes back
// percent-encoded from .pathname and every subsequent open() fails.
const agentDir = fileURLToPath(new URL(`../agents/${agentId}`, import.meta.url))
const agentsRoot = fileURLToPath(new URL('../agents', import.meta.url))

const spec = await loadSpec(agentDir)
const module = await createDirectoryRegistry(agentsRoot).load(agentId)

console.log(`recording ${agentId} from ${(spec.sources ?? []).length} declared source(s)...`)
const { bundle, path, state } = await recordFixture({ agentId, agentDir, spec, module, name })

console.log(`\nwrote ${path}`)
console.log(`  ${bundle.responses.length} response(s), ${state.items.length} item(s) after normalize`)
console.log(`\nnow run: npm run agent:test ${agentId}`)
