/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { parseStore } from '../store'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', async importOriginal => ({ ...await importOriginal<typeof import('@initx-plugin/utils')>(), logger, inquirer: {} }))

let harness: Awaited<ReturnType<typeof createHarness>>
let requests: { url: string, init?: RequestInit }[]

interface Remote {
  store?: unknown
  file?: Uint8Array
}

function stub(remote: Remote = {}) {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const target = String(url)
    const method = (init.method ?? 'GET').toUpperCase()

    if (method === 'DELETE' || method === 'PUT')
      return Response.json({ content: null, commit: { sha: 'next' } })
    if (target.includes('/commits/'))
      return Response.json({ id: 'head' })
    if (target.includes('/contents/test-stores/demo/_files/')) {
      return remote.file
        ? Response.json({ type: 'file', sha: 'file-version', encoding: 'base64', content: Buffer.from(remote.file).toString('base64'), size: remote.file.byteLength })
        : new Response('', { status: 404 })
    }
    if (target.includes('/contents/test-stores/demo/env.json')) {
      return remote.store
        ? Response.json({ type: 'file', sha: 'store-version', encoding: 'base64', content: Buffer.from(JSON.stringify(remote.store)).toString('base64') })
        : new Response('', { status: 404 })
    }
    return new Response('', { status: 404 })
  }))
}

const storeWithVars = (vars: Record<string, string>) => parseStore(JSON.stringify({ schema: 1, vars }), 'demo')
const keyBytes = new TextEncoder().encode('secret-value\n')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fileEntry = () => ({ sha256: sha(keyBytes), bytes: keyBytes.byteLength })

function storeWithFiles(
  vars: Record<string, string>,
  files: Record<string, { sha256: string, bytes: number }>
) {
  return parseStore(JSON.stringify({ schema: 1, vars, files }), 'demo')
}

function savedStore(): { vars: Record<string, string>, files?: Record<string, unknown> } {
  const put = requests.find(request => (request.init?.method ?? '').toUpperCase() === 'PUT' && String(request.url).includes('/contents/test-stores/demo/env.json'))
  return JSON.parse(Buffer.from(JSON.parse(String(put!.init!.body)).content, 'base64').toString())
}
const removes = () => requests.filter(request => (request.init?.method ?? 'GET').toUpperCase() === 'DELETE')
const storeDelete = () => removes().find(request => String(request.url).includes('/contents/test-stores/demo/env.json'))

beforeEach(async () => {
  harness = await createHarness()
  for (const [key, value] of Object.entries(harness.env)) {
    if (/^(?:INITX_ENV_|GH_TOKEN$|GITHUB_TOKEN$|GITHUB_ENV$)/.test(key))
      vi.stubEnv(key, value)
  }
  vi.stubEnv('GH_TOKEN', '')
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await harness.cleanup()
})

describe('rm 删除整个 store', () => {
  it('删除 store 的 env.json，并带上版本做条件删除', async () => {
    stub({ store: storeWithVars({ A: '1', B: '2' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['rm', 'demo'])

    expect(storeDelete()).toBeDefined()
    expect(removes()).toHaveLength(1)
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('已删除'))
  })

  it('rm / remove / delete 三个别名等价', async () => {
    for (const action of ['rm', 'remove', 'delete']) {
      stub({ store: storeWithVars({ A: '1' }) })
      await handleEnv({ store: harness.testStore(), options: createCliOptions() }, [action, 'demo'])
      expect(removes(), `${action} 应该发出一次删除`).toHaveLength(1)
    }
  })

  it('缺 store 名时报用法错误，不发任何请求', async () => {
    stub()
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['rm'])).rejects.toThrow(/用法/)
    expect(requests).toEqual([])
  })

  it('store 不存在时报错，不发删除', async () => {
    stub()
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['rm', 'demo'])).rejects.toThrow(/没有 store/)
    expect(removes()).toEqual([])
  })

  it('--dry-run 只报告，不删除', async () => {
    stub({ store: storeWithVars({ A: '1' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ 'dry-run': true }) }, ['rm', 'demo'])
    expect(removes()).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('--dry-run'))
  })

  it('默认连 _files 下的文件对象一起删掉', async () => {
    stub({ store: storeWithFiles({ A: '${file-key}' }, { key: fileEntry() }), file: keyBytes })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['rm', 'demo'])

    expect(removes().some(r => String(r.url).includes('/_files/key'))).toBe(true)
    expect(storeDelete()).toBeDefined()
  })

  it('--keep-files 保留文件对象', async () => {
    stub({ store: storeWithFiles({ A: '${file-key}' }, { key: fileEntry() }), file: keyBytes })
    await handleEnv({ store: harness.testStore(), options: createCliOptions({ 'keep-files': true }) }, ['rm', 'demo'])

    expect(removes().some(r => String(r.url).includes('/_files/'))).toBe(false)
    expect(storeDelete()).toBeDefined()
  })
})

describe('unset 删除单个变量', () => {
  it('删除普通变量并写回 store', async () => {
    stub({ store: storeWithVars({ A: '1', B: '2' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A'])

    expect(savedStore().vars).toEqual({ B: '2' })
    expect(removes().some(r => String(r.url).includes('/_files/'))).toBe(false)
  })

  it('一次删多个变量', async () => {
    stub({ store: storeWithVars({ A: '1', B: '2', C: '3' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A', 'C'])
    expect(savedStore().vars).toEqual({ B: '2' })
  })

  it('删的是 file 引用时，连 _files 下文件一起删', async () => {
    stub({ store: storeWithFiles({ A: '${file-key}', B: '2' }, { key: fileEntry() }), file: keyBytes })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A'])

    expect(removes().some(r => String(r.url).includes('/_files/key'))).toBe(true)
    const saved = savedStore()
    expect(saved.vars).toEqual({ B: '2' })
    expect(saved.files ?? {}).toEqual({})
  })

  it('文件仍被其他键引用时保留，只删引用', async () => {
    stub({ store: storeWithFiles({ A: '${file-key}', B: '${file-key}' }, { key: fileEntry() }), file: keyBytes })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A'])

    expect(removes().some(r => String(r.url).includes('/_files/'))).toBe(false)
    expect(savedStore().vars).toEqual({ B: '${file-key}' })
  })

  it('变量删光后连 store 本身一起删掉', async () => {
    stub({ store: storeWithVars({ A: '1' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A'])
    expect(storeDelete()).toBeDefined()
  })

  it('缺 KEY 时报用法错误', async () => {
    stub()
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo'])).rejects.toThrow(/用法/)
    expect(requests).toEqual([])
  })

  it('kEYS 全都不存在时报错，不写任何东西', async () => {
    stub({ store: storeWithVars({ A: '1' }) })
    await expect(handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'X'])).rejects.toThrow(/没有这些变量/)
    expect(requests.filter(request => request.init?.method === 'PUT')).toEqual([])
  })

  it('部分键不存在时，删掉存在的并警告', async () => {
    stub({ store: storeWithVars({ A: '1', B: '2' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A', 'X'])

    expect(savedStore().vars).toEqual({ B: '2' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('原本就不存在'))
  })

  it('部分键不存在且剩下的全删光时，仍删整个 store', async () => {
    stub({ store: storeWithVars({ A: '1' }) })
    await handleEnv({ store: harness.testStore(), options: createCliOptions() }, ['unset', 'demo', 'A', 'X'])

    expect(storeDelete()).toBeDefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('原本就不存在'))
  })
})
