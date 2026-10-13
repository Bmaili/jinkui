/**
 * 模拟 GitHub REST API 中金匮用到的部分：仓库信息、Git Trees（按分支名递归列出）、Contents API 的读写删。
 * 行为按 GitHub 文档：更新已有文件必须带 sha，sha 不对返回 409，已存在却没带 sha 返回 422；空仓库列树返回 409。
 */
import http from 'node:http'
import crypto from 'node:crypto'

const blobSha = (b: Buffer) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex')

export interface GitHubMock {
  port: number
  files: Map<string, Buffer>
  commits: string[]
  /** 仓库是否私有 */
  isPrivate: boolean
  /** Token 的过期时间，按 GitHub 的格式（例如 2026-11-05 00:00:00 UTC）放在每个响应头里；空字符串表示不会过期 */
  tokenExpiry: string
  /** 让接下来的 n 个请求返回 502 */
  failNext: (n: number) => void
  close: () => Promise<void>
}

export async function startGitHubMock(opts: { owner: string; repo: string; token: string; branch?: string }): Promise<GitHubMock> {
  const branch = opts.branch ?? 'main'
  let failures = 0
  const mock: GitHubMock = {
    port: 0,
    files: new Map(),
    commits: [],
    isPrivate: true,
    tokenExpiry: '',
    failNext: (n) => (failures = n),
    close: () => new Promise((r) => server.close(() => r())),
  }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const body = raw.length ? JSON.parse(raw.toString()) : null
    // 端到端测试里浏览器直接访问：允许跨域
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Accept, Content-Type, X-GitHub-Api-Version')
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'GitHub-Authentication-Token-Expiration')
    if (mock.tokenExpiry) res.setHeader('GitHub-Authentication-Token-Expiration', mock.tokenExpiry)
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    const send = (status: number, data?: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data))
    if (failures > 0) {
      failures--
      return send(502, { message: 'Bad Gateway' })
    }
    if (req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { message: 'Bad credentials' })
    const url = new URL(req.url!, 'http://x')
    const base = `/repos/${opts.owner}/${opts.repo}`
    if (!url.pathname.startsWith(base)) return send(404, { message: 'Not Found' })
    const p = url.pathname.slice(base.length)
    let m: RegExpExecArray | null

    if (p === '' && req.method === 'GET') {
      return send(200, { private: mock.isPrivate, default_branch: branch, permissions: { push: true } })
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(p)) && req.method === 'GET') {
      if (decodeURIComponent(m[1]) !== branch) return send(404, { message: 'Not Found' })
      if (!mock.commits.length) return send(409, { message: 'Git Repository is empty.' })
      const tree = [...mock.files].map(([path, b]) => ({ path, mode: '100644', type: 'blob', sha: blobSha(b), size: b.length }))
      // GitHub 的递归树里也有目录项
      const dirs = new Set<string>()
      for (const path of mock.files.keys()) {
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
      }
      for (const d of dirs) tree.push({ path: d, mode: '040000', type: 'tree', sha: 'x', size: 0 })
      return send(200, { truncated: false, tree })
    }
    if ((m = /^\/contents\/(.+)$/.exec(p))) {
      const path = m[1].split('/').map(decodeURIComponent).join('/')
      const cur = mock.files.get(path)
      if (req.method === 'GET') {
        if ((url.searchParams.get('ref') ?? branch) !== branch) return send(404, { message: 'No commit found for the ref' })
        if (!cur) return send(404, { message: 'Not Found' })
        if (req.headers.accept === 'application/vnd.github.raw+json') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(cur)
          return
        }
        return send(200, { sha: blobSha(cur), content: cur.toString('base64'), encoding: 'base64' })
      }
      if (req.method === 'PUT') {
        if (cur && !body.sha) return send(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' })
        if (cur && body.sha !== blobSha(cur)) return send(409, { message: `${path} does not match ${body.sha}` })
        if (!cur && body.sha) return send(409, { message: `${path} does not match ${body.sha}` })
        const b = Buffer.from(body.content, 'base64')
        mock.files.set(path, b)
        mock.commits.push(body.message)
        return send(cur ? 200 : 201, { content: { path, sha: blobSha(b) }, commit: { sha: String(mock.commits.length) } })
      }
      if (req.method === 'DELETE') {
        if (!cur) return send(404, { message: 'Not Found' })
        if (body?.sha !== blobSha(cur)) return send(409, { message: `${path} does not match ${body?.sha}` })
        mock.files.delete(path)
        mock.commits.push(body.message)
        return send(200, { commit: { sha: String(mock.commits.length) } })
      }
    }
    send(404, { message: `no route ${req.method} ${p}` })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.port = (server.address() as { port: number }).port
  return mock
}
