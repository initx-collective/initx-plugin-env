import { Buffer } from 'node:buffer'

/**
 * 极简的 GitHub Contents API 客户端。
 *
 * 为什么不用 Octokit：整个插件只需要 4 个调用（读文件 / 列目录 / 写文件 / 删文件），
 * 而 initx-plugin-cp 已经证明了裸 `fetch` 够用 —— 少一个依赖、少一层版本漂移。
 *
 * 与 cp 的 `github.ts` 的差异（那两处是坑，刻意不照抄）：
 *   1. **配置的 path 要校验**（cp 直接把配置值拼进 URL，含 `..` 也能拼出去）；
 *   2. 写冲突（409/422）会翻成 `GitHubConflictError`，让上层能提示"先 pull / --force"，
 *      而不是扔一个原始 API 报错给用户。
 */

export interface GitHubDirEntry {
  name: string
  path: string
  sha: string
  size: number
  type: 'file' | 'dir' | 'symlink' | 'submodule'
}

export interface GitHubFileEntry extends GitHubDirEntry {
  content: string
  encoding: BufferEncoding
  type: 'file'
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: string
  ) {
    super(`GitHub API ${status} ${statusText}${body ? ` - ${body}` : ''}`)
    this.name = 'GitHubApiError'
  }
}

/** 409/422 在 Contents API 里就代表"你手上的 sha 过期了" */
export class GitHubConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubConflictError'
  }
}

export function isConflictError(error: unknown): boolean {
  return error instanceof GitHubConflictError
    || (error instanceof GitHubApiError && (error.status === 409 || error.status === 422))
}

export function validateRepo(repo: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    throw new Error(`仓库要写成 owner/repo 形式，当前是 "${repo}"`)
}

/**
 * 相对路径安全检查：不能是绝对路径、不能有 `..`、不能有空段、不能有反斜杠。
 * 拼进 GitHub Contents API 之前必须过这一关。
 */
export function assertSafePath(path: string): void {
  if (!path || path.startsWith('/') || /^[A-Z]:/i.test(path))
    throw new Error(`路径必须是仓库内的相对路径："${path}"`)

  if (path.includes('\\'))
    throw new Error(`路径分隔符只能用 /："${path}"`)

  const segments = path.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    throw new Error(`路径不能包含空段或 ..："${path}"`)
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'initx-plugin-env'
  }
}

/** 所有 GitHub 请求的统一出口：错误一律翻成 GitHubApiError */
export async function githubFetch(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers ?? {}) }
  })

  if (!res.ok)
    throw new GitHubApiError(res.status, res.statusText, await res.text().catch(() => undefined))

  return res
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export class GitHubContentsClient {
  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly branch: string = 'main'
  ) {
    validateRepo(repo)
  }

  get repoName(): string {
    return this.repo
  }

  get branchName(): string {
    return this.branch
  }

  private apiUrl(path: string): string {
    assertSafePath(path)
    const [owner, repoName] = this.repo.split('/', 2)
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`
  }

  /** 不存在返回 null（404 是"没有这个文件"，不是错误） */
  async getFile(path: string): Promise<GitHubFileEntry | null> {
    const res = await fetch(this.apiUrl(path), { headers: githubHeaders(this.token) })

    if (res.status === 404)
      return null

    if (!res.ok)
      throw new GitHubApiError(res.status, res.statusText, await res.text().catch(() => undefined))

    const data = await res.json() as GitHubFileEntry

    if (data.type !== 'file')
      throw new GitHubApiError(res.status, res.statusText, `路径 "${path}" 不是文件`)

    return data
  }

  /** 不存在返回 []（目录不存在时 GitHub 也回 404） */
  async listDir(path: string): Promise<GitHubDirEntry[]> {
    const res = await fetch(this.apiUrl(path), { headers: githubHeaders(this.token) })

    if (res.status === 404)
      return []

    if (!res.ok)
      throw new GitHubApiError(res.status, res.statusText, await res.text().catch(() => undefined))

    const data = await res.json()

    if (!Array.isArray(data))
      throw new GitHubApiError(res.status, res.statusText, `路径 "${path}" 不是目录`)

    return data as GitHubDirEntry[]
  }

  /** 便捷方法：读文本，不存在返回 null */
  async getText(path: string): Promise<string | null> {
    const file = await this.getFile(path)

    return file ? decodeContent(file) : null
  }

  /** `sha` 为空 = 新建文件；有值 = 更新（服务端会校验它是否还是最新的） */
  async putFile(path: string, content: string, message: string, sha?: string): Promise<void> {
    const body = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
      ...(sha ? { sha } : {})
    }

    const res = await fetch(this.apiUrl(path), {
      method: 'PUT',
      headers: { ...githubHeaders(this.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (res.status === 409 || res.status === 422)
      throw new GitHubConflictError(`"${path}" 在远端已经被改过（sha 过期）`)

    if (!res.ok)
      throw new GitHubApiError(res.status, res.statusText, await res.text().catch(() => undefined))
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    const res = await fetch(this.apiUrl(path), {
      method: 'DELETE',
      headers: { ...githubHeaders(this.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha, branch: this.branch })
    })

    if (res.status === 409 || res.status === 422)
      throw new GitHubConflictError(`"${path}" 在远端已经被改过（sha 过期）`)

    if (!res.ok)
      throw new GitHubApiError(res.status, res.statusText, await res.text().catch(() => undefined))
  }
}

export function decodeContent(file: GitHubFileEntry): string {
  return Buffer.from(file.content.replace(/\n/g, ''), file.encoding || 'base64').toString('utf8')
}
