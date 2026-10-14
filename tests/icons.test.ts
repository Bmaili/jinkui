import { describe, expect, it } from 'vitest'
import { ICON_REFRESH_MS, ICON_RETRY_MS, MAX_ICON_BYTES, fetchIcon, iconDue, iconHostAllowed, iconUrls, sniffImage } from '../src/core/icons'
import type { HttpImpl, HttpRequest } from '../src/core/http'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(1)])
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, ...new Array(40).fill(2)])
const HTML = new TextEncoder().encode('<!doctype html><html><body>not found</body></html>')
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

/** 假的网络：地址 → 响应内容；没有的返回 404。记下请求过哪些地址 */
function fakeHttp(map: Record<string, Uint8Array | 'throw'>): HttpImpl & { calls: string[] } {
  const calls: string[] = []
  const f = (async (req: HttpRequest) => {
    calls.push(req.url)
    const body = map[req.url]
    if (body === 'throw') throw new Error('网络错误')
    const b = body ?? new Uint8Array()
    return { status: body ? 200 : 404, ok: !!body, headers: {}, text: () => '', json: () => ({}) as never, bytes: () => b }
  }) as unknown as HttpImpl & { calls: string[] }
  f.calls = calls
  return f
}

describe('网站图标', () => {
  it('不去取内网、IP、保留后缀的地址', () => {
    for (const h of ['github.com', 'login.taobao.com', 'mail.qq.com']) expect(iconHostAllowed(h)).toBe(true)
    for (const h of ['localhost', '192.168.1.1', '10.0.0.8', 'nas.local', 'router.lan', 'printer', 'x.internal', 'a.onion', '', '[::1]', 'a..b.com']) {
      expect(iconHostAllowed(h)).toBe(false)
    }
  })

  it('子域名取不到时退到主域名', () => {
    expect(iconUrls('login.taobao.com')).toEqual([
      'https://login.taobao.com/apple-touch-icon.png', 'https://login.taobao.com/favicon.ico', 'https://taobao.com/favicon.ico',
    ])
    expect(iconUrls('github.com').at(-1)).toBe('https://www.github.com/favicon.ico')
  })

  it('只收认得出的位图，不收 HTML 错误页和 SVG', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(ICO)).toBe('image/x-icon')
    expect(sniffImage(HTML)).toBeNull()
    expect(sniffImage(SVG)).toBeNull()
  })

  it('依次尝试，跳过错误页、太大的和网络错误', async () => {
    const big = new Uint8Array(MAX_ICON_BYTES + 1)
    big.set(PNG)
    const http = fakeHttp({
      'https://login.taobao.com/apple-touch-icon.png': big,
      'https://login.taobao.com/favicon.ico': 'throw',
      'https://taobao.com/favicon.ico': ICO,
    })
    expect(await fetchIcon('login.taobao.com', http)).toMatch(/^data:image\/x-icon;base64,/)
    expect(http.calls).toHaveLength(3)
    const none = fakeHttp({ 'https://example.org/favicon.ico': HTML })
    expect(await fetchIcon('example.org', none)).toBeNull()
    const inner = fakeHttp({})
    expect(await fetchIcon('nas.local', inner)).toBeNull()
    expect(inner.calls).toEqual([])
  })

  it('没取到的 7 天后再试，取到的 90 天后刷新', () => {
    const now = 1_000_000_000_000
    expect(iconDue(undefined, now)).toBe(true)
    expect(iconDue({ at: now - ICON_RETRY_MS + 1 }, now)).toBe(false)
    expect(iconDue({ at: now - ICON_RETRY_MS - 1 }, now)).toBe(true)
    expect(iconDue({ data: 'data:image/png;base64,', at: now - ICON_RETRY_MS - 1 }, now)).toBe(false)
    expect(iconDue({ data: 'data:image/png;base64,', at: now - ICON_REFRESH_MS - 1 }, now)).toBe(true)
  })
})
