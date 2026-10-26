import type { GitLabOperation } from './debug'
import type { RemoveOptions, StorageAdapter, StorageEntry, StorageLocation, StorageObject, WriteOptions } from './types'
import { Buffer } from 'node:buffer'
import { accessLevel, storageDebug } from './debug'
import { httpError, StorageError } from './errors'
import { requireOk, responseJson, storageFetch } from './http'
import { assertSafePath, normalizeApiBaseUrl, validateStorageRepo } from './path'

interface GitLabProject {
  empty_repo: boolean
  archived?: boolean
  permissions?: { project_access?: { access_level?: number }, group_access?: { access_level?: number } }
}

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
  if (body?.message === 'You are not allowed to push into this branch') {
    throw new StorageError('permission', 400)
  }
}

/** Files/Tree/Commits APIs available in GitLab CE 15.9; no job-token or keyset features. */
export class GitLabStorageAdapter implements StorageAdapter {
  readonly capabilities = { read: true, list: true, write: true, delete: true, conditionalWrite: true }
  private readonly projectUrl: string
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly debug: boolean

  constructor(private readonly location: StorageLocation & { debug?: boolean }, token: string) {
    validateStorageRepo('gitlab', location.repo)
    this.projectUrl = `${normalizeApiBaseUrl(location.apiBaseUrl)}/projects/${encodeURIComponent(location.repo)}`
    this.base = `${this.projectUrl}/repository`
    this.headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }
    this.debug = location.debug === true
  }

  private fileUrl(path: string): string {
    assertSafePath(path)
    return `${this.base}/files/${encodeURIComponent(path)}`
  }

  private async request(operation: GitLabOperation, url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await storageFetch(url, { ...init, headers: this.headers })
    }
    catch (error) {
      storageDebug(this.debug, { operation, event: 'network-error' })
      throw error
    }
    if (init.method)
      storageDebug(this.debug, { operation, event: 'write-result', status: response.status })
    else if (!response.ok && response.status !== 404)
      storageDebug(this.debug, { operation, event: 'request-failed', status: response.status })
    return response
  }

  private async projectInfo(): Promise<GitLabProject> {
    const response = await this.request('project', this.projectUrl)
    requireOk(response)
    const project = await responseJson<GitLabProject>(response)
    if (!project || typeof project.empty_repo !== 'boolean')
      throw new StorageError('validation')
    return project
  }

  private async diagnosePermission(): Promise<void> {
    if (!this.debug)
      return
    try {
      const project = await this.projectInfo()
      const levels = [project.permissions?.project_access?.access_level, project.permissions?.group_access?.access_level]
        .map(accessLevel)
        .filter((level): level is number => level !== undefined)
      storageDebug(this.debug, {
        operation: 'project',
        event: 'permissions',
        emptyRepo: project.empty_repo,
        archived: typeof project.archived === 'boolean' ? project.archived : undefined,
        accessLevel: levels.length ? Math.max(...levels) : undefined
      })
      if (!project.empty_repo) {
        const response = await this.request('branch', `${this.base}/branches/${encodeURIComponent(this.location.branch)}`)
        if (response.ok) {
          const branch = await responseJson<{ protected?: unknown, can_push?: unknown }>(response)
          storageDebug(this.debug, {
            operation: 'branch',
            event: 'permissions',
            protected: typeof branch?.protected === 'boolean' ? branch.protected : undefined,
            canPush: typeof branch?.can_push === 'boolean' ? branch.can_push : undefined
          })
        }
      }
      const response = await this.request('protection', `${this.projectUrl}/protected_branches/${encodeURIComponent(this.location.branch)}`)
      if (response.ok) {
        const protection = await responseJson<{ push_access_levels?: { access_level?: unknown }[] }>(response)
        if (Array.isArray(protection?.push_access_levels)) {
          const allowedPushLevels = protection.push_access_levels
            .map(item => accessLevel(item?.access_level))
            .filter((level): level is number => level !== undefined)
          storageDebug(this.debug, { operation: 'protection', event: 'permissions', allowedPushLevels })
        }
      }
    }
    catch {
      // Diagnostics are best-effort reads and must not replace the write error.
      storageDebug(this.debug, { operation: 'project', event: 'unavailable' })
    }
  }

  private async rejectPermission(response: Response): Promise<void> {
    try {
      await rejectLegacyPermission(response)
    }
    catch (error) {
      if (error instanceof StorageError && error.code === 'permission') {
        await this.diagnosePermission()
      }
      throw error
    }
    if (response.status === 403)
      await this.diagnosePermission()
  }

  private async checkTarget(): Promise<boolean> {
    // Commit lookup accepts both branch names and refs and distinguishes a missing path from an inaccessible target.
    const response = await this.request('commit', `${this.base}/commits/${encodeURIComponent(this.location.branch)}`)
    if (response.status === 404) {
      // Empty projects have no ref yet. Verify project access and the explicit
      // 15.9-compatible empty_repo flag before allowing a first Files POST.
      const project = await this.projectInfo()
      if (project.empty_repo) {
        storageDebug(this.debug, { operation: 'project', event: 'empty-repository' })
        return false
      }
      storageDebug(this.debug, { operation: 'commit', event: 'request-failed', status: response.status })
    }
    requireOk(response)
    return true
  }

  async read(path: string): Promise<StorageObject | null> {
    const response = await this.request('file-read', `${this.fileUrl(path)}?${new URLSearchParams({ ref: this.location.branch })}`)
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
    if (!await this.checkTarget())
      return result
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ ref: this.location.branch, per_page: '100', page: String(page), ...(path ? { path } : {}) })
      const response = await this.request('tree', `${this.base}/tree?${query}`)
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
    const response = await this.request(condition.kind === 'create' ? 'file-create' : 'file-update', this.fileUrl(path), {
      method: condition.kind === 'create' ? 'POST' : 'PUT',
      headers: this.headers,
      body: JSON.stringify({ branch: this.location.branch, commit_message: options.message || 'env: write store', content: Buffer.from(content).toString('base64'), encoding: 'base64', ...(condition.kind === 'update' ? { last_commit_id: condition.expectedVersion } : {}) })
    })
    await this.rejectPermission(response)
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
    const response = await this.request('file-delete', `${this.base}/commits`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ branch: this.location.branch, commit_message: options.message || 'env: remove store', actions: [{ action: 'delete', file_path: path, last_commit_id: options.expectedVersion }] })
    })
    await this.rejectPermission(response)
    if ([400, 404, 409, 422].includes(response.status)) {
      const current = await this.read(path)
      if (current?.version !== options.expectedVersion)
        throw new StorageError('conflict', response.status)
    }
    requireOk(response)
  }
}
