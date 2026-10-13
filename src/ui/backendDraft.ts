import type { BackendConfig } from '../store'

export interface Draft {
  type: 'github' | 'oss'
  /** owner/repo，也接受完整的 GitHub 网址 */
  repo: string
  token: string
  branch: string
  ghPrefix: string
  apiBase: string
  endpoint: string
  bucket: string
  ossPrefix: string
  akId: string
  akSecret: string
}

export function draftFrom(cfg: BackendConfig | null): Draft {
  const d: Draft = {
    type: 'github', repo: '', token: '', branch: 'main', ghPrefix: '', apiBase: '',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: '', ossPrefix: 'jinkui/', akId: '', akSecret: '',
  }
  if (cfg?.type === 'github') {
    const g = cfg.github
    Object.assign(d, { type: 'github', repo: `${g.owner}/${g.repo}`, token: g.token, branch: g.branch || 'main', ghPrefix: g.prefix ?? '', apiBase: g.apiBase ?? '' })
  } else if (cfg?.type === 'oss') {
    const o = cfg.oss
    Object.assign(d, { type: 'oss', endpoint: o.endpoint, bucket: o.bucket, ossPrefix: o.prefix, akId: o.accessKeyId, akSecret: o.accessKeySecret })
  }
  return d
}

/** 把草稿变成配置；有问题返回说明 */
export function configFrom(d: Draft): { cfg: BackendConfig } | { error: string } {
  if (d.type === 'github') {
    const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(d.repo.trim())
    if (!m) return { error: '仓库要写成“用户名/仓库名”，例如 yourname/jinkui-data' }
    if (!d.token.trim()) return { error: '请填写 Token' }
    return {
      cfg: {
        type: 'github',
        github: { owner: m[1], repo: m[2], token: d.token.trim(), branch: d.branch.trim() || 'main', prefix: d.ghPrefix.trim(), apiBase: d.apiBase.trim() || undefined },
      },
    }
  }
  if (!/^(https?:\/\/)?oss-[a-z0-9-]+\.aliyuncs\.com\/?$/i.test(d.endpoint.trim())) return { error: 'Endpoint 应形如 oss-cn-hangzhou.aliyuncs.com' }
  if (!d.bucket.trim()) return { error: '请填写 Bucket' }
  if (!d.akId.trim() || !d.akSecret.trim()) return { error: '请填写 AccessKey ID 和 Secret' }
  return {
    cfg: {
      type: 'oss',
      oss: { endpoint: d.endpoint.trim(), bucket: d.bucket.trim(), prefix: d.ossPrefix.trim() || 'jinkui/', accessKeyId: d.akId.trim(), accessKeySecret: d.akSecret.trim() },
    },
  }
}
