/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { handleEnvApply } from '../commands/env-apply'
import { handleProfile } from '../commands/env-profile'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', async importOriginal => ({ ...await importOriginal<typeof import('@initx-plugin/utils')>(), logger, inquirer: {} }))

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
  it('apply --repo 仍是目标 Actions 仓库，vault 从 profile 解析', async () => {
    await handleEnvApply({ store: harness.testStore(), options: createCliOptions({ 'repo': 'target/actions', 'dry-run': true }) }, ['demo'])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('/repos/fake/vault/contents/test-stores/demo/env.json')
    expect(logger.info.mock.calls.flat().join('\n')).toContain('target/actions')
  })

  it('setup 仍向 GITHUB_ENV 写入并输出 Actions mask', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['setup', 'demo'])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toContain('A=new')
    expect(output.mock.calls.flat()).toContain('::add-mask::new')
  })

  it('setup 与 pull 对超限值硬失败', async () => {
    vars = { BIG: 'x'.repeat(32 * 1024 + 1) }
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['setup', 'demo'])).rejects.toThrow(/32768 字节环境变量上限/)

    vars = { BIG: 'x'.repeat(1024 * 1024 + 1) }
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions({ to: join(harness.directory, '.env.big') }) }, ['pull', 'demo'])).rejects.toThrow(/1048576 字节内联上限/)
  })

  it('pull 保留其他键，重复运行不改字节；push 保留远端独有键', async () => {
    const path = join(harness.directory, '.env.local')
    await writeFile(path, '# comment\nA=old\nLOCAL=keep\n')
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ to: path }) }, ['pull', 'demo'])
    const first = await readFile(path, 'utf8')
    expect(first).toContain('# comment\nA=new\nLOCAL=keep')
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ to: path }) }, ['pull', 'demo'])
    expect(await readFile(path, 'utf8')).toBe(first)
    await writeFile(path, 'A=changed\nLOCAL=keep\n')
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ from: path }) }, ['push', 'demo'])
    const written = requests.find(request => request.init?.method === 'PUT')!
    const body = JSON.parse(String(written.init!.body))
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString()).vars).toEqual({ A: 'changed', REMOTE: 'keep', LOCAL: 'keep' })
  })

  it('pull 与 setup 解引用文件并按多行格式写出', async () => {
    const keyBytes = Buffer.from('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')
    const fileStore = {
      schema: 1,
      vars: { KEY: '${file-key}' },
      files: { key: { sha256: createHash('sha256').update(keyBytes).digest('hex'), bytes: keyBytes.byteLength, encoding: 'utf8', mode: '600' } }
    }
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), init })
      if (init?.method)
        return Response.json({ content: { sha: 'written' } })
      if (String(url).includes('/contents/test-stores/demo/_files/key'))
        return Response.json({ type: 'file', sha: 'file', encoding: 'base64', content: keyBytes.toString('base64'), size: keyBytes.byteLength })
      return Response.json({ type: 'file', sha: 'test', encoding: 'base64', content: Buffer.from(JSON.stringify(fileStore)).toString('base64') })
    }))
    const path = join(harness.directory, '.env.file')
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ to: path }) }, ['pull', 'demo'])
    expect(await readFile(path, 'utf8')).toBe('KEY="-----BEGIN KEY-----\\nABC\\n-----END KEY-----\\n"\n')

    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['setup', 'demo'])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toContain('KEY<<')
  })

  it('status 展示生效的 profile 与实际字段来源', async () => {
    const store = {
      defaultProfile: 'ci',
      profiles: {
        ci: {
          type: 'github' as const,
          apiBaseUrl: 'https://api.github.com',
          repo: 'fake/vault',
          branch: 'test-branch',
          path: 'test-stores',
          token: 'fake-bootstrap-token'
        }
      }
    }
    await handleProfile({ store, options: createCliOptions({ offline: true }) }, 'status', [])
    const effective = logger.info.mock.calls.flat().join('\n')
    for (const expected of ['ci', 'fake/vault', 'test-branch', 'test-stores', 'INITX_ENV_TOKEN'])
      expect(effective).toContain(expected)
    expect(effective).not.toContain('fake-bootstrap-token')
    // status 只读：不改 store，也不发请求
    expect(store.profiles.ci.repo).toBe('fake/vault')
    expect(requests).toEqual([])
  })
})
