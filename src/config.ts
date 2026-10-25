import type { StorageLocation, StorageType } from './storage/types'
import process from 'node:process'
import { readProjectConfig } from './project-config'
import { assertSafePath, DEFAULT_API_URLS, normalizeApiBaseUrl, validateStorageRepo } from './storage/path'

export const DEFAULT_BRANCH = 'main'
export const DEFAULT_PATH = 'stores'

/** Legacy flat fields remain GitHub-only; new local locations and credentials are scoped. */
export interface EnvPluginStore {
  repo?: string
  token?: string
  branch?: string
  path?: string
  storage?: Partial<StorageLocation>
  credentials?: Record<string, string>
}

export interface EnvConfigOverrides {
  repo?: string
  token?: string
  branch?: string
  path?: string
  type?: StorageType
  apiBaseUrl?: string
  config?: string
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface EnvPluginConfig extends StorageLocation {
  token: string
}
export type TokenSource = 'flag' | 'INITX_ENV_TOKEN' | 'GH_TOKEN' | 'GITHUB_TOKEN' | 'config' | 'none'
export interface ResolvedEnvConfig extends EnvPluginConfig {
  tokenSource: TokenSource
  configSource: string
  sources: Record<'type' | 'apiBaseUrl' | 'repo' | 'branch' | 'path', string>
}

export function credentialKey(type: StorageType, apiBaseUrl: string): string {
  return `${type}:${normalizeApiBaseUrl(apiBaseUrl)}`
}

export function localIdentity(store: EnvPluginStore): { type: StorageType, apiBaseUrl: string } {
  const type = store.storage?.type || 'github'
  if (type !== 'github' && type !== 'gitlab')
    throw new Error('本地 storage.type 必须是 github 或 gitlab')
  return { type, apiBaseUrl: normalizeApiBaseUrl(store.storage?.apiBaseUrl || DEFAULT_API_URLS[type]) }
}

function resolveLocation(store: EnvPluginStore, overrides: EnvConfigOverrides) {
  const env = overrides.env ?? process.env
  const project = readProjectConfig(overrides.config, overrides.cwd)
  const local = localIdentity(store)
  const rawType = overrides.type || env.INITX_ENV_TYPE || project?.storage.type || local.type
  if (rawType !== 'github' && rawType !== 'gitlab')
    throw new Error('storage.type 必须是 github 或 gitlab')
  const type: StorageType = rawType
  const projectMatchesType = project?.storage.type === type
  const base = overrides.apiBaseUrl || env.INITX_ENV_API_BASE_URL
    || (projectMatchesType ? project.storage.apiBaseUrl : undefined)
    || (local.type === type ? local.apiBaseUrl : DEFAULT_API_URLS[type])
  const apiBaseUrl = normalizeApiBaseUrl(base)
  const localMatches = local.type === type && local.apiBaseUrl === apiBaseUrl
  const projectMatches = projectMatchesType && project.storage.apiBaseUrl === apiBaseUrl
  const localFields = localMatches ? (store.storage || store) : {}
  const fields = projectMatches ? project.storage : undefined
  const sources: ResolvedEnvConfig['sources'] = {
    type: overrides.type ? 'override' : env.INITX_ENV_TYPE ? 'INITX_ENV_TYPE' : project ? 'project' : 'local/default',
    apiBaseUrl: overrides.apiBaseUrl ? 'override' : env.INITX_ENV_API_BASE_URL ? 'INITX_ENV_API_BASE_URL' : projectMatches ? 'project' : localMatches ? 'local/default' : 'default',
    repo: '',
    branch: '',
    path: ''
  }
  function field(key: 'repo' | 'branch' | 'path', fallback: string): string {
    const envKey = `INITX_ENV_${key.toUpperCase()}`
    const candidates = [
      [overrides[key] || undefined, 'override'],
      [env[envKey] || undefined, envKey],
      [fields?.[key], 'project'],
      [localFields[key] || undefined, 'local'],
      [fallback, 'default']
    ] as const
    const selected = candidates.find(([value]) => value !== undefined)!
    sources[key] = selected[1]
    return selected[0]!
  }
  return { type, apiBaseUrl, repo: field('repo', ''), branch: field('branch', DEFAULT_BRANCH), path: field('path', DEFAULT_PATH), sources, configSource: project?.file || 'local/env/default' }
}

function tokenFor(store: EnvPluginStore, overrides: EnvConfigOverrides, identity: Pick<StorageLocation, 'type' | 'apiBaseUrl'>): { token: string, source: TokenSource } {
  const env = overrides.env ?? process.env
  if (overrides.token)
    return { token: overrides.token, source: 'flag' }
  if (env.INITX_ENV_TOKEN)
    return { token: env.INITX_ENV_TOKEN, source: 'INITX_ENV_TOKEN' }
  const legacy = identity.type === 'github' && identity.apiBaseUrl === DEFAULT_API_URLS.github
  if (legacy) {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      if (env[key])
        return { token: env[key], source: key }
    }
  }
  const scoped = store.credentials?.[credentialKey(identity.type, identity.apiBaseUrl)]
  if (scoped)
    return { token: scoped, source: 'config' }
  if (legacy && store.token)
    return { token: store.token, source: 'config' }
  return { token: '', source: 'none' }
}

export function resolveToken(store: EnvPluginStore, overrides: EnvConfigOverrides = {}): { token: string, source: TokenSource } {
  return tokenFor(store, overrides, resolveLocation(store, overrides))
}

export function resolveConfig(store: EnvPluginStore, overrides: EnvConfigOverrides = {}): ResolvedEnvConfig {
  const location = resolveLocation(store, overrides)
  if (!location.repo)
    throw new Error('还没配 vault 仓库，请配置 .initx-env.json 或 env-config set repo <owner/repo>')
  validateStorageRepo(location.type, location.repo)
  assertSafePath(location.path, true)
  const { token, source } = tokenFor(store, overrides, location)
  if (!token)
    throw new Error('没有可用的当前后端 token，请设置 INITX_ENV_TOKEN、--token 或绑定当前 API 地址的本地凭据')
  return { ...location, token, tokenSource: source }
}

export function maskSecret(value: string): string {
  return value ? '***' : '(未设置)'
}

export function hintSecret(value: string): string {
  return maskSecret(value)
}
