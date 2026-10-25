export type StorageErrorCode = 'authentication' | 'permission' | 'not-found' | 'conflict' | 'validation' | 'rate-limit' | 'network' | 'unsupported'

const hints: Record<StorageErrorCode, string> = {
  'authentication': '认证失败，请检查当前后端的 token',
  'permission': '没有权限，请检查 token 授权与分支保护',
  'not-found': '仓库或 ref 不存在，或当前 token 无权访问',
  'conflict': '远端版本已变化，请重新读取；push 可用 --force 重读后重试一次',
  'validation': '请求或响应不合法，请检查路径、ref 与配置',
  'rate-limit': 'API 请求被限流，请稍后重试',
  'network': '网络请求失败或超时；写入结果可能未知，请先重读确认',
  'unsupported': '存储后端不支持此操作'
}

/** No response bodies, URLs, credentials or upstream exception messages. */
export class StorageError extends Error {
  constructor(public readonly code: StorageErrorCode, public readonly status?: number) {
    super(`${hints[code]}${status ? `（HTTP ${status}）` : ''}`)
    this.name = 'StorageError'
  }
}

export function isConflictError(error: unknown): boolean {
  return error instanceof StorageError && error.code === 'conflict'
}

export function httpError(response: Response): StorageError {
  const status = response.status
  const limited = status === 429 || (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
  return new StorageError(limited ? 'rate-limit' : status === 401 ? 'authentication' : status === 403 ? 'permission' : status === 404 ? 'not-found' : status >= 500 ? 'network' : 'validation', status)
}
