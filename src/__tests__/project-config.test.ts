import type { EnvPluginStore } from '../config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnvConfig } from '../commands/env-config'
import { credentialKey, resolveConfig, resolveToken } from '../config'
import { readProjectConfig } from '../project-config'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', () => ({ logger, inquirer: {} }))

let harness: Awaited<ReturnType<typeof createHarness>>
const storage = { type: 'gitlab', apiBaseUrl: 'https://gitlab.example/api/v4', repo: 'group/sub/vault', branch: 'production', path: 'config' }
const local = { repo: 'legacy/vault', token: 'github-legacy-token', branch: 'legacy', path: 'legacy-stores' }
const tokenEnv = { INITX_ENV_TOKEN: 'explicit-current-target' }

beforeEach(async () => {
  harness = await createHarness()
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await harness.cleanup()
})

async function project(value: unknown = { schema: 1, storage }, name = '.initx-env.json') {
  const file = join(harness.directory, name)
  await writeFile(file, JSON.stringify(value))
  return file
}

function resolve(store: EnvPluginStore = local, env: Record<string, string> = tokenEnv) {
  return resolveConfig(store, { cwd: harness.directory, env })
}

describe('project configuration', () => {
  it('resolves override > environment > project > same-identity local > defaults without mutations', async () => {
    await project()
    const snapshot = structuredClone(local)
    expect(resolve()).toMatchObject({ ...storage, token: tokenEnv.INITX_ENV_TOKEN, sources: { repo: 'project' } })
    expect(resolveConfig(local, { cwd: harness.directory, env: { ...tokenEnv, INITX_ENV_REPO: 'env/vault', INITX_ENV_BRANCH: 'env', INITX_ENV_PATH: 'env-dir' }, repo: 'flag/vault', path: 'flag-dir' })).toMatchObject({ repo: 'flag/vault', branch: 'env', path: 'flag-dir' })
    expect(local).toEqual(snapshot)
  })

  it('requires only type/repo, uses provider defaults and preserves an explicit root path', async () => {
    await project({ schema: 1, storage: { type: 'gitlab', repo: '12345', path: '' } })
    expect(resolve()).toMatchObject({ type: 'gitlab', apiBaseUrl: 'https://gitlab.com/api/v4', repo: '12345', branch: 'main', path: '' })
  })

  it('loads only cwd by default and resolves --config relative to caller cwd', async () => {
    await project()
    const child = join(harness.directory, 'child')
    await mkdir(child)
    expect(readProjectConfig(undefined, child)).toBeUndefined()
    expect(readProjectConfig('../.initx-env.json', child)?.storage.repo).toBe(storage.repo)
    expect(readProjectConfig(join(harness.directory, '.initx-env.json'), child)?.storage.type).toBe('gitlab')
    expect(() => readProjectConfig('missing.json', child)).toThrow(/无法读取/)
  })

  it.each([
    { schema: 2, storage },
    { schema: 1, storage: { ...storage, token: 'secret-sentinel' } },
    { schema: 1, storage, token: 'secret-sentinel' },
    { schema: 1, storage, vars: { API_KEY: 'secret-sentinel' } },
    { schema: 1, storage: { type: 'gitlab' } },
    { schema: 1, storage: { ...storage, type: 's3' } }
  ])('rejects unknown schema, malformed structure and sensitive fields without falling back', async (value) => {
    await project(value)
    expect(() => resolve()).toThrow(/schema 1/)
    try {
      resolve()
    }
    catch (error) {
      expect(String(error)).not.toContain('secret-sentinel')
    }
  })

  it('fails on invalid present JSON rather than using legacy configuration', async () => {
    await writeFile(join(harness.directory, '.initx-env.json'), '{secret-value')
    expect(() => resolve()).toThrow(/合法 JSON/)
    await expect(handleEnvConfig(local, ['status'], createCliOptions({ config: join(harness.directory, '.initx-env.json'), offline: true }))).rejects.toThrow(/合法 JSON/)
  })

  it.each(['https://user:secret@host/api/v4', 'https://host/api/v4?token=secret', 'https://host/api/v4#secret', 'file:///tmp/vault'])('rejects credentials/query/hash/non-http API URL', async (apiBaseUrl) => {
    await project({ schema: 1, storage: { ...storage, apiBaseUrl } })
    expect(() => resolve()).toThrow()
  })

  it('does not infer the provider from the CI runner platform', () => {
    expect(resolve(local, { GITLAB_CI: 'true', GH_TOKEN: 'github-token' })).toMatchObject({ type: 'github', repo: local.repo, token: 'github-token' })
  })
})

describe('credential and location isolation', () => {
  it('does not reuse a GitLab persisted credential for a GitHub project', async () => {
    await project({ schema: 1, storage: { type: 'github', repo: 'owner/vault' } })
    const store: EnvPluginStore = { storage: { type: 'gitlab', apiBaseUrl: storage.apiBaseUrl, repo: storage.repo }, credentials: { [credentialKey('gitlab', storage.apiBaseUrl)]: 'gitlab-only' } }
    expect(() => resolve(store, {})).toThrow(/token/)
  })

  it('never sends GH_TOKEN/GITHUB_TOKEN or legacy token to GitLab or custom GitHub API', async () => {
    await project()
    const env = { GH_TOKEN: 'github-only', GITHUB_TOKEN: 'github-only-too' }
    expect(() => resolve(local, env)).toThrow(/token/)
    await project({ schema: 1, storage: { type: 'github', apiBaseUrl: 'https://enterprise.example/api/v3', repo: 'owner/vault' } })
    expect(() => resolve(local, env)).toThrow(/token/)
  })

  it('binds persisted credentials to provider and the entire normalized API base', async () => {
    await project()
    const store: EnvPluginStore = { ...local, credentials: {
      [credentialKey('gitlab', storage.apiBaseUrl)]: 'gitlab-current',
      [credentialKey('gitlab', 'https://gitlab.example/another/api/v4')]: 'gitlab-other-base',
      [credentialKey('github', storage.apiBaseUrl)]: 'wrong-provider'
    } }
    expect(resolve(store, {})).toMatchObject({ token: 'gitlab-current', tokenSource: 'config' })
    await project({ schema: 1, storage: { ...storage, apiBaseUrl: 'https://another.example/api/v4' } })
    expect(() => resolve(store, {})).toThrow(/token/)
    expect(resolveToken(store, { cwd: harness.directory, env: { INITX_ENV_TOKEN: 'explicit-new-target' } })).toEqual({ token: 'explicit-new-target', source: 'INITX_ENV_TOKEN' })
  })

  it('does not inherit another provider/host repo, branch or path', async () => {
    await project({ schema: 1, storage: { type: 'gitlab', repo: '12345' } })
    expect(resolve()).toMatchObject({ repo: '12345', branch: 'main', path: 'stores' })
    expect(() => resolveConfig(local, { cwd: harness.directory, type: 'gitlab', apiBaseUrl: 'https://other/api/v4', env: tokenEnv })).toThrow(/vault/)
    expect(() => resolveConfig(local, { cwd: harness.directory, type: 'github', apiBaseUrl: 'https://other/api/v3', env: tokenEnv })).toThrow(/vault/)
  })

  it('keeps local configuration commands independent of project config and scopes newly saved tokens', async () => {
    const file = await project()
    const store: EnvPluginStore = { ...local }
    await handleEnvConfig(store, ['set', 'type', 'gitlab'], createCliOptions({ config: file }))
    await handleEnvConfig(store, ['set', 'apiBaseUrl', storage.apiBaseUrl], createCliOptions())
    await handleEnvConfig(store, ['set', 'repo', '123'], createCliOptions())
    await handleEnvConfig(store, ['set', 'token', 'gitlab-local-secret'], createCliOptions())
    expect(store.storage).toMatchObject({ type: 'gitlab', repo: '123' })
    expect(store.credentials?.[credentialKey('gitlab', storage.apiBaseUrl)]).toBe('gitlab-local-secret')
    expect(store.token).toBe(local.token)
    expect(readProjectConfig(file)?.storage).toMatchObject(storage)
    await handleEnvConfig(store, ['get', 'token'], createCliOptions())
    await handleEnvConfig(store, ['list'], createCliOptions())
    expect(logger.info.mock.calls.flat().join('\n')).not.toMatch(/gitlab-local-secret|github-legacy-token/)
    await handleEnvConfig(store, ['rm', 'token'], createCliOptions())
    expect(store.credentials?.[credentialKey('gitlab', storage.apiBaseUrl)]).toBeUndefined()
  })

  it('shows effective identity, sources and fully masked token in status', async () => {
    const file = await project()
    vi.stubEnv('INITX_ENV_TOKEN', 'long-secret-sentinel')
    await handleEnvConfig(local, ['status'], createCliOptions({ config: file, offline: true }))
    const output = logger.info.mock.calls.flat().join('\n')
    for (const expected of ['gitlab', storage.apiBaseUrl, storage.repo, file, 'INITX_ENV_TOKEN', '***'])
      expect(output).toContain(expected)
    expect(output).not.toMatch(/long-secret|sentinel|github-legacy/)
  })
})
