import type { StorageAdapter } from './storage/types'
import type { StoreFile } from './types'
import { requireCapability } from './storage/factory'
import { assertSafePath } from './storage/path'
import { createEmptyStore, normalizeStoreName, STORE_SCHEMA_VERSION, storeFileSchema } from './types'

/**
 * store 的读写层：一个 store = 仓库里的一个 JSON 文件（`<path>/<name>.json`）。
 *
 * 刻意不做任何本地缓存 —— initx-plugin-cp 的缓存是"缓存优先、永不校验"，
 * 对普通文本只是拿到旧值，对**密钥**则是"你以为换了、其实还在用旧的"，
 * 而且它的缓存文件里存的是解码后的明文。这里每次通过适配器现拉，不保存 secret 缓存。
 */

export interface StoreRef {
  name: string
  path: string
  version: string
  store: StoreFile
}

export interface StoreVarsChange {
  added: string[]
  updated: string[]
  unchanged: string[]
}

export function storeFilePath(basePath: string, name: string): string {
  const normalized = normalizeStoreName(name)
  const base = (basePath || '').trim().replace(/^\/+|\/+$/g, '')
  const path = base ? `${base}/${normalized}.json` : `${normalized}.json`

  assertSafePath(path)

  return path
}

export function parseStore(content: string, name: string): StoreFile {
  let json: unknown

  try {
    json = JSON.parse(content)
  }
  catch {
    throw new Error(`store "${name}" 不是合法 JSON`)
  }

  const result = storeFileSchema.safeParse(json)

  if (!result.success)
    throw new Error(`store "${name}" 结构不合法：${result.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)

  return result.data
}

export function serializeStore(store: StoreFile): string {
  return `${JSON.stringify({ ...store, schema: store.schema ?? STORE_SCHEMA_VERSION }, null, 2)}\n`
}

/** 列 `<path>/` 下的 store 名（去掉 `.json`），按字母序 */
export async function listStores(client: StorageAdapter, basePath: string): Promise<string[]> {
  requireCapability(client, 'list')
  const base = (basePath || '').trim().replace(/^\/+|\/+$/g, '')
  const entries = await client.list(base)

  return entries
    .filter(entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => entry.name.replace(/\.json$/i, ''))
    .sort((a, b) => a.localeCompare(b))
}

export async function readStore(
  client: StorageAdapter,
  basePath: string,
  name: string
): Promise<StoreRef | null> {
  const path = storeFilePath(basePath, name)
  requireCapability(client, 'read')
  const file = await client.read(path)

  if (!file)
    return null

  const normalized = normalizeStoreName(name)

  return {
    name: normalized,
    path,
    version: file.version,
    store: parseStore(file.content, normalized)
  }
}

export async function writeStore(
  client: StorageAdapter,
  basePath: string,
  name: string,
  store: StoreFile,
  message: string,
  version?: string
): Promise<void> {
  requireCapability(client, 'write')
  requireCapability(client, 'conditionalWrite')
  await client.write(storeFilePath(basePath, name), serializeStore(store), { message, condition: version === undefined ? { kind: 'create' } : { kind: 'update', expectedVersion: version } })
}

export async function deleteStore(
  client: StorageAdapter,
  basePath: string,
  name: string,
  version: string,
  message: string
): Promise<void> {
  requireCapability(client, 'delete')
  requireCapability(client, 'conditionalWrite')
  await client.remove(storeFilePath(basePath, name), { expectedVersion: version, message })
}

/**
 * 把一批变量并进 store 的 `vars`（更新式）：
 * 同名覆盖、新名追加、**其余键一个都不动**。
 */
export function applyVars(store: StoreFile, updates: Record<string, string>): StoreVarsChange {
  const change: StoreVarsChange = { added: [], updated: [], unchanged: [] }

  for (const [key, value] of Object.entries(updates)) {
    const current = store.vars[key]

    if (current === undefined) {
      store.vars[key] = value
      change.added.push(key)
    }
    else if (current === value) {
      change.unchanged.push(key)
    }
    else {
      store.vars[key] = value
      change.updated.push(key)
    }
  }

  return change
}

export function createStoreWithVars(vars: Record<string, string>): StoreFile {
  return { ...createEmptyStore(), vars: { ...vars } }
}
