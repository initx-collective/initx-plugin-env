import type { StorageAdapter, StorageType } from '../storage/types'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../storage/factory'
import { deleteStore, listStores, readStore, writeStore } from '../store'

export function fileResponse(type: StorageType, content: string, version = 'file-commit') {
  return Response.json({ type: 'file', sha: version, last_commit_id: version, encoding: 'base64', content: Buffer.from(content).toString('base64') })
}

const text = JSON.stringify({ schema: 1, vars: { A: '原值\nline\r\n', EMPTY: '' } })
const token = 'private-token-sentinel'

function adapter(type: StorageType) {
  return createStorageAdapter({ type, apiBaseUrl: type === 'github' ? 'https://api.github.com' : 'https://gitlab.example/api/v4', repo: 'group/vault', branch: 'release/中文 name', path: 'stores', token })
}

afterEach(() => vi.unstubAllGlobals())

describe.each(['github', 'gitlab'] as const)('%s StorageAdapter contract', (type) => {
  it('returns decoded UTF-8 and an opaque file version through the store service', async () => {
    const fetch = vi.fn(async () => fileResponse(type, text))
    vi.stubGlobal('fetch', fetch)
    const ref = await readStore(adapter(type), 'stores', 'demo')
    expect(ref).toMatchObject({ version: 'file-commit', store: { schema: 1, vars: { A: '原值\nline\r\n', EMPTY: '' } } })
    expect(ref).not.toHaveProperty('sha')
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).searchParams.get('ref')).toBe('release/中文 name')
    expect(request).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    expect(request.headers).toMatchObject(type === 'github' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token })
    expect(request.headers).not.toHaveProperty(type === 'github' ? 'PRIVATE-TOKEN' : 'Authorization')
  })

  it('lists only JSON files at the selected directory and supports repository root', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/commits/'))
        return Response.json({ id: 'head' })
      return Response.json([
        { name: 'z.json', path: 'z.json', type: type === 'github' ? 'file' : 'blob' },
        { name: 'a.JSON', path: 'a.JSON', type: type === 'github' ? 'file' : 'blob' },
        { name: 'directory.json', path: 'directory.json', type: type === 'github' ? 'dir' : 'tree' },
        { name: 'README.md', path: 'README.md', type: type === 'github' ? 'file' : 'blob' }
      ])
    }))
    expect(await listStores(adapter(type), '')).toEqual(['a', 'z'])
  })

  it('distinguishes a missing file/directory from inaccessible repository or ref', async () => {
    let accessible = true
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/commits/') && accessible ? Response.json({ id: 'head' }) : new Response('', { status: 404 })))
    expect(await adapter(type).read('stores/missing.json')).toBeNull()
    expect(await adapter(type).list('missing')).toEqual([])
    accessible = false
    await expect(adapter(type).read('stores/missing.json')).rejects.toMatchObject({ code: 'not-found' })
    await expect(adapter(type).list('missing')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('reports update/delete after a concurrent deletion as conflict when the target is accessible', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => !init.method && String(url).includes('/commits/') ? Response.json({ id: 'head' }) : new Response('', { status: 404 })))
    await expect(adapter(type).write('demo.json', 'new', { condition: { kind: 'update', expectedVersion: 'deleted-version' } })).rejects.toMatchObject({ code: 'conflict' })
    await expect(adapter(type).remove('demo.json', { expectedVersion: 'deleted-version' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('creates, updates and deletes conditionally without unconditional overwrite', async () => {
    const calls: { method: string, body: { branch: string, content?: string, sha?: string, last_commit_id?: string, actions?: { action: string, file_path: string, last_commit_id: string }[] } }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      calls.push({ method: init.method, body: JSON.parse(init.body) })
      return new Response(null, { status: 200 })
    }))
    const storage = adapter(type)
    const store = { schema: 1, vars: { A: 'new\n中文' } }
    await writeStore(storage, 'stores', 'demo', store, 'create')
    await writeStore(storage, 'stores', 'demo', store, 'update', 'old-version')
    await deleteStore(storage, 'stores', 'demo', 'latest-version', 'delete')
    expect(calls.map(call => call.method)).toEqual([type === 'github' ? 'PUT' : 'POST', 'PUT', type === 'github' ? 'DELETE' : 'POST'])
    const versionKey = type === 'github' ? 'sha' : 'last_commit_id'
    expect(calls[0]!.body).not.toHaveProperty(versionKey)
    expect(calls[1]!.body[versionKey]).toBe('old-version')
    if (type === 'github')
      expect(calls[2]!.body.sha).toBe('latest-version')
    else
      expect(calls[2]!.body.actions).toEqual([{ action: 'delete', file_path: 'stores/demo.json', last_commit_id: 'latest-version' }])
    expect(calls.every(call => call.body.branch === 'release/中文 name')).toBe(true)
    expect(JSON.parse(Buffer.from(calls[1]!.body.content!, 'base64').toString()).vars).toEqual(store.vars)
  })

  it.each(['create', 'update', 'delete'] as const)('detects a %s race', async (operation) => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method ? new Response('secret response body', { status: type === 'gitlab' ? 400 : 422 }) : fileResponse(type, text, 'newer-version')))
    const storage = adapter(type)
    const action = operation === 'delete'
      ? storage.remove('stores/demo.json', { expectedVersion: 'old-version' })
      : storage.write('stores/demo.json', 'new text', { condition: operation === 'create' ? { kind: 'create' } : { kind: 'update', expectedVersion: 'old-version' } })
    await expect(action).rejects.toMatchObject({ code: 'conflict' })
  })

  it.each([400, 409, 422])('hTTP %s with an unchanged version is validation, not a force retry', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method ? new Response('body-with-secrets', { status }) : fileResponse(type, text, 'same-version')))
    await expect(adapter(type).write('stores/demo.json', 'different text', { condition: { kind: 'update', expectedVersion: 'same-version' } })).rejects.toMatchObject({ code: 'validation' })
  })

  it.each([[401, 'authentication'], [403, 'permission'], [429, 'rate-limit'], [500, 'network']] as const)('classifies HTTP %s without exposing upstream secrets', async (status, code) => {
    const fetch = vi.fn(async () => new Response(`SECRET ${token} https://host/?token=secret`, { status, statusText: 'secret-status-text' }))
    vi.stubGlobal('fetch', fetch)
    for (const operation of [() => adapter(type).read('demo.json'), () => adapter(type).write('demo.json', 'secret-store', { condition: { kind: 'create' } }), () => adapter(type).remove('demo.json', { expectedVersion: 'old' })]) {
      const error = await operation().catch(error => error)
      expect(error).toMatchObject({ code, status })
      expect(String(error)).not.toMatch(/SECRET|private-token|secret-status|secret-store|https:/)
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('classifies network errors/timeouts without retries or original error text', async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`Timeout ${token}`)
    })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter(type).read('demo.json')).rejects.toMatchObject({ code: 'network' })
    await expect(adapter(type).write('demo.json', 'value', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'network' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sets a 30-second deadline and classifies an aborted request as network', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('secret-timeout', 'TimeoutError')))
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      init.signal.throwIfAborted()
      return new Response('unreachable')
    }))
    try {
      const error = await adapter(type).read('demo.json').catch(error => error)
      expect(error).toMatchObject({ code: 'network' })
      expect(String(error)).not.toContain('secret-timeout')
      expect(timeout).toHaveBeenCalledWith(30000)
    }
    finally {
      timeout.mockRestore()
    }
  })

  it('rejects unsafe paths and empty versions before making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const path of ['', '/absolute', 'a/../b', 'a\\b', 'a//b', 'C:/a', 'a\nb', 'a/./b']) {
      await expect(adapter(type).read(path)).rejects.toMatchObject({ code: 'validation' })
      await expect(adapter(type).write(path, '', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'validation' })
      await expect(adapter(type).remove(path, { expectedVersion: 'old' })).rejects.toMatchObject({ code: 'validation' })
      if (path)
        await expect(adapter(type).list(path)).rejects.toMatchObject({ code: 'validation' })
    }
    await expect(adapter(type).remove('demo.json', { expectedVersion: '' })).rejects.toMatchObject({ code: 'validation' })
    await expect(adapter(type).write('demo.json', '', { condition: { kind: 'update', expectedVersion: '' } })).rejects.toMatchObject({ code: 'validation' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sanitizes invalid JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret invalid JSON')))
    const error = await adapter(type).read('demo.json').catch(error => error)
    expect(error).toMatchObject({ code: 'validation' })
    expect(String(error)).not.toContain('secret')
  })

  it('classifies a timeout while consuming the response body as network', async () => {
    const response = Response.json({})
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('private-body-timeout', 'TimeoutError'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const error = await adapter(type).read('demo.json').catch(error => error)
    expect(error).toMatchObject({ code: 'network' })
    expect(String(error)).not.toContain('private-body-timeout')
  })
})

describe('capability checks', () => {
  it('reads a future read-only backend and rejects writes before dispatch', async () => {
    const storage: StorageAdapter = {
      capabilities: { read: true, list: true, write: false, delete: false, conditionalWrite: false },
      read: vi.fn(async () => ({ content: text, version: 'opaque' })),
      list: vi.fn(async () => []),
      write: vi.fn(),
      remove: vi.fn()
    }
    expect((await readStore(storage, '', 'demo'))?.version).toBe('opaque')
    await expect(writeStore(storage, '', 'demo', { schema: 1, vars: {} }, 'write')).rejects.toMatchObject({ code: 'unsupported' })
    await expect(deleteStore(storage, '', 'demo', 'opaque', 'delete')).rejects.toMatchObject({ code: 'unsupported' })
    expect(storage.write).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
    const unconditional = { ...storage, capabilities: { ...storage.capabilities, write: true } }
    await expect(writeStore(unconditional, '', 'demo', { schema: 1, vars: {} }, 'write')).rejects.toMatchObject({ code: 'unsupported' })
  })
})
