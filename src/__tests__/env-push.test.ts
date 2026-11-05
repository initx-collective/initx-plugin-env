/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { parseStore } from '../store'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', async importOriginal => ({ ...await importOriginal<typeof import('@initx-plugin/utils')>(), logger, inquirer: {} }))

const keyBytes = new TextEncoder().encode('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

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
    if (init.method === 'PUT')
      return new Response(null, { status: 200 })
    if (target.includes('/commits/'))
      return Response.json({ id: 'head' })
    if (target.includes('/contents/test-stores/_files/demo/')) {
      return remote.file
        ? Response.json({ type: 'file', sha: 'file-version', encoding: 'base64', content: Buffer.from(remote.file).toString('base64'), size: remote.file.byteLength })
        : new Response('', { status: 404 })
    }
    if (target.includes('/contents/test-stores/demo.json')) {
      return remote.store
        ? Response.json({ type: 'file', sha: 'store-version', encoding: 'base64', content: Buffer.from(JSON.stringify(remote.store)).toString('base64') })
        : new Response('', { status: 404 })
    }
    return new Response('', { status: 404 })
  }))
}

function storeWith(vars: Record<string, string>, files: Record<string, { sha256: string, bytes: number, encoding?: 'utf8' | 'base64' }>) {
  return parseStore(JSON.stringify({ schema: 1, vars, files }), 'demo')
}

function storeWrite() {
  return requests.find(request => request.init?.method === 'PUT' && String(request.url).includes('/contents/test-stores/demo.json'))
}

function savedStore(): { vars: Record<string, string>, files?: Record<string, unknown> } {
  const write = storeWrite()!
  return JSON.parse(Buffer.from(JSON.parse(String(write.init!.body)).content, 'base64').toString())
}

async function envFile(content: string): Promise<string> {
  const path = join(harness.directory, '.env.test')
  await writeFile(path, content)
  return path
}

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

describe('push 与文件引用', () => {
  it('本地内容与文件一致时保留引用且零写入', async () => {
    stub({ store: storeWith({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const path = await envFile('A="-----BEGIN KEY-----\\nABC\\n-----END KEY-----\\n"\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: path }) }, ['push', 'demo'])
    expect(requests.filter(request => request.init?.method === 'PUT')).toEqual([])
  })

  it('内容变化时默认报错，要求显式选择', async () => {
    stub({ store: storeWith({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const path = await envFile('A=changed\n')
    await expect(handleEnv({ store: {}, options: createCliOptions({ from: path }) }, ['push', 'demo'])).rejects.toThrow(/--update-files/)
    expect(requests.filter(request => request.init?.method === 'PUT')).toEqual([])
  })

  it('--update-files 先传文件再更新元数据，引用保持不变', async () => {
    stub({ store: storeWith({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const path = await envFile('A=changed\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: path, updateFiles: true }) }, ['push', 'demo'])

    const writes = requests.filter(request => request.init?.method === 'PUT')
    expect(writes).toHaveLength(2)
    expect(writes[0]!.url).toContain('/contents/test-stores/_files/demo/key')

    const store = savedStore()
    expect(store.vars.A).toBe('${file-key}')
    expect(store.files!.key).toMatchObject({ sha256: sha(new TextEncoder().encode('changed')), bytes: 7 })
  })

  it('--inline 改成普通值并清理文件条目', async () => {
    stub({ store: storeWith({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const path = await envFile('A=changed\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: path, inline: true }) }, ['push', 'demo'])

    expect(requests.filter(request => request.init?.method === 'PUT')).toHaveLength(1)
    const store = savedStore()
    expect(store.vars.A).toBe('changed')
    expect(store.files).toBeUndefined()
  })

  it('set 作用在引用键上等价于 --inline', async () => {
    stub({ store: storeWith({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    await handleEnv({ store: {}, options: createCliOptions() }, ['set', 'demo', 'A=changed'])
    const store = savedStore()
    expect(store.vars.A).toBe('changed')
    expect(store.files).toBeUndefined()
  })

  it('--prune 删除本地没有的引用键并清理文件条目', async () => {
    stub({ store: storeWith({ A: '${file-key}', B: 'plain' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const path = await envFile('C=1\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: path, prune: true }) }, ['push', 'demo'])

    const store = savedStore()
    expect(store.vars).toEqual({ C: '1' })
    expect(store.files).toBeUndefined()
  })
})
