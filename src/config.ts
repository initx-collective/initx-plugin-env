import type { EnvProfile } from './profile'
import type { EnvProjectConfig, ProjectConfig } from './project-config'
import type { StorageLocation, StorageType } from './storage/types'
import process from 'node:process'
import { matchProfile, sortProfileNames } from './profile'
import { readProjectConfig } from './project-config'
import { DEFAULT_API_URLS, normalizeApiBaseUrl } from './storage/path'
import { migrateLegacyStore } from './store-migrate'

export type { EnvProjectConfig } from './project-config'
export { parseProjectConfig } from './project-config'

export function defineConfig<T extends EnvProjectConfig>(config: T): T {
  return config
}

export const DEFAULT_BRANCH = 'main'
export const DEFAULT_PATH = 'stores'

/**
 * 项目文件直接充当 profile 时使用的虚拟名字。
 *
 * 只出现在展示与调试信息里，不写回 store，也不会被 `ix env use` 选中。
 */
export const PROJECT_PROFILE_NAME = '(project)'

/**
 * 插件本地配置：只有 profiles 一份真相，外加"默认用哪个"。
 *
 * 重构后不再有顶层 repo/token 之类的扁平字段——那些由 `migrateLegacyStore`
 * 一次性清掉，避免出现两处配置互相覆盖。
 */
export interface EnvPluginStore {
  defaultProfile?: string
  profiles?: Record<string, EnvProfile>
  /** 旧字段，仅用于迁移识别，迁移后即删除 */
  repo?: string
  token?: string
  branch?: string
  path?: string
  storage?: Partial<StorageLocation>
  credentials?: Record<string, string>
}

export interface EnvConfigOverrides {
  /** 显式指定 profile，优先级最高 */
  profile?: string
  token?: string
  config?: string
  /**
   * The initx core passes null when it has already checked the plugin's
   * project config name and found no matching file. This keeps the legacy
   * resolver API usable for direct callers while preventing a second,
   * plugin-specific file search during normal plugin execution.
   */
  project?: ProjectConfig | null
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface ResolvedEnvConfig extends StorageLocation {
  token: string
  tokenSource: TokenSource
  profile: string
  profileSource: ProfileSource
  configSource: string
}

export type TokenSource = 'flag' | 'INITX_ENV_TOKEN' | 'profile' | 'none'
export type ProfileSource = 'flag' | 'project-match' | 'default' | 'none'

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export function profileNames(store: EnvPluginStore): string[] {
  return sortProfileNames(Object.keys(store.profiles ?? {}))
}

/** 取某个 profile；不存在时报可操作的错误。 */
export function requireProfile(store: EnvPluginStore, name: string): EnvProfile {
  const profile = store.profiles?.[name]

  if (!profile) {
    const existing = profileNames(store)
    throw new ProfileError(
      `profile "${name}" 不存在\n${
        existing.length ? `  现有：${existing.join('、')}\n` : '  本机还没有任何 profile\n'
      }  新建：ix env setup ${name}`
    )
  }

  return profile
}

/** 组装一个 profile：缺省分支/目录补默认值，API 地址统一归一化。 */
export function normalizeProfile(profile: EnvProfile): EnvProfile {
  return {
    ...profile,
    apiBaseUrl: normalizeApiBaseUrl(profile.apiBaseUrl),
    branch: profile.branch || DEFAULT_BRANCH,
    path: profile.path ?? DEFAULT_PATH
  }
}

function describeTarget(type: StorageType, apiBaseUrl: string, repo: string): string {
  return `${type} · ${apiBaseUrl}${repo ? ` · ${repo}` : ''}`
}

function resolveByProject(
  store: EnvPluginStore,
  project: NonNullable<ReturnType<typeof readProjectConfig>>
): { name: string, profile: EnvProfile } {
  const profiles = store.profiles ?? {}
  const result = matchProfile(profiles, project.storage)

  if (result.reason === 'matched' && result.matched)
    return result.matched

  const target = describeTarget(project.storage.type, project.storage.apiBaseUrl, project.storage.repo)

  if (result.reason === 'none') {
    // CI / 无人值守场景：项目文件里的 storage 已完整描述一个 vault，
    // 它本身就是一套可用配置，不必在本机再建 profile（token 走 INITX_ENV_TOKEN）。
    if (project.storage.repo) {
      return {
        name: PROJECT_PROFILE_NAME,
        profile: {
          type: project.storage.type,
          apiBaseUrl: project.storage.apiBaseUrl,
          repo: project.storage.repo,
          branch: project.storage.branch,
          path: project.storage.path
        }
      }
    }

    const existing = profileNames(store)
    throw new ProfileError(
      `找不到匹配的 profile\n`
      + `  项目要求：${target}\n${
        existing.length
          ? `  本地已有：\n${existing.map((name) => {
            const p = profiles[name]!
            return `    ${name}  ${describeTarget(p.type, p.apiBaseUrl, p.repo)}`
          }).join('\n')}\n`
          : '  本机还没有任何 profile\n'
      }  项目文件缺少 repo，补上或在本地新建：ix env setup\n`
      + `  或临时指定：ix env list --profile <name>`
    )
  }

  // ambiguous：同后端多个 profile 且 repo 也没能唯一区分。
  throw new ProfileError(
    `有多个 profile 指向 ${project.storage.type} · ${project.storage.apiBaseUrl}，无法仅凭项目文件确定用哪个\n`
    + `  项目 repo：${project.storage.repo || '(未指定)'}\n`
    + `  候选：\n${result.candidates.map((entry) => {
      const mark = entry.profile.repo === project.storage.repo ? ' ← repo 匹配' : ''
      return `    ${entry.name}  repo: ${entry.profile.repo || '(空)'}${mark}`
    }).join('\n')}\n`
    + `  请显式指定：--profile <name>，或调整 initx-env.config.ts 的 repo`
  )
}

export function resolveConfig(store: EnvPluginStore, overrides: EnvConfigOverrides = {}): ResolvedEnvConfig {
  const env = overrides.env ?? process.env
  // 迁移在这里兜底：任何读配置的路径都不会再看到旧形状。
  migrateLegacyStore(store)

  const explicit = overrides.profile
  const project = overrides.project !== undefined
    ? overrides.project ?? undefined
    : readProjectConfig(overrides.config, overrides.cwd)

  let name: string
  let profileSource: ProfileSource
  let profile: EnvProfile

  if (explicit) {
    name = explicit
    profileSource = 'flag'
    profile = requireProfile(store, explicit)
  }
  else if (project) {
    const resolved = resolveByProject(store, project)
    name = resolved.name
    profileSource = 'project-match'
    profile = resolved.profile
  }
  else if (store.defaultProfile && store.profiles?.[store.defaultProfile]) {
    name = store.defaultProfile
    profileSource = 'default'
    profile = store.profiles[name]!
  }
  else {
    // 只有一个 profile 时无需显式默认——本机只配了一套，意图没有歧义。
    const names = profileNames(store)
    if (names.length === 1) {
      name = names[0]!
      profileSource = 'default'
      profile = store.profiles![name]!
    }
    else {
      throw new ProfileError(
        names.length
          ? `有多个 profile 但没有默认值：${names.join('、')}\n  选一个：ix env use <name>\n  或指定：--profile <name>`
          : '还没有可用的 profile\n  新建：ix env setup'
      )
    }
  }

  profile = normalizeProfile(profile)

  if (!profile.repo) {
    throw new ProfileError(
      `profile "${name}" 缺少 vault 仓库\n`
      + `  修改：ix env edit ${name}`
    )
  }

  const flagToken = overrides.token
  const envToken = env.INITX_ENV_TOKEN
  const token = flagToken || envToken || profile.token || ''
  const tokenSource: TokenSource = flagToken
    ? 'flag'
    : envToken ? 'INITX_ENV_TOKEN' : profile.token ? 'profile' : 'none'

  if (!token) {
    throw new ProfileError(
      `profile "${name}" 没有 token\n`
      + `  CI 里设置 INITX_ENV_TOKEN，或本地：ix env edit ${name}`
    )
  }

  return {
    type: profile.type,
    apiBaseUrl: profile.apiBaseUrl,
    repo: profile.repo,
    branch: profile.branch ?? DEFAULT_BRANCH,
    path: profile.path ?? DEFAULT_PATH,
    token,
    tokenSource,
    profile: name,
    profileSource,
    configSource: project?.file ?? 'default'
  }
}

export function resolveToken(store: EnvPluginStore, overrides: EnvConfigOverrides = {}): { token: string, source: TokenSource } {
  const config = resolveConfig(store, overrides)
  return { token: config.token, source: config.tokenSource }
}

/** 新建 profile 时给一个可用的默认 API 地址。 */
export function defaultApiBaseUrl(type: StorageType): string {
  return DEFAULT_API_URLS[type]
}

export function maskSecret(value: string): string {
  return value ? '***' : '(未设置)'
}

export function hintSecret(value: string): string {
  return maskSecret(value)
}
