/**
 * The manifest that ships with the code is the truth; the `agents.spec` column
 * is a cache of it.
 *
 * WHY. The runtime and every product screen read `agents.spec`, and only
 * `agent:submit` wrote it. So a manifest edited on disk — a dead board retired,
 * a track added — ran nowhere and showed nowhere until somebody remembered to
 * submit a second time. §11o found the settings page offering a retired firm
 * an hour after the file had dropped it. That is silent wrongness of the worst
 * shape: everything looks fine and the wrong thing runs.
 *
 * The fix is a comparison on every tick, before the run. Same bytes: nothing.
 * Different: the row is rewritten from the file and a line is logged. The file
 * missing: nothing happens and nothing is logged — an agent whose code is not
 * in this deployment is not this deployment's to change. In production the
 * files are inside the function because next.config traces `agents/**`.
 */

import { readFile } from 'node:fs/promises'
import { parseYaml } from './spec-yaml.ts'
import type { AgentSpec } from './types.ts'

export interface ManifestSyncClient {
  from(table: 'agents'): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): Promise<{ data: { spec: unknown } | null; error: { message: string } | null }> }
    }
    update(row: Record<string, unknown>): { eq(column: string, value: string): Promise<{ error: { message: string } | null }> }
  }
}

export type ManifestSyncOutcome = 'unchanged' | 'synced' | 'no-file' | 'no-row'

export async function syncManifestFromDisk(
  client: ManifestSyncClient,
  agentId: string,
  opts: { agentsDir?: string; log?: (line: string) => void } = {},
): Promise<ManifestSyncOutcome> {
  const dir = opts.agentsDir ?? `${process.cwd()}/agents`
  let text: string
  try {
    text = await readFile(`${dir}/${agentId}/agent.yaml`, 'utf8')
  } catch {
    return 'no-file'
  }
  const parsed = parseYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'no-file'
  const spec = parsed as unknown as AgentSpec

  const { data, error } = await client.from('agents').select('spec').eq('id', agentId).maybeSingle()
  if (error) throw new Error(`syncManifestFromDisk(${agentId}): ${error.message}`)
  if (!data) return 'no-row'
  // jsonb stores keys sorted, YAML keeps them as written; compared naively the
  // two never match and the row is rewritten every tick. Canonical form first.
  if (canonical(data.spec) === canonical(spec)) return 'unchanged'

  const row = {
    spec: spec as unknown as Record<string, unknown>,
    name: spec.name,
    tagline: spec.tagline ?? '',
    description: typeof spec.description === 'string' ? spec.description : null,
    category: spec.category ?? 'campus-life',
    pattern: spec.pattern,
    region: spec.region ?? null,
    claude_cant_axes: spec.claude_cant_axes ?? [],
  }
  const { error: updateError } = await client.from('agents').update(row).eq('id', agentId)
  if (updateError) throw new Error(`syncManifestFromDisk(${agentId}): ${updateError.message}`)
  opts.log?.(`[runtime] ${agentId}: manifest on disk differs from agents.spec — synced from disk`)
  return 'synced'
}

/** JSON with every object's keys sorted, recursively — the same bytes for the same document whatever wrote it. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}
