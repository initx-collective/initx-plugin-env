/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../storage/factory'
import { legacyStoreFilePath, readStore, storeFilePath, writeStore } from '../store'

const config = {
  type: 'github' as const,
  apiBaseUrl: 'https://api.github.com',
  repo: 'fake/vault',
  branch: 'main',
  path: 'test-stores',
  token: 'token'
}

const keyBytes = new TextEncoder().encode('-----BEGIN KEY-----\nABC\n-----END KEY-----\n')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const legacyStore = {
  schema: 1,
  vars: { KEY: '${file-key}' },
  files: { key: { sha256: sha(keyBytes), bytes: keyBytes.byteLength, encoding: 'utf8', mode: '600' } }
}

function fileResponse(content: string | Uint8Array, version = 'version') {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
  return Response.json({ type: 'file', sha: version, encoding: 'base64', content: bytes.toString('base64'), size: bytes.byteLength })
}

afterEach(() => vi.unstubAllGlobals())

describe('legacy flat store migration', () => {
  it('reads the old file, then moves env.json and _files into the store directory', async () => {
    const decoded = (content: string) => JSON.parse(Buffer.from(content, 'base64').toString())
    const deleted: string[] = []
    let newStore: { vars: Record<string, string> } | undefined
    let newFile: Uint8Array | undefined

    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const path = decodeURIComponent(new URL(String(url)).pathname)

      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        if (path.includes('/contents/test-stores/demo/_files/key'))
          newFile = Buffer.from(body.content, 'base64')
        else
          newStore = decoded(body.content)
        return Response.json({ content: { sha: 'new-version' } })
      }

      if (init.method === 'DELETE') {
        deleted.push(path)
        return Response.json({})
      }

      if (path.endsWith('/commits/main'))
        return Response.json({ id: 'head' })
      if (path.includes('/contents/test-stores/demo/env.json'))
        return newStore ? fileResponse(JSON.stringify(newStore)) : new Response('', { status: 404 })
      if (path.includes('/contents/test-stores/demo/_files/key'))
        return newFile ? fileResponse(newFile) : new Response('', { status: 404 })
      if (path.includes('/contents/test-stores/demo.json'))
        return fileResponse(JSON.stringify(legacyStore), 'legacy-version')
      if (path.includes('/contents/test-stores/_files/demo/key'))
        return fileResponse(keyBytes, 'legacy-file-version')
      if (path.includes('/contents/test-stores/_files/demo'))
        return Response.json([{ name: 'key', path: 'test-stores/_files/demo/key', type: 'file' }])
      return new Response('', { status: 404 })
    }))

    const client = createStorageAdapter(config)
    const before = await readStore(client, 'test-stores', 'demo')

    expect(before?.legacy).toEqual({ path: 'test-stores/demo.json', version: 'legacy-version' })
    expect(before?.store.vars.KEY).toBe('${file-key}')

    await writeStore(client, 'test-stores', 'demo', before!.store, 'migrate', undefined, before!.legacy)

    expect(storeFilePath('test-stores', 'demo')).toBe('test-stores/demo/env.json')
    expect(legacyStoreFilePath('test-stores', 'demo')).toBe('test-stores/demo.json')
    expect(newStore?.vars).toEqual(legacyStore.vars)
    expect(Buffer.from(newFile!).toString()).toBe(Buffer.from(keyBytes).toString())
    expect(deleted.some(path => path.includes('/contents/test-stores/demo.json'))).toBe(true)
    expect(deleted.some(path => path.includes('/contents/test-stores/_files/demo/key'))).toBe(true)
  })
})
