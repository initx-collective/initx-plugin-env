import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import process from 'node:process'
import { inquirer, logger } from '@initx-plugin/utils'
import { configFileOption } from '../cli-options'
import { credentialKey, DEFAULT_BRANCH, DEFAULT_PATH, hintSecret, localIdentity, resolveConfig } from '../config'
import { ProjectConfigError } from '../project-config'
import { createStorageAdapter } from '../storage/factory'
import { assertSafePath, DEFAULT_API_URLS, normalizeApiBaseUrl, validateStorageRepo } from '../storage/path'
import { listStores } from '../store'

/**
 * `npx initx env-config ...` —— vault 仓库本身的配置。
 *
 * 形状刻意对齐 initx-plugin-cp 的 `cp-config`（setup / set / get / list / rm / status），
 * 唯一的改动：token 一律脱敏输出。
 */

const CONFIG_KEYS = ['type', 'apiBaseUrl', 'repo', 'token', 'branch', 'path'] as const
type ConfigKey = typeof CONFIG_KEYS[number]

const TOKEN_WARNING = 'token 会以**明文**存在 ~/.initx/stores/@initx-plugin/env/store.json；'
  + '介意的话改用环境变量 INITX_ENV_TOKEN，或每次用 --token 传。'

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key)
}

export async function handleEnvConfig(
  store: EnvPluginStore,
  args: string[],
  options: CliOptions
): Promise<void> {
  const [command = 'status', ...rest] = args

  switch (command) {
    case 'setup':
      return runSetup(store)

    case 'set':
      return runSet(store, rest)

    case 'get':
      return runGet(store, rest)

    case 'list':
    case 'ls':
      return runList(store)

    case 'rm':
    case 'remove':
      return runRemove(store, rest)

    case 'status':
      return runStatus(store, options)

    default:
      printHelp()
  }
}

async function runSetup(store: EnvPluginStore): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'setup 需要交互式终端。非交互环境请用：\n'
      + '  npx initx env-config set repo <owner/repo>\n'
      + '  npx initx env-config set token <pat>'
    )
  }

  const identity = localIdentity(store)
  const repo = await inquirer.input(`vault 仓库（${identity.type}）`, {
    default: persistedValue(store, 'repo'),
    required: true
  })
  runSet(store, ['repo', repo])

  const token = await inquirer.password(`${identity.type} token（回车保留当前值）`, { mask: '*' })

  if (token)
    runSet(store, ['token', token])

  const branch = await inquirer.input('分支', { default: persistedValue(store, 'branch') || DEFAULT_BRANCH })
  runSet(store, ['branch', branch || DEFAULT_BRANCH])

  const path = await inquirer.input('store 目录', { default: persistedValue(store, 'path') || DEFAULT_PATH })
  runSet(store, ['path', path || DEFAULT_PATH])

  logger.success('本地 vault 配置已保存')
  logger.warn(TOKEN_WARNING)
}

function runSet(store: EnvPluginStore, args: string[]): void {
  const [key, ...valueParts] = args

  if (!key || !isConfigKey(key))
    throw new Error(`用法：npx initx env-config set <${CONFIG_KEYS.join('|')}> <值>`)

  const value = valueParts.join(' ').trim()

  if (!value)
    throw new Error(`${key} 的值不能为空`)

  const identity = localIdentity(store)
  if (key === 'type' || key === 'apiBaseUrl') {
    if (key === 'type' && value !== 'github' && value !== 'gitlab')
      throw new Error('type 必须是 github 或 gitlab')
    const type = key === 'type' ? value as 'github' | 'gitlab' : identity.type
    const apiBaseUrl = key === 'apiBaseUrl' ? normalizeApiBaseUrl(value) : type === identity.type ? identity.apiBaseUrl : DEFAULT_API_URLS[type]
    const same = identity.type === type && identity.apiBaseUrl === apiBaseUrl
    store.storage = { ...(same ? store.storage || { repo: store.repo, branch: store.branch, path: store.path } : {}), type, apiBaseUrl }
  }
  else if (key === 'token') {
    if (!store.storage)
      store.token = value
    else
      (store.credentials ??= {})[credentialKey(identity.type, identity.apiBaseUrl)] = value
  }
  else {
    if (key === 'repo')
      validateStorageRepo(identity.type, value)
    if (key === 'path')
      assertSafePath(value)
    if (store.storage)
      store.storage[key] = value
    else
      store[key] = value
  }

  if (key === 'token') {
    logger.success(`token 已保存：${hintSecret(value)}`)
    logger.warn(TOKEN_WARNING)
    return
  }

  logger.success(`${key} = ${value}`)
}

function runGet(store: EnvPluginStore, args: string[]): void {
  const [key] = args

  if (!key || !isConfigKey(key))
    throw new Error(`用法：npx initx env-config get <${CONFIG_KEYS.join('|')}>`)

  // token 永远不打明文
  logger.info(`${key} = ${displayValue(store, key)}`)
}

function runList(store: EnvPluginStore): void {
  for (const key of CONFIG_KEYS)
    logger.info(`${key}: ${displayValue(store, key)}`)
}

function runRemove(store: EnvPluginStore, args: string[]): void {
  const [key] = args

  if (!key || !isConfigKey(key))
    throw new Error(`用法：npx initx env-config rm <${CONFIG_KEYS.join('|')}>`)

  if (key === 'token') {
    const identity = localIdentity(store)
    delete store.credentials?.[credentialKey(identity.type, identity.apiBaseUrl)]
    if (identity.type === 'github' && identity.apiBaseUrl === DEFAULT_API_URLS.github)
      delete store.token
  }
  else if (key === 'type' || key === 'apiBaseUrl') {
    // Clearing identity also clears its location; credentials remain bound to their original API.
    delete store.storage
  }
  else if (store.storage) {
    delete store.storage[key]
  }
  else {
    delete store[key]
  }
  logger.success(`已清除 ${key}`)
}

async function runStatus(store: EnvPluginStore, options: CliOptions): Promise<void> {
  const file = configFileOption(options)
  let config
  try {
    config = resolveConfig(store, { token: options.string('token'), config: file })
  }
  catch (error) {
    if (error instanceof ProjectConfigError)
      throw error
    // Preserve the original status behavior for incomplete local configuration.
    logger.warn((error as Error).message)
    return
  }

  logger.info(`存储后端: ${config.type}`)
  logger.info(`API 地址: ${config.apiBaseUrl}`)
  logger.info(`配置来源: ${config.configSource}`)
  logger.info(`字段来源: ${JSON.stringify(config.sources)}`)
  logger.info(`vault 仓库: ${config.repo}`)
  logger.info(`分支: ${config.branch}`)
  logger.info(`store 目录: ${config.path}`)
  logger.info(`token: ${hintSecret(config.token)}（来自 ${config.tokenSource}）`)

  if (options.boolean('offline')) {
    logger.info('（--offline：跳过连通性检查）')
    return
  }

  try {
    const client = createStorageAdapter(config)
    const stores = await listStores(client, config.path)
    logger.success(`连通正常，${config.path}/ 下有 ${stores.length} 个 store`)
  }
  catch (error) {
    logger.error(`连不上或没权限：${(error as Error).message}`)
    logger.warn('检查：仓库、ref、当前后端 token 的读取权限与 API 地址')
  }
}

function persistedValue(store: EnvPluginStore, key: ConfigKey): string | undefined {
  const identity = localIdentity(store)
  if (key === 'type' || key === 'apiBaseUrl')
    return identity[key]
  if (key === 'token')
    return store.credentials?.[credentialKey(identity.type, identity.apiBaseUrl)] || (identity.type === 'github' && identity.apiBaseUrl === DEFAULT_API_URLS.github ? store.token : undefined)
  return store.storage ? store.storage[key] : store[key]
}

function displayValue(store: EnvPluginStore, key: ConfigKey): string {
  const value = persistedValue(store, key)
  return key === 'token' ? hintSecret(value || '') : value ?? '(未设置)'
}

export function printConfigHelp(): void {
  printHelp()
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
用法：npx initx env-config <命令>

  setup                      交互式配置当前本地后端（repo / token / branch / path）
  set <key> <value>          设置单项，key 取 type | apiBaseUrl | repo | token | branch | path
  get <key>                  查看持久化单项（token 会脱敏）
  list                       查看全部持久化配置（token 会脱敏）
  rm <key>                   清除单项
  status [--config <file>] [--offline]  查看实际生效配置、来源 + 连通性检查

解析优先级：显式 override > INITX_ENV_* > 项目 .initx-env.json > 同后端/API 的持久化配置 > 默认值。
Token：--token > INITX_ENV_TOKEN > GH_TOKEN / GITHUB_TOKEN（仅 GitHub 默认 API）> 当前 API 绑定的持久化凭据。
get/list/set/rm 仅操作本地配置；切换 type / apiBaseUrl 会清除旧目标定位，凭据仍绑定原 API。
项目文件 schema 1，仅可存 storage.type/apiBaseUrl/repo/branch/path，禁止 token 与业务变量。

示例：
  npx initx env-config set repo imba97/env-vault
  npx initx env-config set token github_pat_xxx
  npx initx env-config set path stores
  npx initx env-config status
  npx initx env-config set type gitlab
  npx initx env-config set apiBaseUrl https://gitlab.example.com/api/v4
  npx initx env-config set repo group/subgroup/vault
`)
}
