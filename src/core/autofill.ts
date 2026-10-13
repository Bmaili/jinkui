/**
 * 自动填充的匹配（规格 5.8）：给一个填充请求（来自哪个 app、哪个网站），找出可能对应的条目。
 *
 * - 网站：条目网址的域名和请求的域名相同（3 分），或同属一个主域名（2 分），例如 login.taobao.com 和 www.taobao.com。
 * - app：条目记住过这个 app 的包名（3 分，用户在这个 app 里填过一次就会记住）；
 *   包名里的词和条目网址的主域名、标题对得上（1 分），例如 com.taobao.taobao 和 taobao.com。
 * 只做推荐：用户总可以在全部条目里搜索、选择别的。
 */
import type { Item } from './item'

export interface FillTarget {
  /** 安卓包名，例如 com.taobao.taobao；浏览器里是浏览器的包名 */
  packageName?: string
  /** 网页的域名（浏览器、app 内嵌网页），例如 login.taobao.com */
  webDomain?: string
}

/** 两段式的公共后缀：域名落在这些后缀下时，主域名取最后三段 */
const SECOND_LEVEL = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.au', 'co.uk', 'org.uk', 'co.jp', 'co.kr', 'com.br',
])

export function hostOf(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
    return u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}

/** 主域名：a.b.taobao.com → taobao.com；x.sina.com.cn → sina.com.cn；IP 原样返回 */
export function baseDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const last2 = parts.slice(-2).join('.')
  return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2
}

/** 主域名里有辨识度的那段：taobao.com → taobao；sina.com.cn → sina */
const brandOf = (base: string) => base.split('.')[0] ?? ''

const STOP = new Set(['com', 'cn', 'net', 'org', 'android', 'app', 'apps', 'mobile', 'client', 'www', 'main', 'phone', 'lite', 'pro', 'hd'])

/** 包名里有辨识度的词：com.eg.android.AlipayGphone → [alipaygphone] */
export function packageTokens(pkg: string): string[] {
  return pkg.toLowerCase().split(/[._-]/).filter((t) => t.length >= 4 && !STOP.has(t))
}

export function scoreItem(it: Item, t: FillTarget): number {
  let score = 0
  const hosts = (it.urls ?? []).map(hostOf).filter(Boolean)
  if (t.webDomain) {
    const host = hostOf(t.webDomain)
    const base = baseDomain(host)
    for (const h of hosts) {
      if (h === host) score = Math.max(score, 3)
      else if (baseDomain(h) === base) score = Math.max(score, 2)
    }
  }
  if (t.packageName) {
    const apps = Array.isArray(it.apps) ? (it.apps as unknown[]) : []
    if (apps.includes(t.packageName)) score = Math.max(score, 3)
    else if (!t.webDomain) {
      const tokens = packageTokens(t.packageName)
      const brands = hosts.map((h) => brandOf(baseDomain(h))).filter((b) => b.length >= 3)
      const title = it.title.toLowerCase()
      const hit = tokens.some((tok) => brands.some((b) => tok === b || tok.includes(b) || b.includes(tok)) || title.includes(tok))
      if (hit) score = Math.max(score, 1)
    }
  }
  return score
}

/** 推荐的条目：只要登录类、没删除的，分高的在前，同分按标题 */
export function matchItems(items: Item[], t: FillTarget): Item[] {
  return items
    .filter((it) => !it.deleted && it.type !== 'note')
    .map((it) => ({ it, s: scoreItem(it, t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.title.localeCompare(b.it.title, 'zh-CN'))
    .map((x) => x.it)
}

/** 条目已经记住了这个 app */
export const remembersApp = (it: Item, pkg: string) => Array.isArray(it.apps) && (it.apps as unknown[]).includes(pkg)
