import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, root, start, stop } from './run-harness'

let harness: Awaited<ReturnType<typeof createHarness>>
const children: ReturnType<typeof start>[] = []

beforeEach(async () => {
  harness = await createHarness()
  // These invocations intentionally use a project file instead of location env overrides.
  for (const key of ['INITX_ENV_REPO', 'INITX_ENV_BRANCH', 'INITX_ENV_PATH'])
    delete harness.env[key]
})
afterEach(async () => {
  for (const running of children.splice(0)) {
    stop(running.child)
    await running.done
  }
  await harness.cleanup()
})

async function execute(type: 'github' | 'gitlab', options: Record<string, unknown>, args: string[] = ['demo'], readOnly = false) {
  const host = join(harness.directory, 'run-host.mjs')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { appendFileSync } from 'node:fs';
        import { Buffer } from 'node:buffer';
        import { logger } from '@initx-plugin/utils';
        import { createCliOptions } from './src/cli-options.ts';
        import { handleEnvRun } from './src/commands/env-run.ts';
        globalThis.fetch = async (url, init) => {
          appendFileSync(process.env.INITX_TEST_EVENTS, JSON.stringify({url, redirect: init.redirect}) + '\\n');
          if (process.env.INITX_TEST_FETCH_ERROR) throw new Error('private-token secret-response');
          return Response.json({type:'file', sha:'github-version', last_commit_id:'gitlab-version', encoding:'base64', content:Buffer.from(JSON.stringify({schema:1, vars:JSON.parse(process.env.INITX_TEST_VARS)})).toString('base64')});
        };
        const options = createCliOptions(JSON.parse(process.env.INITX_TEST_OPTIONS));
        logger.setLevel(options.boolean('debug') || options.boolean('d') ? 'debug' : 'info');
        await handleEnvRun({store:{}, options}, JSON.parse(process.env.INITX_TEST_ARGS));
      `
    },
    outfile: host,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: readOnly
      ? [{
          name: 'readonly-fixture',
          setup(builder) {
            builder.onLoad({ filter: /storage[/\\]factory\.ts$/ }, () => ({
              loader: 'ts',
              contents: `
            export function createStorageAdapter() {
              return {capabilities:{read:true,list:false,write:false,delete:false,conditionalWrite:false},
                read:async()=>({version:'opaque-readonly',content:JSON.stringify({schema:1,vars:JSON.parse(process.env.INITX_TEST_VARS)})})};
            }
            export function requireCapability(adapter, operation) { if (!adapter.capabilities[operation]) throw new Error('unsupported'); }
          `
            }))
          }
        }]
      : []
  })
  if (!harness.env.INITX_TEST_LEGACY)
    await writeFile(join(harness.directory, '.initx-env.json'), JSON.stringify({ schema: 1, storage: { type, repo: 'fake/vault' } }))
  harness.env.INITX_TEST_OPTIONS = JSON.stringify(options)
  harness.env.INITX_TEST_ARGS = JSON.stringify(args)
  const running = start(process.execPath, [host], { env: harness.env, cwd: harness.directory })
  children.push(running)
  return running
}

describe.each(['github', 'gitlab'] as const)('%s env run integration', (type) => {
  it('passes argv, multiline/empty/unexpanded values, cwd and inherited stdin/stdout/stderr to a real child', async () => {
    const vars = { OVERRIDE: 'store', EMPTY: '', MULTI: '中文\nline\r\n$VAR', QUOTES: '" ; $' }
    harness.env.INITX_TEST_VARS = JSON.stringify(vars)
    harness.env.OVERRIDE = 'parent'
    harness.env.KEEP_PARENT = 'kept'
    const tail = ['--config', 'child.json', '--token=child', '--help', '--', '', 'a b', '你好']
    const script = `let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),vars:Object.fromEntries(${JSON.stringify([...Object.keys(vars), 'KEEP_PARENT'])}.map(k=>[k,process.env[k]])),input})); process.stderr.write('child-stderr-marker'); process.exitCode=23 });`
    const running = await execute(type, { 'config': '.initx-env.json', '--': [process.execPath, '-e', script, '--', ...tail] })
    running.child.stdin!.end('child-stdin-marker')
    const result = await running.done
    expect(result.code).toBe(23)
    expect(JSON.parse(result.stdout)).toEqual({ argv: tail, cwd: harness.directory, vars: { ...vars, KEEP_PARENT: 'kept' }, input: 'child-stdin-marker' })
    expect(result.stderr).toBe('child-stderr-marker')
    const events = await readFile(harness.env.INITX_TEST_EVENTS!, 'utf8')
    expect(events).toContain(type === 'github' ? 'api.github.com/repos/fake/vault' : 'gitlab.com/api/v4/projects/fake%2Fvault')
    expect(events).not.toContain('fake-bootstrap-token')
    expect((await readdir(harness.directory)).filter(name => /^\.env/.test(name))).toEqual([])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toBe('unchanged\n')
  })

  it('preserves the Slides-style call without new flags or a project file', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    harness.env.INITX_TEST_LEGACY = '1'
    harness.env.INITX_ENV_REPO = 'fake/slides-vault'
    const running = await execute('github', { '--': [process.execPath, '-e', 'process.stdout.write("slides-child-executed"); process.exitCode=17'] })
    // This call uses legacy location overrides even on a GitLab runner.
    const result = await running.done
    expect(result.code).toBe(17)
    expect(result.stdout).toBe('slides-child-executed')
  })

  it('does not leak fetch error contents or launch the child on a read failure', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    harness.env.INITX_TEST_FETCH_ERROR = '1'
    const result = await (await execute(type, { '--': [process.execPath, '-e', 'console.log("should-not-run")'] })).done
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toBe(' ERROR  env run: 读取 store失败\n')
    expect(result.stderr).toBe('')
  })

  it('accepts the global debug prefix and preserves the child debug argument and exit status', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    const result = await (await execute(type, { 'debug': true, '--': [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exitCode=13', '--', '--debug'] })).done
    expect(result.code).toBe(13)
    expect(result.stdout).toBe('["--debug"]')
    expect(result.stdout + result.stderr).not.toMatch(/fake-bootstrap-token|private-token/)
  })

  it('rejects extra prefix flags and malformed --config before reading', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    for (const prefix of [{ repo: 'forbidden/repo' }, { config: true }, { config: ['a', 'b'] }]) {
      const result = await (await execute(type, { ...prefix, '--': [process.execPath, '-e', 'console.log("should-not-run")'] })).done
      expect(result.code).toBe(1)
      expect(stripVTControlCharacters(result.stdout)).toContain(' ERROR  env run: 参数失败')
      expect(result.stderr).toBe('')
    }
    expect(await readdir(harness.directory)).not.toContain('events.jsonl')
  })
})

it('env run accepts a future read-only adapter without changing process execution', async () => {
  harness.env.INITX_TEST_VARS = JSON.stringify({ FROM_READONLY: 'yes' })
  const result = await (await execute('github', { '--': [process.execPath, '-e', 'process.stdout.write(process.env.FROM_READONLY)'] }, ['demo'], true)).done
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('yes')
})
