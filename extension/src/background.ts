/**
 * 扩展的后台（service worker）。保险库只在这里解开；弹窗和网页里的内容脚本都通过消息找它。
 * Chrome 闲置约 30 秒就会停掉后台，醒来时 VaultService.ready() 从 storage.session 恢复解锁状态。
 */
import { VaultService, type Kv, type Pending } from './service'
import { backendTitle } from './title'
import { baseDomain, hostOf } from '../../src/core/autofill'
import type { ContentMsg, FillMsg, ItemsReply, OffscreenMsg, PendingHereReply, PopupMsg, StateReply } from './messages'

const kv = (area: chrome.storage.Area): Kv => ({
  async get(k) {
    const v = (await area.get(k))[k]
    return typeof v === 'string' ? v : null
  },
  set: (k, v) => area.set({ [k]: v }),
  remove: (k) => area.remove(k),
})

// 解开的保险库密钥放在 session 里：只给扩展自己的页面看，网页里的内容脚本读不到（这也是 Chrome 的默认值）
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
const svc = new VaultService(kv(chrome.storage.local), kv(chrome.storage.session))

const SYNC_EVERY_MS = 15 * 60_000

function ensureAlarm() {
  void chrome.alarms.create('tick', { periodInMinutes: 5 })
}
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return
  void (async () => {
    await svc.ready()
    if (await svc.checkIdle()) return
    if (svc.phase === 'unlocked' && (svc.sync.pending || Date.now() - svc.sync.last > SYNC_EVERY_MS)) await svc.syncNow()
  })()
})

// ---------- 剪贴板（后台没有页面，借一个看不见的 offscreen 页面来写、到时清空） ----------

async function copy(text: string, secret: boolean) {
  const url = chrome.runtime.getURL('offscreen.html')
  const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
  if (!open.length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: '复制密码，并在设定的时间后清空剪贴板' })
  }
  const msg: OffscreenMsg = { t: 'clip', text, clearAfterSec: secret ? svc.prefs.clipboardSec : 0, target: 'offscreen' }
  await chrome.runtime.sendMessage(msg)
}

// ---------- 填充 ----------

/** 把条目的账号密码发给这个标签页（各个框架里的内容脚本自己核对网站再填） */
async function fillTab(tabId: number, url: string, cred: { username?: string; password?: string }) {
  const tab = await chrome.tabs.get(tabId)
  // 弹窗打开期间标签页可能已经跳到别的网站：以标签页现在的地址为准
  if (!tab.url || hostOf(tab.url) !== hostOf(url)) throw new Error('网页已经变了，请重新打开金匮再填')
  const msg: FillMsg = { t: 'fill', host: hostOf(tab.url), ...cred }
  const r = await chrome.tabs.sendMessage<{ filled: boolean }>(tabId, msg).catch(() => null)
  if (!r?.filled) throw new Error('这个网页上没有找到可以填的账号或密码框')
  await svc.touch()
}

async function fillItem(tabId: number, url: string, id: string) {
  const it = svc.item(id)
  if (!it) throw new Error('条目不存在')
  // 用户在弹窗里明确选了这一条（网址和当前网页对不上时弹窗会先确认）；
  // 内容脚本只填进主域名和标签页一致的框架，嵌在页面里的别的网站拿不到
  await fillTab(tabId, url, { username: it.username, password: it.password })
}

/** 快捷键：填当前网页的第一条推荐；没有推荐、或者上锁了，就打开弹窗 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'fill') return
  void (async () => {
    await svc.ready()
    const t = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    if (svc.phase !== 'unlocked' || !t?.id || !t.url) return void chrome.action.openPopup().catch(() => {})
    const s = svc.suggest(t.url)
    if (s.length !== 1) return void chrome.action.openPopup().catch(() => {})
    await fillItem(t.id, t.url, s[0].id).catch(() => chrome.action.openPopup().catch(() => {}))
  })()
})

// ---------- 消息 ----------

/** 待保存的密码只留在后台，弹窗和网页都只看到账号和网站 */
function withoutPassword(p: Pending | null) {
  return p ? { tabId: p.tabId, at: p.at, url: p.url, username: p.username, updateId: p.updateId, updateTitle: p.updateTitle } : null
}

async function onPopup(m: PopupMsg): Promise<unknown> {
  switch (m.t) {
    case 'state': {
      if (svc.phase === 'unlocked') await svc.touch()
      const r: StateReply = {
        phase: svc.phase,
        prefs: { deviceName: svc.prefs.deviceName, idleMin: svc.prefs.idleMin, clipboardSec: svc.prefs.clipboardSec },
        sync: svc.sync,
        backendTitle: backendTitle(svc.backend),
        suggested: svc.phase === 'unlocked' && m.url ? svc.suggest(m.url).map((i) => i.id) : [],
        pending: m.tabId !== undefined ? withoutPassword(await svc.pendingFor(m.tabId)) : null,
        version: chrome.runtime.getManifest().version,
      }
      // 打开弹窗时，超过 1 分钟没同步就同步一次
      if (svc.phase === 'unlocked' && Date.now() - svc.sync.last > 60_000) void svc.syncNow()
      return r
    }
    case 'items': {
      const r: ItemsReply = svc.phase === 'unlocked' ? { items: svc.items(), folders: svc.folders() } : { items: [], folders: [] }
      return r
    }
    case 'join':
      await svc.join(m.code, m.pass, m.name)
      return {}
    case 'unlock':
      await svc.unlock(m.pass)
      return {}
    case 'lock':
      await svc.lock()
      return {}
    case 'sync':
      return { ok: await svc.syncNow() }
    case 'fill':
      await fillItem(m.tabId, m.url, m.id)
      return {}
    case 'fillPassword':
      await fillTab(m.tabId, m.url, { password: m.password })
      return {}
    case 'copy':
      await copy(m.text, m.secret)
      await svc.touch()
      return {}
    case 'savePending':
      await svc.savePending(m.tabId, m.mode)
      await clearBadge(m.tabId, true)
      return {}
    case 'dropPending':
      await svc.dropPending(m.tabId)
      await clearBadge(m.tabId, true)
      return {}
    case 'prefs':
      await svc.savePrefs(m.patch)
      return {}
    case 'wipe':
      if (!(await svc.verifyPassphrase(m.pass))) throw new Error('主密码不对')
      await svc.wipe()
      return {}
  }
}

/** 待保存的登录处理掉了：去掉图标上的数字，网页上的提示条也收起来 */
async function clearBadge(tabId: number, fromPopup: boolean) {
  await chrome.action.setBadgeText({ text: '', tabId }).catch(() => {})
  if (fromPopup) await chrome.tabs.sendMessage(tabId, { t: 'showSave' }, { frameId: 0 }).catch(() => {})
}

async function onContent(m: ContentMsg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id
  if (tabId === undefined) throw new Error('不是来自标签页')
  switch (m.t) {
    case 'capture': {
      // 以发消息的框架的真实地址为准（sender.url），不信消息里自报的网址
      const url = sender.url ?? ''
      if (!url || baseDomain(hostOf(url)) !== baseDomain(hostOf(m.url))) return { result: 'ignored' }
      const result = await svc.capture(tabId, { url, username: String(m.username ?? '').slice(0, 300), password: String(m.password ?? '').slice(0, 300) })
      if (result === 'pending') {
        await chrome.action.setBadgeBackgroundColor({ color: '#8d6526' }).catch(() => {})
        await chrome.action.setBadgeText({ text: '1', tabId }).catch(() => {})
        // 提示条只在顶层页面显示（登录框可能在 iframe 里）
        await chrome.tabs.sendMessage(tabId, { t: 'showSave' }, { frameId: 0 }).catch(() => {})
      }
      return { result }
    }
    case 'pendingHere': {
      const p = await svc.pendingFor(tabId)
      const r: PendingHereReply = {
        phase: svc.phase,
        // 不把密码交回网页
        pending: p ? { username: p.username, url: p.url, updateId: p.updateId, updateTitle: p.updateTitle } : null,
      }
      return r
    }
    case 'savePendingHere':
      await svc.savePending(tabId, m.mode)
      await clearBadge(tabId, false)
      return {}
    case 'dropPendingHere':
      await svc.dropPending(tabId)
      await clearBadge(tabId, false)
      return {}
    case 'openPopup':
      await chrome.action.openPopup().catch(() => {})
      return {}
  }
}

const POPUP_ONLY = new Set(['state', 'items', 'join', 'unlock', 'lock', 'sync', 'fill', 'fillPassword', 'copy', 'savePending', 'dropPending', 'prefs', 'wipe'])

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const m = msg as { t?: string; target?: string }
  if (m?.target === 'offscreen' || m?.t === 'clipDone') {
    if (m.t === 'clipDone') void chrome.offscreen.closeDocument().catch(() => {})
    return false
  }
  // 扩展自己的页面（弹窗，或在标签页里打开的扩展页面）地址是 chrome-extension://本扩展/…；
  // 网页里的内容脚本发来的消息，sender.url 是网页的地址，只能是 ContentMsg
  const fromExtensionPage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''))
  const job = (async () => {
    await svc.ready()
    if (fromExtensionPage && POPUP_ONLY.has(m.t ?? '')) return onPopup(msg as PopupMsg)
    if (!fromExtensionPage && sender.tab && !POPUP_ONLY.has(m.t ?? '')) return onContent(msg as ContentMsg, sender)
    throw new Error('不认识的消息')
  })()
  job.then(
    (r) => sendResponse(r ?? {}),
    (e) => sendResponse({ error: (e as Error).message || '出错了' }),
  )
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => void svc.ready().then(() => svc.dropPending(tabId)))
