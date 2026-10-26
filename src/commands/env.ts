import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import type { StorageAdapter } from '../storage/types'
import type { StoreRef } from '../store'
import { readdir } from 'node:fs/promises'
import process from 'node:process'
import { inquirer, logger } from '@initx-plugin/utils'
import { configFileOption } from '../cli-options'
import { resolveConfig } from '../config'
import { isConflictError } from '../storage/errors'
import { createStorageAdapter } from '../storage/factory'
import { applyVars, listStores, readStore, writeStore } from '../store'
import { createEmptyStore, isValidEnvKey, normalizeStoreName } from '../types'
import { diffEnv, mergeEnv, parseEnv, readEnvFileIfExists, writeEnvFileWithBackup } from '../utils/envfile'
import { injectEnv, isGitHubActions } from '../utils/gh-env'
import { colorText } from '../utils/terminal'

/**
 * `npx initx env ...` 的读侧命令：list / pull / setup，以及写侧：set / push。
 *
 * 这里刻意**不做任何本地缓存**：每次现拉仓库里的 JSON。
 * 缓存密钥的下场是"换了 token 但还在用旧的"，cp 的缓存正是这个坑。
 */

export interface EnvCommandContext {
  store: EnvPluginStore
  options: CliOptions
}

/** `.env` / `.env.local` / `.env.production` …（排除备份与模板） */
const ENV_FILE_RE = /^\.env(?:\..+)?$/
const ENV_FILE_EXCLUDE = ['.bak', '.example', '.sample', '.template', '.keys', '.enc']

export async function handleEnv(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [action = 'list', ...rest] = args

  switch (action) {
    case 'list':
    case 'ls':
      return runList(ctx)

    case 'pull':
      return runPull(ctx, rest)

    case 'set':
      return runSet(ctx, rest)

    case 'push':
      return runPush(ctx, rest)

    case 'setup':
      return runSetup(ctx, rest)

    default:
      throw new Error(`未知子命令 "${action}"，可用：list | pull | set | push | setup | apply（npx initx env help）`)
  }
}

function createClient(ctx: EnvCommandContext, extra: { repo?: string } = {}) {
  const config = resolveConfig(ctx.store, { token: ctx.options.string('token'), config: configFileOption(ctx.options), repo: extra.repo })

  return { config, client: createStorageAdapter({ ...config, debug: ctx.options.boolean('debug') || ctx.options.boolean('d') }) }
}

async function runList(ctx: EnvCommandContext): Promise<void> {
  const { config, client } = createClient(ctx)
  const names = await listStores(client, config.path)

  if (!names.length) {
    logger.warn(colorText(`${config.repo} 的 ${config.path}/ 下还没有 store`, 'yellow'))
    logger.info('建一个：npx initx env set <名字> KEY=value')
    return
  }

  logger.info(`${colorText(config.repo, 'blue')} · ${colorText(`${config.path}/`, 'blue')} 共 ${names.length} 个 store：`)
  for (const name of names)
    logger.info(`  - ${colorText(name, 'blue')}`)
}

/** 没给名字就列出来让用户选（只有一个时直接用） */
async function pickStoreName(
  client: StorageAdapter,
  basePath: string,
  name?: string
): Promise<string> {
  if (name)
    return normalizeStoreName(name)

  const names = await listStores(client, basePath)

  if (!names.length)
    throw new Error(`仓库里还没有 store。先建一个：npx initx env set <名字> KEY=value`)

  if (names.length === 1)
    return names[0]!

  if (!process.stdin.isTTY)
    throw new Error(`有多个 store，非交互环境下必须指定名字：\n  ${names.join('\n  ')}`)

  return inquirer.search('选一个 store', names)
}

async function requireStore(
  client: StorageAdapter,
  basePath: string,
  name: string
): Promise<StoreRef> {
  const ref = await readStore(client, basePath, name)

  if (!ref)
    throw new Error(`仓库里没有 store "${name}"。用 npx initx env list 看看有哪些`)

  return ref
}

/** 决定这次要写哪些 `.env` 文件：--to > store 里的 targets.envFiles > 探测当前目录 */
async function resolveTargets(
  ctx: EnvCommandContext,
  ref: StoreRef
): Promise<string[]> {
  const explicit = ctx.options.string('to')

  if (explicit)
    return explicit.split(',').map(item => item.trim()).filter(Boolean)

  const fromStore = ref.store.targets?.envFiles

  if (fromStore?.length)
    return fromStore

  const detected = await detectEnvFiles()

  if (detected.length === 1)
    return detected

  if (detected.length === 0) {
    if (!process.stdin.isTTY)
      return ['.env.local']

    const ok = await inquirer.confirm('当前目录没有 .env 文件，新建 .env.local？')

    if (!ok)
      throw new Error('已取消（也可以用 --to <文件> 指定目标）')

    return ['.env.local']
  }

  if (!process.stdin.isTTY)
    throw new Error(`当前目录有多个 .env 文件，非交互环境下请用 --to 指定：\n  ${detected.join('\n  ')}`)

  // 注意：`@initx-plugin/utils` 的 select 对字符串数组返回的是**下标**，不是值
  const index = await inquirer.select('写到哪个文件', detected)

  return [detected[index]!]
}

async function detectEnvFiles(): Promise<string[]> {
  const entries = await readdir(process.cwd(), { withFileTypes: true })

  return entries
    .filter(entry => entry.isFile() && ENV_FILE_RE.test(entry.name))
    .map(entry => entry.name)
    .filter(name => !ENV_FILE_EXCLUDE.some(suffix => name.endsWith(suffix)))
    .sort((a, b) => {
      const rank = (name: string) => (name === '.env.local' ? 0 : name === '.env' ? 1 : 2)

      return rank(a) - rank(b) || a.localeCompare(b)
    })
}

async function runPull(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { config, client } = createClient(ctx)
  const name = await pickStoreName(client, config.path, args[0])
  const ref = await requireStore(client, config.path, name)
  const vars = ref.store.vars
  const keys = Object.keys(vars)

  if (!keys.length) {
    logger.warn(colorText(`store "${name}" 里没有任何变量`, 'yellow'))
    return
  }

  const targets = await resolveTargets(ctx, ref)
  const dryRun = ctx.options.boolean('dry-run')

  for (const target of targets) {
    const original = await readEnvFileIfExists(target) ?? ''
    const result = mergeEnv(original, vars)

    if (!result.changed) {
      logger.info(`${colorText(target, 'blue')}: 已经是最新的（${keys.length} 个变量，无需改动）`)
      continue
    }

    if (dryRun) {
      const diff = diffEnv(original, vars)
      logger.info(`${colorText(target, 'blue')}（${colorText('--dry-run，未写入', 'yellow')}）：`)
      for (const key of diff.added)
        logger.info(colorText(`  + ${key}`, 'green'))
      for (const key of diff.updated)
        logger.info(colorText(`  ~ ${key}`, 'yellow'))
      continue
    }

    const { backupPath } = await writeEnvFileWithBackup(target, result.content)
    logger.success(colorText(`${target}: 新增 ${result.added.length} · 更新 ${result.updated.length} · 未变 ${result.unchanged.length}`, 'green'))

    if (backupPath)
      logger.info(`  旧文件备份在 ${colorText(backupPath, 'blue')}`)

    if (result.duplicates.length)
      logger.warn(colorText(`  注意：${result.duplicates.join(', ')} 在文件里出现多次，只更新了最后一行`, 'yellow'))
  }
}

function parsePairs(pairs: string[]): Record<string, string> {
  const vars: Record<string, string> = {}

  for (const pair of pairs) {
    const index = pair.indexOf('=')

    if (index <= 0)
      throw new Error('参数要写成 KEY=value 形式')

    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1)

    if (!isValidEnvKey(key))
      throw new Error(`变量名不合法："${key}"`)

    vars[key] = value
  }

  if (!Object.keys(vars).length)
    throw new Error('至少给一个 KEY=value')

  return vars
}

async function runSet(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName, ...pairs] = args

  if (!rawName)
    throw new Error('用法：npx initx env set <store 名> KEY=value [KEY2=value2 ...]')

  const name = normalizeStoreName(rawName)
  const updates = parsePairs(pairs)
  const { config, client } = createClient(ctx)
  const existing = await readStore(client, config.path, name)
  const store = existing?.store ?? createEmptyStore()
  const change = applyVars(store, updates)

  if (!change.added.length && !change.updated.length) {
    logger.info(`store "${colorText(name, 'blue')}" 无需改动（${change.unchanged.length} 个变量值相同）`)
    return
  }

  await writeStore(
    client,
    config.path,
    name,
    store,
    `env: set ${Object.keys(updates).join(', ')} in ${name}`,
    existing?.version
  )

  logger.success(colorText(`store "${name}" 已更新：新增 ${change.added.length} · 修改 ${change.updated.length}`, 'green'))
  for (const key of change.added)
    logger.info(colorText(`  + ${key}`, 'green'))
  for (const key of change.updated)
    logger.info(colorText(`  ~ ${key}`, 'yellow'))
}

async function runPush(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName] = args

  if (!rawName)
    throw new Error('用法：npx initx env push <store 名> [--from .env.local] [--prune] [--force]')

  const name = normalizeStoreName(rawName)
  const from = ctx.options.string('from') ?? (await pickDefaultEnvFile())
  const content = await readEnvFileIfExists(from)

  if (content === null)
    throw new Error(`找不到文件 "${from}"（用 --from 指定）`)

  const vars = Object.fromEntries(parseEnv(content).pairs)

  if (!Object.keys(vars).length)
    throw new Error(`"${from}" 里没解析出任何 KEY=value`)

  const { config, client } = createClient(ctx)
  const existing = await readStore(client, config.path, name)
  const store = existing?.store ?? createEmptyStore()
  const change = applyVars(store, vars)
  const removed: string[] = []

  if (ctx.options.boolean('prune')) {
    for (const key of Object.keys(store.vars)) {
      if (!(key in vars)) {
        delete store.vars[key]
        removed.push(key)
      }
    }
  }

  if (!change.added.length && !change.updated.length && !removed.length) {
    logger.info(`store "${colorText(name, 'blue')}" 无需改动（${colorText(from, 'blue')} 里的值都一样）`)
    return
  }

  const message = `env: push ${name} from ${from}`

  try {
    await writeStore(client, config.path, name, store, message, existing?.version)
  }
  catch (error) {
    if (!isConflictError(error) || !ctx.options.boolean('force'))
      throw error

    const latest = await requireStore(client, config.path, name)
    logger.warn(colorText('远端已更新，--force：以本地文件为准重新写入', 'yellow'))
    await writeStore(client, config.path, name, store, message, latest.version)
  }

  logger.success(colorText(`store "${name}" 已更新：新增 ${change.added.length} · 修改 ${change.updated.length}${removed.length ? ` · 删除 ${removed.length}` : ''}`, 'green'))
}

async function pickDefaultEnvFile(): Promise<string> {
  for (const candidate of ['.env.local', '.env']) {
    if (await readEnvFileIfExists(candidate) !== null)
      return candidate
  }

  throw new Error('当前目录没有 .env.local / .env（用 --from 指定文件）')
}

async function runSetup(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { config, client } = createClient(ctx)
  const name = await pickStoreName(client, config.path, args[0])
  const ref = await requireStore(client, config.path, name)
  const vars = ref.store.vars

  if (!Object.keys(vars).length)
    throw new Error(`store "${name}" 里没有任何变量`)

  if (ctx.options.boolean('json')) {
    // 给 workflow 里 `fromJson(steps.x.outputs.vars)` 用
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(vars))
    logger.info(`已输出 ${Object.keys(vars).length} 个变量（JSON）`)
    return
  }

  const result = injectEnv(vars, {
    forceStdout: ctx.options.boolean('stdout'),
    mask: !ctx.options.boolean('no-mask')
  })

  if (result.target === 'github_env') {
    logger.success(colorText(`已注入本次 job 的后续步骤（${result.injected.length} 个变量，${result.masked.length} 个已脱敏）`, 'green'))
    return
  }

  if (!isGitHubActions()) {
    logger.warn(colorText('当前不在 GitHub Actions 里，变量打到 stdout（可以 eval 或重定向）', 'yellow'))
  }
}
