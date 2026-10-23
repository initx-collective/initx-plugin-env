import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import process from 'node:process'
import { inquirer, logger } from '@initx-plugin/utils'
import { DEFAULT_BRANCH, DEFAULT_PATH, hintSecret, resolveConfig } from '../config'
import { GitHubContentsClient } from '../github'
import { listStores } from '../store'

/**
 * `npx initx env-config ...` —— vault 仓库本身的配置。
 *
 * 形状刻意对齐 initx-plugin-cp 的 `cp-config`（setup / set / get / list / rm / status），
 * 唯一的改动：token 一律脱敏输出。
 */

const CONFIG_KEYS = ['repo', 'token', 'branch', 'path'] as const
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

  const repo = await inquirer.input('vault 仓库（owner/repo）', {
    default: store.repo,
    required: true,
    pattern: /^[^/\s]+\/[^/\s]+$/,
    patternError: '要写成 owner/repo 形式'
  })

  store.repo = repo

  const token = await inquirer.password('GitHub token（回车保留当前值）', { mask: '*' })

  if (token)
    store.token = token

  const branch = await inquirer.input('分支', { default: store.branch || DEFAULT_BRANCH })
  store.branch = branch || DEFAULT_BRANCH

  const path = await inquirer.input('store 目录', { default: store.path || DEFAULT_PATH })
  store.path = path || DEFAULT_PATH

  logger.success(`已保存：${store.repo}（分支 ${store.branch}，目录 ${store.path}）`)
  logger.warn(TOKEN_WARNING)
}

function runSet(store: EnvPluginStore, args: string[]): void {
  const [key, ...valueParts] = args

  if (!key || !isConfigKey(key))
    throw new Error(`用法：npx initx env-config set <${CONFIG_KEYS.join('|')}> <值>`)

  const value = valueParts.join(' ').trim()

  if (!value)
    throw new Error(`${key} 的值不能为空`)

  if (key === 'repo' && !/^[^/\s]+\/[^/\s]+$/.test(value))
    throw new Error('repo 要写成 owner/repo 形式')

  store[key] = value

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
  logger.info(`${key} = ${key === 'token' ? hintSecret(store.token ?? '') : (store[key] ?? '(未设置)')}`)
}

function runList(store: EnvPluginStore): void {
  for (const key of CONFIG_KEYS)
    logger.info(`${key}: ${key === 'token' ? hintSecret(store.token ?? '') : (store[key] ?? '(未设置)')}`)
}

function runRemove(store: EnvPluginStore, args: string[]): void {
  const [key] = args

  if (!key || !isConfigKey(key))
    throw new Error(`用法：npx initx env-config rm <${CONFIG_KEYS.join('|')}>`)

  delete store[key]
  logger.success(`已清除 ${key}`)
}

async function runStatus(store: EnvPluginStore, options: CliOptions): Promise<void> {
  let config

  try {
    config = resolveConfig(store, { token: options.string('token') })
  }
  catch (error) {
    logger.warn((error as Error).message)
    return
  }

  logger.info(`vault 仓库: ${config.repo}`)
  logger.info(`分支: ${config.branch}`)
  logger.info(`store 目录: ${config.path}`)
  logger.info(`token: ${hintSecret(config.token)}（来自 ${config.tokenSource}）`)

  if (options.boolean('offline')) {
    logger.info('（--offline：跳过连通性检查）')
    return
  }

  try {
    const client = new GitHubContentsClient(config.repo, config.token, config.branch)
    const stores = await listStores(client, config.path)
    logger.success(`连通正常，${config.path}/ 下有 ${stores.length} 个 store`)
  }
  catch (error) {
    logger.error(`连不上或没权限：${(error as Error).message}`)
    logger.warn('检查：仓库名对不对、token 有没有 Contents 读写权限、分支是否存在')
  }
}

export function printConfigHelp(): void {
  printHelp()
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
用法：npx initx env-config <命令>

  setup                      交互式配置（repo / token / branch / path）
  set <key> <value>          设置单项，key 取 repo | token | branch | path
  get <key>                  查看持久化单项（token 会脱敏）
  list                       查看全部持久化配置（token 会脱敏）
  rm <key>                   清除单项
  status [--offline]         查看实际生效配置 + 连通性检查

解析优先级：显式 override > INITX_ENV_REPO / INITX_ENV_BRANCH / INITX_ENV_PATH > 持久化配置 > 默认值。
Token：--token > INITX_ENV_TOKEN > GH_TOKEN > GITHUB_TOKEN > 持久化配置。

示例：
  npx initx env-config set repo imba97/env-vault
  npx initx env-config set token github_pat_xxx
  npx initx env-config set path stores
  npx initx env-config status
`)
}
