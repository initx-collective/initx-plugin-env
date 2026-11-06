import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import type { StorageAdapter } from '../storage/types'
import type { StoreRef } from '../store'
import { readdir } from 'node:fs/promises'
import process from 'node:process'
import { inquirer, logger } from '@initx-plugin/utils'
import { configFileOption } from '../cli-options'
import { resolveConfig } from '../config'
import { assertEnvLimit, assertInlineLimit, maxFileBytes } from '../files/limits'
import { storeFilesPath } from '../files/paths'
import { analyzePush, hashBytes } from '../files/push'
import { collectVarFileRefs, keysReferencing, parseFileRef } from '../files/refs'
import { resolveStoreVars } from '../files/resolve'
import { isConflictError } from '../storage/errors'
import { createStorageAdapter } from '../storage/factory'
import { applyVars, deleteStore, listStores, readStore, serializeStore, writeStore } from '../store'
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

    case 'unset':
      return runUnset(ctx, rest)

    case 'rm':
    case 'remove':
    case 'delete':
      return runRemove(ctx, rest)

    case 'setup':
      return runSetup(ctx, rest)

    default:
      throw new Error(`未知子命令 "${action}"，可用：list | pull | set | unset | push | rm | setup | apply（npx initx env help）`)
  }
}

export function createClient(ctx: EnvCommandContext, extra: { repo?: string } = {}) {
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
  const resolved = await resolveStoreVars(client, config.path, name, ref.store)
  const vars = resolved.vars
  const keys = Object.keys(vars)

  if (!keys.length) {
    logger.warn(colorText(`store "${name}" 里没有任何变量`, 'yellow'))
    return
  }

  assertInlineLimit(vars, name)

  const targets = await resolveTargets(ctx, ref)
  const dryRun = ctx.options.boolean('dry-run')

  for (const target of targets) {
    const original = await readEnvFileIfExists(target) ?? ''
    const result = mergeEnv(original, vars, { forceQuote: resolved.fileKeys })

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
  const refKeys = new Set(collectVarFileRefs(store).map(ref => ref.key))
  const change = applyVars(store, updates)
  const detached = Object.keys(updates).filter(key => refKeys.has(key) && parseFileRef(store.vars[key] ?? '') === null)

  // `set` 作用在引用键上等价于 --inline：值变成字面量，同时清掉不再被引用的文件条目。
  if (store.files) {
    for (const id of Object.keys(store.files)) {
      if (!keysReferencing(store, id).length)
        delete store.files[id]
    }
    if (!Object.keys(store.files).length)
      delete store.files
  }

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

  if (detached.length)
    logger.warn(colorText(`这些键已改为普通值，文件条目已清理：${detached.join('、')}`, 'yellow'))

  logger.success(colorText(`store "${name}" 已更新：新增 ${change.added.length} · 修改 ${change.updated.length}`, 'green'))
  for (const key of change.added)
    logger.info(colorText(`  + ${key}`, 'green'))
  for (const key of change.updated)
    logger.info(colorText(`  ~ ${key}`, 'yellow'))
}

async function runPush(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName] = args

  if (!rawName)
    throw new Error('用法：npx initx env push <store 名> [--from .env.local] [--prune] [--force] [--update-files|--inline]')

  const name = normalizeStoreName(rawName)
  const from = ctx.options.string('from') ?? (await pickDefaultEnvFile())
  const content = await readEnvFileIfExists(from)

  if (content === null)
    throw new Error(`找不到文件 "${from}"（用 --from 指定）`)

  const local = Object.fromEntries(parseEnv(content).pairs)

  if (!Object.keys(local).length)
    throw new Error(`"${from}" 里没解析出任何 KEY=value`)

  const updateFiles = ctx.options.boolean('update-files')
  const inline = ctx.options.boolean('inline')

  if (updateFiles && inline)
    throw new Error('--update-files 与 --inline 不能同时使用')

  const mode = updateFiles ? 'update-files' : inline ? 'inline' : 'error'
  const { config, client } = createClient(ctx)
  const existing = await readStore(client, config.path, name)
  const store = existing?.store ?? createEmptyStore()
  const before = serializeStore(store)
  const analysis = analyzePush(store, local, mode)

  if (analysis.conflicts.length && mode === 'error') {
    throw new Error(`这些引用键的本地内容与文件不同：${analysis.conflicts.join('、')}。
  --update-files  重新上传本地内容并保留引用
  --inline        改成普通值（删除文件条目）`)
  }

  const change = applyVars(store, analysis.updates)
  change.unchanged.push(...analysis.unchanged)

  for (const key of analysis.inline) {
    store.vars[key] = local[key]!
    change.updated.push(key)
  }

  const removed: string[] = []

  if (ctx.options.boolean('prune')) {
    for (const key of Object.keys(store.vars)) {
      if (!(key in local)) {
        delete store.vars[key]
        removed.push(key)
      }
    }
  }

  if (store.files) {
    for (const id of Object.keys(store.files)) {
      if (!keysReferencing(store, id).length)
        delete store.files[id]
    }
    if (!Object.keys(store.files).length)
      delete store.files
  }

  // 文件先写，store 后写；中途失败只会留下可被 check 发现的孤儿/漂移。
  for (const update of analysis.fileUpdates) {
    const limit = maxFileBytes()

    if (update.bytes.byteLength > limit)
      throw new Error(`文件 "${update.id}" 超过 ${limit} 字节上限`)

    const path = storeFilesPath(config.path, name, update.id)
    const current = await client.readBytes(path, { maxBytes: limit })

    if (!current)
      throw new Error(`文件 "${update.id}" 不存在，无法 --update-files`)

    await client.writeBytes(path, update.bytes, {
      condition: { kind: 'update', expectedVersion: current.version },
      message: `env: update file ${update.id} (${update.key}) in ${name}`
    })

    const entry = store.files![update.id]!
    entry.sha256 = hashBytes(update.bytes)
    entry.bytes = update.bytes.byteLength
  }

  if (!analysis.fileUpdates.length && serializeStore(store) === before) {
    logger.info(`store "${colorText(name, 'blue')}" 无需改动（${colorText(from, 'blue')} 里的值与当前内容一致）`)
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

  if (analysis.inline.length)
    logger.warn(colorText(`--inline：这些键已改成普通值，文件条目已清理：${analysis.inline.join('、')}`, 'yellow'))

  logger.success(colorText(`store "${name}" 已更新：新增 ${change.added.length} · 修改 ${change.updated.length}${removed.length ? ` · 删除 ${removed.length}` : ''}${analysis.fileUpdates.length ? ` · 文件 ${analysis.fileUpdates.length}` : ''}`, 'green'))
}

async function runRemove(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName] = args

  if (!rawName)
    throw new Error('用法：npx initx env rm <store 名> [--dry-run] [--keep-files]')

  const name = normalizeStoreName(rawName)
  const { config, client } = createClient(ctx)
  const ref = await requireStore(client, config.path, name)
  const fileIds = Object.keys(ref.store.files ?? {})
  const varsCount = Object.keys(ref.store.vars).length
  const keepFiles = ctx.options.boolean('keep-files')

  if (ctx.options.boolean('dry-run')) {
    logger.info(`${colorText('--dry-run，未删除', 'yellow')}：将删除 store "${colorText(name, 'blue')}"（${varsCount} 个变量${fileIds.length && !keepFiles ? ` · ${fileIds.length} 个文件` : ''}）`)
    return
  }

  // 先删文件对象，再删 store JSON：中途失败只留下可被 check 发现的孤儿，而不是悬空引用。
  const removedFiles = keepFiles ? 0 : await removeStoreFiles(client, config.path, name, fileIds)

  await deleteStore(client, config.path, name, ref.version, `env: rm ${name}`)

  logger.success(colorText(`store "${name}" 已删除（${varsCount} 个变量${removedFiles ? ` · ${removedFiles} 个文件` : ''}）`, 'green'))

  if (fileIds.length && keepFiles)
    logger.warn(colorText(`按 --keep-files 保留了 ${fileIds.length} 个文件对象`, 'yellow'))
}

/** 删除 store 目录下 `_files/` 里的文件对象，返回实际删掉的数量。 */
async function removeStoreFiles(
  client: StorageAdapter,
  basePath: string,
  name: string,
  ids: string[]
): Promise<number> {
  let removed = 0

  for (const id of ids) {
    const path = storeFilesPath(basePath, name, id)
    const current = await client.readBytes(path, { maxBytes: maxFileBytes() })

    if (!current) {
      logger.warn(colorText(`文件 "${id}" 已经不存在，跳过`, 'yellow'))
      continue
    }

    await client.remove(path, { expectedVersion: current.version, message: `env: rm file ${id} in ${name}` })
    removed++
  }

  return removed
}

async function runUnset(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName, ...keys] = args

  if (!rawName || !keys.length)
    throw new Error('用法：npx initx env unset <store 名> KEY [KEY2 ...]')

  const name = normalizeStoreName(rawName)
  const { config, client } = createClient(ctx)
  const ref = await requireStore(client, config.path, name)
  const store = ref.store

  const missing = keys.filter(key => !(key in store.vars))

  if (missing.length === keys.length)
    throw new Error(`store "${name}" 里没有这些变量：${missing.join('、')}`)

  // 删除前先记下每个键引用的文件 id，删完之后判断是否还有别的键在用。
  const touchedIds = new Set(
    keys
      .map(key => parseFileRef(store.vars[key] ?? ''))
      .filter((id): id is string => id !== null)
  )

  for (const key of keys)
    delete store.vars[key]

  const keptIds: string[] = []
  const orphanIds: string[] = []

  for (const id of touchedIds) {
    if (keysReferencing(store, id).length)
      keptIds.push(id)
    else
      orphanIds.push(id)
  }

  // 没有引用的文件条目从元数据里移除，避免 dangling-metadata。
  for (const id of orphanIds) {
    if (store.files)
      delete store.files[id]
  }
  if (store.files && !Object.keys(store.files).length)
    delete store.files

  const remainingVars = Object.keys(store.vars)

  const reportMissing = (): void => {
    for (const key of missing)
      logger.warn(colorText(`  - ${key}（原本就不存在）`, 'yellow'))
  }

  if (!remainingVars.length) {
    // 变量被删光：直接删掉 store 本身，并清理文件对象，否则会留一个空壳。
    const removedFiles = await removeStoreFiles(client, config.path, name, orphanIds)
    await deleteStore(client, config.path, name, ref.version, `env: unset ${keys.join(', ')} in ${name}`)

    logger.success(colorText(`store "${name}" 的变量已删光，store 一并删除（${keys.length - missing.length} 个变量${removedFiles ? ` · ${removedFiles} 个文件` : ''}）`, 'green'))
    reportMissing()
    return
  }

  await writeStore(client, config.path, name, store, `env: unset ${keys.join(', ')} in ${name}`, ref.version)

  const removedFiles = await removeStoreFiles(client, config.path, name, orphanIds)

  logger.success(colorText(`store "${name}" 已更新：删除 ${keys.length - missing.length} 个变量${removedFiles ? ` · ${removedFiles} 个文件` : ''}`, 'green'))
  for (const key of keys) {
    if (!missing.includes(key))
      logger.info(colorText(`  - ${key}`, 'red'))
  }
  reportMissing()

  if (keptIds.length)
    logger.info(colorText(`文件 ${keptIds.join('、')} 仍被其他键引用，已保留`, 'yellow'))
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
  const resolved = await resolveStoreVars(client, config.path, name, ref.store)
  const vars = resolved.vars

  if (!Object.keys(vars).length)
    throw new Error(`store "${name}" 里没有任何变量`)

  assertEnvLimit(vars, name)

  if (ctx.options.boolean('json')) {
    // 给 workflow 里 `fromJson(steps.x.outputs.vars)` 用
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(vars))
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
