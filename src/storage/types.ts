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
  readonly capabilities: Readonly<Record<'read' | 'list' | 'write' | 'delete' | 'conditionalWrite', boolean>>
  read: (path: string) => Promise<StorageObject | null>
  list: (path: string) => Promise<StorageEntry[]>
  write: (path: string, content: string, options: WriteOptions) => Promise<void>
  remove: (path: string, options: RemoveOptions) => Promise<void>
}
