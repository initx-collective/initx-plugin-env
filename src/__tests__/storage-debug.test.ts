import { logger } from '@initx-plugin/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStorageAdapter } from '../storage/factory'

const config = { type: 'gitlab' as const, apiBaseUrl: 'https://gitlab.example/api/v4', repo: 'group/vault', branch: 'main', path: 'stores', token: 'private-token-sentinel', debug: true }

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('opt-in storage diagnostics', () => {
  it.each([true, false])('logs only selected metadata for a denied branch write (empty = %s)', async (empty) => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const fetch = vi.fn(async (value, init = {}) => {
      const url = new URL(value)
      if (init.method === 'POST')
        return Response.json({ message: 'You are not allowed to push into this branch', secret: 'private-response-sentinel' }, { status: 400 })
      if (url.pathname.endsWith('/branches/main'))
        return Response.json({ protected: true, can_push: false, secret: 'private-response-sentinel' })
      if (url.pathname.includes('/protected_branches/'))
        return Response.json({ push_access_levels: [{ access_level: 40, user_id: 123, name: 'private-response-sentinel' }] })
      return Response.json({ empty_repo: empty, archived: false, default_branch: empty ? null : 'main', permissions: { project_access: { access_level: 30 } }, secret: 'private-response-sentinel' })
    })
    vi.stubGlobal('fetch', fetch)
    const result = createStorageAdapter(config).write('stores/demo.json', 'private-store-sentinel', { condition: { kind: 'create' }, message: 'private-commit-sentinel' })
    await expect(result).rejects.toMatchObject({ code: 'permission', status: 400 })
    const output = debug.mock.calls.map(([text]) => text).join('')
    expect(output).toContain('"event":"write-result"')
    expect(output).toContain(`"emptyRepo":${empty}`)
    expect(output).toContain('"accessLevel":30')
    expect(output).toContain('"allowedPushLevels":[40]')
    if (!empty)
      expect(output).toContain('"canPush":false')
    expect(output).not.toMatch(/private-|https:|user_id|request-id|group\/vault/)
    expect(fetch.mock.calls.filter(([, init]) => init.method)).toHaveLength(1)
  })

  it('has no logging or diagnostic reads when disabled', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const fetch = vi.fn(async () => Response.json({ message: 'You are not allowed to push into this branch' }, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createStorageAdapter({ ...config, debug: false }).write('demo.json', 'secret', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'permission' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('preserves the original write error if diagnostic reads fail', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (_url, init = {}) => {
      if (init.method)
        return new Response(null, { status: 403 })
      throw new Error('private-upstream-network-error')
    }))
    await expect(createStorageAdapter(config).write('demo.json', 'secret', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'permission', status: 403 })
    const output = debug.mock.calls.map(([text]) => text).join('')
    expect(output).toContain('"event":"unavailable"')
    expect(output).not.toContain('private-upstream')
  })

  it('diagnoses an empty Developer project even when its reported default differs and protection cannot be read', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
      if (init.method)
        return Response.json({ message: 'You are not allowed to push into this branch' }, { status: 400 })
      if (String(value).includes('/protected_branches/'))
        return new Response(null, { status: 403 })
      return Response.json({ empty_repo: true, archived: false, default_branch: 'master', permissions: { project_access: { access_level: 30 } } })
    }))
    await expect(createStorageAdapter(config).write('demo.json', 'secret', { condition: { kind: 'create' } })).rejects.toMatchObject({ code: 'permission', status: 400 })
    const output = debug.mock.calls.map(([text]) => text).join('')
    expect(output).toContain('"emptyRepo":true,"archived":false,"accessLevel":30')
    expect(output).toContain('"operation":"protection","event":"request-failed","status":403')
    expect(output).not.toContain('allowedPushLevels')
  })

  it('logs only initialization and the write result on a successful empty-vault push', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
      if (init.method)
        return Response.json({}, { status: 201 })
      return String(value).endsWith('/projects/group%2Fvault') ? Response.json({ empty_repo: true }) : new Response(null, { status: 404 })
    }))
    const storage = createStorageAdapter(config)
    expect(await storage.read('demo.json')).toBeNull()
    await storage.write('demo.json', 'private-value', { condition: { kind: 'create' } })
    expect(debug.mock.calls.map(([text]) => text)).toEqual([
      'GitLab {"operation":"project","event":"empty-repository"}',
      'GitLab {"operation":"file-create","event":"write-result","status":201}'
    ])
  })
})
