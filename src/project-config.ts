import type { StorageLocation } from './storage/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { assertSafePath, DEFAULT_API_URLS, normalizeApiBaseUrl, validateStorageRepo } from './storage/path'

const projectSchema = z.object({
  schema: z.literal(1),
  storage: z.object({
    type: z.enum(['github', 'gitlab']),
    apiBaseUrl: z.string().min(1).optional(),
    repo: z.string().min(1),
    branch: z.string().min(1).optional(),
    path: z.string().optional()
  }).strict()
}).strict()

export interface ProjectConfig {
  file: string
  storage: Pick<StorageLocation, 'type' | 'apiBaseUrl' | 'repo'> & Partial<Pick<StorageLocation, 'branch' | 'path'>>
}

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectConfigError'
  }
}

/** Search only cwd. Explicit missing files and malformed present files never fall back. */
export function readProjectConfig(file?: string, cwd = process.cwd()): ProjectConfig | undefined {
  const absolute = resolve(cwd, file || '.initx-env.json')
  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  }
  catch (error) {
    if (!file && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw new ProjectConfigError('无法读取项目配置文件，请检查 --config 路径与文件权限')
  }
  let data
  try {
    data = projectSchema.parse(JSON.parse(text))
  }
  catch {
    throw new ProjectConfigError('项目配置必须是 schema 1 的合法 JSON，且只能包含非敏感 storage 定位字段（禁止 token / vars）')
  }
  try {
    const storage = { ...data.storage, apiBaseUrl: normalizeApiBaseUrl(data.storage.apiBaseUrl || DEFAULT_API_URLS[data.storage.type]) }
    validateStorageRepo(storage.type, storage.repo)
    if (storage.path !== undefined)
      assertSafePath(storage.path, true)
    return { file: absolute, storage }
  }
  catch {
    throw new ProjectConfigError('项目 storage 的 API 地址、仓库或路径不合法')
  }
}
