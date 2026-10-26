import type { StorageType } from '../storage/types'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { createStorageAdapter } from '../storage/factory'
import { listStores, readStore, writeStore } from '../store'

afterEach(() => vi.unstubAllGlobals())

describe.each(['github', 'gitlab'] as const)('%s empty vault contract', (type: StorageType) => {
  it.each([undefined, 'release/custom'])('creates the first store on branch %s and can read it afterwards', async (branch) => {
    const config = resolveConfig({}, { type, repo: 'group/vault', token: 'fake-only', branch, env: {}, cwd: '__no_project_config__' })
    expect(config.branch).toBe(branch || 'main')
    let content: string | undefined
    const writes: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
      const url = new URL(value)
      if (init.method) {
        writes.push(init)
        const body = JSON.parse(init.body)
        expect(body.branch).toBe(config.branch)
        expect(body.sha).toBeUndefined()
        expect(body.last_commit_id).toBeUndefined()
        expect(body.start_branch).toBeUndefined()
        expect(init.method).toBe(type === 'github' ? 'PUT' : 'POST')
        content = Buffer.from(body.content, 'base64').toString('utf8')
        return Response.json({}, { status: 201 })
      }
      if (url.pathname.includes('/commits/')) {
        if (content !== undefined)
          return Response.json({ id: 'first-commit' })
        return type === 'gitlab' ? new Response(null, { status: 404 }) : Response.json({ message: 'Git Repository is empty.' }, { status: 409 })
      }
      if (type === 'gitlab' && url.pathname.endsWith('/projects/group%2Fvault'))
        return Response.json({ empty_repo: content === undefined })
      const listing = type === 'github' ? url.pathname.endsWith('/contents/stores') : url.pathname.endsWith('/tree')
      if (listing && content !== undefined)
        return Response.json([{ name: 'demo.json', path: 'stores/demo.json', type: type === 'github' ? 'file' : 'blob' }])
      if (content === undefined)
        return new Response(null, { status: 404 })
      return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: 'first-commit', last_commit_id: 'first-commit' })
    }))
    const storage = createStorageAdapter(config)
    expect(await listStores(storage, 'stores')).toEqual([])
    expect(await readStore(storage, 'stores', 'demo')).toBeNull()
    expect(writes).toEqual([])
    await writeStore(storage, 'stores', 'demo', { schema: 1, vars: { A: '中文\nvalue' } }, 'first store')
    expect(writes).toHaveLength(1)
    expect(await listStores(storage, 'stores')).toEqual(['demo'])
    expect(await readStore(storage, 'stores', 'demo')).toMatchObject({ version: 'first-commit', store: { schema: 1, vars: { A: '中文\nvalue' } } })
  })

  it('preserves create conflict detection if another writer initializes the same file first', async () => {
    const config = resolveConfig({}, { type, repo: 'group/vault', token: 'fake-only', env: {}, cwd: '__no_project_config__' })
    let initialized = false
    let writes = 0
    vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
      if (init.method) {
        initialized = true
        writes++
        return Response.json({ message: 'private upstream response' }, { status: type === 'github' ? 422 : 400 })
      }
      const url = new URL(value)
      if (url.pathname.includes('/commits/'))
        return type === 'github' ? Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) : new Response(null, { status: 404 })
      if (url.pathname.endsWith('/projects/group%2Fvault'))
        return Response.json({ empty_repo: true })
      return initialized
        ? Response.json({ type: 'file', content: Buffer.from('{"schema":1,"vars":{"A":"other-writer"}}').toString('base64'), encoding: 'base64', sha: 'concurrent-version', last_commit_id: 'concurrent-version' })
        : new Response(null, { status: 404 })
    }))
    const storage = createStorageAdapter(config)
    expect(await readStore(storage, 'stores', 'demo')).toBeNull()
    const error = await writeStore(storage, 'stores', 'demo', { schema: 1, vars: { A: 'local' } }, 'first store').catch(error => error)
    expect(error).toMatchObject({ code: 'conflict' })
    expect(String(error)).not.toContain('private upstream response')
    expect(writes).toBe(1)
  })
})

describe('gitLab empty project verification', () => {
  const config = { type: 'gitlab' as const, apiBaseUrl: 'https://gitlab.example/api/v4', repo: '1234', branch: 'main', path: 'stores', token: 'fake-only' }

  it.each([[401, 'authentication'], [403, 'permission'], [404, 'not-found'], [500, 'network']] as const)('does not treat project HTTP %s as an empty repository', async (status, code) => {
    const fetch = vi.fn(async (value, init = {}) => {
      expect(init.method).toBeUndefined()
      return String(value).endsWith('/projects/1234') ? new Response('private response', { status }) : new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    const storage = createStorageAdapter(config)
    for (const operation of [() => storage.read('stores/demo.json'), () => storage.list('stores')]) {
      const error = await operation().catch(error => error)
      expect(error).toMatchObject({ code, status })
      expect(String(error)).not.toContain('private response')
    }
    expect(fetch.mock.calls.some(([value]) => String(value).endsWith('/projects/1234'))).toBe(true)
  })

  it.each([{}, { empty_repo: 'true' }, { empty_repo: null }])('requires a boolean empty_repo flag: %j', async (project) => {
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/projects/1234') ? Response.json(project) : new Response(null, { status: 404 })))
    await expect(createStorageAdapter(config).read('demo.json')).rejects.toMatchObject({ code: 'validation' })
  })

  it('keeps a missing branch in an initialized project as not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/projects/1234') ? Response.json({ empty_repo: false }) : new Response(null, { status: 404 })))
    await expect(createStorageAdapter(config).read('demo.json')).rejects.toMatchObject({ code: 'not-found', status: 404 })
  })
})

describe('gitHub empty repository verification', () => {
  const config = { type: 'github' as const, apiBaseUrl: 'https://api.github.com', repo: 'group/vault', branch: 'main', path: 'stores', token: 'fake-only' }

  it.each([404, 409])('accepts Contents HTTP %s and verifies emptiness when the requested ref returns 404', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (value) => {
      const url = new URL(value)
      if (url.pathname.endsWith('/commits'))
        return Response.json({ message: 'Git Repository is empty.' }, { status: 409 })
      return url.pathname.includes('/contents/') && status === 409 ? Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) : new Response(null, { status: 404 })
    }))
    const storage = createStorageAdapter(config)
    expect(await storage.read('demo.json')).toBeNull()
    expect(await storage.list('stores')).toEqual([])
  })

  it('does not hide a missing configured ref when the repository has commits', async () => {
    vi.stubGlobal('fetch', vi.fn(async value => new URL(value).pathname.endsWith('/commits') ? Response.json([{ sha: 'existing-commit' }]) : new Response(null, { status: 404 })))
    await expect(createStorageAdapter(config).read('demo.json')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('does not interpret arbitrary 409 responses as empty repositories', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'private-conflict-sentinel' }, { status: 409 })))
    const error = await createStorageAdapter(config).read('demo.json').catch(error => error)
    expect(error).toMatchObject({ code: 'validation', status: 409 })
    expect(String(error)).not.toContain('private-conflict-sentinel')
  })
})
