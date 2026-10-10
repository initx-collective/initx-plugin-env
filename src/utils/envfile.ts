import type { Stats } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'

/**
 * Parsing / merging helpers for `.env` files; no third-party dependency, only
 * `node:*` builtins. The numbered semantics below are hard requirements and each
 * one is pinned by a test in `src/__tests__/envfile.test.ts`.
 *
 * 1. `KEY=value` / `KEY = value` / `export KEY=value` parse; the `export `
 *    prefix is remembered and kept when the line is rewritten.
 * 2. Values are unquoted, single quoted (verbatim, no escapes at all) or double
 *    quoted (`\n` `\r` `\t` `\"` `\\` unescaped).
 * 3. An unquoted value is right trimmed and cut at the first "blank + `#`" like
 *    dotenv (`KEY=abc # note` -> `abc`); quoted values are never cut, so
 *    `KEY="abc # note"` -> `abc # note`.
 * 4. A line whose first non-blank character is `#` is a comment, kept verbatim.
 * 5. Blank lines are kept verbatim.
 * 6. A double quoted value may span lines (SSH keys, JSON): an unterminated `"`
 *    keeps swallowing the following lines into the same pair, and those
 *    newlines come back as real `\n`, re-escaped on write.
 * 7. Unrecognised lines (`FOO BAR`) stay verbatim and never become a pair.
 * 8. Duplicate keys: `pairs` keeps the LAST value, the key lands in
 *    `duplicates`, and a merge rewrites only the LAST occurrence.
 * 9. The original EOL (`\n` / `\r\n`) and whether the file ends with a newline
 *    are preserved. An empty file has no EOL hint, so `mergeEnv` falls back to
 *    the `renderEnvFile` default (`\n`).
 */
export interface EnvPair {
  key: string
  value: string
  exportPrefix: boolean
  quote: 'none' | 'single' | 'double'
  raw: string
  /** 0-based line index into `EnvParseResult.lines` (inclusive) */
  startLine: number
  /** 0-based line index of the LAST physical line of this pair (inclusive) */
  endLine: number
}
export interface EnvParseResult {
  lines: string[]
  pairs: Map<string, string>
  duplicates: string[]
  eol: '\n' | '\r\n'
  trailingNewline: boolean
  /** Recognised assignments in file order; a multi-line pair is one entry. */
  entries: EnvPair[]
}
export interface MergeResult {
  content: string
  added: string[]
  updated: string[]
  unchanged: string[]
  duplicates: string[]
  changed: boolean
}
export interface EnvDiff {
  added: string[]
  updated: string[]
  unchanged: string[]
  localOnly: string[]
}

// Everything before the FIRST `=` is the key, so `FOO BAR` (no `=`) never matches
// while `FOO BAR=1` does; `readKey` then right-trims it so `KEY = value` works.
//
// The `export ` prefix is stripped by its own pattern instead of being part of
// PAIR_PATTERN: written as `^(?:export[ \t]+)?([^=]*)=` the two parts compete for
// the same blanks, which is textbook super-linear backtracking (eslint's
// regexp/no-super-linear-backtracking flags it, correctly).
const EXPORT_PREFIX_PATTERN = /^export[ \t]+/
const PAIR_PATTERN = /^([^=]*)=(.*)$/

/**
 * Key text before `=` with its trailing blanks removed. A key may not be empty,
 * so `=1` is not a pair, and (like dotenv) a line that starts with a blank before
 * the key is not a pair either: `  A=1` stays verbatim.
 */
function readKey(text: string): string | null {
  const key = text.replace(/[ \t]+$/, '')
  return key === '' || /^[ \t]/.test(key) ? null : key
}
const COMMENT_PATTERN = /^[ \t]*#/

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  }
  catch (error) {
    if (isNotFoundError(error))
      return null
    throw error
  }
}

function unescapeDouble(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match: string, char: string) =>
    char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char)
}

/**
 * Rule 3 for the raw text after `=` of an unquoted value: the blanks directly
 * after `=` are ignored (`KEY= value` -> `value`), the value is right trimmed and
 * cut at the first "blank + `#`". Searched per line so `\s` (which also matches
 * `\n`) can never cross into an absorbed line.
 */
function parseUnquoted(raw: string): string {
  const text = raw.replace(/^[ \t]+/, '')
  for (const line of text.split('\n')) {
    const match = /[ \t]#/.exec(line)
    if (match !== null)
      return line.slice(0, match.index).replace(/[ \t]+$/, '')
  }
  return text.replace(/[ \t]+$/, '')
}

function splitLines(content: string): string[] {
  // An empty file has no lines at all (as opposed to one empty line).
  if (content === '')
    return []
  const lines = content.split(/\r?\n/)
  // A newline-terminated file always yields one trailing empty element.
  if (content.endsWith('\n'))
    lines.pop()
  return lines
}

/**
 * Index of the closing `"` of a double quoted body, or -1. An escaped `\"` does
 * not close the value, which is what lets a JSON or SSH key value carry quotes.
 */
function findClosingQuote(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === '"')
      return i
  }
  return -1
}

/**
 * Line-level parser. Rule 6 advances past every absorbed line, so the caller
 * resumes on the line after the pair.
 */
function readEntry(lines: string[], index: number): EnvPair | null {
  const raw = lines[index]
  if (COMMENT_PATTERN.test(raw))
    return null
  const exportPrefix = EXPORT_PREFIX_PATTERN.test(raw)
  const match = PAIR_PATTERN.exec(exportPrefix ? raw.replace(EXPORT_PREFIX_PATTERN, '') : raw)
  if (match === null)
    return null
  const key = readKey(match[1])
  if (key === null)
    return null
  const body = match[2]
  let endLine = index
  let quote: EnvPair['quote'] = 'none'
  let value: string
  if (body.startsWith('"')) {
    // Rule 6: keep swallowing lines until the closing quote or the EOF.
    let chunk = body.slice(1)
    let close = findClosingQuote(chunk)
    while (close === -1 && endLine + 1 < lines.length) {
      endLine += 1
      chunk += `\n${lines[endLine]}`
      close = findClosingQuote(chunk)
    }
    quote = 'double'
    value = unescapeDouble(close === -1 ? chunk : chunk.slice(0, close))
  }
  else if (body.startsWith('\'')) {
    // Rule 2: a single quoted value is verbatim - no unescaping, no comment cut
    // and no trimming - it simply ends at the first `'`.
    const close = body.indexOf('\'', 1)
    quote = 'single'
    value = close === -1 ? body.slice(1) : body.slice(1, close)
  }
  else {
    value = parseUnquoted(body)
  }
  return { key, value, exportPrefix, quote, raw, startLine: index, endLine }
}

export function parseEnv(content: string): EnvParseResult {
  const eol: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = content.endsWith('\n')
  const lines = splitLines(content)
  const pairs = new Map<string, string>()
  const duplicates: string[] = []
  const entries: EnvPair[] = []
  for (let index = 0; index < lines.length;) {
    const entry = readEntry(lines, index)
    if (entry === null) {
      index += 1
      continue
    }
    // Rule 8: the LAST occurrence wins, the key is listed once in `duplicates`.
    if (pairs.has(entry.key) && !duplicates.includes(entry.key))
      duplicates.push(entry.key)
    pairs.set(entry.key, entry.value)
    entries.push(entry)
    index = entry.endLine + 1
  }
  return { lines, pairs, duplicates, eol, trailingNewline, entries }
}

/**
 * Safe as a plain unquoted value: nothing rule 3 would eat or mangle survives.
 * Rejected are empty values, anything containing whitespace (a space would break
 * `source .env` in a shell, and ` #` would be cut by rule 3), and the characters
 * a shell would interpret (`"` `'` `\` `$` `` ` `` `#`) — quoting them keeps the
 * file safe to source as well as to re-parse.
 */
const NEEDS_QUOTING = /[\s"'\\#$`]/

function canBeUnquoted(value: string): boolean {
  return value !== '' && !NEEDS_QUOTING.test(value)
}

function renderValue(value: string): string {
  if (canBeUnquoted(value))
    return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** The `export ` prefix is kept on a rewritten line; an appended line is plain. */
function renderKeyValue(key: string, value: string, exportPrefix: boolean): string {
  return `${exportPrefix ? 'export ' : ''}${key}=${renderValue(value)}`
}

function joinLines(lines: string[], eol: '\n' | '\r\n', trailingNewline: boolean): string {
  return `${lines.join(eol)}${trailingNewline ? eol : ''}`
}

function planChanges(original: string, updates: Record<string, string>): { added: string[], updated: string[], unchanged: string[], target: Map<string, string> } {
  const { pairs } = parseEnv(original)
  const added: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []
  const target = new Map<string, string>()
  for (const [key, value] of Object.entries(updates)) {
    target.set(key, value)
    if (!pairs.has(key))
      added.push(key)
    else if (pairs.get(key) === value)
      // Idempotency: the effective value already matches, so nothing is written.
      unchanged.push(key)
    else
      updated.push(key)
  }
  return { added, updated, unchanged, target }
}

export function mergeEnv(original: string, updates: Record<string, string>): MergeResult {
  // An empty file carries no EOL / trailing-newline hint, so render it fresh.
  if (original === '') {
    const content = renderEnvFile(updates)
    return { content, added: Object.keys(updates), updated: [], unchanged: [], duplicates: [], changed: content !== original }
  }
  const parse = parseEnv(original)
  const { added, updated, unchanged, target } = planChanges(original, updates)
  const lines = parse.lines
  const lastOf = new Map<string, number>()
  parse.entries.forEach((entry, position) => lastOf.set(entry.key, position))
  // Rewritten back to front: collapsing a multi-line pair (rule 6) must not
  // shift the line indices of a pair that appears after it.
  for (let position = parse.entries.length - 1; position >= 0; position -= 1) {
    const entry = parse.entries[position]
    if (lastOf.get(entry.key) !== position)
      continue // Rule 8: an earlier duplicate keeps its own line untouched.
    const value = target.get(entry.key)
    // Unchanged pairs are left byte-identical, which is what keeps the merge
    // idempotent: normalising a multi-line value (rule 6) would otherwise rewrite
    // the file on the second run.
    if (value === undefined || value === entry.value)
      continue
    // Only the first physical line is replaced; the absorbed lines are dropped,
    // so the pair collapses back into a single line.
    const rendered = renderKeyValue(entry.key, value, entry.exportPrefix)
    lines.splice(entry.startLine, entry.endLine - entry.startLine + 1, rendered)
  }
  if (added.length > 0) {
    // Appended keys have no source line, so they can only be plain `KEY=value`.
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '')
      lines.push('')
    for (const key of added)
      lines.push(renderKeyValue(key, updates[key], false))
  }
  const content = joinLines(lines, parse.eol, parse.trailingNewline)
  return { content, added, updated, unchanged, duplicates: parse.duplicates, changed: content !== original }
}

export function renderEnvFile(updates: Record<string, string>, eol: '\n' | '\r\n' = '\n'): string {
  const lines = Object.entries(updates).map(([key, value]) => renderKeyValue(key, value, false))
  if (lines.length === 0)
    return ''
  // Always newline-terminated: this is a freshly generated file.
  return joinLines(lines, eol, true)
}

export function diffEnv(original: string, updates: Record<string, string>): EnvDiff {
  const { added, updated, unchanged } = planChanges(original, updates)
  const localOnly = [...parseEnv(original).pairs.keys()].filter(key => !(key in updates))
  return { added, updated, unchanged, localOnly }
}

export async function readEnvFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (isNotFoundError(error))
      return null
    throw error
  }
}

export async function writeEnvFileWithBackup(path: string, content: string): Promise<{ backupPath: string | null }> {
  const info = await statOrNull(path)
  // Only an existing file whose bytes actually differ is worth a backup; a
  // missing one is simply created. Content is written verbatim, no extra newline.
  if (info !== null && info.isFile()) {
    if ((await readFile(path, 'utf8')) !== content) {
      const backupPath = `${path}.bak`
      await copyFile(path, backupPath)
      await writeFile(path, content, 'utf8')
      return { backupPath }
    }
    return { backupPath: null }
  }
  await writeFile(path, content, 'utf8')
  return { backupPath: null }
}
