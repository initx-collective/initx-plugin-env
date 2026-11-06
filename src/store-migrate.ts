import type { EnvProfile } from './profile'
import type { StorageType } from './storage/types'
import { DEFAULT_API_URLS, normalizeApiBaseUrl } from './storage/path'

/**
 * 旧配置形状：顶层扁平字段 + 一份 storage + 按 API 绑定的 credentials 字典。
 *
 * 这几种字段组合在重构前都可能出现，迁移要能覆盖全部：
 * - 只有顶层 repo/token（GitHub 时代的默认写法）
 * - storage 指向某个后端，credentials 里挂着它（或别的后端）的 token
 * - 两者都有（切换过 type 但没重新设 repo）
 */
export interface LegacyStoreShape {
  repo?: string
  token?: string
  branch?: string
  path?: string
  storage?: {
    type?: StorageType
    apiBaseUrl?: string
    repo?: string
    branch?: string
    path?: string
  }
  credentials?: Record<string, string>
  profiles?: Record<string, EnvProfile>
  defaultProfile?: string
}

export interface MigrationResult {
  changed: boolean
  /** 迁移出的 profile 名，按创建顺序 */
  created: string[]
  /** 被清掉的旧字段，用于提示与测试 */
  removed: string[]
}

const LEGACY_FIELDS = ['repo', 'token', 'branch', 'path', 'storage', 'credentials'] as const

/** credentials 的键形如 `<type>:<normalizedApiBaseUrl>`。 */
function parseCredentialKey(key: string): { type: StorageType, apiBaseUrl: string } | undefined {
  const index = key.indexOf(':')
  if (index <= 0)
    return undefined

  const type = key.slice(0, index)
  if (type !== 'github' && type !== 'gitlab')
    return undefined

  return { type, apiBaseUrl: key.slice(index + 1) }
}

function profileName(type: StorageType, apiBaseUrl: string, taken: Set<string>): string {
  if (type === 'github' && apiBaseUrl === DEFAULT_API_URLS.github)
    return 'default'

  const host = apiBaseUrl.replace(/^https?:\/\//, '').split('/')[0]!.split(':')[0]!
  const base = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || type
  let name = base
  let index = 2
  while (taken.has(name))
    name = `${base}-${index++}`
  return name
}

/**
 * 把旧配置就地迁移成 profiles。**幂等**：已经迁移过时原样返回。
 *
 * 迁移后旧字段一个不留——保留会导致"两处真相"，下次又得猜哪个优先。
 */
export function migrateLegacyStore(store: LegacyStoreShape): MigrationResult {
  const hasLegacy = LEGACY_FIELDS.some(field => store[field] !== undefined)

  if (!hasLegacy)
    return { changed: false, created: [], removed: [] }

  const profiles: Record<string, EnvProfile> = { ...(store.profiles ?? {}) }
  const taken = new Set(Object.keys(profiles))
  const created: string[] = []
  const defaultBranch = 'main'
  const defaultPath = 'stores'

  const addProfile = (profile: EnvProfile): void => {
    const name = profileName(profile.type, profile.apiBaseUrl, taken)
    taken.add(name)
    profiles[name] = { ...profile }
    created.push(name)
  }

  // 1. 顶层扁平字段：历史上只可能是 GitHub 默认 API。
  const hasFlatLocation = store.repo !== undefined || store.branch !== undefined || store.path !== undefined
  const flatProfile: EnvProfile = {
    type: 'github',
    apiBaseUrl: DEFAULT_API_URLS.github,
    repo: store.repo ?? '',
    branch: store.branch ?? defaultBranch,
    path: store.path ?? defaultPath,
    token: store.token
  }

  // 2. credentials 覆盖到各自后端；与顶层同 API 的合并成一个 profile。
  const handledEndpoints = new Set<string>()

  if (store.token && hasFlatLocation) {
    handledEndpoints.add(`github:${DEFAULT_API_URLS.github}`)
    addProfile(flatProfile)
  }
  else if (store.token) {
    handledEndpoints.add(`github:${DEFAULT_API_URLS.github}`)
    addProfile({ ...flatProfile, repo: store.storage?.repo ?? '' })
  }

  if (store.storage?.type) {
    const type = store.storage.type
    const apiBaseUrl = normalizeApiBaseUrl(store.storage.apiBaseUrl || DEFAULT_API_URLS[type])
    const endpoint = `${type}:${apiBaseUrl}`

    if (!handledEndpoints.has(endpoint)) {
      handledEndpoints.add(endpoint)
      addProfile({
        type,
        apiBaseUrl,
        repo: store.storage.repo ?? store.repo ?? '',
        branch: store.storage.branch ?? store.branch ?? defaultBranch,
        path: store.storage.path ?? store.path ?? defaultPath,
        token: store.credentials?.[endpoint]
      })
    }
  }

  for (const [key, token] of Object.entries(store.credentials ?? {})) {
    const parsed = parseCredentialKey(key)
    if (!parsed)
      continue

    const endpoint = `${parsed.type}:${parsed.apiBaseUrl}`
    if (handledEndpoints.has(endpoint))
      continue

    handledEndpoints.add(endpoint)
    addProfile({
      type: parsed.type,
      apiBaseUrl: parsed.apiBaseUrl,
      repo: store.repo ?? store.storage?.repo ?? '',
      branch: store.branch ?? store.storage?.branch ?? defaultBranch,
      path: store.path ?? store.storage?.path ?? defaultPath,
      token
    })
  }

  // 3. 只有存储定位、连 token 都没有的配置：也保留下来，否则用户会以为配置丢了。
  if (!created.length && hasFlatLocation) {
    handledEndpoints.add(`github:${DEFAULT_API_URLS.github}`)
    addProfile(flatProfile)
  }

  const removed: string[] = []

  for (const field of LEGACY_FIELDS) {
    if (store[field] !== undefined) {
      delete store[field]
      removed.push(field)
    }
  }

  store.profiles = profiles
  store.defaultProfile = store.defaultProfile && profiles[store.defaultProfile]
    ? store.defaultProfile
    : created[0] ?? Object.keys(profiles)[0]

  return { changed: true, created, removed }
}
