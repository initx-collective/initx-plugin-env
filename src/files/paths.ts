import { assertSafePath } from '../storage/path'
import { assertValidFileId } from './refs'

/**
 * 每个 store 一个目录：
 *
 *   <path>/<store>/env.json
 *   <path>/<store>/_files/<id>
 */
export const STORE_FILE_NAME = 'env.json'
export const FILES_DIR = '_files'

function normalizeBase(basePath: string): string {
  return (basePath || '').trim().replace(/^\/+|\/+$/g, '')
}

export function storeFilesDir(basePath: string, store: string): string {
  const base = normalizeBase(basePath)
  const path = base ? `${base}/${store}/${FILES_DIR}` : `${store}/${FILES_DIR}`

  assertSafePath(path)

  return path
}

export function storeFilesPath(basePath: string, store: string, id: string): string {
  assertValidFileId(id)

  const path = `${storeFilesDir(basePath, store)}/${id}`

  assertSafePath(path)

  return path
}
