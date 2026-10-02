/**
 * A strict YAML subset, just large enough for agent.yaml.
 *
 * The runtime reads a spec from the database (agents.spec is the parsed
 * manifest). This parser exists for the two places that read the file itself:
 * the offline fixture harness, and the publish pipeline that puts the manifest
 * into the database in the first place.
 *
 * It is deliberately small and deliberately loud. It supports block maps, block
 * sequences, flow maps, flow sequences, quoted and bare scalars, and comments —
 * the grammar every manifest in AGENT-SPEC.md actually uses. Anything else
 * (anchors, block scalars, multi-document files) throws with a line number
 * rather than being half-parsed into a manifest we then act on.
 *
 * Pulling in a real YAML dependency later is fine; the export shape will not
 * change.
 */

import type { JsonValue } from './types.ts'

export function parseYaml(text: string): JsonValue {
  const lines = tokenize(text)
  if (lines.length === 0) return {}
  const [value, next] = parseBlock(lines, 0, lines[0].indent)
  if (next < lines.length) {
    throw new YamlError(`unexpected content`, lines[next].line)
  }
  return value
}

export class YamlError extends Error {
  constructor(message: string, line: number) {
    super(`agent.yaml line ${line}: ${message}`)
    this.name = 'YamlError'
  }
}

interface Line {
  indent: number
  content: string
  line: number
}

function tokenize(text: string): Line[] {
  const out: Line[] = []
  const raw = text.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\s*---\s*$/.test(line)) continue
    if (line.includes('\t')) throw new YamlError('tabs are not valid indentation', i + 1)
    const indent = line.length - line.trimStart().length
    const content = stripComment(line.trim())
    if (content === '') continue
    if (/(^|\s)[|>][-+]?\s*$/.test(content)) {
      throw new YamlError('block scalars (| and >) are not supported by this parser', i + 1)
    }
    if (/^[*&]/.test(content)) {
      throw new YamlError('anchors and aliases are not supported by this parser', i + 1)
    }
    out.push({ indent, content, line: i + 1 })
  }
  return out
}

/** Strip a trailing `# comment`, respecting quotes. */
function stripComment(content: string): string {
  let quote: string | null = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(content[i - 1]))) {
      return content.slice(0, i).trimEnd()
    }
  }
  return content
}

function parseBlock(lines: Line[], start: number, indent: number): [JsonValue, number] {
  if (start >= lines.length) return [null, start]
  return lines[start].content.startsWith('- ') || lines[start].content === '-'
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent)
}

function parseMapping(lines: Line[], start: number, indent: number): [JsonValue, number] {
  const map: Record<string, JsonValue> = {}
  let i = start

  while (i < lines.length && lines[i].indent >= indent) {
    if (lines[i].indent > indent) throw new YamlError('unexpected indentation', lines[i].line)
    const { content, line } = lines[i]
    const split = splitKey(content)
    if (!split) throw new YamlError(`expected "key: value", got "${content}"`, line)
    const [key, rest] = split

    if (rest === '') {
      // Nested block, or an empty value at the end of the file.
      const child = i + 1
      if (child < lines.length && lines[child].indent > indent) {
        const [value, next] = parseBlock(lines, child, lines[child].indent)
        map[key] = value
        i = next
        continue
      }
      map[key] = null
      i++
      continue
    }

    map[key] = parseScalar(rest, line)
    i++
  }

  return [map, i]
}

function parseSequence(lines: Line[], start: number, indent: number): [JsonValue, number] {
  const seq: JsonValue[] = []
  let i = start

  while (i < lines.length && lines[i].indent === indent && (lines[i].content.startsWith('- ') || lines[i].content === '-')) {
    const { content, line } = lines[i]
    const rest = content === '-' ? '' : content.slice(2).trim()

    if (rest === '') {
      const child = i + 1
      if (child < lines.length && lines[child].indent > indent) {
        const [value, next] = parseBlock(lines, child, lines[child].indent)
        seq.push(value)
        i = next
        continue
      }
      seq.push(null)
      i++
      continue
    }

    // `- key: value` opens a map whose remaining keys are indented past the dash.
    const split = splitKey(rest)
    if (split && !rest.startsWith('{') && !rest.startsWith('[')) {
      // Continuation keys sit under the character after the dash, i.e. indent+2.
      const itemIndent = indent + 2
      const synthetic: Line[] = [{ indent: itemIndent, content: rest, line }]
      let j = i + 1
      while (j < lines.length && lines[j].indent > indent) {
        synthetic.push(lines[j])
        j++
      }
      const [value] = parseMapping(synthetic, 0, itemIndent)
      seq.push(value)
      i = j
      continue
    }

    seq.push(parseScalar(rest, line))
    i++
  }

  return [seq, i]
}

function splitKey(content: string): [string, string] | null {
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ':' && depth === 0 && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      return [unquote(content.slice(0, i).trim()), content.slice(i + 1).trim()]
    }
  }
  return null
}

export function parseScalar(raw: string, line: number): JsonValue {
  const value = raw.trim()
  if (value === '' || value === '~' || value === 'null') return null
  if (value === 'true' || value === 'yes') return true
  if (value === 'false' || value === 'no') return false

  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new YamlError('unterminated flow sequence', line)
    return splitFlow(value.slice(1, -1)).map((part) => parseScalar(part, line))
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new YamlError('unterminated flow mapping', line)
    const map: Record<string, JsonValue> = {}
    for (const part of splitFlow(value.slice(1, -1))) {
      const split = splitKey(part)
      if (!split) throw new YamlError(`expected "key: value" inside { }, got "${part}"`, line)
      map[split[0]] = parseScalar(split[1], line)
    }
    return map
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value)
  }
  // An anchor or alias parsed as a plain string would put "&thing" into a
  // manifest and nobody would notice until the agent ran against it.
  if (/^[*&][A-Za-z0-9_-]/.test(value)) {
    throw new YamlError('anchors and aliases are not supported by this parser', line)
  }
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d*\.\d+$/.test(value)) return Number(value)
  return value
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      if (current.trim() !== '') parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}
