/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  list?: { name: string, type: string }[]
}

function stub(remote: Remote = {}) {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const target = String(url)
    if (init.method === 'PUT' || init.method === 'DELETE')
      return new Response(null, { status: 200 })
    if (target.includes('/commits/'))
      return Response.json({ id: 'head' })
    if (target.includes('/contents/test-stores/_files/demo?'))
      return Response.json((remote.list ?? []).map(item => ({ ...item, path: `test-stores/_files/demo/${item.name}` })))
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
  process.exitCode = 0
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

function fileStore(vars: Record<string, string>, files: Record<string, { sha256: string, bytes: number, encoding?: 'utf8' | 'base64', mode?: string }>) {
  return parseStore(JSON.stringify({ schema: 1, vars, files }), 'demo')
}

describe('env file ls cat pull rm check', () => {
  it('ls 支持 --json 输出引用与元数据', async () => {
    stub({ store: fileStore({ KEY: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ json: true }) }, ['ls', 'demo'])
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual([{
      key: 'KEY',
      id: 'key',
      sha256: sha(keyBytes),
      bytes: keyBytes.byteLength,
      encoding: 'utf8'
    }])
  })

  it('cat 默认只报元数据，--show 才输出注入值', async () => {
    stub({ store: fileStore({ KEY: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }), file: keyBytes })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnvFile({ store: storeConfig, options: createCliOptions() }, ['cat', 'demo', 'KEY'])
    expect(output).not.toHaveBeenCalled()

    await handleEnvFile({ store: storeConfig, options: createCliOptions({ show: true }) }, ['cat', 'demo', 'KEY'])
    expect(output).toHaveBeenCalledWith('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')
  })

  it('pull 落盘原始字节，默认不覆盖', async () => {
    stub({ store: fileStore({ KEY: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength, mode: '600' } }), file: keyBytes })
    const out = join(directory, 'secrets')
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ 'to-dir': out }) }, ['pull', 'demo'])
    expect(await readFile(join(out, 'key'), 'utf8')).toBe('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')

    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions({ 'to-dir': out }) }, ['pull', 'demo'])).rejects.toThrow(/已存在/)
    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions({ toDir: out, force: true }) }, ['pull', 'demo'])).resolves.toBeUndefined()
  })

  it('rm 删除最后一个引用时才删文件，共用 id 时保留', async () => {
    stub({
      store: fileStore({ A: '${file-key}', B: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }),
      file: keyBytes
    })
    await handleEnvFile({ store: storeConfig, options: createCliOptions() }, ['rm', 'demo', 'A'])
    expect(requests.some(request => request.init?.method === 'DELETE')).toBe(false)
    const sharedWrite = requests.find(request => request.init?.method === 'PUT')!
    const shared = JSON.parse(Buffer.from(JSON.parse(String(sharedWrite.init!.body)).content, 'base64').toString())
    expect(shared.vars).toEqual({ B: '${file-key}' })
    expect(shared.files.key).toBeDefined()

    stub({
      store: fileStore({ A: '${file-key}' }, { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength } }),
      file: keyBytes
    })
    await handleEnvFile({ store: storeConfig, options: createCliOptions() }, ['rm', 'demo', 'A'])
    expect(requests.some(request => request.init?.method === 'DELETE')).toBe(true)
    const lastWrite = requests.find(request => request.init?.method === 'PUT')!
    const last = JSON.parse(Buffer.from(JSON.parse(String(lastWrite.init!.body)).content, 'base64').toString())
    expect(last.vars).toEqual({})
    expect(last.files).toBeUndefined()
  })

  it('rm 对普通值报错', async () => {
    stub({ store: fileStore({ A: 'plain' }, {}) })
    await expect(handleEnvFile({ store: storeConfig, options: createCliOptions() }, ['rm', 'demo', 'A'])).rejects.toThrow(/不是文件引用/)
  })

  it('check 报出四个方向的问题并以非零码退出', async () => {
    stub({
      store: fileStore(
        { A: '${file-key}', D: '${file-missing}' },
        {
          'key': { sha256: sha(keyBytes), bytes: keyBytes.byteLength },
          'orphan-meta': { sha256: sha(new Uint8Array()), bytes: 0 }
        }
      ),
      file: new TextEncoder().encode('different'),
      list: [{ name: 'stray', type: 'file' }]
    })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnvFile({ store: storeConfig, options: createCliOptions({ json: true }) }, ['check', 'demo'])
    const report = JSON.parse(String(output.mock.calls[0]![0]))
    const types = report.problems.map((problem: { type: string }) => problem.type)
    expect(types).toContain('undeclared-ref')
    expect(types).toContain('dangling-metadata')
    expect(types).toContain('size-mismatch')
    expect(types).toContain('orphan-file')
    expect(process.exitCode).toBe(1)
  })
})
