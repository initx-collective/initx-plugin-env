import type { ReadBytesOptions, RemoveOptions, StorageAdapter, StorageBytes, StorageEntry, StorageLocation, StorageObject, WriteOptions } from './types'
import { Buffer } from 'node:buffer'
import { httpError, StorageError, StorageSizeError } from './errors'
import { requireOk, responseJson, storageFetch } from './http'
import { assertSafePath, normalizeApiBaseUrl, validateStorageRepo } from './path'

export function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'initx-plugin-env'
  }
}

export class GitHubStorageAdapter implements StorageAdapter {
  readonly capabilities = {
    read: true,
    list: true,
    write: true,
    delete: true,
    conditionalWrite: true,
    readBytes: true,
    writeBytes: true
  }

  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(private readonly location: StorageLocation, token: string) {
    validateStorageRepo('github', location.repo)
    this.base = `${normalizeApiBaseUrl(location.apiBaseUrl)}/repos/${location.repo.split('/').map(encodeURIComponent).join('/')}`
    this.headers = githubHeaders(token)
  }

  private url(path: string): string {
    assertSafePath(path, true)
    const suffix = path
      ? `/${path.split('/').map(encodeURIComponent).join('/')}`
      : ''
    return `${this.base}/contents${suffix}?${new URLSearchParams({ ref: this.location.branch })}`
  }

  private async checkTarget(): Promise<void> {
    // A Contents 404 also hides inaccessible repositories and nonexistent refs.
    const response = await storageFetch(`${this.base}/commits/${encodeURIComponent(this.location.branch)}`, { headers: this.headers })
    // The Contents and Commit endpoints can return 409 for an empty repository.
    // Recognize only GitHub's known literal, never a generic conflict or 404.
    if (await this.isEmptyRepository(response))
      return
    if (response.status === 404) {
      const commits = await storageFetch(`${this.base}/commits?per_page=1`, { headers: this.headers })
      if (await this.isEmptyRepository(commits))
        return
      requireOk(commits)
    }
    requireOk(response)
  }

  private async isEmptyRepository(response: Response): Promise<boolean> {
    if (response.status !== 409)
      return false
    const body = await responseJson<{ message?: unknown }>(response)
    return body?.message === 'Git Repository is empty.'
  }

  async read(path: string): Promise<StorageObject | null> {
    assertSafePath(path)
    const response = await storageFetch(this.url(path), { headers: this.headers })
    if (response.status === 404 || await this.isEmptyRepository(response)) {
      await this.checkTarget()
      return null
    }
    requireOk(response)
    const file = await responseJson<{ type: string, sha: string, content: string, encoding: string }>(response)
    if (!file || file.type !== 'file' || typeof file.sha !== 'string' || !file.sha || typeof file.content !== 'string' || file.encoding !== 'base64')
      throw new StorageError('validation')
    return {
      content: Buffer.from(file.content, 'base64').toString('utf8'),
      version: file.sha
    }
  }

  async readBytes(path: string, options: ReadBytesOptions = {}): Promise<StorageBytes | null> {
    assertSafePath(path)
    const response = await storageFetch(this.url(path), { headers: this.headers })
    if (response.status === 404 || await this.isEmptyRepository(response)) {
      await this.checkTarget()
      return null
    }
    requireOk(response)
    const file = await responseJson<{ type?: string, sha?: string, content?: string, encoding?: string, size?: number }>(response)
    if (!file || file.type !== 'file' || typeof file.sha !== 'string' || !file.sha)
      throw new StorageError('validation')
    if (typeof file.size === 'number' && options.maxBytes !== undefined && file.size > options.maxBytes)
      throw new StorageSizeError(options.maxBytes)
    if (file.size === 0) {
      return {
        bytes: new Uint8Array(),
        version: file.sha
      }
    }
    let base64 = typeof file.content === 'string'
      ? file.content
      : ''
    if (file.encoding !== 'base64' || base64 === '') {
      // Contents API 对 >1 MB 的文件返回 encoding: "none"、content: ""。
      // 用文件 sha 走 Git Blobs API（≤100 MB），不依赖 download_url 的跨域重定向。
      const blobResponse = await storageFetch(`${this.base}/git/blobs/${encodeURIComponent(file.sha)}`, { headers: this.headers })
      requireOk(blobResponse)
      const blob = await responseJson<{ content?: string, encoding?: string, size?: number }>(blobResponse)
      if (!blob || typeof blob.content !== 'string' || blob.encoding !== 'base64')
        throw new StorageError('validation')
      if (typeof blob.size === 'number' && options.maxBytes !== undefined && blob.size > options.maxBytes)
        throw new StorageSizeError(options.maxBytes)
      base64 = blob.content
    }
    const bytes = Buffer.from(base64, 'base64')
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes)
      throw new StorageSizeError(options.maxBytes)
    return { bytes, version: file.sha }
  }

  async list(path: string): Promise<StorageEntry[]> {
    const response = await storageFetch(this.url(path), { headers: this.headers })
    if (response.status === 404 || await this.isEmptyRepository(response)) {
      await this.checkTarget()
      return []
    }
    requireOk(response)
    const entries = await responseJson<{ name: string, path: string, type: string }[]>(response)
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.type !== 'string'))
      throw new StorageError('validation')
    return entries.map(entry => ({
      name: entry.name,
      path: entry.path,
      kind: entry.type === 'file'
        ? 'file'
        : entry.type === 'dir'
          ? 'directory'
          : 'other'
    }))
  }

  async write(path: string, content: string, options: WriteOptions): Promise<void> {
    assertSafePath(path)
    const condition = options.condition
    if (condition.kind !== 'create' && (condition.kind !== 'update' || !condition.expectedVersion))
      throw new StorageError('validation')
    const response = await storageFetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: this.location.branch,
        message: options.message || 'env: write store',
        content: Buffer.from(content).toString('base64'),
        ...(condition.kind === 'update'
          ? { sha: condition.expectedVersion }
          : {})
      })
    })
    if ([404, 409, 422].includes(response.status)) {
      const current = await this.read(path)
      if (condition.kind === 'create'
        ? current !== null
        : current?.version !== condition.expectedVersion) {
        throw new StorageError('conflict', response.status)
      }
    }
    if (!response.ok)
      throw httpError(response)
  }

  async writeBytes(path: string, bytes: Uint8Array, options: WriteOptions): Promise<void> {
    assertSafePath(path)
    const condition = options.condition
    if (condition.kind !== 'create' && (condition.kind !== 'update' || !condition.expectedVersion))
      throw new StorageError('validation')
    const response = await storageFetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: this.location.branch,
        message: options.message || 'env: write file',
        content: Buffer.from(bytes).toString('base64'),
        ...(condition.kind === 'update'
          ? { sha: condition.expectedVersion }
          : {})
      })
    })
    if ([404, 409, 422].includes(response.status)) {
      const current = await this.readBytes(path)
      if (condition.kind === 'create'
        ? current !== null
        : current?.version !== condition.expectedVersion) {
        throw new StorageError('conflict', response.status)
      }
    }
    if (!response.ok)
      throw httpError(response)
  }

  async remove(path: string, options: RemoveOptions): Promise<void> {
    assertSafePath(path)
    if (!options.expectedVersion)
      throw new StorageError('validation')
    const response = await storageFetch(this.url(path), {
      method: 'DELETE',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: this.location.branch, message: options.message || 'env: remove store', sha: options.expectedVersion })
    })
    if ([404, 409, 422].includes(response.status)) {
      const current = await this.read(path)
      if (current?.version !== options.expectedVersion)
        throw new StorageError('conflict', response.status)
    }
    requireOk(response)
  }
}
