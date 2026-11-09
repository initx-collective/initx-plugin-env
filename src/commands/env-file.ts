import type { FileEncoding, FileEntry } from '../types'
import type { EnvCommandContext } from './env'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { logger } from '@initx-plugin/utils'
import { maxFileBytes } from '../files/limits'
import { storeFilesDir, storeFilesPath } from '../files/paths'
import { readVerifiedFile } from '../files/read'
import { assertValidFileId, collectVarFileRefs, FileRefError, formatFileRef, keysReferencing, parseFileRef, slugifyFileId } from '../files/refs'
import { resolveStoreVars } from '../files/resolve'
import { StorageSizeError } from '../storage/errors'
import { readStore, serializeStore, writeStore } from '../store'
import { createEmptyStore, isValidEnvKey, normalizeStoreName } from '../types'
import { colorText } from '../utils/terminal'
import { createClient } from './env'

/**
 * `initx env file ...`：文件对象的管理面。
 *
 * 与 `pull` / `push` 分开的理由：这些命令是「整份 .env 的键级投影」，
 * 而文件对象有自己的生命周期（上传、校验、引用、落盘），且有远端写副作用。
 */

const USAGE = '用法：initx env file add <store> KEY --file <path> [--as <id>] [--encoding utf8|base64] [--mode 600] [--dry-run]'

export async function handleEnvFile(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [action = 'ls', ...rest] = args

  switch (action) {
    case 'add':
      return runAdd(ctx, rest)

    case 'ls':
      return runList(ctx, rest)

    case 'cat':
      return runCat(ctx, rest)

    case 'pull':
      return runPull(ctx, rest)

    case 'rm':
      return runRm(ctx, rest)

    case 'check':
      return runCheck(ctx, rest)

    default:
      throw new Error(`未知子命令 "${action}"，可用：add | ls | cat | pull | rm | check`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertUtf8(bytes: Uint8Array): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new Error('文件不是合法 UTF-8；二进制内容请用 --encoding base64')
  }
}

function parseEncoding(value: string | undefined): FileEncoding {
  if (value === undefined)
    return 'utf8'
  if (value !== 'utf8' && value !== 'base64')
    throw new Error('--encoding 只能是 utf8 或 base64')
  return value
}

function parseMode(value: string | undefined): string | undefined {
  if (value === undefined)
    return undefined
  if (!/^[0-7]{3,4}$/.test(value))
    throw new Error('--mode 必须是 3-4 位八进制，例如 600')
  return value
}

async function readInput(path: string): Promise<Uint8Array> {
  if (path !== '-') {
    try {
      return new Uint8Array(await readFile(path))
    }
    catch {
      throw new Error('无法读取 --file 指定的文件，请检查路径与权限')
    }
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function runAdd(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const [rawName, key] = args

  if (!rawName || !key)
    throw new Error(USAGE)

  const name = normalizeStoreName(rawName)

  if (!isValidEnvKey(key))
    throw new Error(`变量名不合法："${key}"`)

  const filePath = ctx.options.string('file')

  if (!filePath)
    throw new Error(USAGE)

  const id = ctx.options.string('as') ?? slugifyFileId(key)
  assertValidFileId(id)

  const encoding = parseEncoding(ctx.options.string('encoding'))
  const mode = parseMode(ctx.options.string('mode'))
  const dryRun = ctx.options.boolean('dry-run')
  const bytes = await readInput(filePath)
  const limit = maxFileBytes()

  if (bytes.byteLength > limit)
    throw new Error(`文件超过 ${limit} 字节上限`)

  if (encoding === 'utf8')
    assertUtf8(bytes)

  const digest = sha256(bytes)
  const { config, client } = createClient(ctx)
  const existing = await readStore(client, config.path, name)
  const store = existing?.store ?? createEmptyStore()
  const before = serializeStore(store)
  const owners = keysReferencing(store, id)

  if (owners.some(owner => owner !== key))
    throw new Error(`文件 id "${id}" 已被 ${owners.join('、')} 引用；用 --as 指定新 id`)

  const previousId = parseFileRef(store.vars[key] ?? '')
  const path = storeFilesPath(config.path, name, id)

  if (dryRun) {
    logger.info(`${colorText('--dry-run', 'yellow')}：${colorText(key, 'blue')} → ${colorText(formatFileRef(id), 'blue')}`)
    logger.info(`  路径 ${colorText(path, 'blue')} · ${bytes.byteLength} 字节 · sha256 ${digest.slice(0, 8)}${encoding === 'base64'
      ? ' · base64'
      : ''}`)
    return
  }

  const current = await client.readBytes(path, { maxBytes: limit })

  if (!current) {
    await client.writeBytes(path, bytes, {
      condition: { kind: 'create' },
      message: `env: add file ${id} (${key}) in ${name}`
    })
  }
  else if (sha256(current.bytes) !== digest) {
    logger.info(`覆盖已有文件 ${colorText(id, 'blue')}（sha256 ${sha256(current.bytes).slice(0, 8)}/${current.bytes.byteLength} B → ${digest.slice(0, 8)}/${bytes.byteLength} B）`)
    await client.writeBytes(path, bytes, {
      condition: { kind: 'update', expectedVersion: current.version },
      message: `env: update file ${id} (${key}) in ${name}`
    })
  }

  store.vars[key] = formatFileRef(id)
  store.files = {
    ...(store.files ?? {}),
    [id]: {
      sha256: digest,
      bytes: bytes.byteLength,
      encoding,
      ...(mode
        ? { mode }
        : {})
    }
  }

  if (previousId && previousId !== id)
    logger.warn(colorText(`注意：${key} 原来引用 "${previousId}"，旧文件没有被删除；用 initx env file check 查看`, 'yellow'))

  if (!existing || serializeStore(store) !== before) {
    await writeStore(
      client,
      config.path,
      name,
      store,
      `env: add file ${id} for ${key} in ${name}`,
      existing?.version
    )
  }

  logger.success(colorText(`store "${name}" 已更新：${key} → ${formatFileRef(id)}`, 'green'))
  logger.info(`  ${colorText(path, 'blue')} · ${bytes.byteLength} 字节 · sha256 ${digest.slice(0, 8)}${encoding === 'base64'
    ? ' · base64'
    : ''}`)
}

async function openStore(ctx: EnvCommandContext, rawName?: string) {
  if (!rawName)
    throw new Error('要指定 store 名（用 initx env list 查看）')

  const name = normalizeStoreName(rawName)
  const { config, client } = createClient(ctx)
  const ref = await readStore(client, config.path, name)

  if (!ref)
    throw new Error(`仓库里没有 store "${name}"。用 initx env list 看看有哪些`)

  return { name, config, client, ref }
}

function describeEntry(entry: FileEntry): string {
  return `${entry.bytes} B · ${entry.encoding}${entry.mode
    ? ` · ${entry.mode}`
    : ''} · sha256 ${entry.sha256.slice(0, 8)}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function runList(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { name, ref } = await openStore(ctx, args[0])
  const refs = collectVarFileRefs(ref.store)
  const used = new Set(refs.map(item => item.id))
  const dangling = Object.keys(ref.store.files ?? {}).filter(id => !used.has(id))

  if (ctx.options.boolean('json')) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(refs.map(({ key, id }) => {
      const entry = ref.store.files?.[id]
      return entry
        ? { key, id, ...entry }
        : { key, id, missing: true }
    })))
    return
  }

  if (!refs.length) {
    logger.info(`store "${colorText(name, 'blue')}" 没有文件引用`)
  }
  else {
    logger.info(`store "${colorText(name, 'blue')}" 共 ${refs.length} 个文件引用：`)
    for (const { key, id } of refs) {
      const entry = ref.store.files?.[id]
      const detail = entry
        ? describeEntry(entry)
        : colorText('缺少元数据（用 file check 查看）', 'yellow')
      logger.info(`  ${colorText(key, 'blue')} → ${colorText(formatFileRef(id), 'blue')}  ${detail}`)
    }
  }

  if (dangling.length)
    logger.warn(colorText(`另有 ${dangling.length} 个未被引用的文件条目：${dangling.join(', ')}（用 file check 查看）`, 'yellow'))
}

async function runCat(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { name, config, client, ref } = await openStore(ctx, args[0])
  const key = args[1]

  if (!key)
    throw new Error('用法：initx env file cat <store> KEY [--show]')

  const id = parseFileRef(ref.store.vars[key] ?? '')

  if (!id)
    throw new Error(`${key} 不是文件引用`)

  const entry = ref.store.files?.[id]

  if (!entry)
    throw new Error(`文件 "${id}" 没有元数据，store 不完整`)

  if (!ctx.options.boolean('show')) {
    logger.info(`${colorText(key, 'blue')} → ${colorText(formatFileRef(id), 'blue')}  ${describeEntry(entry)}`)
    return
  }

  logger.warn(colorText('--show 会把注入值打到 stdout，注意日志采集', 'yellow'))
  const resolved = await resolveStoreVars(client, config.path, name, ref.store, {
    keys: [key]
  })
  // eslint-disable-next-line no-console
  console.log(resolved.vars[key])
}

async function runPull(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { name, config, client, ref } = await openStore(ctx, args[0])
  const dir = ctx.options.string('to-dir')

  if (!dir)
    throw new Error('用法：initx env file pull <store> --to-dir <dir> [--only KEY] [--force]')

  const only = ctx.options.string('only')?.split(',').map(item => item.trim()).filter(Boolean)
  const refs = collectVarFileRefs(ref.store).filter(item => !only || only.includes(item.key))

  if (!refs.length)
    throw new Error(`store "${name}" 没有可落盘的文件引用`)

  try {
    await mkdir(dir, { recursive: true })
  }
  catch {
    throw new Error('无法创建目标目录，请检查 --to-dir 与权限')
  }

  const written = new Set<string>()

  for (const { key, id } of refs) {
    if (written.has(id))
      continue

    const entry = ref.store.files?.[id]

    if (!entry)
      throw new FileRefError('unknown-ref', `${key} 引用了未声明的文件 "${id}"`)

    const target = join(dir, id)

    if (!ctx.options.boolean('force') && await exists(target))
      throw new Error(`目标文件已存在：${id}（加 --force 覆盖）`)

    const file = await readVerifiedFile(client, config.path, name, id, entry)
    const mode = Number.parseInt(entry.mode ?? '600', 8)

    try {
      // 创建时就带上权限，避免先 0644 再 chmod 的短暂窗口。
      await writeFile(target, file.bytes, { mode })

      if (process.platform !== 'win32')
        await chmod(target, mode)
    }
    catch {
      throw new Error(`写入文件 "${id}" 失败，请检查目录权限`)
    }

    written.add(id)
    logger.success(colorText(`${key} → ${id}`, 'green'))
  }

  logger.info('提示：确认目标目录在 .gitignore 内，避免密钥被提交')
}

async function runRm(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { name, config, client, ref } = await openStore(ctx, args[0])
  const key = args[1]

  if (!key)
    throw new Error('用法：initx env file rm <store> KEY [--keep-blob]')

  const id = parseFileRef(ref.store.vars[key] ?? '')

  if (!id)
    throw new Error(`${key} 不是文件引用（普通值请用 set 修改）`)

  const entry = ref.store.files?.[id]
  const path = storeFilesPath(config.path, name, id)

  delete ref.store.vars[key]

  const remaining = keysReferencing(ref.store, id)

  if (!remaining.length && ref.store.files) {
    delete ref.store.files[id]
    if (!Object.keys(ref.store.files).length)
      delete ref.store.files
  }

  await writeStore(client, config.path, name, ref.store, `env: rm ${key} in ${name}`, ref.version)

  if (remaining.length) {
    logger.warn(colorText(`文件 "${id}" 仍被 ${remaining.join('、')} 引用，保留文件本体`, 'yellow'))
    logger.success(colorText(`store "${name}" 已更新：删除 ${key} 的引用`, 'green'))
    return
  }

  if (ctx.options.boolean('keep-blob')) {
    logger.info(`保留文件本体 ${colorText(path, 'blue')}（check 会报孤儿）`)
  }
  else {
    const current = await client.readBytes(path, {
      maxBytes: maxFileBytes()
    })

    if (current) {
      await client.remove(path, { expectedVersion: current.version, message: `env: rm file ${id} in ${name}` })
    }
    else {
      logger.warn(colorText(`文件 "${id}" 已经不存在，只删了引用与元数据`, 'yellow'))
    }
  }

  logger.success(colorText(`store "${name}" 已更新：删除 ${key}${entry ? '' : '（元数据原本缺失）'}`, 'green'))
}

interface CheckProblem {
  type: 'undeclared-ref' | 'dangling-metadata' | 'missing-file' | 'size-mismatch' | 'checksum-mismatch' | 'orphan-file' | 'too-large'
  id: string
  key?: string
  expected?: number
  actual?: number
}

function describeProblem(problem: CheckProblem): string {
  switch (problem.type) {
    case 'undeclared-ref': return `${problem.key ?? ''} 引用了未声明的文件 "${problem.id}"`
    case 'dangling-metadata': return `文件条目 "${problem.id}" 没有被任何键引用`
    case 'missing-file': return `文件 "${problem.id}" 不存在`
    case 'size-mismatch': return `文件 "${problem.id}" 大小不符（期望 ${problem.expected ?? 0}，实际 ${problem.actual ?? 0}）`
    case 'checksum-mismatch': return `文件 "${problem.id}" 的 sha256 不符`
    case 'orphan-file': return `文件 "${problem.id}" 没有被任何 files 条目登记`
    case 'too-large': return `文件 "${problem.id}" 超过读取上限`
  }
}

async function runCheck(ctx: EnvCommandContext, args: string[]): Promise<void> {
  const { name, config, client, ref } = await openStore(ctx, args[0])
  const problems: CheckProblem[] = []
  const refs = collectVarFileRefs(ref.store)
  const files = ref.store.files ?? {}

  for (const { key, id } of refs) {
    if (!files[id])
      problems.push({ type: 'undeclared-ref', key, id })
  }

  for (const [id, entry] of Object.entries(files)) {
    if (!refs.some(item => item.id === id))
      problems.push({ type: 'dangling-metadata', id })

    try {
      const current = await client.readBytes(storeFilesPath(config.path, name, id), {
        maxBytes: maxFileBytes()
      })

      if (!current) {
        problems.push({ type: 'missing-file', id })
      }
      else if (current.bytes.byteLength !== entry.bytes) {
        problems.push({
          type: 'size-mismatch',
          id,
          expected: entry.bytes,
          actual: current.bytes.byteLength
        })
      }
      else if (sha256(current.bytes) !== entry.sha256) {
        problems.push({ type: 'checksum-mismatch', id })
      }
    }
    catch (error) {
      if (error instanceof StorageSizeError)
        problems.push({ type: 'too-large', id })
      else
        throw error
    }
  }

  const listed = await client.list(storeFilesDir(config.path, name))

  for (const item of listed) {
    if (item.kind === 'file' && !(item.name in files))
      problems.push({ type: 'orphan-file', id: item.name })
  }

  if (ctx.options.boolean('json')) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: name, problems }, null, 2))

    if (problems.length)
      process.exitCode = 1
    return
  }

  for (const problem of problems)
    logger.error(colorText(`  ${describeProblem(problem)}`, 'red'))

  if (!problems.length)
    logger.success(colorText(`store "${name}" check 通过`, 'green'))

  if (problems.length) {
    logger.error(colorText(`check: ${problems.length} 个问题`, 'red'))
    process.exitCode = 1
  }
}
