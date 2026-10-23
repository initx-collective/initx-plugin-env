import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveToken } from '../config'

describe('配置解析（同一份可注入环境，不回写）', () => {
  const local = { repo: 'local/vault', token: 'local-token', branch: 'local', path: 'local-stores' }
  const env = { INITX_ENV_REPO: 'ci/vault', INITX_ENV_BRANCH: 'ci', INITX_ENV_PATH: 'ci-stores', INITX_ENV_TOKEN: 'ci-token', GH_TOKEN: 'gh', GITHUB_TOKEN: 'github' }

  it('所有配置遵循 override > env > local > default', () => {
    const snapshot = { ...local }
    expect(resolveConfig(local, { env })).toMatchObject({ repo: 'ci/vault', branch: 'ci', path: 'ci-stores', token: 'ci-token' })
    expect(resolveConfig(local, { env, repo: 'flag/vault', branch: 'flag', path: 'flag-stores', token: 'flag-token' })).toMatchObject({ repo: 'flag/vault', branch: 'flag', path: 'flag-stores', token: 'flag-token', tokenSource: 'flag' })
    expect(resolveConfig(local, { env: {} })).toMatchObject(local)
    expect(resolveConfig({ repo: local.repo, token: local.token }, { env: {} })).toMatchObject({ branch: 'main', path: 'stores' })
    expect(local).toEqual(snapshot)
  })

  it('空值逐级回退，不读取真实进程环境', () => {
    const empty = { repo: '', branch: '', path: '', token: '' }
    expect(resolveConfig(local, { ...empty, env: { INITX_ENV_REPO: '', INITX_ENV_BRANCH: '', INITX_ENV_PATH: '', INITX_ENV_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' } })).toMatchObject(local)
    expect(resolveConfig({ repo: local.repo, token: local.token, branch: '', path: '' }, { ...empty, env: {} })).toMatchObject({ branch: 'main', path: 'stores' })
    expect(() => resolveConfig({}, { env: {} })).toThrow(/vault/)
    expect(() => resolveConfig({ repo: 'bad', token: 'fake' }, { env: {} })).toThrow(/owner\/repo/)
    expect(() => resolveConfig({ repo: 'o/r' }, { env: {} })).toThrow(/token/)
  })

  it('凭据 Token 优先级保持兼容', () => {
    expect(resolveToken(local, { env, token: 'flag' })).toEqual({ token: 'flag', source: 'flag' })
    expect(resolveToken(local, { env })).toEqual({ token: 'ci-token', source: 'INITX_ENV_TOKEN' })
    expect(resolveToken(local, { env: { GH_TOKEN: 'gh', GITHUB_TOKEN: 'github' } })).toEqual({ token: 'gh', source: 'GH_TOKEN' })
    expect(resolveToken(local, { env: { GITHUB_TOKEN: 'github' } })).toEqual({ token: 'github', source: 'GITHUB_TOKEN' })
    expect(resolveToken(local, { env: {} })).toEqual({ token: local.token, source: 'config' })
    expect(resolveToken({}, { env: {} })).toEqual({ token: '', source: 'none' })
  })
})
