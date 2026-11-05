import type { StorageAdapter, StorageBytes } from '../storage/types'
import type { FileEntry } from '../types'
import { createHash } from 'node:crypto'
import { StorageSizeError } from '../storage/errors'
import { maxFileBytes } from './limits'
import { storeFilesPath } from './paths'
import { FileRefError } from './refs'

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
  const maxBytes = options.maxBytes ?? maxFileBytes()
  let file

  try {
    file = await client.readBytes(storeFilesPath(basePath, name, id), { maxBytes })
  }
  catch (error) {
    if (error instanceof StorageSizeError)
      throw new FileRefError('too-large', `文件 "${id}" 超过 ${maxBytes} 字节上限`)
    throw error
  }

  if (!file)
    throw new FileRefError('missing-file', `store "${name}" 引用的文件 "${id}" 不存在（检查分支与路径）`)

  if (file.bytes.byteLength !== entry.bytes)
    throw new FileRefError('size-mismatch', `文件 "${id}" 大小与元数据不符（期望 ${entry.bytes}，实际 ${file.bytes.byteLength}）`)

  const digest = createHash('sha256').update(file.bytes).digest('hex')

  if (digest !== entry.sha256)
    throw new FileRefError('checksum-mismatch', `文件 "${id}" 的 sha256 与元数据不符，可能被手工改过`)

  return file
}
