import { githubHeaders } from './storage/github'
import { requireOk, storageFetch } from './storage/http'

/** Shared authenticated transport for the GitHub Actions target. */
export async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await storageFetch(url, { ...init, headers: { ...githubHeaders(token), ...(init.headers ?? {}) } })
  requireOk(response)
  return response
}
