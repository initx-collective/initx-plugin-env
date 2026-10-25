import type { RemoveOptions, StorageAdapter, StorageEntry, StorageLocation, StorageObject, WriteOptions } from './types'
import { Buffer } from 'node:buffer'
import { httpError, StorageError } from './errors'
import { requireOk, responseJson, storageFetch } from './http'
import { assertSafePath, normalizeApiBaseUrl, validateStorageRepo } from './path'

async function rejectLegacyPermission(response: Response): Promise<void> {
  if (response.status !== 400)
    return
  let body: { message?: unknown } | undefined
  try {
    body = await responseJson(response)
  }
  catch (error) {
    if (error instanceof StorageError && error.code === 'network')
      throw error
  }
  // Commits::CreateService#validate_permissions! in v15.9.4 returns this as 400.
  // Recognize only the known literal; never expose arbitrary upstream text.
  if (body?.message === 'You are not allowed to push into this branch')
    throw new StorageError('permission', 400)
}

/** Files/Tree/Commits APIs available in GitLab CE 15.9; no job-token or keyset features. */
export class GitLabStorageAdapter implements StorageAdapter {
  readonly capabilities = { read: true, list: true, write: true, delete: true, conditionalWrite: true }
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(private readonly location: StorageLocation, token: string) {
    validateStorageRepo('gitlab', location.repo)
    this.base = `${normalizeApiBaseUrl(location.apiBaseUrl)}/projects/${encodeURIComponent(location.repo)}/repository`
    this.headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }
  }

  private fileUrl(path: string): string {
    assertSafePath(path)
    return `${this.base}/files/${encodeURIComponent(path)}`
  }

  private async checkTarget(): Promise<void> {
    // Commit lookup accepts both branch names and refs and distinguishes a missing path from an inaccessible target.
    const response = await storageFetch(`${this.base}/commits/${encodeURIComponent(this.location.branch)}`, { headers: this.headers })
    requireOk(response)
  }

  async read(path: string): Promise<StorageObject | null> {
    const response = await storageFetch(`${this.fileUrl(path)}?${new URLSearchParams({ ref: this.location.branch })}`, { headers: this.headers })
    if (response.status === 404) {
      await this.checkTarget()
      return null
    }
    requireOk(response)
    const file = await responseJson<{ content: string, encoding: string, last_commit_id: string }>(response)
    if (!file || typeof file.content !== 'string' || file.encoding !== 'base64' || typeof file.last_commit_id !== 'string' || !file.last_commit_id)
      throw new StorageError('validation')
    return { content: Buffer.from(file.content, 'base64').toString('utf8'), version: file.last_commit_id }
  }

  async list(path: string): Promise<StorageEntry[]> {
    assertSafePath(path, true)
    const result: StorageEntry[] = []
    // 15.9 may return 200 [] for an invalid ref as well as a missing directory.
    await this.checkTarget()
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ ref: this.location.branch, per_page: '100', page: String(page), ...(path ? { path } : {}) })
      const response = await storageFetch(`${this.base}/tree?${query}`, { headers: this.headers })
      if (response.status === 404) {
        await this.checkTarget()
        return result
      }
      requireOk(response)
      const entries = await responseJson<{ name: string, path: string, type: string }[]>(response)
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.type !== 'string'))
        throw new StorageError('validation')
      result.push(...entries.map((entry): StorageEntry => ({ name: entry.name, path: entry.path, kind: entry.type === 'blob' ? 'file' : entry.type === 'tree' ? 'directory' : 'other' })))
      const next = response.headers.get('x-next-page')
      if (!entries.length || next === '' || (next === null && entries.length < 100))
        return result
      // Follow page numbers only, never server-provided URLs carrying credentials elsewhere.
      if (next !== null && next !== String(page + 1))
        throw new StorageError('validation')
    }
  }

  async write(path: string, content: string, options: WriteOptions): Promise<void> {
    const condition = options.condition
    if (condition.kind !== 'create' && (condition.kind !== 'update' || !condition.expectedVersion))
      throw new StorageError('validation')
    const response = await storageFetch(this.fileUrl(path), {
      method: condition.kind === 'create' ? 'POST' : 'PUT',
      headers: this.headers,
      body: JSON.stringify({ branch: this.location.branch, commit_message: options.message || 'env: write store', content: Buffer.from(content).toString('base64'), encoding: 'base64', ...(condition.kind === 'update' ? { last_commit_id: condition.expectedVersion } : {}) })
    })
    await rejectLegacyPermission(response)
    if ([400, 404, 409, 422].includes(response.status)) {
      const current = await this.read(path)
      if (condition.kind === 'create' ? current !== null : current?.version !== condition.expectedVersion)
        throw new StorageError('conflict', response.status)
      // GitLab returns 400 for empty commits. Equal content at the expected version is already successful.
      if (condition.kind === 'update' && response.status === 400 && current?.content === content)
        return
    }
    if (!response.ok)
      throw httpError(response)
  }

  async remove(path: string, options: RemoveOptions): Promise<void> {
    assertSafePath(path)
    if (!options.expectedVersion)
      throw new StorageError('validation')
    // GitLab 15.9.4 Files DELETE drops last_commit_id (simple_file_params).
    // Its Commits API declares and checks this condition for delete actions.
    const response = await storageFetch(`${this.base}/commits`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ branch: this.location.branch, commit_message: options.message || 'env: remove store', actions: [{ action: 'delete', file_path: path, last_commit_id: options.expectedVersion }] })
    })
    await rejectLegacyPermission(response)
    if ([400, 404, 409, 422].includes(response.status)) {
      const current = await this.read(path)
      if (current?.version !== options.expectedVersion)
        throw new StorageError('conflict', response.status)
    }
    requireOk(response)
  }
}
