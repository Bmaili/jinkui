import { describe, expect, it } from 'vitest'
import { baseDomain, hostOf, matchItems, packageTokens, scoreItem } from '../src/core/autofill'
import { createItem, deleteItem, emptyVault, liveItems, type VaultState } from '../src/core/vault'

let s: VaultState = emptyVault()
const add = (c: Parameters<typeof createItem>[1], id: string) => (s = createItem(s, c, { device: 'A', newId: id }).state)
add({ type: 'login', title: '淘宝', urls: ['https://login.taobao.com/member/login.jhtml'] }, 'tb')
add({ type: 'login', title: '天猫', urls: ['tmall.com'] }, 'tm')
add({ type: 'login', title: '新浪微博', urls: ['https://weibo.com'] }, 'wb')
add({ type: 'login', title: '新浪邮箱', urls: ['https://mail.sina.com.cn'] }, 'sina')
add({ type: 'login', title: '微信', apps: ['com.tencent.mm'] }, 'wx')
add({ type: 'login', title: '支付宝', urls: ['https://www.alipay.com'] }, 'ali')
add({ type: 'note', title: 'taobao 备忘', notes: 'x' }, 'note')
add({ type: 'login', title: '已删除的淘宝', urls: ['taobao.com'] }, 'del')
s = deleteItem(s, 'del', { device: 'A' })
const all = Object.values(s.items)
const ids = (t: Parameters<typeof matchItems>[1]) => matchItems(all, t).map((i) => i.id)

describe('域名', () => {
  it('取主机名和主域名', () => {
    expect(hostOf('https://WWW.Taobao.com/x?y')).toBe('taobao.com')
    expect(hostOf('taobao.com/login')).toBe('taobao.com')
    expect(hostOf('')).toBe('')
    expect(baseDomain('login.taobao.com')).toBe('taobao.com')
    expect(baseDomain('mail.sina.com.cn')).toBe('sina.com.cn')
    expect(baseDomain('sina.com.cn')).toBe('sina.com.cn')
    expect(baseDomain('a.b.c.co.uk')).toBe('c.co.uk')
    expect(baseDomain('192.168.1.1')).toBe('192.168.1.1')
    expect(packageTokens('com.eg.android.AlipayGphone')).toEqual(['alipaygphone'])
  })
})

describe('匹配', () => {
  it('网站：同一主机最优先，同一主域名其次；不推荐笔记和已删除的', () => {
    expect(ids({ webDomain: 'login.taobao.com', packageName: 'com.android.chrome' })).toEqual(['tb'])
    expect(ids({ webDomain: 'www.taobao.com' })).toEqual(['tb'])
    expect(ids({ webDomain: 'm.sina.com.cn' })).toEqual(['sina'])
    expect(ids({ webDomain: 'example.com' })).toEqual([])
  })

  it('app：记住过的包名最优先；包名和主域名对得上的也推荐', () => {
    expect(ids({ packageName: 'com.tencent.mm' })).toEqual(['wx'])
    expect(ids({ packageName: 'com.taobao.taobao' })).toEqual(['tb'])
    expect(ids({ packageName: 'com.eg.android.AlipayGphone' })).toEqual(['ali'])
    // sina、weibo 两个词各对上一条，同分按标题（拼音）排序
    expect(ids({ packageName: 'com.sina.weibo' })).toEqual(['wb', 'sina'])
    expect(ids({ packageName: 'com.unknown.thing' })).toEqual([])
  })

  it('浏览器里按网址匹配，不按浏览器的包名猜', () => {
    const chrome = { packageName: 'com.android.chrome', webDomain: 'tmall.com' }
    expect(ids(chrome)).toEqual(['tm'])
    expect(scoreItem(s.items.tb, { packageName: 'com.taobao.taobao', webDomain: 'example.com' })).toBe(0)
  })

  it('网址主机完全相同的，排在只是同一主域名的前面', () => {
    const t = createItem(s, { type: 'login', title: 'A 淘宝小号', urls: ['https://taobao.com'] }, { device: 'A', newId: 'tb2' }).state
    expect(matchItems(liveItems(t), { webDomain: 'taobao.com' }).map((i) => i.id)).toEqual(['tb2', 'tb'])
  })
})
