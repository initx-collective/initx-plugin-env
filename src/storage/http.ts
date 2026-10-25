import { httpError, StorageError } from './errors'

/** No retries: a timed-out mutation may already have committed. Never follow redirects with auth. */
export async function storageFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) })
  }
  catch {
    throw new StorageError('network')
  }
}

export async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  }
  catch (error) {
    // Abort/stream failures can happen after response headers have arrived.
    throw new StorageError(error instanceof SyntaxError ? 'validation' : 'network')
  }
}

export function requireOk(response: Response): void {
  if (!response.ok)
    throw httpError(response)
}
