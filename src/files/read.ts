import type { StorageAdapter, StorageBytes } from '../storage/types'
import type { FileEntry } from '../types'
import { createHash } from 'node:crypto'
import { StorageSizeError } from '../storage/errors'
import { maxFileBytes } from './limits'
import { legacyStoreFilesPath, storeFilesPath } from './paths'
import { FileRefError } from './refs'

export interface LocatedBytes {
  path: string
  file: StorageBytes
}

/**
 * 先读新版 `<store>/_files/<id>`，不存在时回退旧版 `_files/<store>/<id>`。
 * 旧版 store 在迁移前仍能正常 pull / run / check。
 */
export async function readStoreFileBytes(
  client: StorageAdapter,
  basePath: string,
  name: string,
  id: string,
  options: { maxBytes?: number } = {}
): Promise<LocatedBytes | null> {
  const maxBytes = options.maxBytes ?? maxFileBytes()
  const nextPath = storeFilesPath(basePath, name, id)

  try {
    const next = await client.readBytes(nextPath, { maxBytes })

    if (next)
      return { path: nextPath, file: next }

    const legacyPath = legacyStoreFilesPath(basePath, name, id)
    const legacy = await client.readBytes(legacyPath, { maxBytes })

    return legacy ? { path: legacyPath, file: legacy } : null
  }
  catch (error) {
    if (error instanceof StorageSizeError)
      throw new FileRefError('too-large', `文件 "${id}" 超过 ${maxBytes} 字节上限`)
    throw error
  }
}

/**
 * 读取并校验一个文件对象：存在性、字节数、sha256 三项都过才返回。
 * 错误消息只含 id 与大小，不含内容。
 */
export async function readVerifiedFile(
  client: StorageAdapter,
  basePath: string,
  name: string,
  id: string,
  entry: FileEntry,
  options: { maxBytes?: number } = {}
): Promise<StorageBytes> {
  const located = await readStoreFileBytes(client, basePath, name, id, options)

  if (!located)
    throw new FileRefError('missing-file', `store "${name}" 引用的文件 "${id}" 不存在（检查分支与路径）`)

  const file = located.file

  if (file.bytes.byteLength !== entry.bytes)
    throw new FileRefError('size-mismatch', `文件 "${id}" 大小与元数据不符（期望 ${entry.bytes}，实际 ${file.bytes.byteLength}）`)

  const digest = createHash('sha256').update(file.bytes).digest('hex')

  if (digest !== entry.sha256)
    throw new FileRefError('checksum-mismatch', `文件 "${id}" 的 sha256 与元数据不符，可能被手工改过`)

  return file
}
