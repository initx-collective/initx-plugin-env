import process from 'node:process'

/**
 * 插件配置的解析：vault 仓库地址 + 访问凭据。
 *
 * 配置本身存在 initx 的 store 里（`~/.initx/stores/@initx-plugin/env/store.json`，
 * 由 `InitxPlugin` 的 `defaultStore` 机制自动落盘）。**Token 是明文存的** ——
 * 和 initx-plugin-cp 一样，这点会在写入时明确告警。
 *
 * 所有取值都遵循同一个优先级：**命令行 flag > 环境变量 > store 里的配置**。
 * 环境变量这条在 CI 里特别有用：不用把 PAT 落盘，直接给进程就行。
 */

export const DEFAULT_BRANCH = 'main'
export const DEFAULT_PATH = 'stores'

/** 插件自己的持久化配置（`src/index.ts` 的 defaultStore 就是它） */
export interface EnvPluginStore {
  repo?: string
  token?: string
  branch?: string
  path?: string
}

export interface EnvConfigOverrides {
  repo?: string
  token?: string
  branch?: string
  path?: string
  env?: Record<string, string | undefined>
}

export interface EnvPluginConfig {
  repo: string
  token: string
  branch: string
  path: string
}

export type TokenSource = 'flag' | 'INITX_ENV_TOKEN' | 'GH_TOKEN' | 'GITHUB_TOKEN' | 'config' | 'none'

export interface ResolvedEnvConfig extends EnvPluginConfig {
  tokenSource: TokenSource
}

/** 按优先级找 token，返回它来自哪里 —— 报错和 `status` 都要用这个来源信息 */
const TOKEN_ENV_KEYS = ['INITX_ENV_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const

export function resolveToken(
  store: EnvPluginStore,
  overrides: EnvConfigOverrides = {}
): { token: string, source: TokenSource } {
  const env = overrides.env ?? process.env

  if (overrides.token)
    return { token: overrides.token, source: 'flag' }

  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key]

    if (value)
      return { token: value, source: key }
  }

  if (store.token)
    return { token: store.token, source: 'config' }

  return { token: '', source: 'none' }
}

export function resolveConfig(
  store: EnvPluginStore,
  overrides: EnvConfigOverrides = {}
): ResolvedEnvConfig {
  const repo = overrides.repo || store.repo || ''
  const { token, source } = resolveToken(store, overrides)

  if (!repo) {
    throw new Error('还没配 vault 仓库，先跑：npx initx env-config set repo <owner/repo>')
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    throw new Error(`仓库要写成 owner/repo 形式，当前是 "${repo}"`)

  if (!token) {
    throw new Error(
      '没有可用的 GitHub token。三选一：\n'
      + '  1) npx initx env-config set token <pat>\n'
      + '  2) 设置环境变量 INITX_ENV_TOKEN（或 GH_TOKEN / GITHUB_TOKEN）\n'
      + '  3) 任何命令都支持 --token <pat> 临时传入'
    )
  }

  return {
    repo,
    token,
    branch: overrides.branch || store.branch || DEFAULT_BRANCH,
    path: overrides.path || store.path || DEFAULT_PATH,
    tokenSource: source
  }
}

/**
 * 输出用的脱敏。**任何时候都不要把 token 原样打出来** ——
 * initx-plugin-cp 的 `get token` 就是明文打印的，反面教材。
 */
export function maskSecret(value: string): string {
  return value ? '***' : '(未设置)'
}

/** 只用于给用户确认"是哪一个 token"，不泄露内容 */
export function hintSecret(value: string): string {
  if (!value)
    return '(未设置)'

  if (value.length <= 12)
    return `***（${value.length} 字符）`

  return `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 字符）`
}
