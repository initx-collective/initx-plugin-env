import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diffEnv,
  mergeEnv,
  parseEnv,
  readEnvFileIfExists,
  renderEnvFile,
  writeEnvFileWithBackup
} from '../utils/envfile'

/**
 * The numbered semantics from `src/utils/envfile.ts` live here as tests:
 *
 * 1. `KEY=value` / `KEY = value` / `export KEY=value` parse; the `export `
 *    prefix is remembered and kept when the line is rewritten.
 * 2. Values are unquoted, single quoted (verbatim, no escapes at all) or double
 *    quoted (`\n` `\r` `\t` `\"` `\\` unescaped).
 * 3. An unquoted value is right trimmed and cut at the first "blank + `#`" like
 *    dotenv; quoted values are never cut.
 * 4. A line whose first non-blank character is `#` is a comment, kept verbatim.
 * 5. Blank lines are kept verbatim.
 * 6. A double quoted value may span lines; those newlines come back as real `\n`
 *    and are re-escaped on write.
 * 7. Unrecognised lines (`FOO BAR`) stay verbatim and never become a pair.
 * 8. Duplicate keys: `pairs` keeps the LAST value, the key lands in
 *    `duplicates`, and a merge rewrites only the LAST occurrence.
 * 9. The original EOL and "ends with a newline" are preserved.
 */

const CRLF_FILE = `${['# comment', 'A=1', '', 'B="x"'].join('\r\n')}\r\n`

describe('parseEnv', () => {
  it('parses basic key/value pairs, blank lines and comments (rules 4, 5)', () => {
    const result = parseEnv('# a comment\n\nKEY=value\nEMPTY=\nSPACED = 1\n')

    expect(result.lines).toEqual(['# a comment', '', 'KEY=value', 'EMPTY=', 'SPACED = 1'])
    expect(result.pairs.get('KEY')).toBe('value')
    expect(result.pairs.get('EMPTY')).toBe('')
    expect(result.pairs.get('SPACED')).toBe('1')
    expect(result.eol).toBe('\n')
    expect(result.trailingNewline).toBe(true)
    expect(result.entries.map(entry => entry.key)).toEqual(['KEY', 'EMPTY', 'SPACED'])
  })

  it('keeps the export prefix (rule 1)', () => {
    const entries = parseEnv('export KEY=value\nexport\tTABBED=x\n').entries

    expect(entries[0].exportPrefix).toBe(true)
    expect(entries[1].exportPrefix).toBe(true)
    expect(mergeEnv('export KEY=1\n', { KEY: '2' }).content).toBe('export KEY=2\n')
  })

  it('reads single quoted values verbatim, including a hash (rules 2, 3)', () => {
    const result = parseEnv('A=\'abc # note\'\nB=\'escaped\\\'quote\'\nC=\'back\\nslash\'\n')

    expect(result.pairs.get('A')).toBe('abc # note')
    // No escape handling in single quotes: the value ends at the first `'`.
    expect(result.pairs.get('B')).toBe('escaped\\')
    expect(result.pairs.get('C')).toBe('back\\nslash')
    expect(result.entries.every(entry => entry.quote === 'single')).toBe(true)
  })

  it('trims an unquoted value and cuts it at whitespace + hash (rule 3)', () => {
    const result = parseEnv('A=abc # note\nB=abc   \nC=a#b\nD=abc\t# note\n')

    expect(result.pairs.get('A')).toBe('abc')
    expect(result.pairs.get('B')).toBe('abc')
    // Not "blank + #", so it is part of the value.
    expect(result.pairs.get('C')).toBe('a#b')
    expect(result.pairs.get('D')).toBe('abc')
  })

  it('does not cut a double quoted value at a hash and unescapes it (rules 2, 3)', () => {
    const result = parseEnv('A="abc # note"\nB="line1\\nline2"\nC="q\\"q"\nD="c:\\\\tmp"\n')

    expect(result.pairs.get('A')).toBe('abc # note')
    expect(result.pairs.get('B')).toBe('line1\nline2')
    expect(result.pairs.get('C')).toBe('q"q')
    expect(result.pairs.get('D')).toBe('c:\\tmp')
  })

  it('absorbs lines into an unterminated double quoted value (rule 6)', () => {
    const content = 'A=before\nPRIVATE="-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----"\nAFTER=1\n'
    const result = parseEnv(content)
    const entry = result.entries[1]

    expect(entry.key).toBe('PRIVATE')
    expect(entry.quote).toBe('double')
    // 0-based indices into `lines` — these are the indices `mergeEnv` splices with.
    expect(entry.startLine).toBe(1)
    expect(entry.endLine).toBe(4)
    expect(entry.value).toBe('-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----')
    expect(result.pairs.get('AFTER')).toBe('1')
    expect(mergeEnv(content, { PRIVATE: entry.value }).changed).toBe(false)
  })

  it('round-trips a multi-line double quoted value (rule 6)', () => {
    const updates = { KEY: 'line1\nline2' }
    const content = renderEnvFile(updates)

    expect(content).toBe('KEY="line1\\nline2"\n')
    expect(parseEnv(content).pairs.get('KEY')).toBe('line1\nline2')
    expect(mergeEnv(content, updates).changed).toBe(false)
  })

  it('keeps unrecognised lines verbatim (rule 7)', () => {
    const result = parseEnv('FOO BAR\nnot a pair\nKEY=1\n')

    expect(result.lines).toEqual(['FOO BAR', 'not a pair', 'KEY=1'])
    expect([...result.pairs.keys()]).toEqual(['KEY'])
    expect(result.entries).toHaveLength(1)
  })

  it('keeps the last value of a duplicate key and lists it once (rule 8)', () => {
    const result = parseEnv('KEY=one\nOTHER=1\nKEY=two\nKEY=two\n')

    expect(result.pairs.get('KEY')).toBe('two')
    expect(result.duplicates).toEqual(['KEY'])
    expect(result.entries).toHaveLength(4)
  })

  it('detects CRLF and a missing trailing newline (rule 9)', () => {
    const crlf = parseEnv(CRLF_FILE)
    const noEol = parseEnv('A=1')

    expect(crlf.eol).toBe('\r\n')
    expect(crlf.trailingNewline).toBe(true)
    expect(crlf.lines).toEqual(['# comment', 'A=1', '', 'B="x"'])
    expect(noEol.eol).toBe('\n')
    expect(noEol.trailingNewline).toBe(false)
    expect(parseEnv('').lines).toEqual([])
  })
})

describe('mergeEnv', () => {
  it('updates in place, preserving comments, blank lines and order (rules 1-5)', () => {
    const original = '# comment\n\nA=1\nB="x # y"\n\nOTHER=keep\n'
    const result = mergeEnv(original, { A: '2', B: 'x # y' })

    // A is rewritten in place, B is unchanged because the effective value match.
    expect(result.content).toBe('# comment\n\nA=2\nB="x # y"\n\nOTHER=keep\n')
    expect(result.updated).toEqual(['A'])
    expect(result.unchanged).toEqual(['B'])
    expect(result.added).toEqual([])
    expect(result.changed).toBe(true)
  })

  it('keeps the export prefix and position of an updated key (rule 1)', () => {
    const original = 'export A=1\nB=2\n'
    const result = mergeEnv(original, { A: 'new value' })

    expect(result.content).toBe('export A="new value"\nB=2\n')
  })

  it('appends new keys after a blank separator line', () => {
    const result = mergeEnv('A=1\n', { B: '2', C: 'has space' })

    expect(result.content).toBe('A=1\n\nB=2\nC="has space"\n')
    expect(result.added).toEqual(['B', 'C'])
    expect(result.changed).toBe(true)
  })

  it('does not add a separator when the file already ends with a blank line', () => {
    expect(mergeEnv('A=1\n\n', { B: '2' }).content).toBe('A=1\n\nB=2\n')
  })

  it('leaves an unchanged multi-line double quoted value byte-identical', () => {
    const original = 'A=before\nKEY="one\ntwo"\nZ=after\n'

    // Same value → nothing is rewritten, so a multi-line pair is NOT normalised
    // into a single line (that normalisation would break idempotency).
    expect(mergeEnv(original, { KEY: 'one\ntwo' }).content).toBe(original)
    expect(mergeEnv(original, { KEY: 'one\ntwo' }).changed).toBe(false)
  })

  it('collapses a changed multi-line double quoted value into one line', () => {
    const original = 'A=before\nKEY="one\ntwo"\nZ=after\n'
    const result = mergeEnv(original, { KEY: 'one\ntwo\nthree' })

    expect(result.content).toBe('A=before\nKEY="one\\ntwo\\nthree"\nZ=after\n')
    expect(result.changed).toBe(true)
    expect(result.updated).toEqual(['KEY'])
  })

  it('updates only the last occurrence of a duplicate key (rule 8)', () => {
    const original = 'A=one\nB=keep\nA=two\n'
    const result = mergeEnv(original, { A: 'three' })

    expect(result.content).toBe('A=one\nB=keep\nA=three\n')
    expect(result.duplicates).toEqual(['A'])
    expect(result.added).toEqual([])
    // A is reported once as updated, the earlier `A=one` line is untouched.
    expect(result.updated).toEqual(['A'])
  })

  it('is idempotent: a second merge reports changed=false and identical content', () => {
    const original = '# head\nA=1\nexport B="keep me"\nC=has space\n'
    const updates = { A: '2', B: 'new value', C: 'x' }
    const first = mergeEnv(original, updates)
    const second = mergeEnv(first.content, updates)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
    expect(second.updated).toEqual([])
    expect(second.unchanged.sort()).toEqual(['A', 'B', 'C'])
  })

  it('only touches the key whose value changed (rule 3 truncation on write)', () => {
    const result = mergeEnv('A=1\n', { A: 'abc # note' })

    // Unquotable as-is: it must be quoted, otherwise it would re-parse as "abc".
    expect(result.content).toBe('A="abc # note"\n')
    expect(parseEnv(result.content).pairs.get('A')).toBe('abc # note')
  })

  it('renders a fresh file for empty input', () => {
    const result = mergeEnv('', { A: '1', B: 'has space' })

    expect(result.content).toBe('A=1\nB="has space"\n')
    expect(result.added).toEqual(['A', 'B'])
    expect(result.changed).toBe(true)
    expect(mergeEnv('', {}).content).toBe('')
    expect(mergeEnv('', {}).changed).toBe(false)
  })

  it('preserves CRLF and a missing trailing newline on merge (rule 9)', () => {
    const kept = mergeEnv(CRLF_FILE, { A: '1' })

    expect(kept.changed).toBe(false)
    expect(kept.content).toBe(CRLF_FILE)

    const updated = mergeEnv(CRLF_FILE, { A: '2' })
    expect(updated.content).toBe(`${['# comment', 'A=2', '', 'B="x"'].join('\r\n')}\r\n`)
    expect(updated.content).not.toContain('\n\n')

    const appended = mergeEnv(CRLF_FILE, { C: '3' })
    expect(appended.content).toBe(`${CRLF_FILE}\r\nC=3\r\n`)

    const noEol = mergeEnv('A=1\nB=2', { B: '3' })
    expect(noEol.content).toBe('A=1\nB=3')
    expect(parseEnv(noEol.content).trailingNewline).toBe(false)
    // An appended key still ends without a newline when the file did not have one;
    // the blank separator is added whenever the last line is not blank.
    expect(mergeEnv('A=1\nB=2', { C: '3' }).content).toBe('A=1\nB=2\n\nC=3')
  })

  it('leaves local-only keys, comments and unknown lines alone', () => {
    const original = 'LOCAL=1\n# note\nWEIRD LINE\nREMOTE=old\n'
    const result = mergeEnv(original, { REMOTE: 'new' })

    expect(result.content).toBe('LOCAL=1\n# note\nWEIRD LINE\nREMOTE=new\n')
    expect(result.unchanged).toEqual([])
    expect(result.duplicates).toEqual([])
  })
})

describe('renderEnvFile', () => {
  it('renders plain and quoted values with the requested EOL', () => {
    expect(renderEnvFile({ A: '1', B: 'two words' })).toBe('A=1\nB="two words"\n')
    expect(renderEnvFile({ A: '1' }, '\r\n')).toBe('A=1\r\n')
    expect(renderEnvFile({})).toBe('')
  })

  it('quotes values that could not survive a re-parse', () => {
    const updates = {
      EMPTY: '',
      LEADING: ' x',
      TRAILING: 'x ',
      HASH: 'x # y',
      TAB: 'x\ty',
      NEWLINE: 'x\ny',
      QUOTE: 'say "hi"',
      BACKSLASH: 'C:\\tmp'
    }
    const content = renderEnvFile(updates)

    for (const [key, value] of Object.entries(updates))
      expect(parseEnv(content).pairs.get(key)).toBe(value)
  })
})

describe('diffEnv', () => {
  it('classifies added, updated, unchanged and local-only keys', () => {
    const original = 'A=1\nB=2\nC=3\n'
    const diff = diffEnv(original, { A: '1', B: 'changed', D: 'new' })

    expect(diff.added).toEqual(['D'])
    expect(diff.updated).toEqual(['B'])
    expect(diff.unchanged).toEqual(['A'])
    expect(diff.localOnly).toEqual(['C'])
  })

  it('reports every key of an empty file as added', () => {
    expect(diffEnv('', { A: '1' })).toEqual({ added: ['A'], updated: [], unchanged: [], localOnly: [] })
  })
})

describe('readEnvFileIfExists', () => {
  const dirs: string[] = []

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'envfile-'))
    dirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('returns null for a missing file and the content for an existing one', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')

    expect(await readEnvFileIfExists(path)).toBe(null)
    await writeFile(path, 'A=1\n', 'utf8')
    expect(await readEnvFileIfExists(path)).toBe('A=1\n')
  })

  it('returns the raw text with CRLF intact', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, CRLF_FILE, 'utf8')

    expect(await readEnvFileIfExists(path)).toBe(CRLF_FILE)
  })

  it('backs up an existing file whose content differs, then writes verbatim', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'A=1\n', 'utf8')

    const result = await writeEnvFileWithBackup(path, 'A=2\n')

    expect(result.backupPath).toBe(`${path}.bak`)
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('A=1\n')
    expect(await readFile(path, 'utf8')).toBe('A=2\n')
    // No added trailing newline.
    expect(await readEnvFileIfExists(path)).toBe('A=2\n')
  })

  it('never adds a newline and does not back up when nothing changed', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, 'A=2\n', 'utf8')

    const same = await writeEnvFileWithBackup(path, 'A=2\n')

    expect(same.backupPath).toBe(null)
    expect(await readEnvFileIfExists(`${path}.bak`)).toBe(null)

    const noEol = await writeEnvFileWithBackup(path, 'A=3')
    expect(noEol.backupPath).toBe(`${path}.bak`)
    expect(await readEnvFileIfExists(path)).toBe('A=3')
  })

  it('creates a missing file without a backup', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')

    const result = await writeEnvFileWithBackup(path, 'A=1\n')

    expect(result.backupPath).toBe(null)
    expect(await readEnvFileIfExists(path)).toBe('A=1\n')
  })

  it('round-trips a merged Windows file through disk', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(path, CRLF_FILE, 'utf8')

    const merged = mergeEnv((await readEnvFileIfExists(path)) ?? '', { A: '2', NEW: 'n' })
    await writeEnvFileWithBackup(path, merged.content)

    expect(await readEnvFileIfExists(path)).toBe(merged.content)
    expect(merged.content).toContain('\r\n')
    expect(mergeEnv((await readEnvFileIfExists(path)) ?? '', { A: '2', NEW: 'n' }).changed).toBe(false)
  })
})
