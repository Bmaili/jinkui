/**
 * 网站图标（1.0.7 起，设置里开启，默认关）。规格 5.9。
 *
 * 只直接向条目网址所在的网站要图标（/apple-touch-icon.png、首页声明的图标、/favicon.ico），不用 Google、DuckDuckGo 这类
 * 图标服务：那等于把“在哪些网站有账号”的完整清单交给第三方。内网地址（IP、localhost、.local 等）不请求。
 * 只收认得出的位图（PNG、ICO、JPEG、GIF、WebP），不收 SVG、HTML；太大的不要。
 */
import type { HttpImpl } from './http'
import { toBase64 } from './bytes'
import { baseDomain } from './autofill'

/** 单个图标最大字节数（apple-touch-icon 一般 5–30 KB） */
export const MAX_ICON_BYTES = 48 * 1024
/** 取不到的网站，过这么久再试 */
export const ICON_RETRY_MS = 7 * 86_400_000
/** 取到的图标，过这么久重新取一次（网站可能换了图标） */
export const ICON_REFRESH_MS = 90 * 86_400_000

const PRIVATE_SUFFIX = /\.(local|lan|home|internal|intranet|corp|localdomain|test|invalid|example|onion|arpa)$/

/** 这个主机能不能去取图标：要有点、不是 IP、不是内网或保留的后缀 */
export function iconHostAllowed(host: string): boolean {
  const h = host.toLowerCase()
  if (!h || h.length > 253 || !h.includes('.') || h === 'localhost' || h.endsWith('.localhost')) return false
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false
  if (PRIVATE_SUFFIX.test(h)) return false
  return /^[a-z0-9.-]+$/.test(h) && !h.startsWith('.') && !h.startsWith('-') && !h.includes('..')
}

/**
 * 依次去问的主机：本主机；子域名时退到主域名，否则试 www. 主机（很多国内网站只在 www 上有网页）。
 * 每个主机依次试：/apple-touch-icon.png（大图）、首页里声明的图标（1.0.8 起）、/favicon.ico。
 */
export function iconHosts(host: string): string[] {
  const base = baseDomain(host)
  return [host, base && base !== host ? base : `www.${host}`]
}

export interface IconLink {
  url: string
  /** 声明的边长；没写时按类型估计（apple-touch-icon 180，其他 32） */
  size: number
}

const ATTR_RE = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/**
 * 从首页 HTML 里找图标声明（<link rel="icon" / "shortcut icon" / "apple-touch-icon" …>），
 * 换成 https 的绝对地址，跳过 SVG 和内网地址，按清晰程度排好（最接近 128 像素的在前），最多 3 个。
 */
export function parseIconLinks(html: string, pageUrl: string): IconLink[] {
  const head = html.slice(0, 300_000).split(/<\/head\s*>/i)[0]
  const out: IconLink[] = []
  const seen = new Set<string>()
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {}
    for (const a of m[0].matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = (a[2] ?? a[3] ?? a[4] ?? '').trim()
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
    if (!rel.some((r) => r === 'icon' || r.startsWith('apple-touch-icon'))) continue
    const type = (attrs.type ?? '').toLowerCase()
    if (!attrs.href || type.includes('svg')) continue
    let u: URL
    try {
      u = new URL(attrs.href.replace(/&amp;/g, '&'), pageUrl)
    } catch {
      continue
    }
    if (u.protocol === 'http:') u.protocol = 'https:'
    if (u.protocol !== 'https:' || /\.svgz?$/i.test(u.pathname) || !iconHostAllowed(u.hostname)) continue
    const url = u.toString()
    if (seen.has(url)) continue
    seen.add(url)
    const declared = Math.max(0, ...(attrs.sizes ?? '').toLowerCase().split(/\s+/).map((x) => Number(x.split('x')[0]) || 0))
    out.push({ url, size: declared || (rel.some((r) => r.startsWith('apple-touch-icon')) ? 180 : 32) })
  }
  const score = (l: IconLink) => Math.abs(Math.log2(l.size / 128))
  return out.sort((a, b) => score(a) - score(b)).slice(0, 3)
}

/** 按文件头认出图片类型；认不出（HTML 错误页、SVG 等）返回 null */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 16) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  return null
}

async function getImage(url: string, http: HttpImpl): Promise<string | null> {
  try {
    const res = await http({ url, responseType: 'bytes', timeoutMs: 8000, headers: { Accept: 'image/*' } })
    if (!res.ok) return null
    const bytes = res.bytes()
    if (bytes.length > MAX_ICON_BYTES) return null
    const mime = sniffImage(bytes)
    return mime ? `data:${mime};base64,${toBase64(bytes)}` : null
  } catch {
    return null // 网络错误，试下一个
  }
}

async function getLinks(host: string, http: HttpImpl): Promise<IconLink[]> {
  const page = `https://${host}/`
  try {
    const res = await http({ url: page, responseType: 'text', timeoutMs: 8000, headers: { Accept: 'text/html' } })
    return res.ok ? parseIconLinks(res.text(), page) : []
  } catch {
    return []
  }
}

/** 取一个网站的图标，返回 data: 地址；都取不到返回 null。不抛错 */
export async function fetchIcon(host: string, http: HttpImpl): Promise<string | null> {
  if (!iconHostAllowed(host)) return null
  for (const h of iconHosts(host)) {
    if (!iconHostAllowed(h)) continue
    const hit = (await getImage(`https://${h}/apple-touch-icon.png`, http))
      ?? (await firstOf((await getLinks(h, http)).map((l) => l.url), http))
      ?? (await getImage(`https://${h}/favicon.ico`, http))
    if (hit) return hit
  }
  return null
}

async function firstOf(urls: string[], http: HttpImpl): Promise<string | null> {
  for (const u of urls) {
    const d = await getImage(u, http)
    if (d) return d
  }
  return null
}

export interface IconEntry {
  /** data: 地址；没有表示上次没取到 */
  data?: string
  /** 上次尝试的时间 */
  at: number
}

/** 该不该（重新）去取：没取过；上次没取到且过了 ICON_RETRY_MS；取到的过了 ICON_REFRESH_MS */
export function iconDue(e: IconEntry | undefined, now: number): boolean {
  if (!e) return true
  return now - e.at > (e.data ? ICON_REFRESH_MS : ICON_RETRY_MS)
}
