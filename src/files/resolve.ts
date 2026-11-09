import type { StorageAdapter } from '../storage/types'
import type { FileEntry, StoreFile } from '../types'
import { Buffer } from 'node:buffer'
import { maxFileBytes } from './limits'
import { readVerifiedFile } from './read'
import { assertDeclaredRefs, collectVarFileRefs, FileRefError } from './refs'

export interface ResolveOptions {
  /** 单文件读取上限；默认 `INITX_ENV_MAX_FILE_BYTES` 或 10 MB。 */
  maxBytes?: number
  /** 只解析这些键的引用；用于 `apply --only`，避免无谓下载。 */
  keys?: readonly string[]
}

export interface ResolvedVars {
  vars: Record<string, string>
  /** 由文件解析出的键；`pull` 用它对值强制加双引号。 */
  fileKeys: Set<string>
}

const CONCURRENCY = 4

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({
    length: Math.max(1, Math.min(limit, items.length))
  }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await worker(item!)
    }
  })
  await Promise.all(workers)
}

function decodeValue(entry: FileEntry, bytes: Uint8Array, id: string): string {
  if (entry.encoding === 'base64')
    return Buffer.from(bytes).toString('base64')

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch {
    throw new FileRefError('invalid-utf8', `文件 "${id}" 不是合法 UTF-8；二进制内容请用 --encoding base64`)
  }
}

/**
 * 把 store 里的 `${file-<id>}` 解析成真实值。
 *
 * - 只下载被引用的文件，同一个 id 只下载一次（多个键共用时）；
 * - 下载后校验 `bytes` 与 `sha256`，不一致直接失败；
 * - 任何错误消息只包含 store / 键 / id / 大小，不含内容。
 */
export async function resolveStoreVars(
  client: StorageAdapter,
  basePath: string,
  name: string,
  store: StoreFile,
  options: ResolveOptions = {}
): Promise<ResolvedVars> {
  assertDeclaredRefs(store)

  const vars = { ...store.vars }
  const wanted = options.keys
    ? new Set(options.keys)
    : null
  const refs = collectVarFileRefs(store).filter(ref => !wanted || wanted.has(ref.key))
  const fileKeys = new Set<string>()

  if (!refs.length)
    return { vars, fileKeys }

  for (const ref of refs)
    fileKeys.add(ref.key)

  const maxBytes = options.maxBytes ?? maxFileBytes()
  const byId = new Map<string, { key: string, entry: FileEntry }>()

  for (const ref of refs) {
    if (!byId.has(ref.id))
      byId.set(ref.id, { key: ref.key, entry: store.files![ref.id]! })
  }

  const values = new Map<string, string>()

  await mapLimit([
    ...byId.keys()
  ], CONCURRENCY, async (id) => {
    const current = byId.get(id)!
    const file = await readVerifiedFile(client, basePath, name, id, current.entry, { maxBytes })
    values.set(id, decodeValue(current.entry, file.bytes, id))
  })

  for (const ref of refs)
    vars[ref.key] = values.get(ref.id)!

  return { vars, fileKeys }
}
