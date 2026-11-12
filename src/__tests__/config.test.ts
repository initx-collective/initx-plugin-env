import type { EnvPluginStore } from '../config'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveToken } from '../config'
import { isValidProfileName, matchProfile, normalizeProfileName } from '../profile'

const githubProfile = {
  type: 'github' as const,
  apiBaseUrl: 'https://api.github.com',
  repo: 'me/vault',
  branch: 'main',
  path: 'stores',
  token: 'gh-token'
}

const gitlabProfile = {
  type: 'gitlab' as const,
  apiBaseUrl: 'https://gitlab.acewill.cn/api/v4',
  repo: 'imba97/env',
  branch: 'main',
  path: 'stores',
  token: 'gl-token'
}

function store(): EnvPluginStore {
  return {
    defaultProfile: 'default',
    profiles: { default: githubProfile, acewill: gitlabProfile }
  }
}

describe('profile 解析（无项目文件时用默认 profile）', () => {
  it('回落到 defaultProfile', () => {
    const config = resolveConfig(store(), { env: {} })
    expect(config).toMatchObject({
      profile: 'default',
      profileSource: 'default',
      type: 'github',
      repo: 'me/vault',
      token: 'gh-token',
      tokenSource: 'profile'
    })
  })

  it('--profile 显式指定优先于默认', () => {
    const config = resolveConfig(store(), { profile: 'acewill', env: {} })
    expect(config).toMatchObject({ profile: 'acewill', profileSource: 'flag', token: 'gl-token' })
  })

  it('显式指定不存在的 profile 时报错并列出已有的', () => {
    expect(() => resolveConfig(store(), { profile: 'nope', env: {} }))
      .toThrow(/profile "nope" 不存在[\s\S]*acewill、default/)
  })

  it('没有任何 profile 时提示 setup', () => {
    expect(() => resolveConfig({ profiles: {} }, { env: {} })).toThrow(/env setup/)
  })

  it('iNITX_ENV_TOKEN 覆盖 profile 里的 token', () => {
    const config = resolveConfig(store(), {
      env: { INITX_ENV_TOKEN: 'ci-token' }
    })
    expect(config.token).toBe('ci-token')
    expect(config.tokenSource).toBe('INITX_ENV_TOKEN')
  })

  it('--token 优先级最高', () => {
    const result = resolveToken(store(), {
      token: 'flag-token',
      env: { INITX_ENV_TOKEN: 'ci' }
    })
    expect(result).toEqual({ token: 'flag-token', source: 'flag' })
  })

  it('profile 缺 token 时报错提示 edit', () => {
    expect(() => resolveConfig({
      profiles: {
        x: { ...githubProfile, token: undefined }
      }
    }, { env: {} }))
      .toThrow(/env edit x/)
  })

  it('profile 缺 repo 时报错', () => {
    expect(() => resolveConfig({
      profiles: {
        x: { ...githubProfile, repo: '' }
      }
    }, { env: {} }))
      .toThrow(/vault 仓库/)
  })

  it('缺省 branch/path 时补默认值', () => {
    const config = resolveConfig(
      {
        profiles: {
          x: {
            type: 'github',
            apiBaseUrl: 'https://api.github.com',
            repo: 'a/b',
            token: 't'
          }
        }
      },
      { env: {} }
    )
    expect(config).toMatchObject({ branch: 'main', path: 'stores' })
  })
})

describe('项目文件自身充当 profile（CI 无人值守）', () => {
  function writeProject(content: unknown): { file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'initx-env-project-'))
    const file = join(dir, '.initx-env.json')
    writeFileSync(file, JSON.stringify(content), 'utf8')
    return { file }
  }

  it('本机没有任何 profile 时直接用项目文件定位 vault', () => {
    const { file } = writeProject({
      schema: 1,
      storage: {
        type: 'gitlab',
        apiBaseUrl: 'https://gitlab.acewill.cn/api/v4',
        repo: 'imba97/env',
        branch: 'main',
        path: 'stores'
      }
    })

    const config = resolveConfig({}, {
      config: file,
      env: { INITX_ENV_TOKEN: 'ci-token' }
    })

    expect(config).toMatchObject({
      profile: 'default',
      profileSource: 'project-match',
      type: 'gitlab',
      repo: 'imba97/env',
      token: 'ci-token',
      tokenSource: 'INITX_ENV_TOKEN'
    })
  })

  it('缺少 INITX_ENV_TOKEN 时仍然报错提示 token', () => {
    const { file } = writeProject({
      schema: 1,
      storage: { type: 'gitlab', apiBaseUrl: 'https://gitlab.acewill.cn/api/v4', repo: 'imba97/env' }
    })

    expect(() => resolveConfig({}, { config: file, env: {} }))
      .toThrow(/token/)
  })

  it('本机已有同后端 profile 时项目配置仍优先，profile 只提供 token', () => {
    const { file } = writeProject({
      schema: 1,
      storage: { type: 'gitlab', apiBaseUrl: 'https://gitlab.acewill.cn/api/v4', repo: 'imba97/other' }
    })

    const config = resolveConfig(store(), { config: file, env: {} })

    expect(config).toMatchObject({
      profile: 'acewill',
      profileSource: 'project-match',
      repo: 'imba97/other',
      token: 'gl-token'
    })
  })
})

describe('matchProfile 自动匹配', () => {
  const profiles = {
    default: githubProfile,
    envA: { ...gitlabProfile, repo: 'imba97/env' },
    envB: { ...gitlabProfile, repo: 'imba97/other' }
  }

  it('同后端只有一个时直接命中', () => {
    const result = matchProfile({ default: githubProfile }, {
      type: 'github',
      apiBaseUrl: 'https://api.github.com',
      repo: 'irrelevant'
    })
    expect(result.reason).toBe('matched')
    expect(result.matched?.name).toBe('default')
  })

  it('同后端多个时用 repo 唯一区分', () => {
    const result = matchProfile(profiles, {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.acewill.cn/api/v4',
      repo: 'imba97/other'
    })
    expect(result.reason).toBe('matched')
    expect(result.matched?.name).toBe('envB')
  })

  it('同后端多个且 repo 也没命中时返回候选', () => {
    const result = matchProfile(profiles, {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.acewill.cn/api/v4',
      repo: 'unknown/repo'
    })
    expect(result.reason).toBe('ambiguous')
    expect(result.candidates.map(c => c.name)).toEqual(['envA', 'envB'])
  })

  it('后端不同时不做匹配', () => {
    const result = matchProfile(profiles, {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      repo: 'imba97/env'
    })
    expect(result.reason).toBe('none')
  })
})

describe('profile 名校验', () => {
  it('接受小写字母数字与连字符下划线', () => {
    expect(isValidProfileName('acewill')).toBe(true)
    expect(isValidProfileName('my-env_2')).toBe(true)
  })

  it('拒绝大写、空格与路径分隔符', () => {
    expect(isValidProfileName('Acewill')).toBe(false)
    expect(isValidProfileName('my env')).toBe(false)
    expect(isValidProfileName('a/b')).toBe(false)
    expect(() => normalizeProfileName('  ')).toThrow(/不能为空/)
    expect(() => normalizeProfileName('Bad')).toThrow(/不合法/)
  })

  it('trim 后返回', () => {
    expect(normalizeProfileName('  acewill  ')).toBe('acewill')
  })
})
