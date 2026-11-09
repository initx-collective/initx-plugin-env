import { Buffer } from 'node:buffer'
import process from 'node:process'
import { FileRefError } from './refs'

/** 单文件硬上限；GitHub Contents / GitLab Files 都远高于这个值。 */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
/** `pull` 写进 `.env` 的单值上限。 */
export const MAX_INLINE_BYTES = 1024 * 1024
/** `setup` 写进环境变量的单值上限；超过直接失败，不降级为警告。 */
export const MAX_ENV_BYTES = 32 * 1024

function readLimit(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw)
    return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

export function maxFileBytes(): number {
  return readLimit('INITX_ENV_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES)
}

export function maxInlineBytes(): number {
  return readLimit('INITX_ENV_MAX_INLINE_BYTES', MAX_INLINE_BYTES)
}

export interface OversizedValue {
  key: string
  bytes: number
}

export function oversizedValues(vars: Record<string, string>, limit: number): OversizedValue[] {
  return Object.entries(vars)
    .map(([key, value]) => ({
      key,
      bytes: Buffer.byteLength(value, 'utf8')
    }))
    .filter(item => item.bytes > limit)
}

function describe(oversized: OversizedValue[]): string {
  return oversized.map(item => `${item.key}（${item.bytes} 字节）`).join('、')
}

export function assertInlineLimit(vars: Record<string, string>, store: string): void {
  const limit = maxInlineBytes()
  const oversized = oversizedValues(vars, limit)

  if (!oversized.length)
    return

  throw new FileRefError('too-large', `store "${store}" 有值超过 ${limit} 字节内联上限：${describe(oversized)}。改用 initx env file pull ${store} --to-dir <dir> 落盘`)
}

export function assertEnvLimit(vars: Record<string, string>, store: string): void {
  const oversized = oversizedValues(vars, MAX_ENV_BYTES)

  if (!oversized.length)
    return

  throw new FileRefError('too-large', `store "${store}" 有值超过 ${MAX_ENV_BYTES} 字节环境变量上限：${describe(oversized)}。大文件请用 initx env file pull ${store} --to-dir <dir> 落盘后传路径`)
}
