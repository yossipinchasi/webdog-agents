/**
 * "No undeclared network access", read out of the source text.
 *
 * WHY A TEXT SCAN AND NOT A SANDBOX. There is no sandbox in v1 and there should
 * not be one (CLAUDE.md §7: build the interface as if untrusted code will run
 * there, add isolation when someone else's code does). We are the only builder.
 * The runtime already blocks undeclared HOSTS at `ctx.fetch` — what it cannot
 * block is agent code reaching past `ctx` entirely: `globalThis.fetch`, a
 * `node:https` import, `process.env`, a child process. That escape is not
 * detectable at runtime by anything short of isolation, and it is trivially
 * detectable in the source of a file we are about to merge.
 *
 * So this is a REVIEW AID with teeth, not a security boundary, and it is
 * documented as one. It runs on code that is already in the repository and
 * already going through a pull request; what it buys is that the pull request
 * cannot be waved through. When third-party code arrives, this check does not
 * become the defence — isolation does, and this stays as the thing that catches
 * the honest mistake before it gets that far.
 *
 * Every pattern below is deliberately shallow. A scanner that tries to be clever
 * about obfuscation invites an arms race it cannot win and produces false
 * confidence, which is worse than no scanner. It catches what a person writes
 * when they are not thinking about the rule.
 */

export interface ScanFinding {
  path: string
  line: number
  /** The rule that fired. */
  rule: string
  /** The source line, trimmed. */
  text: string
  why: string
}

interface Rule {
  name: string
  pattern: RegExp
  /** A line matching this is not a hit, however well `pattern` fits. */
  unless?: RegExp
  why: string
}

const RULES: Rule[] = [
  {
    name: 'direct-fetch',
    // `ctx.fetch(` and `opts.fetch(` are the sanctioned call. A bare `fetch(`
    // or an explicitly global one is not.
    pattern: /(?:^|[^.\w])(?:globalThis|window|global)\s*\.\s*fetch\s*\(|(?:^|[^.\w])fetch\s*\(/,
    // Every agent EXPORTS a function called `fetch` — it is step 1 of the
    // frozen interface. Declaring it is the contract; calling a bare `fetch` is
    // the escape, and a scanner that cannot tell them apart flags all 200
    // agents on their first line and is switched off by week two.
    unless: /\bfunction\s+fetch\b|\bfetch\s*[:=]\s*(?:async\s*)?\(/,
    why: 'ctx.fetch is the only network access an agent has. It enforces the manifest allowlist; a bare fetch() does not.',
  },
  {
    name: 'node-network',
    pattern: /\b(?:require|from|import)\s*\(?\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/,
    why: 'A network module bypasses ctx.fetch, the allowlist, the rate limiter, the redirect check and the response cap.',
  },
  {
    name: 'process-escape',
    pattern: /\b(?:require|from|import)\s*\(?\s*['"](?:node:)?(?:child_process|worker_threads|vm|fs|fs\/promises)['"]/,
    why: 'Agent code is a spec plus three pure functions. It has no filesystem, no subprocess and no second runtime.',
  },
  {
    name: 'outside-import',
    // An import statement, or a require/dynamic import, of anything at all…
    pattern: /^\s*(?:import|export)\b[^'"]*\bfrom\s*['"][^'"]+['"]|\b(?:require|import)\s*\(\s*['"][^'"]+['"]/,
    // …unless it is the agent's own directory, the runtime's types, or a
    // pattern — or a type-only import, which is erased before anything runs.
    unless:
      /^\s*import\s+type\b|['"](?:\.\/|(?:\.\.\/\.\.\/|@\/)lib\/(?:runtime|patterns)\/)[^'"]*['"]/,
    why: 'An agent imports its own files, lib/runtime and lib/patterns, and nothing else. In the platform repository a relative path reaches the database client and every package we install; in the kit it does not exist, so a check that passed there would have meant nothing here.',
  },
  {
    name: 'env-access',
    pattern: /\bprocess\s*\.\s*env\b|\bDeno\s*\.\s*env\b/,
    why: 'Hard rule 9: secrets live in env vars, and agent code never sees them. Configuration arrives as ctx.params and UserConfig.',
  },
  {
    name: 'dynamic-eval',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    why: 'Code assembled at runtime cannot be reviewed, and reviewing it is the entire v1 isolation model.',
  },
  {
    name: 'wall-clock',
    pattern: /\bDate\s*\.\s*now\s*\(\)|\bnew\s+Date\s*\(\s*\)|\bMath\s*\.\s*random\s*\(/,
    why: 'The clock is injected as ctx.now. A function that reads the wall clock is not deterministic, so its fixtures prove nothing.',
  },
]

/** Lines that are entirely a comment. Cheap, and enough: rules fire on code. */
function isComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

export function scanSource(path: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = []
  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (isComment(line)) return
    const hits = RULES.filter((rule) => !rule.unless?.test(line) && rule.pattern.test(line))
    // `outside-import` is the general rule. When a specific one already says
    // why this import is refused (a network module, the filesystem), that
    // sentence is the one a builder can act on, and saying it twice is noise.
    const specific = hits.filter((rule) => rule.name !== 'outside-import')
    for (const rule of specific.length > 0 ? specific : hits) {
      findings.push({ path, line: index + 1, rule: rule.name, text: line.trim(), why: rule.why })
    }
  })

  return findings
}

export function scanSources(sources: readonly { path: string; text: string }[]): ScanFinding[] {
  return sources.flatMap((file) => scanSource(file.path, file.text))
}

export function formatFinding(finding: ScanFinding): string {
  return `${finding.path}:${finding.line} ${finding.rule} — ${finding.text}`
}
