import type { StorageLocation, StorageType } from './storage/types'

/**
 * 一个 profile 就是一套完整的 vault 连接配置。
 *
 * 刻意保持自包含：不继承、不合并。这样"本机同时挂多套仓库"只是多几条记录，
 * 而不是一套优先级猜谜。
 */
export interface EnvProfile {
  type: StorageType
  apiBaseUrl: string
  repo: string
  branch?: string
  path?: string
  token?: string
}

/** profile 名：小写字母数字与 `-` `_`，避免和文件系统、shell 语义打架。 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name)
}

export function normalizeProfileName(input: string): string {
  const name = input.trim()
  if (!name)
    throw new Error('profile 名不能为空')
  if (!isValidProfileName(name))
    throw new Error(`profile 名不合法："${input}"（只允许小写字母、数字、- 和 _，长度 1-64）`)
  return name
}

/** profile 列表按名字排序，便于稳定输出与测试断言。 */
export function sortProfileNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * 用项目文件里的定位去匹配本地 profile。
 *
 * 规则按"越具体越优先"：
 * 1. type + apiBaseUrl 必须一致（不同后端不可能共用 token）
 * 2. repo 一致者优先
 * 3. 只剩一个 → 直接用；剩多个 → 交给调用方提示用户选；一个不剩 → 报错
 */
export interface ProfileMatch {
  matched?: { name: string, profile: EnvProfile }
  candidates: { name: string, profile: EnvProfile }[]
  reason: 'matched' | 'ambiguous' | 'none'
}

export function matchProfile(
  profiles: Record<string, EnvProfile>,
  target: Pick<StorageLocation, 'type' | 'apiBaseUrl' | 'repo'>
): ProfileMatch {
  const entries = Object.entries(profiles).map(([name, profile]) => ({ name, profile }))
  const sameEndpoint = entries.filter(
    entry => entry.profile.type === target.type && entry.profile.apiBaseUrl === target.apiBaseUrl
  )

  if (!sameEndpoint.length)
    return { candidates: [], reason: 'none' }

  if (sameEndpoint.length === 1)
    return { matched: sameEndpoint[0], candidates: sameEndpoint, reason: 'matched' }

  const sameRepo = sameEndpoint.filter(entry => entry.profile.repo === target.repo)

  if (sameRepo.length === 1)
    return { matched: sameRepo[0], candidates: sameEndpoint, reason: 'matched' }

  return { candidates: sameEndpoint, reason: 'ambiguous' }
}
