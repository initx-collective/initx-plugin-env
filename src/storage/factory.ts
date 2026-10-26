import type { StorageAdapter, StorageLocation } from './types'
import { StorageError } from './errors'
import { GitHubStorageAdapter } from './github'
import { GitLabStorageAdapter } from './gitlab'

const adapters = { github: GitHubStorageAdapter, gitlab: GitLabStorageAdapter }

export function createStorageAdapter(config: StorageLocation & { token: string, debug?: boolean }): StorageAdapter {
  const Adapter = adapters[config.type]
  if (!Adapter)
    throw new StorageError('unsupported')
  return new Adapter(config, config.token)
}

export function requireCapability(adapter: StorageAdapter, operation: keyof StorageAdapter['capabilities']): void {
  if (!adapter.capabilities[operation])
    throw new StorageError('unsupported')
}
