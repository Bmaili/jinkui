/**
 * GitHub 私有仓库（规格 7.2）。
 *
 * - 列表：Git Trees API，`trees/<分支>?recursive=1`，一个请求拿到全部文件和各自的 blob sha（就是版本标识）。
 * - 读：Contents API，raw 格式（文件最大 100 MB）。
 * - 写、删：Contents API。更新时必须带上旧的 blob sha，sha 不对 GitHub 返回 409，等于条件写入；
 *   文件已存在却没带 sha 返回 422。两种都转成 RemoteConflictError。
 * - 每次写入是一个 commit。数据仓库必须是私有的，公开的直接拒绝。
 */
import { toBase64 } from '../bytes'
import { call, RemoteConflictError, RemoteError, type PutOpts, type RemoteFile, type RemoteStore } from './remote'

export interface GitHubConfig {
  owner: string
  repo: string
  /** 默认 main */
  branch: string
  /** Fine-grained PAT，只授予这个仓库的 Contents 读写 */
  token: string
  /** 默认 https://api.github.com，可填自建反代 */
  apiBase?: string
  /** 仓库内的路径前缀，默认为空 */
  prefix?: string
}

interface TreeEntry { path: string; type: string; sha: string; size?: number }

export class GitHubStore implements RemoteStore {
  readonly id = 'github'
  readonly label = 'GitHub'
  private base: string
  private prefix: string
  /** 最近一次列表里各文件的 sha，写入时没给 ifVersion 就用它 */
  private known = new Map<string, string>()

  constructor(private cfg: GitHubConfig) {
    this.base = (cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '')
    const p = (cfg.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
    this.prefix = p ? p + '/' : ''
  }

  private get branch() {
    return this.cfg.branch || 'main'
  }

  private get repoPath() {
    return `/repos/${encodeURIComponent(this.cfg.owner.trim())}/${encodeURIComponent(this.cfg.repo.trim())}`
  }

  private contentsUrl(path: string) {
    return `${this.base}${this.repoPath}/contents/${(this.prefix + path).split('/').map(encodeURIComponent).join('/')}`
  }

  private headers(accept = 'application/vnd.github+json', json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token.trim()}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private fail(status: number, body: string): never {
    let msg = ''
    try {
      msg = (JSON.parse(body) as { message?: string }).message ?? ''
    } catch { /* 非 JSON */ }
    const hint: Record<number, string> = {
      401: 'Token 无效或已过期',
      403: /rate limit/i.test(msg) ? '请求太频繁，稍后再试' : 'Token 没有这个仓库的 Contents 读写权限',
      404: '仓库不存在，或 Token 看不到这个仓库',
    }
    throw new RemoteError(`GitHub 返回 ${status}：${hint[status] ?? msg}`, status, status >= 500 || status === 429)
  }

  private async json<T>(method: string, url: string, body?: unknown, ok: number[] = []): Promise<{ status: number; data: T }> {
    const res = await call({ url, method, headers: this.headers(undefined, !!body), body: body ? JSON.stringify(body) : undefined })
    if (!res.ok && !ok.includes(res.status)) this.fail(res.status, res.text())
    const text = res.text()
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
  }

  async list(): Promise<RemoteFile[]> {
    const url = `${this.base}${this.repoPath}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`
    const res = await this.json<{ tree: TreeEntry[]; truncated: boolean }>('GET', url, undefined, [404, 409])
    if (res.status === 409) {
      // 空仓库（还没有任何提交）
      this.known.clear()
      return []
    }
    if (res.status === 404) {
      // 分支不存在，或仓库不存在：先确认仓库在（不在的话这里会抛出明确的错误）
      const repo = await this.json<{ default_branch?: string }>('GET', `${this.base}${this.repoPath}`)
      if (repo.data.default_branch && repo.data.default_branch !== this.branch) {
        throw new RemoteError(`分支 ${this.branch} 不存在（仓库默认分支是 ${repo.data.default_branch}）`, 404, false)
      }
      this.known.clear()
      return []
    }
    if (res.data.truncated) throw new RemoteError('仓库文件太多，GitHub 返回的列表被截断', undefined, false)
    const out: RemoteFile[] = []
    this.known.clear()
    for (const e of res.data.tree) {
      if (e.type !== 'blob' || !e.path.startsWith(this.prefix)) continue
      const path = e.path.slice(this.prefix.length)
      this.known.set(path, e.sha)
      out.push({ path, version: e.sha, size: e.size ?? 0 })
    }
    return out
  }

  async get(path: string): Promise<Uint8Array | null> {
    const res = await call({
      url: `${this.contentsUrl(path)}?ref=${encodeURIComponent(this.branch)}`,
      headers: this.headers('application/vnd.github.raw+json'),
      responseType: 'bytes',
      timeoutMs: 60000,
    })
    if (res.status === 404) return null
    if (!res.ok) this.fail(res.status, res.text())
    return res.bytes()
  }

  async put(path: string, bytes: Uint8Array, opts: PutOpts = {}): Promise<string> {
    const sha = opts.ifVersion === undefined ? this.known.get(path) : opts.ifVersion ?? undefined
    const res = await call({
      url: this.contentsUrl(path),
      method: 'PUT',
      headers: this.headers(undefined, true),
      body: JSON.stringify({ message: `jinkui: ${path}`, content: toBase64(bytes), branch: this.branch, ...(sha ? { sha } : {}) }),
      timeoutMs: 60000,
    })
    // 409：sha 对不上（别人先改了，或分支同时被别的提交推进）；422：文件已存在但没给 sha
    if (res.status === 409 || (res.status === 422 && /sha/i.test(res.text()))) throw new RemoteConflictError(path)
    if (!res.ok) this.fail(res.status, res.text())
    const v = res.json<{ content: { sha: string } }>().content.sha
    this.known.set(path, v)
    return v
  }

  async remove(path: string): Promise<void> {
    let sha = this.known.get(path)
    if (!sha) {
      await this.list()
      sha = this.known.get(path)
      if (!sha) return
    }
    const res = await call({
      url: this.contentsUrl(path),
      method: 'DELETE',
      headers: this.headers(undefined, true),
      body: JSON.stringify({ message: `jinkui: 删除 ${path}`, sha, branch: this.branch }),
    })
    if (res.status === 404) return
    if (res.status === 409) throw new RemoteConflictError(path)
    if (!res.ok) this.fail(res.status, res.text())
    this.known.delete(path)
  }

  /** 仓库能访问、Token 有写权限、而且是私有仓库 */
  async test(): Promise<void> {
    const repo = await this.json<{ private?: boolean; permissions?: { push?: boolean } }>('GET', `${this.base}${this.repoPath}`)
    if (repo.data.private === false) throw new RemoteError('这个仓库是公开的。保险库只能放在私有仓库里，请先在 GitHub 上把它改成私有', 403, false)
    if (repo.data.permissions && repo.data.permissions.push === false) throw new RemoteError('Token 对这个仓库只有读权限，需要 Contents 读写', 403, false)
    await this.list()
  }
}
