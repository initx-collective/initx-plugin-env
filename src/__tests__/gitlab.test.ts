import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../storage/factory'

const config = { type: 'gitlab' as const, apiBaseUrl: 'https://gitlab.example/nested/api/v4/', repo: 'group/sub/sub2/vault', branch: 'release/中文 space', path: '', token: 'gitlab-only' }

afterEach(() => vi.unstubAllGlobals())

describe('gitLab API compatibility', () => {
  it('classifies the known 15.9.4 protected branch HTTP 400 as permission without exposing the body', async () => {
    const fetch = vi.fn(async () => Response.json({ message: 'You are not allowed to push into this branch', secret: 'private-response-sentinel' }, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const storage = createStorageAdapter(config)
    for (const operation of [() => storage.write('a.json', 'value', { condition: { kind: 'create' } }), () => storage.remove('a.json', { expectedVersion: 'old' })]) {
      const error = await operation().catch(error => error)
      expect(error).toMatchObject({ code: 'permission', status: 400 })
      expect(String(error)).not.toContain('private-response-sentinel')
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses the 15.9.4 Commits delete condition because Files DELETE ignores last_commit_id', async () => {
    let exists = true
    const fetch = vi.fn(async (value, init = {}) => {
      const url = new URL(value)
      if (init.method === 'DELETE') {
        // Legacy Files DELETE discards the undeclared last_commit_id.
        exists = false
        return new Response(null, { status: 204 })
      }
      if (init.method === 'POST' && url.pathname.endsWith('/commits')) {
        const body = JSON.parse(init.body)
        expect(body.branch).toBe(config.branch)
        expect(body.actions[0].file_path).toBe('stores/中文 name.json')
        if (body.actions[0].last_commit_id !== 'latest-file-commit')
          return new Response('file has changed', { status: 400 })
        exists = false
        return Response.json({ id: 'delete-commit' })
      }
      return Response.json({ content: Buffer.from('current').toString('base64'), encoding: 'base64', last_commit_id: 'latest-file-commit' })
    })
    vi.stubGlobal('fetch', fetch)
    const storage = createStorageAdapter(config)
    await expect(storage.remove('stores/中文 name.json', { expectedVersion: 'stale-file-commit' })).rejects.toMatchObject({ code: 'conflict' })
    expect(exists).toBe(true)
    await storage.remove('stores/中文 name.json', { expectedVersion: 'latest-file-commit' })
    expect(exists).toBe(false)
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it.each(['12345', 'group/sub/sub2/vault'])('encodes project %s and file path once, using last_commit_id rather than blob id', async (repo) => {
    const fetch = vi.fn(async () => Response.json({ content: Buffer.from('中文\n').toString('base64'), encoding: 'base64', last_commit_id: 'commit', blob_id: 'blob' }))
    vi.stubGlobal('fetch', fetch)
    expect(await createStorageAdapter({ ...config, repo }).read('目录/a b.json')).toEqual({ content: '中文\n', version: 'commit' })
    const url = String((fetch.mock.calls as unknown[][])[0]![0])
    expect(url).toContain(`/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent('目录/a b.json')}?`)
    expect(url).not.toContain('%252F')
    expect(new URL(url).searchParams.get('ref')).toBe(config.branch)
  })

  it.each([true, false])('paginates all entries without recursive/keyset or following URLs (headers = %s)', async (headers) => {
    const pages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (value) => {
      const url = new URL(value)
      if (url.pathname.includes('/commits/'))
        return Response.json({ id: 'head' })
      pages.push(url.searchParams.get('page')!)
      expect(url.searchParams.get('per_page')).toBe('100')
      expect(url.searchParams.get('path')).toBe('stores/目录')
      expect(url.searchParams.has('recursive')).toBe(false)
      expect(url.searchParams.has('pagination')).toBe(false)
      const page = Number(url.searchParams.get('page'))
      return Response.json(Array.from({ length: page === 1 ? 100 : 2 }, (_, index) => ({ name: `${page}-${index}.json`, path: `stores/目录/${page}-${index}.json`, type: 'blob', id: 'blob-not-file-version' })), headers ? { headers: { 'x-next-page': page === 1 ? '2' : '' } } : undefined)
    }))
    expect(await createStorageAdapter(config).list('stores/目录')).toHaveLength(102)
    expect(pages).toEqual(['1', '2'])
  })

  it.each([200, 404])('accepts missing directory HTTP %s after validating the target ref', async (status) => {
    const fetch = vi.fn(async url => String(url).includes('/commits/') ? Response.json({ id: 'head' }) : status === 200 ? Response.json([]) : new Response('', { status }))
    vi.stubGlobal('fetch', fetch)
    expect(await createStorageAdapter(config).list('missing')).toEqual([])
    expect(String(fetch.mock.calls[0]![0])).toContain('/commits/')
  })

  it('does not interpret legacy empty tree for an invalid ref as an empty vault', async () => {
    const fetch = vi.fn(async url => String(url).includes('/commits/') ? new Response('', { status: 404 }) : Response.json([]))
    vi.stubGlobal('fetch', fetch)
    await expect(createStorageAdapter(config).list('missing')).rejects.toMatchObject({ code: 'not-found' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('omits path for repository root and stops after an exact full page with no next header', async () => {
    const pages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (value) => {
      const url = new URL(value)
      if (url.pathname.includes('/commits/'))
        return Response.json({ id: 'head' })
      expect(url.searchParams.has('path')).toBe(false)
      pages.push(url.searchParams.get('page')!)
      return Response.json(pages.length === 1 ? Array.from({ length: 100 }, () => ({ name: 'a', path: 'a', type: 'blob' })) : [])
    }))
    expect(await createStorageAdapter(config).list('')).toHaveLength(100)
    expect(pages).toEqual(['1', '2'])
  })

  it('accepts an unchanged content 400 only at the expected file version', async () => {
    let version = 'current'
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method
      ? new Response('secret body', { status: 400 })
      : Response.json({ content: Buffer.from('same').toString('base64'), encoding: 'base64', last_commit_id: version })))
    const storage = createStorageAdapter(config)
    await expect(storage.write('a.json', 'same', { condition: { kind: 'update', expectedVersion: 'current' } })).resolves.toBeUndefined()
    version = 'changed'
    await expect(storage.write('a.json', 'same', { condition: { kind: 'update', expectedVersion: 'current' } })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('does not turn a permission failure during conflict verification into conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response('secret', { status: init.method ? 400 : 403 })))
    await expect(createStorageAdapter(config).write('a.json', 'value', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'permission' })
  })

  it('never follows a redirect with PRIVATE-TOKEN', async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(init.redirect).toBe('error')
      throw new TypeError('redirect to https://attacker/?private=secret')
    })
    vi.stubGlobal('fetch', fetch)
    await expect(createStorageAdapter(config).read('a.json')).rejects.toMatchObject({ code: 'network' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
