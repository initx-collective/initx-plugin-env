import type { StorageType } from '../storage/types'
import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCliOptions } from '../cli-options'
import { handleEnv } from '../commands/env'
import { handleEnvApply } from '../commands/env-apply'
import { handleEnvConfig } from '../commands/env-config'
import { loadSodium, openSealedBoxForTest } from '../crypto/sealed-box'
import { createHarness } from './run-harness'

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('@initx-plugin/utils', () => ({ logger, inquirer: {} }))

let harness: Awaited<ReturnType<typeof createHarness>>
let file: string
let vars: Record<string, string>
let requests: { url: URL, init: RequestInit }[]
const sourceToken = 'gitlab-source-only'
const targetToken = 'github-target-only'

beforeEach(async () => {
  harness = await createHarness()
  file = join(harness.directory, '.initx-env.json')
  await writeFile(file, JSON.stringify({ schema: 1, storage: { type: 'gitlab', apiBaseUrl: 'https://gitlab.example/api/v4', repo: 'group/sub/vault', branch: 'main', path: 'stores' } }))
  vars = { A: 'new', REMOTE: 'keep' }
  requests = []
  for (const key of ['INITX_ENV_REPO', 'INITX_ENV_BRANCH', 'INITX_ENV_PATH', 'INITX_ENV_TYPE', 'INITX_ENV_API_BASE_URL', 'INITX_ENV_TARGET_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])
    vi.stubEnv(key, '')
  vi.stubEnv('INITX_ENV_TOKEN', sourceToken)
  vi.stubEnv('GITHUB_ENV', harness.env.GITHUB_ENV!)
  vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
    const url = new URL(value)
    requests.push({ url, init })
    if (url.pathname.includes('/commits/'))
      return Response.json({ id: 'head' })
    if (url.pathname.endsWith('/tree'))
      return Response.json([{ name: 'demo.json', path: 'stores/demo.json', type: 'blob' }])
    if (init.method) {
      vars = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString()).vars
      return Response.json({ file_path: 'stores/demo.json' })
    }
    return Response.json({ content: Buffer.from(JSON.stringify({ schema: 1, vars })).toString('base64'), encoding: 'base64', last_commit_id: 'last-file-commit' })
  }))
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await harness.cleanup()
})

const options = (extra: Record<string, unknown> = {}) => createCliOptions({ config: file, ...extra })

describe('gitLab command regressions', () => {
  it('list and status go through the adapter factory', async () => {
    await handleEnv({ store: {}, options: options() }, ['list'])
    await handleEnvConfig({}, ['status'], options())
    expect(logger.info.mock.calls.flat().join('\n')).toContain('demo')
    expect(logger.success.mock.calls.flat().join('\n')).toContain('连通正常')
    expect(requests.every(request => request.url.hostname === 'gitlab.example')).toBe(true)
  })

  it('pull/set/push/setup retain merging, pruning and GitHub job injection semantics', async () => {
    const envFile = join(harness.directory, '.env')
    await writeFile(envFile, '# comment\nA=old\nLOCAL=keep\n')
    await handleEnv({ store: {}, options: options({ to: envFile }) }, ['pull', 'demo'])
    expect(await readFile(envFile, 'utf8')).toContain('# comment\nA=new\nLOCAL=keep')
    await handleEnv({ store: {}, options: options() }, ['set', 'demo', 'ADDED=中文'])
    expect(vars).toEqual({ A: 'new', REMOTE: 'keep', ADDED: '中文' })
    await writeFile(envFile, 'A=changed\nLOCAL=keep\n')
    await handleEnv({ store: {}, options: options({ from: envFile }) }, ['push', 'demo'])
    expect(vars).toEqual({ A: 'changed', REMOTE: 'keep', ADDED: '中文', LOCAL: 'keep' })
    await handleEnv({ store: {}, options: options({ from: envFile, prune: true }) }, ['push', 'demo'])
    expect(vars).toEqual({ A: 'changed', LOCAL: 'keep' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleEnv({ store: {}, options: options() }, ['setup', 'demo'])
    expect(await readFile(harness.env.GITHUB_ENV!, 'utf8')).toContain('A=changed')
    const writes = requests.filter(request => request.init.method)
    expect(writes).toHaveLength(3)
    expect(writes.every(request => JSON.parse(String(request.init.body)).last_commit_id === 'last-file-commit')).toBe(true)
  })

  it.each(['github', 'gitlab'] as const)('%s force is bounded to one fresh-version retry and never retries permission/validation failures', async (type: StorageType) => {
    await writeFile(file, JSON.stringify({ schema: 1, storage: { type, repo: 'group/vault' } }))
    const envFile = join(harness.directory, '.env')
    await writeFile(envFile, 'A=local\n')
    for (const { status, concurrent } of [{ status: type === 'gitlab' ? 400 : 422, concurrent: true }, { status: 403, concurrent: false }, { status: 422, concurrent: false }]) {
      let version = 'initial'
      let writes = 0
      vi.stubGlobal('fetch', vi.fn(async (_value, init = {}) => {
        if (init.method) {
          writes++
          // Only the first case actually has a concurrent version change.
          if (concurrent)
            version = `concurrent-${writes}`
          return new Response('sensitive response', { status })
        }
        return Response.json({ type: 'file', sha: version, last_commit_id: version, content: Buffer.from(JSON.stringify({ schema: 1, vars: { A: 'old' } })).toString('base64'), encoding: 'base64' })
      }))
      const result = handleEnv({ store: {}, options: options({ from: envFile, force: true }) }, ['push', 'demo'])
      await expect(result).rejects.toMatchObject({ code: status === 403 ? 'permission' : concurrent ? 'conflict' : 'validation' })
      expect(writes).toBe(concurrent ? 2 : 1)
    }
  })

  it('rejects a missing or malformed explicit --config before any network request', async () => {
    for (const config of [join(harness.directory, 'missing.json'), true, ['one', 'two']])
      await expect(handleEnv({ store: {}, options: options({ config }) }, ['list'])).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

describe('apply source and destination credentials', () => {
  it('requires an independent target credential for a GitLab source, including dry-run', async () => {
    vi.stubEnv('GH_TOKEN', 'unrelated-github-token')
    await expect(handleEnvApply({ store: {}, options: options({ 'repo': 'target/actions', 'dry-run': true }) }, ['demo'])).rejects.toThrow(/独立凭据/)
    expect(requests).toEqual([])
  })

  it('uses explicit target credentials to seal and write GitHub Actions secrets from GitLab', async () => {
    const sodium = await loadSodium()
    const pair = sodium.crypto_box_keypair()
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL)
    const privateKey = sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL)
    const sourceFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (value, init = {}) => {
      const url = new URL(value)
      if (url.hostname === 'gitlab.example')
        return sourceFetch(value, init)
      requests.push({ url, init })
      return url.pathname.endsWith('/public-key') ? Response.json({ key_id: 'key', key: publicKey }) : new Response(null, { status: 201 })
    }))
    await handleEnvApply({ store: {}, options: options({ repo: 'target/actions', targetToken, only: 'A' }) }, ['demo'])
    const source = requests.find(request => request.url.hostname === 'gitlab.example')!
    expect(source.init.headers).toMatchObject({ 'PRIVATE-TOKEN': sourceToken })
    const destination = requests.filter(request => request.url.hostname === 'api.github.com')
    expect(destination).toHaveLength(2)
    for (const request of destination) {
      expect(request.init.headers).toMatchObject({ Authorization: `Bearer ${targetToken}` })
      expect(request.init.headers).not.toHaveProperty('PRIVATE-TOKEN')
      expect(request.url.pathname).toContain('/repos/target/actions/actions/secrets/')
    }
    const body = JSON.parse(String(destination[1]!.init.body))
    expect(await openSealedBoxForTest(body.encrypted_value, publicKey, privateKey)).toBe('new')
  })

  it('supports INITX_ENV_TARGET_TOKEN and keeps source identity unchanged', async () => {
    vi.stubEnv('INITX_ENV_TARGET_TOKEN', targetToken)
    await handleEnvApply({ store: {}, options: options({ 'repo': 'target/actions', 'dry-run': true }) }, ['demo'])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url.pathname).toContain('/projects/group%2Fsub%2Fvault/')
    expect(logger.info.mock.calls.flat().join('\n')).toContain('target/actions')
  })
})
