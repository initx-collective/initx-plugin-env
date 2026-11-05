import { assertSafePath } from '../storage/path'
import { assertValidFileId } from './refs'

/**
 * 新版每个 store 一个目录：
 *
 *   <path>/<store>/env.json
 *   <path>/<store>/_files/<id>
 *
 * 旧版是扁平文件：
 *
 *   <path>/<store>.json
 *   <path>/_files/<store>/<id>
 *
 * 旧路径只用于读取回退与一次性迁移。
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

/** 旧版文件目录：`<path>/_files/<store>` */
export function legacyStoreFilesDir(basePath: string, store: string): string {
  const base = normalizeBase(basePath)
  const path = base ? `${base}/${FILES_DIR}/${store}` : `${FILES_DIR}/${store}`

  assertSafePath(path)

  return path
}

/** 旧版文件：`<path>/_files/<store>/<id>` */
export function legacyStoreFilesPath(basePath: string, store: string, id: string): string {
  assertValidFileId(id)

  const path = `${legacyStoreFilesDir(basePath, store)}/${id}`

  assertSafePath(path)

  return path
}
