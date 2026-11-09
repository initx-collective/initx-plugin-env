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
          if (process.env.INITX_TEST_HTTP_STATUS) return new Response('private-token secret-response', {status:Number(process.env.INITX_TEST_HTTP_STATUS)});
          if (process.env.INITX_TEST_MISSING_STORE) return /repository\\/files\\/|\\/contents\\//.test(new URL(url).pathname) ? new Response(null, {status:404}) : Response.json({id:'head'});
          const content = process.env.INITX_TEST_RAW_STORE ?? JSON.stringify({schema:1, vars:JSON.parse(process.env.INITX_TEST_VARS)});
          return Response.json({type:'file', sha:'github-version', last_commit_id:'gitlab-version', encoding:'base64', content:Buffer.from(content).toString('base64')});
        };
        const options = createCliOptions(JSON.parse(process.env.INITX_TEST_OPTIONS));
        logger.setLevel(options.boolean('debug') || options.boolean('d') ? 'debug' : 'info');
        // 夹具直接构造 store：重构后 vault 定位只能来自 profile。
        // apiBaseUrl 必须和下面写入的项目文件一致，否则 profile 匹配不上。
        const apiBaseUrl = process.env.INITX_TEST_TYPE === 'github' ? 'https://api.github.com' : 'https://gitlab.example/api/v4';
        const store = { profiles: { default: { type: process.env.INITX_TEST_TYPE, apiBaseUrl, repo: 'fake/vault', token: 'fixture-token' } } };
        await handleEnvRun({store, options}, JSON.parse(process.env.INITX_TEST_ARGS));
      `
    },
    outfile: host,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: readOnly
      ? [
          {
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
          }
        ]
      : []
  })
  if (!harness.env.INITX_TEST_LEGACY) {
    const apiBaseUrl = type === 'github'
      ? 'https://api.github.com'
      : 'https://gitlab.example/api/v4'
    await writeFile(join(harness.directory, '.initx-env.json'), JSON.stringify({
      schema: 1,
      storage: { type, apiBaseUrl, repo: 'fake/vault' }
    }))
  }
  harness.env.INITX_TEST_OPTIONS = JSON.stringify(options)
  harness.env.INITX_TEST_ARGS = JSON.stringify(args)
  harness.env.INITX_TEST_TYPE = type
  const running = start(process.execPath, [host], { env: harness.env, cwd: harness.directory })
  children.push(running)
  return running
}

describe.each(['github', 'gitlab'] as const)('%s env run integration', (type) => {
  it('passes argv, multiline/empty/unexpanded values, cwd and inherited stdin/stdout/stderr to a real child', async () => {
    const vars = {
      OVERRIDE: 'store',
      EMPTY: '',
      MULTI: '中文\nline\r\n$VAR',
      QUOTES: '" ; $'
    }
    harness.env.INITX_TEST_VARS = JSON.stringify(vars)
    harness.env.OVERRIDE = 'parent'
    harness.env.KEEP_PARENT = 'kept'
    const tail = [
      '--config',
      'child.json',
      '--token=child',
      '--help',
      '--',
      '',
      'a b',
      '你好'
    ]
    const script = `let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),vars:Object.fromEntries(${JSON.stringify([
      ...Object.keys(vars),
      'KEEP_PARENT'
    ])}.map(k=>[k,process.env[k]])),input})); process.stderr.write('child-stderr-marker'); process.exitCode=23 });`
    const running = await execute(type, {
      'config': '.initx-env.json',
      '--': [
        process.execPath,
        '-e',
        script,
        '--',
        ...tail
      ]
    })
    running.child.stdin!.end('child-stdin-marker')
    const result = await running.done
    expect(result.code).toBe(23)
    expect(JSON.parse(result.stdout)).toEqual({
      argv: tail,
      cwd: harness.directory,
      vars: { ...vars, KEEP_PARENT: 'kept' },
      input: 'child-stdin-marker'
    })
    expect(result.stderr).toBe('child-stderr-marker')
    const events = await readFile(harness.env.INITX_TEST_EVENTS!, 'utf8')
    expect(events).toContain(type === 'github'
      ? 'api.github.com/repos/fake/vault'
      : 'gitlab.example/api/v4/projects/fake%2Fvault')
    expect(events).not.toContain('fake-bootstrap-token')
    expect((await readdir(harness.directory)).filter(name => /^\.env/.test(name))).toEqual([])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toBe('unchanged\n')
  })

  it('does not leak fetch error contents or launch the child on a read failure', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    harness.env.INITX_TEST_FETCH_ERROR = '1'
    const result = await (await execute(type, {
      '--': [process.execPath, '-e', 'console.log("should-not-run")']
    })).done
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toContain('env run: 读取 store失败：网络请求失败或超时')
    expect(result.stdout).not.toContain('后端=')
    expect(result.stdout).not.toMatch(/private-token|secret-response|should-not-run/)
    expect(result.stderr).toBe('')
  })

  it.each(['debug', 'd'])('prints resolved configuration metadata only with --%s on read failure', async (flag) => {
    harness.env.INITX_TEST_HTTP_STATUS = '403'
    const result = await (await execute(type, {
      [flag]: true,
      '--': [process.execPath, '-e', 'console.log("should-not-run")']
    })).done
    const output = stripVTControlCharacters(result.stdout)
    expect(result.code).toBe(1)
    expect(output).toContain(` DEBUG  env run: 后端=${type}，profile=default（来自 project-match），凭据来源=INITX_ENV_TOKEN`)
    expect(output).toContain('HTTP 403')
    expect(result.stdout + result.stderr).not.toMatch(/private-token|secret-response|should-not-run|fake-bootstrap-token/)
  })

  it.each([401, 403, 429, 500])('reports HTTP %s without leaking response bodies or starting the child', async (status) => {
    harness.env.INITX_TEST_HTTP_STATUS = String(status)
    const result = await (await execute(type, {
      '--': [process.execPath, '-e', 'console.log("should-not-run")']
    })).done
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toContain(`HTTP ${status}`)
    expect(result.stdout).not.toMatch(/private-token|secret-response|should-not-run|fake-bootstrap-token/)
    expect(result.stderr).toBe('')
  })

  it('distinguishes a missing store from authentication failure', async () => {
    harness.env.INITX_TEST_MISSING_STORE = '1'
    const result = await (await execute(type, {
      '--': [process.execPath, '-e', 'console.log("should-not-run")']
    })).done
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('store 文件不存在')
    expect(result.stdout).not.toContain('should-not-run')
  })

  it.each([
    ['private-token secret-response', 'store 文件不是合法 JSON'],
    [
      JSON.stringify({
        vars: { 'private-token secret-response': 123 }
      }),
      '字段：vars'
    ],
    [
      JSON.stringify({ vars: {}, targets: null }),
      '字段：targets'
    ],
    [
      JSON.stringify({
        vars: {},
        targets: {
          secrets: [
            { repo: 'private-token secret-response' }
          ]
        }
      }),
      '字段：targets.secrets'
    ],
    [
      JSON.stringify({
        vars: {},
        targets: {
          envFiles: ['']
        }
      }),
      '字段：targets.envFiles'
    ]
  ])('reports a controlled store validation hint without private content: %s', async (content, hint) => {
    harness.env.INITX_TEST_RAW_STORE = content
    const result = await (await execute(type, {
      '--': [process.execPath, '-e', 'console.log("should-not-run")']
    })).done
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(hint)
    expect(result.stdout).not.toMatch(/private-token|secret-response|should-not-run|fake-bootstrap-token/)
    expect(result.stderr).toBe('')
  })

  it('accepts the global debug prefix and preserves the child debug argument and exit status', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    const result = await (await execute(type, {
      'debug': true,
      '--': [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exitCode=13',
        '--',
        '--debug'
      ]
    })).done
    expect(result.code).toBe(13)
    expect(result.stdout).toBe('["--debug"]')
    expect(result.stdout + result.stderr).not.toMatch(/fake-bootstrap-token|private-token/)
  })

  it('rejects extra prefix flags and malformed --config before reading', async () => {
    harness.env.INITX_TEST_VARS = '{}'
    for (const prefix of [
      { repo: 'forbidden/repo' },
      { config: true },
      {
        config: ['a', 'b']
      }
    ]) {
      const result = await (await execute(type, {
        ...prefix,
        '--': [process.execPath, '-e', 'console.log("should-not-run")']
      })).done
      expect(result.code).toBe(1)
      expect(stripVTControlCharacters(result.stdout)).toContain(' ERROR  env run: 参数失败')
      expect(result.stderr).toBe('')
    }
    expect(await readdir(harness.directory)).not.toContain('events.jsonl')
  })
})

it('env run accepts a future read-only adapter without changing process execution', async () => {
  harness.env.INITX_TEST_VARS = JSON.stringify({ FROM_READONLY: 'yes' })
  const result = await (await execute('github', {
    '--': [process.execPath, '-e', 'process.stdout.write(process.env.FROM_READONLY)']
  }, ['demo'], true)).done
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('yes')
})
