import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { handleEnvApply } from '../commands/env-apply'
import { handleEnvConfig } from '../commands/env-config'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', () => ({ logger, inquirer: {} }))

let harness: Awaited<ReturnType<typeof createHarness>>
let requests: { url: string, init?: RequestInit }[]
let vars: Record<string, string>

beforeEach(async () => {
  harness = await createHarness()
  requests = []
  vars = { A: 'new', REMOTE: 'keep' }
  for (const [key, value] of Object.entries(harness.env)) {
    if (/^(?:INITX_ENV_|GH_TOKEN$|GITHUB_TOKEN$|GITHUB_ENV$)/.test(key))
      vi.stubEnv(key, value)
  }
  vi.stubEnv('GH_TOKEN', '')
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    requests.push({ url: String(url), init })
    if (init?.method === 'PUT')
      return Response.json({ content: { sha: 'written' } })
    return Response.json({ type: 'file', sha: 'test', encoding: 'base64', content: Buffer.from(JSON.stringify({ schema: 1, vars })).toString('base64') })
  }))
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await harness.cleanup()
})

describe('原有命令回归（仅模拟 GitHub，不执行写接口）', () => {
  it('apply --repo 仍是目标 Actions 仓库，vault 从环境解析', async () => {
    await handleEnvApply({ store: { repo: 'local/vault' }, options: createCliOptions({ 'repo': 'target/actions', 'dry-run': true }) }, ['demo'])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('/repos/fake/vault/contents/test-stores/demo.json')
    expect(logger.info.mock.calls.flat().join('\n')).toContain('target/actions')
  })

  it('setup 仍向 GITHUB_ENV 写入并输出 Actions mask', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnv({ store: {}, options: createCliOptions() }, ['setup', 'demo'])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toContain('A=new')
    expect(output.mock.calls.flat()).toContain('::add-mask::new')
  })

  it('pull 保留其他键，重复运行不改字节；push 保留远端独有键', async () => {
    const path = join(harness.directory, '.env.local')
    await writeFile(path, '# comment\nA=old\nLOCAL=keep\n')
    await handleEnv({ store: {}, options: createCliOptions({ to: path }) }, ['pull', 'demo'])
    const first = await readFile(path, 'utf8')
    expect(first).toContain('# comment\nA=new\nLOCAL=keep')
    await handleEnv({ store: {}, options: createCliOptions({ to: path }) }, ['pull', 'demo'])
    expect(await readFile(path, 'utf8')).toBe(first)
    await writeFile(path, 'A=changed\nLOCAL=keep\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: path }) }, ['push', 'demo'])
    const written = requests.find(request => request.init?.method === 'PUT')!
    const body = JSON.parse(String(written.init!.body))
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString()).vars).toEqual({ A: 'changed', REMOTE: 'keep', LOCAL: 'keep' })
  })

  it('status 展示生效配置，get/list 仍展示持久化值且不回写', async () => {
    const store = { repo: 'local/vault', branch: 'local', path: 'local-path', token: 'local-token' }
    await handleEnvConfig(store, ['status'], createCliOptions({ offline: true }))
    const effective = logger.info.mock.calls.flat().join('\n')
    for (const expected of ['fake/vault', 'test-branch', 'test-stores', 'INITX_ENV_TOKEN'])
      expect(effective).toContain(expected)
    expect(effective).not.toContain('fake-bootstrap-token')
    logger.info.mockClear()
    await handleEnvConfig(store, ['get', 'repo'], createCliOptions())
    await handleEnvConfig(store, ['list'], createCliOptions())
    expect(logger.info.mock.calls.flat().join('\n')).toContain('local/vault')
    expect(store).toEqual({ repo: 'local/vault', branch: 'local', path: 'local-path', token: 'local-token' })
    expect(requests).toEqual([])
  })
})
