/**
 * 网站图标（1.0.7 起，设置里开启，默认关）。规格 5.9。
 *
 * 只直接向条目网址所在的网站要图标（/apple-touch-icon.png、/favicon.ico），不用 Google、DuckDuckGo 这类
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

/** 依次尝试的地址：本主机的大图标、小图标；子域名没有时退到主域名 */
export function iconUrls(host: string): string[] {
  const base = baseDomain(host)
  const out = [`https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`]
  if (base && base !== host) out.push(`https://${base}/favicon.ico`)
  else out.push(`https://www.${host}/favicon.ico`)
  return out
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

/** 取一个网站的图标，返回 data: 地址；都取不到返回 null。不抛错 */
export async function fetchIcon(host: string, http: HttpImpl): Promise<string | null> {
  if (!iconHostAllowed(host)) return null
  for (const url of iconUrls(host)) {
    try {
      const res = await http({ url, responseType: 'bytes', timeoutMs: 8000, headers: { Accept: 'image/*' } })
      if (!res.ok) continue
      const bytes = res.bytes()
      if (bytes.length > MAX_ICON_BYTES) continue
      const mime = sniffImage(bytes)
      if (mime) return `data:${mime};base64,${toBase64(bytes)}`
    } catch { /* 网络错误，试下一个 */ }
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
