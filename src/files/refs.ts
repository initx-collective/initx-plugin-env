import type { FileEntry, StoreFile } from '../types'
import { isValidFileId } from '../types'

/**
 * 文件型变量的引用语法，必须**整值匹配**：`${file-<id>}`。
 *
 * 不做插值、不做递归、不做 shell 展开；只有 store 的 `files` 里声明过的 id
 * 才会被解析（见 `assertDeclaredRefs`）。
 */
export const FILE_REF_PATTERN = /^\$\{file-([a-z0-9][a-z0-9._-]{0,63})\}$/

export type FileRefErrorCode
  = | 'invalid-id'
    | 'unknown-ref'
    | 'missing-file'
    | 'size-mismatch'
    | 'checksum-mismatch'
    | 'invalid-utf8'
    | 'too-large'

/**
 * 文件对象的受控错误。消息里只允许出现 store 名、变量名、文件 id 和大小，
 * 绝不带文件内容或 token。
 */
export class FileRefError extends Error {
  constructor(public readonly code: FileRefErrorCode, message: string) {
    super(message)
    this.name = 'FileRefError'
  }
}

export function parseFileRef(value: string): string | null {
  const match = FILE_REF_PATTERN.exec(value)
  return match ? match[1]! : null
}

export function formatFileRef(id: string): string {
  assertValidFileId(id)
  return `\${file-${id}}`
}

export function assertValidFileId(id: string): void {
  if (!isValidFileId(id))
    throw new FileRefError('invalid-id', `文件 id "${id}" 不合法：只允许小写字母、数字、- _ .，以字母或数字开头，最长 64 字符`)
}

/** `IOS_P12` → `ios-p12`，`SA_JSON` → `sa-json`。 */
export function slugifyFileId(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')

  if (!slug)
    throw new FileRefError('invalid-id', `无法从变量名 "${key}" 推导文件 id，请用 --as 指定`)

  return slug
}

export function storeFiles(store: StoreFile): Record<string, FileEntry> {
  return store.files ?? {}
}

export interface VarFileRef {
  key: string
  id: string
}

/** 文件顺序按 `vars` 的键顺序，便于稳定输出。 */
export function collectVarFileRefs(store: StoreFile): VarFileRef[] {
  const refs: VarFileRef[] = []

  for (const [key, value] of Object.entries(store.vars)) {
    const id = parseFileRef(value)
    if (id !== null)
      refs.push({ key, id })
  }

  return refs
}

/**
 * 引用必须与 `files` 声明成对出现。未声明的引用一律硬失败：
 * 放过它等于把 `${file-…}` 字面量当密钥注入，错误会推迟到业务运行时。
 */
export function assertDeclaredRefs(store: StoreFile): void {
  for (const { key, id } of collectVarFileRefs(store)) {
    if (!store.files?.[id])
      throw new FileRefError('unknown-ref', `store 的 ${key} 引用了未声明的文件 "${id}"（检查拼写，或先执行 initx env file add / file ls）`)
  }
}

/** id 被哪些键引用（用于 rm 时判断能否删除文件本体）。 */
export function keysReferencing(store: StoreFile, id: string): string[] {
  return collectVarFileRefs(store)
    .filter(ref => ref.id === id)
    .map(ref => ref.key)
}
