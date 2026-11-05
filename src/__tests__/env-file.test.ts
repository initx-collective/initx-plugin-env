/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnvFile } from '../commands/env-file'
import { parseStore } from '../store'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', async importOriginal => ({ ...await importOriginal<typeof import('@initx-plugin/utils')>(), logger, inquirer: {} }))

const storeConfig = { repo: 'fake/vault', token: 'token', branch: 'main', path: 'test-stores' }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let directory: string
let requests: { url: string, init?: RequestInit }[]
const keyBytes = new TextEncoder().encode('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')

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

async function sourceFile(bytes: Uint8Array, name = 'key.pem'): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, bytes)
  return path
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'env-file-add-'))
  delete process.env.INITX_ENV_MAX_FILE_BYTES
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete process.env.INITX_ENV_MAX_FILE_BYTES
  await rm(directory, { recursive: true, force: true })
})

describe('env file add', () => {
  it('先写文件再写 store，变量变成引用', async () => {
    stub()
    const file = await sourceFile(keyBytes)
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ file, as: 'deploy-key' }) }, ['add', 'demo', 'DEPLOY_KEY'])

    const writes = requests.filter(request => request.init?.method === 'PUT')
    expect(writes).toHaveLength(2)
    expect(writes[0]!.url).toContain('/contents/test-stores/_files/demo/deploy-key')
    expect(writes[1]!.url).toContain('/contents/test-stores/demo.json')

    const body = JSON.parse(String(writes[1]!.init!.body))
    const store = JSON.parse(Buffer.from(body.content, 'base64').toString())
    expect(store.vars.DEPLOY_KEY).toBe('${file-deploy-key}')
    expect(store.files['deploy-key']).toEqual({
      sha256: sha(keyBytes),
      bytes: keyBytes.byteLength,
      encoding: 'utf8'
    })
  })

  it('同键、同内容时完全幂等，不产生任何写入', async () => {
    const store = parseStore(JSON.stringify({
      schema: 1,
      vars: { DEPLOY_KEY: '${file-deploy-key}' },
      files: { 'deploy-key': { sha256: sha(keyBytes), bytes: keyBytes.byteLength, encoding: 'utf8' } }
    }), 'demo')
    stub({ store, file: keyBytes })
    const file = await sourceFile(keyBytes)
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ file, as: 'deploy-key' }) }, ['add', 'demo', 'DEPLOY_KEY'])
    expect(requests.filter(request => request.init?.method === 'PUT')).toEqual([])
  })

  it('id 被别的键占用时报错', async () => {
    const store = parseStore(JSON.stringify({
      schema: 1,
      vars: { OTHER: '${file-deploy-key}' },
      files: { 'deploy-key': { sha256: sha(keyBytes), bytes: keyBytes.byteLength, encoding: 'utf8' } }
    }), 'demo')
    stub({ store, file: keyBytes })
    const file = await sourceFile(keyBytes)
    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions({ file, as: 'deploy-key' }) }, ['add', 'demo', 'DEPLOY_KEY'])).rejects.toThrow(/已被 OTHER 引用/)
  })

  it('--dry-run 不上传也不写 store', async () => {
    stub()
    const file = await sourceFile(keyBytes)
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ file, as: 'deploy-key', dryRun: true }) }, ['add', 'demo', 'DEPLOY_KEY'])
    expect(requests.filter(request => request.init?.method === 'PUT')).toEqual([])
    expect(logger.info.mock.calls.flat().join('\n')).toContain('--dry-run')
  })

  it('utf8 模式下拒绝非 UTF-8 文件', async () => {
    stub()
    const file = await sourceFile(new Uint8Array([0xFF, 0xFE]))
    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions({ file }) }, ['add', 'demo', 'BIN'])).rejects.toThrow(/UTF-8/)
    expect(requests).toEqual([])
  })

  it('超过单文件上限时拒绝', async () => {
    stub()
    process.env.INITX_ENV_MAX_FILE_BYTES = '2'
    const file = await sourceFile(new TextEncoder().encode('abc'))
    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions({ file }) }, ['add', 'demo', 'BIG'])).rejects.toThrow(/2 字节上限/)
    expect(requests).toEqual([])
  })
})
