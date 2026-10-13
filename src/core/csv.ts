/**
 * CSV 导入导出（规格 5.7）。
 * 导入认得 Chrome / Edge、Bitwarden、KeePassXC、1Password 以及中文表头的常见列名；
 * 导出用 Chrome 的格式（name,url,username,password,note），几乎所有密码管理器都能导入。
 */
import type { ItemContent } from './item'

/** RFC 4180：引号、引号里的逗号和换行、"" 转义，去掉 BOM */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const esc = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
}

const COLUMNS: Record<string, string[]> = {
  title: ['name', 'title', '标题', '名称', '网站名称', 'account'],
  url: ['url', 'login_uri', 'website', 'uri', 'urls', '网址', '网站', 'origin_url'],
  username: ['username', 'login_username', 'user', 'login', 'user name', '用户名', '账号', '帐号', 'email'],
  password: ['password', 'login_password', '密码'],
  notes: ['note', 'notes', 'extra', 'comments', '备注', '说明'],
  totp: ['totp', 'login_totp', 'otpauth', 'one-time password', 'otp'],
  group: ['folder', 'group', 'grouping', 'category', '分组', '文件夹'],
  favorite: ['favorite', 'fav', '收藏'],
  type: ['type'],
}

export interface ImportResult {
  items: ItemContent[]
  /** 认不出表头时的提示 */
  error?: string
  /** 空行、没有任何内容的行 */
  skipped: number
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text)
  if (rows.length < 2) return { items: [], skipped: 0, error: '文件里没有数据' }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {}
  for (const [key, names] of Object.entries(COLUMNS)) {
    const i = header.findIndex((h) => names.includes(h))
    if (i >= 0) col[key as keyof typeof COLUMNS] = i
  }
  if (col.password == null && col.username == null && col.notes == null) {
    return { items: [], skipped: 0, error: '认不出表头：至少要有 password、username 或 notes 这类列' }
  }
  const get = (r: string[], k: keyof typeof COLUMNS) => (col[k] == null ? '' : (r[col[k]!] ?? '').trim())
  const items: ItemContent[] = []
  let skipped = 0
  for (const r of rows.slice(1)) {
    const url = get(r, 'url')
    const username = get(r, 'username')
    const password = r[col.password ?? -1] ?? '' // 密码不去空格
    const notes = col.notes == null ? '' : (r[col.notes] ?? '')
    const totp = get(r, 'totp')
    if (!url && !username && !password && !notes.trim() && !get(r, 'title')) {
      skipped++
      continue
    }
    const type = get(r, 'type').toLowerCase()
    const isNote = type === 'note' || type === 'securenote' || (!username && !password && !url && !!notes.trim())
    const title = get(r, 'title') || hostOf(url) || username || '未命名'
    const item: ItemContent = { type: isNote ? 'note' : 'login', title }
    if (username) item.username = username
    if (password) item.password = password
    if (url) item.urls = url.split(/[\n,]\s*/).map((u) => u.trim()).filter(Boolean)
    if (notes.trim()) item.notes = notes
    if (totp) item.totp = totp
    const group = get(r, 'group')
    if (group) item.tags = [group]
    if (/^(1|true|yes|是)$/i.test(get(r, 'favorite'))) item.favorite = true
    items.push(item)
  }
  return { items, skipped }
}

/** 导出为 Chrome 格式。多出来的网址、自定义字段、动态码密钥写进备注，不丢信息 */
export function exportCsv(items: ItemContent[]): string {
  const rows: string[][] = [['name', 'url', 'username', 'password', 'note']]
  for (const it of items) {
    const urls = it.urls ?? []
    const extra: string[] = []
    if (urls.length > 1) extra.push(...urls.slice(1).map((u) => `网址: ${u}`))
    if (it.totp) extra.push(`TOTP: ${it.totp}`)
    for (const f of it.fields ?? []) extra.push(`${f.name}: ${f.value}`)
    if (it.tags?.length) extra.push(`标签: ${it.tags.join(', ')}`)
    const note = [it.notes ?? '', ...(extra.length ? [extra.join('\n')] : [])].filter(Boolean).join('\n\n')
    rows.push([it.title, urls[0] ?? '', it.username ?? '', it.password ?? '', note])
  }
  return toCsv(rows)
}
