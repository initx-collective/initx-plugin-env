export type StorageType = 'github' | 'gitlab'

export interface StorageLocation {
  type: StorageType
  apiBaseUrl: string
  repo: string
  branch: string
  path: string
}

export interface StorageObject {
  content: string
  version: string
}

export interface StorageBytes {
  bytes: Uint8Array
  version: string
}

export interface ReadBytesOptions {
  /** 超过上限时抛 StorageSizeError，避免把大文件读进内存。 */
  maxBytes?: number
}

export type StorageCapability = 'read' | 'list' | 'write' | 'delete' | 'conditionalWrite' | 'readBytes' | 'writeBytes'

export interface StorageEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'other'
}

export type WriteCondition = { kind: 'create' } | { kind: 'update', expectedVersion: string }
export interface WriteOptions {
  condition: WriteCondition
  message?: string
}
export interface RemoveOptions {
  expectedVersion: string
  message?: string
}

export interface StorageAdapter {
  readonly capabilities: Readonly<Record<StorageCapability, boolean>>
  read: (path: string) => Promise<StorageObject | null>
  /** 文件对象按原始字节读写；store JSON 继续用 read/write。 */
  readBytes: (path: string, options?: ReadBytesOptions) => Promise<StorageBytes | null>
  list: (path: string) => Promise<StorageEntry[]>
  write: (path: string, content: string, options: WriteOptions) => Promise<void>
  writeBytes: (path: string, bytes: Uint8Array, options: WriteOptions) => Promise<void>
  remove: (path: string, options: RemoveOptions) => Promise<void>
}
