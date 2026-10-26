/**
 * 内容脚本：跑在每个网页（包括里面的 iframe）里，和网页自己的脚本隔开。
 *
 * - 填充：只在后台发来 FillMsg 时（用户在弹窗里点了“填充”、或按了快捷键）。先核对本框架所在网站的主域名
 *   和标签页一致，嵌在页面里的别的网站（广告、第三方框架）拿不到账号密码。
 * - 保存：用户提交含密码框的表单（提交、点按钮、在框里按回车）时，把账号密码交给后台；后台判断要不要提示。
 *   提示条只在顶层页面显示，放在 Shadow DOM 里，网页的样式影响不到它。
 * 这里拿不到任何已保存的条目。
 */
import { baseDomain, hostOf } from '../../src/core/autofill'
import type { FillMsg, PendingHereReply } from './messages'

// ---------- 找框 ----------

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const st = getComputedStyle(el)
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05
}

const fields = (scope: ParentNode): HTMLInputElement[] =>
  Array.from(scope.querySelectorAll('input')).filter((i) => !i.disabled && !i.readOnly && i.type !== 'hidden' && visible(i))

const passwordFields = (scope: ParentNode) => fields(scope).filter((i) => i.type === 'password')

const USER_TYPES = new Set(['text', 'email', 'tel', 'url'])
const NOT_USER = /search|captcha|verif|otp|code|验证码|搜索|keyword/i

function describe(i: HTMLInputElement): string {
  return [i.name, i.id, i.placeholder, i.getAttribute('aria-label') ?? '', i.autocomplete].join(' ')
}

const isUserField = (i: HTMLInputElement) => USER_TYPES.has(i.type) && !NOT_USER.test(describe(i))

/** 账号框：声明了 autocomplete=username/email 的；否则密码框前面最近的文本框 */
function usernameFor(pw: HTMLInputElement | null, scope: ParentNode): HTMLInputElement | null {
  const all = fields(scope)
  const declared = all.find((i) => /\b(username|email)\b/.test(i.autocomplete) && isUserField(i))
  if (declared) return declared
  if (pw) {
    for (let j = all.indexOf(pw) - 1; j >= 0; j--) if (isUserField(all[j])) return all[j]
    return null
  }
  return all.find(isUserField) ?? null
}

/** 要填的框：优先当前焦点所在的表单 */
function targets(): { user: HTMLInputElement | null; pw: HTMLInputElement | null } {
  const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const scope: ParentNode = active?.form ?? document
  let pw = active?.type === 'password' ? active : (passwordFields(scope)[0] ?? null)
  if (!pw && scope !== document) pw = passwordFields(document)[0] ?? null
  const userScope: ParentNode = pw?.form ?? scope
  return { user: usernameFor(pw, userScope), pw }
}

/** 像用户输入一样写进去：React 等框架监听的是原生 setter 和 input 事件 */
function setValue(el: HTMLInputElement, v: string) {
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, v)
  else el.value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const sameSite = (host: string) => !!host && baseDomain(hostOf(location.href)) === baseDomain(hostOf(host))

function fill(m: FillMsg): boolean {
  if (!sameSite(m.host)) return false
  const { user, pw } = targets()
  let done = false
  if (m.username && user) {
    setValue(user, m.username)
    done = true
  }
  if (m.password && pw) {
    setValue(pw, m.password)
    done = true
  }
  return done
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { t?: string }
  if (m?.t === 'fill') {
    // 只有真的填了的框架回话：几个框架都收到时，回话的那个说了算；都没填，后台会提示“没有找到”
    if (fill(msg as FillMsg)) sendResponse({ filled: true })
    return false
  }
  if (m?.t === 'showSave' && window === window.top) void checkPending()
  return false
})

// ---------- 登录时捕获 ----------

let lastSent = ''
let lastAt = 0

function capture(scope: ParentNode) {
  const pws = passwordFields(scope).filter((p) => p.value)
  if (!pws.length) return
  // 改密码的表单（旧密码、新密码、确认）：新密码在后面，和旧的不一样
  const pw = pws.length >= 2 && pws[pws.length - 1].value !== pws[0].value ? pws[pws.length - 1] : pws[0]
  const username = (usernameFor(pws[0], scope)?.value ?? '').trim()
  const key = `${location.host}\n${username}\n${pw.value}`
  if (key === lastSent && Date.now() - lastAt < 5000) return
  lastSent = key
  lastAt = Date.now()
  void chrome.runtime.sendMessage({ t: 'capture', url: location.href, username, password: pw.value }).catch(() => {})
}

const scopeOf = (el: Element): ParentNode => (el as HTMLInputElement).form ?? el.closest('form') ?? document

document.addEventListener('submit', (e) => {
  if (e.target instanceof HTMLFormElement) capture(e.target)
}, true)

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button, input[type=submit], input[type=button], input[type=image], [role=button]') : null
  if (!b) return
  // 表单里只认提交按钮（“显示密码”这类按钮是 type=button，不算登录）；不用表单的网页（单页应用）点任何按钮都看一眼
  const form = (b as HTMLButtonElement).form ?? b.closest('form')
  if (form && !((b instanceof HTMLButtonElement || b instanceof HTMLInputElement) && (b.type === 'submit' || b.type === 'image'))) return
  capture(form ?? document)
}, true)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) capture(scopeOf(e.target))
}, true)

// ---------- 保存提示条（只在顶层页面） ----------

let bar: HTMLElement | null = null

function closeBar() {
  bar?.remove()
  bar = null
}

function button(label: string, primary: boolean, onClick: () => void) {
  const b = document.createElement('button')
  b.textContent = label
  b.className = primary ? 'p' : ''
  // 只认用户真的点了：网页自己的脚本模拟点击（isTrusted 为 false）不算
  b.addEventListener('click', (e) => {
    if (e.isTrusted) onClick()
  })
  return b
}

async function act(t: 'savePendingHere' | 'dropPendingHere', mode?: 'update' | 'new') {
  const r = await chrome.runtime.sendMessage<{ error?: string }>(mode ? { t, mode } : { t }).catch((e: Error) => ({ error: e.message }))
  if (t === 'savePendingHere') showBar(r?.error ? `没有保存：${r.error}` : '已保存到金匮', [])
  else closeBar()
}

function showBar(text: string, buttons: HTMLButtonElement[], sub = '') {
  closeBar()
  const host = document.createElement('div')
  host.setAttribute('data-jinkui', '')
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .bar { position: fixed; top: 12px; right: 12px; z-index: 2147483647; max-width: 360px; padding: 12px 14px; border-radius: 14px;
      background: #fbf8f1; color: #2a2622; border: 1px solid #e2d9c8; box-shadow: 0 10px 30px -10px rgba(0,0,0,.35);
      font: 14px/1.5 system-ui, -apple-system, 'Microsoft YaHei', sans-serif; }
    .t { display: flex; gap: 8px; align-items: center; font-weight: 600; }
    .t b { color: #8d6526; font-family: 'Noto Serif SC', 'Songti SC', 'SimSun', serif; }
    .s { margin-top: 2px; color: #6d655a; font-size: 12px; word-break: break-all; }
    .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; justify-content: flex-end; }
    button { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 999px; color: #6d655a; font-weight: 600; }
    button:hover { background: #e2d9c8; }
    button.p { background: #8d6526; color: #fbf8f1; }
    button.x { position: absolute; top: 6px; right: 8px; padding: 2px 6px; }
    @media (prefers-color-scheme: dark) {
      .bar { background: #1f1c19; color: #ece4d6; border-color: #3a342d; }
      .s, button { color: #a59c8d; }
      button:hover { background: #3a342d; }
      .t b { color: #d4a85a; }
      button.p { background: #d4a85a; color: #1a1714; }
    }`
  const box = document.createElement('div')
  box.className = 'bar'
  box.setAttribute('role', 'dialog')
  const t = document.createElement('div')
  t.className = 't'
  const brand = document.createElement('b')
  brand.textContent = '金匮'
  const span = document.createElement('span')
  span.textContent = text
  t.append(brand, span)
  box.append(t)
  if (sub) {
    const s = document.createElement('div')
    s.className = 's'
    s.textContent = sub
    box.append(s)
  }
  if (buttons.length) {
    const bs = document.createElement('div')
    bs.className = 'btns'
    bs.append(...buttons)
    box.append(bs)
  } else {
    setTimeout(closeBar, 2500)
  }
  root.append(style, box)
  document.documentElement.append(host)
  bar = host
}

async function checkPending() {
  const r = await chrome.runtime.sendMessage<PendingHereReply>({ t: 'pendingHere' }).catch(() => null)
  const p = r?.pending
  if (!r || !p) return closeBar()
  const who = p.username ? `${p.username} · ${hostOf(p.url)}` : hostOf(p.url)
  const never = button('不保存', false, () => void act('dropPendingHere'))
  if (r.phase !== 'unlocked') {
    showBar('已上锁：解锁后保存这个登录', [never, button('解锁', true, () => void chrome.runtime.sendMessage({ t: 'openPopup' }).catch(() => {}))], `${who}（10 分钟内有效；也可以点浏览器右上角的金匮图标）`)
  } else if (p.updateId) {
    showBar(`更新“${p.updateTitle}”的密码？`, [never, button('另存一条', false, () => void act('savePendingHere', 'new')), button('更新', true, () => void act('savePendingHere', 'update'))], who)
  } else {
    showBar('保存这个登录？', [never, button('保存', true, () => void act('savePendingHere', 'new'))], who)
  }
}

if (window === window.top) {
  // 登录后跳到新页面：看看有没有待保存的
  void checkPending()
}
