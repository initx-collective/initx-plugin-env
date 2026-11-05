import type { FileEncoding, StoreFile } from '../types'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { FileRefError, parseFileRef } from './refs'

export type PushMode = 'error' | 'update-files' | 'inline'

export interface FileUpdate {
  id: string
  key: string
  bytes: Uint8Array
}

export interface PushAnalysis {
  /** 普通键（非引用）的新值。 */
  updates: Record<string, string>
  /** 本地内容与当前文件一致的引用键。 */
  unchanged: string[]
  /** 本地内容与当前文件不同的引用键。 */
  conflicts: string[]
  /** `--inline` 时要改成字面量的键。 */
  inline: string[]
  /** `--update-files` 时要重新上传的文件（按 id 去重）。 */
  fileUpdates: FileUpdate[]
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength)
    return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index])
      return false
  }
  return true
}

/** `.env` 里的字面值按 `encoding` 还原成字节；非法 base64 返回 null。 */
export function localBytes(value: string, encoding: FileEncoding): Uint8Array | null {
  if (encoding === 'utf8')
    return Buffer.from(value, 'utf8')

  if (value.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(value))
    return null

  return Buffer.from(value, 'base64')
}

/**
 * 判定 `push` 每个键的去向。**全程不下载**：只比本地字节、`bytes` 和 `sha256`。
 *
 * - 非引用键 → 普通更新；
 * - 引用键且内容一致 → 保留引用；
 * - 引用键且内容不同 → 冲突，交给 `--update-files` / `--inline` 决定。
 */
export function analyzePush(store: StoreFile, local: Record<string, string>, mode: PushMode): PushAnalysis {
  const analysis: PushAnalysis = { updates: {}, unchanged: [], conflicts: [], inline: [], fileUpdates: [] }
  const queued = new Map<string, Uint8Array>()

  for (const [key, value] of Object.entries(local)) {
    const id = parseFileRef(store.vars[key] ?? '')

    if (id === null) {
      analysis.updates[key] = value
      continue
    }

    const entry = store.files?.[id]

    if (!entry)
      throw new FileRefError('unknown-ref', `${key} 引用了未声明的文件 "${id}"`)

    const bytes = localBytes(value, entry.encoding)

    if (bytes && bytes.byteLength === entry.bytes && hashBytes(bytes) === entry.sha256) {
      analysis.unchanged.push(key)
      continue
    }

    analysis.conflicts.push(key)

    if (mode === 'inline') {
      analysis.inline.push(key)
      continue
    }

    if (mode === 'update-files') {
      if (!bytes)
        throw new Error(`${key} 的值不是合法 base64，无法按当前 encoding 重新上传`)

      const previous = queued.get(id)

      if (previous && !sameBytes(previous, bytes))
        throw new Error(`文件 id "${id}" 被多个键引用，本地内容不一致；请用 --inline 分开处理`)

      if (!previous) {
        queued.set(id, bytes)
        analysis.fileUpdates.push({ id, key, bytes })
      }
    }
  }

  return analysis
}
