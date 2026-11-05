import { assertSafePath } from '../storage/path'
import { assertValidFileId } from './refs'

/**
 * 文件对象固定放在 `<path>/_files/<store>/<id>`：
 * - 与 store 同级，跟着已有的 `path` 配置走，不引入第二个配置项；
 * - `listStores` 只取 `.json`，`_files` 目录天然被忽略。
 */
export const FILES_DIR = '_files'

function normalizeBase(basePath: string): string {
  return (basePath || '').trim().replace(/^\/+|\/+$/g, '')
}

export function storeFilesDir(basePath: string, store: string): string {
  const base = normalizeBase(basePath)
  const path = base ? `${base}/${FILES_DIR}/${store}` : `${FILES_DIR}/${store}`

  assertSafePath(path)

  return path
}

export function storeFilesPath(basePath: string, store: string, id: string): string {
  assertValidFileId(id)

  const path = `${storeFilesDir(basePath, store)}/${id}`

  assertSafePath(path)

  return path
}
