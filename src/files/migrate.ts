import type { StorageAdapter } from '../storage/types'
import type { FileEntry, StoreFile } from '../types'
import { createHash } from 'node:crypto'
import { StorageSizeError } from '../storage/errors'
import { requireCapability } from '../storage/factory'
import { maxFileBytes } from './limits'
import { legacyStoreFilesDir, legacyStoreFilesPath, storeFilesPath } from './paths'
import { FileRefError } from './refs'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function verify(id: string, entry: FileEntry, bytes: Uint8Array): void {
  if (bytes.byteLength !== entry.bytes)
    throw new FileRefError('size-mismatch', `文件 "${id}" 大小与元数据不符（期望 ${entry.bytes}，实际 ${bytes.byteLength}）`)

  if (digest(bytes) !== entry.sha256)
    throw new FileRefError('checksum-mismatch', `文件 "${id}" 的 sha256 与元数据不符，可能被手工改过`)
}

/**
 * 旧版扁平 store 迁移时，把 `_files/<store>/<id>` 搬到 `<store>/_files/<id>`。
 * 先只写入新位置；新 store 成功写完后，调用方再删除旧文件。
 */
export async function migrateLegacyFiles(
  client: StorageAdapter,
  basePath: string,
  name: string,
  store: StoreFile
): Promise<void> {
  const files = Object.entries(store.files ?? {})

  if (!files.length)
    return

  requireCapability(client, 'readBytes')
  requireCapability(client, 'writeBytes')

  for (const [id, entry] of files) {
    const nextPath = storeFilesPath(basePath, name, id)
    const next = await client.readBytes(nextPath, { maxBytes: maxFileBytes() })

    if (next) {
      verify(id, entry, next.bytes)
      continue
    }

    let previous
    try {
      previous = await client.readBytes(legacyStoreFilesPath(basePath, name, id), { maxBytes: maxFileBytes() })
    }
    catch (error) {
      if (error instanceof StorageSizeError)
        throw new FileRefError('too-large', `文件 "${id}" 超过迁移上限`)
      throw error
    }

    if (!previous)
      throw new FileRefError('missing-file', `旧版 store "${name}" 引用的文件 "${id}" 不存在，无法迁移`)

    verify(id, entry, previous.bytes)

    await client.writeBytes(nextPath, previous.bytes, {
      condition: { kind: 'create' },
      message: `env: migrate ${name}/${id}`
    })
  }
}

/** 新 store 写完后，best-effort 删除旧版扁平文件与旧文件对象。 */
export async function removeLegacyStore(
  client: StorageAdapter,
  basePath: string,
  name: string,
  legacy: { path: string, version: string }
): Promise<void> {
  if (!client.capabilities.delete)
    return

  if (client.capabilities.list) {
    const entries = await client.list(legacyStoreFilesDir(basePath, name))

    for (const entry of entries) {
      if (entry.kind !== 'file')
        continue

      const old = await client.readBytes(entry.path, { maxBytes: maxFileBytes() })

      if (old)
        await client.remove(entry.path, { expectedVersion: old.version, message: `env: migrate ${name}` })
    }
  }

  const current = await client.read(legacy.path)

  if (current)
    await client.remove(legacy.path, { expectedVersion: current.version, message: `env: migrate ${name}` })
}
