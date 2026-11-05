/* eslint-disable no-console, no-template-curly-in-string -- 用例需要截获 check 的 JSON 输出并断言字面量占位符 */
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { handleEnvFile } from '../commands/env-file'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', async importOriginal => ({ ...await importOriginal<typeof import('@initx-plugin/utils')>(), logger, inquirer: {} }))

interface Store {
  schema: number
  vars: Record<string, string>
  files?: Record<string, { sha256: string, bytes: number, encoding?: string, mode?: string }>
}

let directory: string
let server: Server
let store: Store | null
let files: Map<string, Buffer>
let version = 0

function json(response: import('node:http').ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status
  if (body !== undefined)
    response.setHeader('content-type', 'application/json')
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

function fileBody(content: Buffer, sha: string) {
  return { type: 'file', sha, encoding: 'base64', content: content.toString('base64'), size: content.byteLength }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function startServer(): Promise<string> {
  server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/repos/fake/vault/commits/main') {
      json(response, 200, { id: 'head' })
      return
    }

    const prefix = '/repos/fake/vault/contents/'
    if (!url.pathname.startsWith(prefix)) {
      json(response, 404)
      return
    }

    const path = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    const storePath = 'test-stores/demo/env.json'
    const filePrefix = 'test-stores/demo/_files/'

    if (request.method === 'GET') {
      if (path === storePath) {
        if (!store) {
          json(response, 404)
          return
        }
        json(response, 200, fileBody(Buffer.from(JSON.stringify(store)), `store-${version}`))
        return
      }
      if (path === filePrefix.slice(0, -1)) {
        json(response, 200, [...files.keys()].map(name => ({ name, path: `${filePrefix}${name}`, type: 'file' })))
        return
      }
      if (path.startsWith(filePrefix)) {
        const content = files.get(path.slice(filePrefix.length))
        if (!content) {
          json(response, 404)
          return
        }
        json(response, 200, fileBody(content, `file-${version}`))
        return
      }
      json(response, 404)
      return
    }

    if (request.method === 'PUT') {
      const body = await readBody(request)
      const content = Buffer.from(String(body.content), 'base64')
      version += 1
      if (path === storePath) {
        store = JSON.parse(content.toString('utf8')) as Store
        json(response, 200, { content: { sha: `store-${version}` } })
        return
      }
      if (path.startsWith(filePrefix)) {
        files.set(path.slice(filePrefix.length), content)
        json(response, 200, { content: { sha: `file-${version}` } })
        return
      }
    }

    if (request.method === 'DELETE' && path.startsWith(filePrefix)) {
      files.delete(path.slice(filePrefix.length))
      json(response, 200)
      return
    }

    json(response, 404)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
    })
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'env-http-e2e-'))
  store = null
  files = new Map()
  version = 0
  const baseUrl = await startServer()
  vi.stubEnv('INITX_ENV_API_BASE_URL', baseUrl)
  vi.stubEnv('INITX_ENV_REPO', 'fake/vault')
  vi.stubEnv('INITX_ENV_TOKEN', 'token')
  vi.stubEnv('INITX_ENV_BRANCH', 'main')
  vi.stubEnv('INITX_ENV_PATH', 'test-stores')
  vi.stubEnv('GH_TOKEN', '')
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.clearAllMocks()
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = 0
  await rm(directory, { recursive: true, force: true })
})

describe('file refs over a real HTTP loopback', () => {
  it('runs add → pull → check → file pull → push --update-files', async () => {
    const pem = '-----BEGIN KEY-----\nABC\n-----END KEY-----\n'
    const source = join(directory, 'key.pem')
    await writeFile(source, pem)

    await handleEnvFile({ store: {}, options: createCliOptions({ file: source, as: 'key' }) }, ['add', 'demo', 'KEY'])
    expect(store?.vars.KEY).toBe('${file-key}')
    expect(store?.files?.key.bytes).toBe(Buffer.byteLength(pem))

    const envPath = join(directory, '.env')
    await handleEnv({ store: {}, options: createCliOptions({ to: envPath }) }, ['pull', 'demo'])
    expect(await readFile(envPath, 'utf8')).toBe('KEY="-----BEGIN KEY-----\\nABC\\n-----END KEY-----\\n"\n')

    const out = join(directory, 'out')
    await handleEnvFile({ store: {}, options: createCliOptions({ toDir: out }) }, ['pull', 'demo'])
    expect(await readFile(join(out, 'key'), 'utf8')).toBe(pem)

    let captured = ''
    const originalLog = console.log
    console.log = (...args) => {
      captured += `${args.join(' ')}\n`
    }
    await handleEnvFile({ store: {}, options: createCliOptions({ json: true }) }, ['check', 'demo'])
    console.log = originalLog
    expect(JSON.parse(captured).problems).toEqual([])

    const changed = join(directory, '.env.changed')
    await writeFile(changed, 'KEY=changed\n')
    await handleEnv({ store: {}, options: createCliOptions({ from: changed, updateFiles: true }) }, ['push', 'demo'])

    expect(files.get('key')?.toString('utf8')).toBe('changed')
    expect(store?.files?.key.bytes).toBe(7)
    expect(store?.vars.KEY).toBe('${file-key}')
  })
})
