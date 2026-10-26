import type { PopupMsg } from '../messages'
import { isError } from '../messages'

/** 发消息给后台，出错时抛出后台给的说明 */
export async function call<T = Record<string, never>>(m: PopupMsg): Promise<T> {
  const r = await chrome.runtime.sendMessage<T | { error: string }>(m)
  if (isError(r)) throw new Error(r.error)
  return r as T
}

/** 当前标签页 */
export async function activeTab(): Promise<{ id?: number; url: string }> {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
  return { id: t?.id, url: t?.url ?? '' }
}

const REPO = 'Bmaili/jinkui'
export const RELEASES_URL = `https://github.com/${REPO}/releases`

/** 扩展的新版本：Releases 里最新的 ext-v1.0.N（手机版的 v1.0.N 不算） */
export async function latestExtVersion(): Promise<{ version: string; url: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) return null
  const list = (await res.json()) as { tag_name: string; html_url: string; draft: boolean }[]
  const best = list
    .filter((r) => !r.draft && /^ext-v\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => ({ version: r.tag_name.slice(5), url: r.html_url }))
    .sort((a, b) => compareVersions(b.version, a.version))[0]
  return best ?? null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
