import { describe, expect, it } from 'vitest'
import { ICON_REFRESH_MS, ICON_RETRY_MS, MAX_ICON_BYTES, fetchIcon, iconDue, iconHostAllowed, iconHosts, parseIconLinks, sniffImage } from '../src/core/icons'
import type { HttpImpl, HttpRequest } from '../src/core/http'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(1)])
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, ...new Array(40).fill(2)])
const HTML = new TextEncoder().encode('<!doctype html><html><body>not found</body></html>')
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

/** 假的网络：地址 → 响应内容；没有的返回 404。记下请求过哪些地址 */
function fakeHttp(map: Record<string, Uint8Array | string | 'throw'>): HttpImpl & { calls: string[] } {
  const calls: string[] = []
  const f = (async (req: HttpRequest) => {
    calls.push(req.url)
    const body = map[req.url]
    if (body === 'throw') throw new Error('网络错误')
    const b = typeof body === 'string' ? new TextEncoder().encode(body) : body ?? new Uint8Array()
    return { status: body ? 200 : 404, ok: !!body, headers: {}, text: () => new TextDecoder().decode(b), json: () => ({}) as never, bytes: () => b }
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

  it('子域名取不到时退到主域名，主域名再试 www', () => {
    expect(iconHosts('login.taobao.com')).toEqual(['login.taobao.com', 'taobao.com'])
    expect(iconHosts('icbc.com.cn')).toEqual(['icbc.com.cn', 'www.icbc.com.cn'])
  })

  it('从首页里找图标声明：跳过 SVG 和内网地址，http 换成 https，最清楚的在前', () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <LINK REL='shortcut icon' href='//static.example.com/a.ico'>
      <link rel="mask-icon" href="/pin.svg">
      <link rel="icon" type="image/svg+xml" href="/i">
      <link rel="icon" href="/logo.svg">
      <link rel="apple-touch-icon" href="http://example.com/touch.png">
      <link rel="icon" href="https://192.168.1.2/x.png">
      <link rel="stylesheet" href="/a.css">
      <link rel="icon" href="/big.png" sizes="96x96 512x512">
      </head><body><link rel="icon" href="/late.png"></body></html>`
    expect(parseIconLinks(html, 'https://www.example.com/')).toEqual([
      { url: 'https://example.com/touch.png', size: 180 },
      { url: 'https://static.example.com/a.ico', size: 32 },
      { url: 'https://www.example.com/big.png', size: 512 },
    ])
    expect(parseIconLinks('<html>没有图标</html>', 'https://a.com/')).toEqual([])
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
      'https://login.taobao.com/': 'throw',
      'https://login.taobao.com/favicon.ico': 'throw',
      'https://taobao.com/favicon.ico': ICO,
    })
    expect(await fetchIcon('login.taobao.com', http)).toMatch(/^data:image\/x-icon;base64,/)
    expect(http.calls).toEqual([
      'https://login.taobao.com/apple-touch-icon.png', 'https://login.taobao.com/', 'https://login.taobao.com/favicon.ico',
      'https://taobao.com/apple-touch-icon.png', 'https://taobao.com/', 'https://taobao.com/favicon.ico',
    ])
    const none = fakeHttp({ 'https://example.org/favicon.ico': HTML })
    expect(await fetchIcon('example.org', none)).toBeNull()
    const inner = fakeHttp({})
    expect(await fetchIcon('nas.local', inner)).toBeNull()
    expect(inner.calls).toEqual([])
  })

  it('首页声明的图标优先于小的 favicon.ico；只有 www 上有首页时也能取到', async () => {
    const http = fakeHttp({
      'https://www.bank.cn/': '<head><link rel="icon" href="/img/logo.svg"><link rel="icon" href="/img/logo-64.png" sizes="64x64"></head>',
      'https://www.bank.cn/img/logo-64.png': PNG,
      'https://www.bank.cn/favicon.ico': ICO,
    })
    expect(await fetchIcon('bank.cn', http)).toMatch(/^data:image\/png;base64,/)
    expect(http.calls).not.toContain('https://www.bank.cn/favicon.ico')
    expect(http.calls.some((u) => u.endsWith('.svg'))).toBe(false)
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
