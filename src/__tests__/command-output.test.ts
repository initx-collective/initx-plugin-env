import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, root, start, stop } from './run-harness'

let harness: Awaited<ReturnType<typeof createHarness>>
let host: string
const children: ReturnType<typeof start>[] = []

beforeEach(async () => {
  harness = await createHarness()
  delete harness.env.FORCE_COLOR
  delete harness.env.NO_COLOR
  harness.env.INITX_TEST_HTTP_STATUS = '403'
  await writeFile(join(harness.directory, '.initx-env.json'), JSON.stringify({ schema: 1, storage: { type: 'gitlab', repo: 'fake/vault' } }))
  await writeFile(join(harness.directory, '.env'), 'A=dummy-local-value\n')
  host = join(harness.directory, 'minified-plugin-host.mjs')
  await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { Buffer } from 'node:buffer';
        import EnvPlugin from './src/index.ts';
        globalThis.fetch = async () => {
          const status = Number(process.env.INITX_TEST_HTTP_STATUS);
          if (status !== 200) return new Response('private-upstream-sentinel', {status});
          return Response.json({type:'file',sha:'version',last_commit_id:'version',encoding:'base64',content:Buffer.from(JSON.stringify({schema:1,vars:{A:'dummy-remote-value'}})).toString('base64')});
        };
        await new EnvPlugin().handle({key:process.env.INITX_TEST_KEY || 'env',store:{},cliOptions:JSON.parse(process.env.INITX_TEST_OPTIONS),optionsList:[]}, ...JSON.parse(process.env.INITX_TEST_ARGS));
      `
    },
    outfile: host,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
  })
})

afterEach(async () => {
  for (const running of children.splice(0)) {
    stop(running.child)
    await running.done
  }
  await harness.cleanup()
})

async function execute(args: string[], options: Record<string, unknown> = {}) {
  harness.env.INITX_TEST_ARGS = JSON.stringify(args)
  harness.env.INITX_TEST_OPTIONS = JSON.stringify(options)
  const running = start(process.execPath, [host], { env: harness.env, cwd: harness.directory })
  children.push(running)
  return running.done
}

describe('plugin command error boundary in a minified subprocess', () => {
  it.each(['list', 'pull', 'set', 'push', 'apply', 'status'])('%s reports only the error message and exits nonzero', async (action) => {
    if (action === 'status')
      harness.env.INITX_TEST_KEY = 'env-config'
    const result = await execute(action === 'set' ? ['set', 'demo', 'A=dummy-local-value'] : [action, 'demo'], { targetToken: 'fake-target-token' })
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toContain(' ERROR  没有权限，请检查 token 授权与分支保护（HTTP 403）\n')
    expect(result.stderr).toBe('')
    expect(result.stdout + result.stderr).not.toMatch(/file:\/\/\/|\bat \w|StorageError|Node\.js v|private-upstream-sentinel|dummy-local-value|fake-bootstrap-token/)
  })

  it('prints the not-found message without source code or a stack', async () => {
    harness.env.INITX_TEST_HTTP_STATUS = '404'
    const result = await execute(['push', 'demo'])
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toBe(' ERROR  仓库或 ref 不存在，或当前 token 无权访问（HTTP 404）\n')
    expect(result.stderr).toBe('')
  })

  it.each(['debug', 'd'])('uses the context %s flag for sanitized storage diagnostics', async (flag) => {
    const result = await execute(['push', 'demo'], { [flag]: true })
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toContain(' DEBUG  GitLab {"operation":"file-read","event":"request-failed","status":403}')
    expect(result.stdout).not.toMatch(/fake-bootstrap-token|private-upstream-sentinel|dummy-local-value/)
    expect(result.stderr).toBe('')
  })

  it('handles local validation errors at the same boundary', async () => {
    const result = await execute(['push'])
    expect(result.code).toBe(1)
    expect(stripVTControlCharacters(result.stdout)).toMatch(/^ ERROR {2}用法：[^\n]+\n$/)
    expect(result.stderr).toBe('')
  })

  it('colors the full error message red through the utils builder', async () => {
    harness.env.FORCE_COLOR = '1'
    const result = await execute(['push', 'demo'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('\x1B[31m没有权限，请检查 token 授权与分支保护（HTTP 403）\x1B[0m\n')
    expect(result.stderr).toBe('')
  })

  it('highlights status values blue and keeps token values masked', async () => {
    harness.env.FORCE_COLOR = '1'
    harness.env.INITX_TEST_KEY = 'env-config'
    const result = await execute(['status'], { offline: true })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('\x1B[34mgitlab\x1B[0m')
    expect(result.stdout).toContain('\x1B[33m***\x1B[0m')
    expect(result.stdout).not.toContain('fake-bootstrap-token')
    expect(result.stderr).toBe('')
  })

  it('uses green for added keys and yellow for changed keys without printing values', async () => {
    harness.env.FORCE_COLOR = '1'
    harness.env.INITX_TEST_HTTP_STATUS = '200'
    const result = await execute(['set', 'demo', 'A=dummy-local-value', 'B=dummy-added-value'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('\x1B[32m  + B\x1B[0m')
    expect(result.stdout).toContain('\x1B[33m  ~ A\x1B[0m')
    expect(result.stdout).not.toMatch(/dummy-local-value|dummy-added-value|dummy-remote-value/)
    expect(result.stderr).toBe('')
  })

  it('leaves setup JSON unchanged even when terminal colors are forced', async () => {
    harness.env.FORCE_COLOR = '1'
    harness.env.INITX_TEST_HTTP_STATUS = '200'
    const result = await execute(['setup', 'demo'], { json: true })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.split('\n')[0]!)).toEqual({ A: 'dummy-remote-value' })
    expect(result.stderr).toBe('')
  })
})
