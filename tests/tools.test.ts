import { describe, expect, it } from 'vitest'
import { DEFAULT_GEN, estimateBits, generatePassword, randomInt, strengthLabel } from '../src/core/generator'
import { exportCsv, importCsv, parseCsv, toCsv } from '../src/core/csv'
import { initialOf, searchItems } from '../src/core/search'
import { createItem, emptyVault, liveItems, type VaultState } from '../src/core/vault'

describe('密码生成器', () => {
  it('长度、字符种类都满足，每种至少一个', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ ...DEFAULT_GEN, length: 12 })
      expect(p).toHaveLength(12)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/\d/)
      expect(p).toMatch(/[^a-zA-Z\d]/)
      expect(p).not.toMatch(/[0Oo1lI|]/)
    }
    expect(generatePassword({ ...DEFAULT_GEN, upper: false, symbols: false, length: 30 })).toMatch(/^[a-z2-9]{30}$/)
    expect(() => generatePassword({ ...DEFAULT_GEN, lower: false, upper: false, digits: false, symbols: false })).toThrow()
  })

  it('随机下标分布均匀（粗查）', () => {
    const counts = new Array(7).fill(0)
    for (let i = 0; i < 70000; i++) counts[randomInt(7)]++
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(600)
  })

  it('强度估算', () => {
    expect(strengthLabel(estimateBits('123456')).level).toBe(0)
    expect(strengthLabel(estimateBits(generatePassword())).level).toBe(3)
  })
})

describe('CSV', () => {
  it('解析引号、逗号、换行、BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line1\nline2 ""q"""\n\n')).toEqual([['a', 'b'], ['x, y', 'line1\nline2 "q"']])
    expect(parseCsv(toCsv([['a"b', ' c', 'd\ne']]))).toEqual([['a"b', ' c', 'd\ne']])
  })

  it('导入 Chrome 导出的文件', () => {
    const r = importCsv('name,url,username,password,note\ngithub.com,https://github.com/login,me,p@ss, x \n,https://www.example.com/,u2,pw2,\n,,,,\n')
    expect(r.skipped).toBe(0) // 全空的行在解析时就去掉了
    expect(r.items).toEqual([
      { type: 'login', title: 'github.com', username: 'me', password: 'p@ss', urls: ['https://github.com/login'], notes: ' x ' },
      { type: 'login', title: 'example.com', username: 'u2', password: 'pw2', urls: ['https://www.example.com/'] },
    ])
  })

  it('导入 Bitwarden 导出的文件（含收藏、文件夹、安全笔记、TOTP）', () => {
    const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
      + '工作,1,login,邮箱,,,0,https://mail.x.com,me@x.com,secret,otpauth://totp/x?secret=ABC\n'
      + ',,note,银行卡备忘,"卡号尾号 1234",,0,,,,\n'
    const r = importCsv(csv)
    expect(r.items[0]).toEqual({ type: 'login', title: '邮箱', username: 'me@x.com', password: 'secret', urls: ['https://mail.x.com'], totp: 'otpauth://totp/x?secret=ABC', tags: ['工作'], favorite: true })
    expect(r.items[1]).toEqual({ type: 'note', title: '银行卡备忘', notes: '卡号尾号 1234' })
  })

  it('导入 KeePassXC 和中文表头；认不出表头时报错', () => {
    expect(importCsv('"Group","Title","Username","Password","URL","Notes"\n"Root","QQ","123","pw","",""\n').items[0])
      .toEqual({ type: 'login', title: 'QQ', username: '123', password: 'pw', tags: ['Root'] })
    expect(importCsv('标题,用户名,密码,网址,备注\n淘宝,tb,mm,taobao.com,\n').items[0]).toMatchObject({ title: '淘宝', urls: ['taobao.com'] })
    expect(importCsv('a,b\n1,2\n').error).toMatch(/认不出/)
  })

  it('导出再导入，信息不丢', () => {
    const items = [
      { type: 'login', title: 'A', username: 'u', password: 'p,"x"', urls: ['https://a.com', 'https://b.com'], notes: 'n', totp: 'T', fields: [{ name: 'PIN', value: '0000' }], tags: ['t'] },
    ]
    const csv = exportCsv(items)
    const back = importCsv(csv).items[0]
    expect(back.password).toBe('p,"x"')
    expect(back.urls).toEqual(['https://a.com'])
    expect(back.notes).toBe('n\n\n网址: https://b.com\nTOTP: T\nPIN: 0000\n标签: t')
  })
})

describe('搜索', () => {
  let s: VaultState = emptyVault()
  const add = (c: Parameters<typeof createItem>[1]) => (s = createItem(s, c, { device: 'A' }).state)
  add({ type: 'login', title: '招商银行', username: 'me', urls: ['https://cmbchina.com'] })
  add({ type: 'login', title: 'GitHub', username: 'octo', favorite: true })
  add({ type: 'note', title: 'Wi-Fi', notes: '家里 github 备用' })

  it('多个词都要命中；标题命中的排前；收藏在前', () => {
    const all = liveItems(s)
    expect(searchItems(all, '').map((i) => i.title)[0]).toBe('GitHub')
    expect(searchItems(all, 'github').map((i) => i.title)).toEqual(['GitHub', 'Wi-Fi'])
    expect(searchItems(all, 'cmb me').map((i) => i.title)).toEqual(['招商银行'])
    expect(searchItems(all, 'xyz')).toEqual([])
    expect(initialOf(' github')).toBe('G')
    expect(initialOf('招商')).toBe('招')
  })
})
