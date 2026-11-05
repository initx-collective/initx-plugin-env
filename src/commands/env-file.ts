import type { FileEncoding } from '../types'
import type { EnvCommandContext } from './env'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { logger } from '@initx-plugin/utils'
import { maxFileBytes } from '../files/limits'
import { storeFilesPath } from '../files/paths'
import { assertValidFileId, formatFileRef, keysReferencing, parseFileRef, slugifyFileId } from '../files/refs'
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

    default:
      throw new Error(`未知子命令 "${action}"，可用：add（ls/cat/pull/rm/check 即将提供）`)
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
      throw new Error(`无法读取文件 "${path}"`)
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
    logger.info(`  路径 ${colorText(path, 'blue')} · ${bytes.byteLength} 字节 · sha256 ${digest.slice(0, 8)}${encoding === 'base64' ? ' · base64' : ''}`)
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
    logger.info(`覆盖已有文件 ${colorText(id, 'blue')}（sha256 ${sha256(current.bytes).slice(0, 8)} → ${digest.slice(0, 8)}）`)
    await client.writeBytes(path, bytes, {
      condition: { kind: 'update', expectedVersion: current.version },
      message: `env: update file ${id} (${key}) in ${name}`
    })
  }

  store.vars[key] = formatFileRef(id)
  store.files = {
    ...(store.files ?? {}),
    [id]: { sha256: digest, bytes: bytes.byteLength, encoding, ...(mode ? { mode } : {}) }
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
  logger.info(`  ${colorText(path, 'blue')} · ${bytes.byteLength} 字节 · sha256 ${digest.slice(0, 8)}${encoding === 'base64' ? ' · base64' : ''}`)
}
