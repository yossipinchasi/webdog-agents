/**
 * npm run agent:check <agent-id>
 *
 * Every automated check the platform's gate runs, on your machine, writing
 * nothing. The same function our gate calls (lib/submission/prepare.ts), not a
 * copy — the public builder kit is generated from this repository so the two
 * cannot drift (scripts/kit-sync.ts).
 *
 * One check differs, and the report says so: "the deployed runtime can load
 * it" is about our bundle, which you do not have. We add your agent to it when
 * we import your submission.
 */

import { fileURLToPath } from 'node:url'
import { formatSubmission } from '../lib/submission/checks.ts'
import { prepareSubmission } from '../lib/submission/prepare.ts'

const agentId = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
if (!agentId) {
  console.error('usage: npm run agent:check <agent-id>')
  process.exit(2)
}

// fileURLToPath, not .pathname: a path with a space in it comes back
// percent-encoded from .pathname and every open() after it fails.
const agentDir = fileURLToPath(new URL(`../agents/${agentId}`, import.meta.url))
const agentsRoot = fileURLToPath(new URL('../agents', import.meta.url))

const prepared = await prepareSubmission({ agentId, agentDir, agentsRoot })
console.log(`\n${formatSubmission(prepared.report)}\n`)
console.log(
  prepared.report.passed
    ? 'Every automated check passed. Commit, push, and submit the repository link and commit from your builder page.'
    : 'Not yet. Fix what failed above and run it again — nothing here is a judgement about the idea.',
)
process.exit(prepared.report.passed ? 0 : 1)
