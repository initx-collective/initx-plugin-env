import type { StorageType } from './types'
import { StorageError } from './errors'

export const DEFAULT_API_URLS: Record<StorageType, string> = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com/api/v4'
}

export function assertSafePath(path: string, allowRoot = false): void {
  if (path === '' && allowRoot)
    return
  if (path.split('/').some(part => part === '.' || part === '..'))
    throw Object.assign(new StorageError('validation'), { message: '路径不能包含 . 或 ..' })
  // eslint-disable-next-line no-control-regex
  if (!path || /[\\\x00-\x1F\x7F]/.test(path) || path.startsWith('/') || /^[A-Z]:/i.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new StorageError('validation')
  }
}

export function normalizeApiBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid API base URL')
    return url.href.replace(/\/+$/, '')
  }
  catch {
    throw new StorageError('validation')
  }
}

export function validateStorageRepo(type: StorageType, repo: string): void {
  assertSafePath(repo)
  if (/\s/.test(repo) || (type === 'github' ? repo.split('/').length !== 2 : !/^\d+$/.test(repo) && repo.split('/').length < 2))
    throw new Error(type === 'github' ? '仓库要写成 owner/repo 形式' : 'GitLab 仓库必须是数字项目 ID 或 group/subgroup/project')
}
