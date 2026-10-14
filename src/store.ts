/**
 * 应用层（规格 5、6）：本地保险库、解锁与上锁、编辑、同步调度。界面只通过这里改数据。
 *
 * 本地文件（都经过 SlotStore 双槽写入）：
 * - identity：用主密码加密的保险库密钥（和云端 keys/identity.age 相同的内容）
 * - vault：本地保险库，加密给保险库公钥
 * - config：同步后端配置（含 Token / AccessKey），加密给保险库公钥
 * - syncstate：同步状态，加密给保险库公钥
 * 解锁后明文只在内存里；上锁时清掉。
 */
import { reactive, shallowRef } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { utf8 } from './core/bytes'
import {
  KEY_INFO, VaultCipher, WrongPassphraseError, changePassphrase as rewrap, createKeys, encryptJsonTo, parseKeyInfo, unwrapIdentity, type KeyBundle,
} from './core/crypto'
import { identityToRecipient } from 'age-encryption'
import { canonicalJson, type ItemContent } from './core/item'
import { GitHubStore, type GitHubConfig } from './core/sync/github'
import { OssStore, type OssConfig } from './core/sync/oss'
import { RemoteError, type RemoteStore } from './core/sync/remote'
import { KeyMismatchError, NotInitializedError, SyncEngine, type SyncHost, type SyncProblem, type SyncState } from './core/sync/engine'
import type { DeviceInfo } from './core/sync/deviceFile'
import { initRemote, joinRemote, makeJoinCode, probeRemote, uploadWrappedKey, type Probe } from './core/sync/setup'
import {
  FORMAT, FormatTooNewError, createFolder, createItem, deleteFolder, deleteItem, emptyVault, gcTombstones, mergeVaults, moveFolder, parseVault,
  purgeItem, renameFolder, restoreItem, revertTo, updateItem, type VaultState,
} from './core/vault'
import { liveFolders } from './core/folders'
import { fetchIcon, iconDue, iconHostAllowed, type IconEntry } from './core/icons'
import { hostOf } from './core/autofill'
import { http } from './core/http'
import type { ImportedItem } from './core/csv'
import type { Rev } from './core/rev'
import { files, wipeLocal } from './platform/files'
import { bioEnroll, bioRemove, bioStatus, bioUnlock, type BioStatus } from './platform/vaultKey'
import { clearIfDue, copyText } from './platform/clipboard'
import { setScreenshotBlocking } from './platform/privacy'
import { defaultDeviceName, newDeviceId } from './platform/device'
import { loadPrefs, prefs, resetPrefs, savePrefs } from './prefs'
import { watch } from 'vue'
import { diag } from './diag'

export type BackendConfig =
  | { type: 'github'; github: GitHubConfig }
  | { type: 'oss'; oss: OssConfig }

export function makeRemote(cfg: BackendConfig): RemoteStore {
  return cfg.type === 'github' ? new GitHubStore(cfg.github) : new OssStore(cfg.oss)
}

export function backendTitle(cfg: BackendConfig | null): string {
  if (!cfg) return '未开启同步'
  if (cfg.type === 'github') return `GitHub · ${cfg.github.owner}/${cfg.github.repo}`
  return `阿里云 OSS · ${cfg.oss.bucket}/${cfg.oss.prefix || ''}`
}

export type SyncErrorKind = '' | 'network' | 'auth' | 'key' | 'missing' | 'format' | 'other'

export const app = reactive({
  phase: 'loading' as 'loading' | 'setup' | 'locked' | 'unlocked' | 'broken',
  /** 启动失败（本地文件格式更新、损坏）时的说明 */
  fatal: '',
  backend: null as BackendConfig | null,
  sync: {
    running: false,
    /** 上次成功同步的时间 */
    last: 0,
    error: '',
    errorKind: '' as SyncErrorKind,
    /** 本机有修改还没上传 */
    pending: false,
    devices: [] as DeviceInfo[],
    problems: [] as SyncProblem[],
    /** GitHub Token 的过期时间（毫秒），0 表示不会过期或还不知道。快到期时首页提醒 */
    tokenExpires: 0,
  },
  bio: { available: false, reason: 'web' as BioStatus['reason'] },
  /** 刚建立或加入保险库，首页提示开启指纹 */
  offerBio: false,
  toast: '',
  /** app 在前台（主界面里由前后台事件维护） */
  active: true,
  /** 锁屏状态下回到前台的次数：锁屏看到它变了就弹指纹框 */
  foregroundTick: 0,
  /** 指纹框正在显示 */
  bioPrompting: false,
})

/** 当前保险库（不可变对象，整个替换；shallowRef 避免把上千个条目都变成响应式） */
export const vault = shallowRef<VaultState>(emptyVault())

/**
 * 本机记录的“最近使用”时间（条目ID → 毫秒），用于“最近使用”排序。只在本机，不同步；
 * 存在加密的 usage 文件里（哪天用过哪些账号也是隐私），上锁时清掉。
 */
export const usedAt = shallowRef<Record<string, number>>({})

let keys: KeyBundle | null = null
let cipher: VaultCipher | null = null
let syncState: SyncState | null = null
let engine: SyncEngine | null = null
/** 本地修改的计数：同步开始时记下，结束时没变才算“已全部上传” */
let editSeq = 0

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  app.toast = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (app.toast = ''), 2600)
}

// ---------- 本地文件 ----------

async function readEncrypted<T>(name: string): Promise<T | null> {
  const b = await files.read(name)
  return b ? await cipher!.decryptJson<T>(b) : null
}

async function writeEncrypted(name: string, v: unknown): Promise<void> {
  await files.write(name, await cipher!.encryptJson(v))
}

interface LocalVaultFile {
  format: number
  vault: VaultState
  dirty?: boolean
}

/**
 * 本机磁盘上的保险库合并进内存（规格 6.4）。自动填充窗口和主界面是两个独立的网页环境，
 * 一边保存的条目，另一边内存里没有；合并是幂等的，多合并几次没有坏处。
 */
async function mergeFromDisk(): Promise<boolean> {
  if (!cipher) return false
  let disk: LocalVaultFile | null = null
  try {
    disk = await readEncrypted<LocalVaultFile>('vault')
  } catch {
    return false
  }
  if (!disk || disk.format > FORMAT) return false
  const merged = gcTombstones(mergeVaults(vault.value, parseVault(disk.vault).state))
  if (canonicalJson(merged) === canonicalJson(vault.value)) return false
  vault.value = merged
  if (disk.dirty && app.backend) app.sync.pending = true
  return true
}

async function persistVault(): Promise<void> {
  if (!cipher) return
  // 先合并磁盘上的：另一个窗口可能刚写过，直接覆盖会丢掉它的修改
  await mergeFromDisk()
  const file: LocalVaultFile = { format: FORMAT, vault: vault.value, dirty: app.sync.pending }
  await writeEncrypted('vault', file)
}

async function persistConfig(): Promise<void> {
  await writeEncrypted('config', { backend: app.backend })
}

// ---------- 启动、解锁、上锁 ----------

/**
 * 启动。mode 为 'autofill' 时是自动填充窗口（AutofillActivity）：窗口用完就关，每次打开都要重新解锁；
 * 解锁后切走（不管自动上锁设的多久）立即上锁，不会把解开的保险库留在后台。
 */
export async function init(mode: 'main' | 'autofill' = 'main'): Promise<void> {
  await loadPrefs()
  app.bio = await bioStatus()
  const id = await files.read('identity')
  app.phase = id && prefs.recipient ? 'locked' : 'setup'
  watch(() => prefs.blockScreenshots, (on) => void setScreenshotBlocking(on), { immediate: true })
  installLifecycle(mode)
}

async function openWith(k: KeyBundle): Promise<void> {
  if (prefs.recipient && k.recipient !== prefs.recipient) {
    // 换密钥（重新加入）时身份密钥已经写好、公钥设置还没存上 app 就被杀了：
    // 本机保险库能用这把密钥解开，说明它就是本机现在的密钥，补上公钥设置
    const b = await files.read('vault')
    let ok = false
    if (b) {
      try {
        await new VaultCipher(k).decrypt(b)
        ok = true
      } catch { /* 解不开 */ }
    }
    if (!ok) throw new Error('这把密钥不属于本机的保险库')
    prefs.recipient = k.recipient
    await savePrefs()
    diag('本机公钥和身份密钥不一致（上次换密钥没做完），已修正')
  }
  keys = k
  cipher = new VaultCipher(k)
  let v = emptyVault()
  let dirty = false
  const local = await readEncrypted<LocalVaultFile>('vault')
  if (local) {
    if (local.format > FORMAT) throw new FormatTooNewError(local.format)
    v = parseVault(local.vault).state
    dirty = !!local.dirty
  }
  const cfg = await readEncrypted<{ backend: BackendConfig | null }>('config')
  syncState = await readEncrypted<SyncState>('syncstate')
  vault.value = gcTombstones(v)
  usedAt.value = await readUsage()
  await loadIcons()
  app.backend = cfg?.backend ?? null
  app.sync.pending = dirty
  app.sync.devices = Object.values(syncState?.devices ?? {})
  app.sync.last = syncState?.lastSync ?? 0
  app.sync.error = ''
  app.sync.errorKind = ''
  engine = new SyncEngine(host)
  hiddenAt = 0
  app.phase = 'unlocked'
  diag('解锁')
  requestSync(0)
}

/** 主密码解锁（scrypt 较慢，手机上要一两秒） */
export async function unlockWithPassword(passphrase: string): Promise<void> {
  const wrapped = await files.read('identity')
  if (!wrapped) throw new Error('本机没有保险库')
  await openWith(await unwrapIdentity(wrapped, passphrase))
}

export async function unlockWithBio(): Promise<void> {
  if (!prefs.bioData) throw new Error('还没有开启指纹解锁')
  let identity: string
  try {
    identity = await bioUnlock(prefs.bioData)
  } catch (e) {
    if ((e as { code?: string }).code === 'INVALIDATED') {
      prefs.bioData = ''
      await bioRemove()
    }
    throw e
  }
  const recipient = await identityToRecipient(identity)
  const wrapped = await files.read('identity')
  if (!wrapped) throw new Error('本机没有保险库')
  await openWith({ identity, recipient, wrapped })
}

export function lock(): void {
  if (app.phase !== 'unlocked') return
  diag('上锁')
  clearTimeout(syncTimer)
  clearTimeout(retryTimer)
  keys = null
  cipher = null
  syncState = null
  engine = null
  vault.value = emptyVault()
  usedAt.value = {}
  stopIcons()
  app.phase = 'locked'
}

// ---------- 上锁时没保存的编辑 ----------

/**
 * 编辑到一半切走、被上锁了：表单加密给保险库公钥（加密不需要私钥，上锁后也能做）放在内存里，
 * 解锁回到同一个编辑页时解开恢复。只在内存里，app 被系统杀掉就没了。
 */
let draftStash: { key: string; data: Uint8Array } | null = null

export async function stashDraft(key: string, value: unknown): Promise<void> {
  draftStash = null
  if (!prefs.recipient) return
  const data = await new VaultCipher({ identity: '', recipient: prefs.recipient }).encryptJson(value)
  draftStash = { key, data }
}

/** 取回 key 对应的草稿（取一次就删）；没有、或者解不开时返回 null */
export async function takeDraft<T>(key: string): Promise<T | null> {
  const s = draftStash
  if (!s || s.key !== key || !cipher) return null
  draftStash = null
  try {
    return await cipher.decryptJson<T>(s.data)
  } catch {
    return null
  }
}

// ---------- 建立与加入 ----------

async function ensureDevice(): Promise<void> {
  if (!prefs.deviceId) prefs.deviceId = newDeviceId()
  if (!prefs.deviceName) prefs.deviceName = await defaultDeviceName()
}

/** 检查后端配置：能访问、权限够；返回云端有没有保险库 */
export async function probeBackend(cfg: BackendConfig): Promise<Probe> {
  const r = makeRemote(cfg)
  await r.test?.()
  return probeRemote(r)
}

/** 新建保险库。backend 不为空时同时在云端建立（云端必须是空的） */
export async function setupNew(passphrase: string, backend: BackendConfig | null): Promise<void> {
  await ensureDevice()
  const k = await createKeys(passphrase)
  if (backend) await initRemote(makeRemote(backend), k)
  await files.write('identity', k.wrapped)
  prefs.recipient = k.recipient
  await savePrefs()
  keys = k
  cipher = new VaultCipher(k)
  vault.value = emptyVault()
  app.backend = backend
  syncState = null
  await persistConfig()
  await persistVault()
  await openWith(k)
  app.offerBio = app.bio.available
}

/** 加入已有保险库：下载 identity.age，用主密码解开 */
export async function setupJoin(passphrase: string, backend: BackendConfig): Promise<void> {
  await ensureDevice()
  const k = await joinRemote(makeRemote(backend), passphrase)
  await files.write('identity', k.wrapped)
  prefs.recipient = k.recipient
  await savePrefs()
  keys = k
  cipher = new VaultCipher(k)
  vault.value = emptyVault()
  app.backend = backend
  syncState = null
  await persistConfig()
  await persistVault()
  await openWith(k)
  app.offerBio = app.bio.available
}

// ---------- 编辑 ----------

const ctx = () => ({ device: prefs.deviceId })

async function commit(next: VaultState): Promise<void> {
  if (next === vault.value) return
  vault.value = next
  editSeq++
  app.sync.pending = !!app.backend
  await persistVault()
  requestSync(3000)
}

export async function addItem(content: ItemContent): Promise<string> {
  const r = createItem(vault.value, content, ctx())
  await commit(r.state)
  return r.id
}

export async function saveItem(id: string, patch: Partial<ItemContent>): Promise<void> {
  await commit(updateItem(vault.value, id, patch, ctx()))
}

export async function removeItem(id: string): Promise<void> {
  await commit(deleteItem(vault.value, id, ctx()))
}

export async function restore(id: string): Promise<void> {
  await commit(restoreItem(vault.value, id, ctx()))
}

export async function purge(id: string): Promise<void> {
  await commit(purgeItem(vault.value, id, ctx()))
}

export async function revert(id: string, rev: Rev): Promise<void> {
  await commit(revertTo(vault.value, id, rev, ctx()))
}

/** 批量导入（CSV）。标题、用户名、密码、网址都相同的条目跳过；原来的分组按名字放进目录（没有就新建） */
export async function importItems(items: ImportedItem[]): Promise<{ added: number; duplicates: number }> {
  const key = (c: Partial<ItemContent>) => JSON.stringify([c.title ?? '', c.username ?? '', c.password ?? '', (c.urls ?? [])[0] ?? '', c.notes ?? ''])
  const seen = new Set(Object.values(vault.value.items).filter((i) => !i.deleted).map(key))
  let s = vault.value
  let added = 0
  let duplicates = 0
  const folderIds = new Map(liveFolders(s.folders).map((f) => [f.name.trim().toLowerCase(), f.id]))
  for (const { folderName, ...c } of items) {
    const k = key(c)
    if (seen.has(k)) {
      duplicates++
      continue
    }
    seen.add(k)
    const fname = folderName?.trim().slice(0, 20)
    if (fname) {
      let fid = folderIds.get(fname.toLowerCase())
      if (!fid) {
        const r = createFolder(s, fname, ctx())
        s = r.state
        fid = r.id
        folderIds.set(fname.toLowerCase(), fid)
      }
      c.folder = fid
    }
    s = createItem(s, c, ctx()).state
    added++
  }
  await commit(s)
  return { added, duplicates }
}

// ---------- 目录 ----------

export async function addFolder(name: string): Promise<string> {
  const r = createFolder(vault.value, name, ctx())
  await commit(r.state)
  return r.id
}

export async function renameFolderById(id: string, name: string): Promise<void> {
  await commit(renameFolder(vault.value, id, name, ctx()))
}

export async function removeFolder(id: string): Promise<void> {
  await commit(deleteFolder(vault.value, id, ctx()))
}

/** 把目录拖到第 to 个位置（同步到其他设备） */
export async function moveFolderTo(id: string, to: number): Promise<void> {
  await commit(moveFolder(vault.value, id, to, ctx()))
}

// ---------- 最近使用（本机） ----------

interface UsageFile {
  format: 1
  used: Record<string, number>
}
const MAX_USAGE = 3000

async function readUsage(): Promise<Record<string, number>> {
  try {
    const f = await readEncrypted<UsageFile>('usage')
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(f?.used ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

/**
 * 记一次使用（打开详情、自动填充选中）。自动填充窗口和主界面各写各的：写之前先读磁盘上的取较大值，
 * 不会互相覆盖。顺手清掉已经不存在的条目，最多留 MAX_USAGE 条。
 */
export async function markUsed(id: string): Promise<void> {
  if (!cipher || !vault.value.items[id]) return
  const now = Date.now()
  usedAt.value = { ...usedAt.value, [id]: now }
  try {
    const disk = await readUsage()
    const merged: Record<string, number> = { ...disk }
    for (const [k, v] of Object.entries(usedAt.value)) if (!(merged[k] >= v)) merged[k] = v
    const live = Object.entries(merged)
      .filter(([k]) => vault.value.items[k] && !vault.value.items[k].purged)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_USAGE)
    if (!cipher) return
    const used = Object.fromEntries(live)
    usedAt.value = used
    await writeEncrypted('usage', { format: 1, used } satisfies UsageFile)
  } catch { /* 只影响排序，写不进去就算了 */ }
}

// ---------- 网站图标（规格 5.9，设置里开启） ----------

/** 主机 → 图标的 data: 地址（界面用）；取不到的不在这里 */
export const siteIcons = shallowRef<Record<string, string>>({})
let iconCache: Record<string, IconEntry> = {}
/** 上锁、关掉开关时加一，正在进行的取图标作废 */
let iconGen = 0
const iconQueue = new Set<string>()
let iconWorkers = 0
let iconSaveTimer: ReturnType<typeof setTimeout> | undefined

function publishIcons() {
  const out: Record<string, string> = {}
  for (const [h, e] of Object.entries(iconCache)) if (e.data) out[h] = e.data
  siteIcons.value = out
}

async function loadIcons(): Promise<void> {
  iconCache = {}
  if (!prefs.siteIcons) return publishIcons()
  try {
    const f = await readEncrypted<{ format: 1; icons: Record<string, IconEntry> }>('icons')
    for (const [h, e] of Object.entries(f?.icons ?? {})) {
      if (e && typeof e.at === 'number' && (e.data === undefined || (typeof e.data === 'string' && e.data.startsWith('data:image/')))) iconCache[h] = e
    }
  } catch { /* 缓存坏了就重新取 */ }
  publishIcons()
}

function saveIconsSoon() {
  clearTimeout(iconSaveTimer)
  iconSaveTimer = setTimeout(() => {
    if (!cipher || !prefs.siteIcons) return
    // 只留还有条目用到的网站
    const used = new Set(liveItemHosts())
    const icons = Object.fromEntries(Object.entries(iconCache).filter(([h]) => used.has(h)))
    void writeEncrypted('icons', { format: 1, icons }).catch(() => {})
  }, 1500)
}

/** 条目第一个网址的主机（列表头像用的就是它） */
function liveItemHosts(): string[] {
  const out = new Set<string>()
  for (const it of Object.values(vault.value.items)) {
    if (it.deleted || !it.urls?.[0]) continue
    const h = hostOf(it.urls[0])
    if (h) out.add(h)
  }
  return [...out]
}

/** 列表里看得到的网站：没取过（或该重新取）的排进队列，最多同时取 3 个，只在主界面里取 */
export function wantIcons(hosts: string[]): void {
  if (!prefs.siteIcons || !cipher || lifecycleMode !== 'main') return
  const now = Date.now()
  for (const h of hosts) if (iconHostAllowed(h) && iconDue(iconCache[h], now)) iconQueue.add(h)
  while (iconWorkers < 3 && iconQueue.size) void iconWorker(iconGen)
}

async function iconWorker(gen: number): Promise<void> {
  iconWorkers++
  try {
    while (iconQueue.size && gen === iconGen) {
      const host = iconQueue.values().next().value as string
      iconQueue.delete(host)
      const data = await fetchIcon(host, http)
      if (gen !== iconGen || !cipher) return
      const old = iconCache[host]
      iconCache = { ...iconCache, [host]: { data: data ?? old?.data, at: Date.now() } }
      if (data && data !== old?.data) publishIcons()
      saveIconsSoon()
    }
  } finally {
    iconWorkers--
  }
}

function stopIcons() {
  iconGen++
  iconQueue.clear()
  clearTimeout(iconSaveTimer)
  iconCache = {}
  siteIcons.value = {}
}

/** 开关网站图标。关掉时删掉本机的图标缓存 */
export async function setSiteIcons(on: boolean): Promise<void> {
  prefs.siteIcons = on
  await savePrefs()
  stopIcons()
  if (on) {
    await loadIcons()
    wantIcons(liveItemHosts())
  } else await files.remove('icons').catch(() => {})
}

// ---------- 自动填充（规格 5.8） ----------

/** 记住：以后在这个 app 里优先推荐这一条 */
export async function rememberApp(id: string, pkg: string): Promise<void> {
  const it = vault.value.items[id]
  if (!it || !pkg) return
  const apps = Array.isArray(it.apps) ? (it.apps as string[]) : []
  if (apps.includes(pkg)) return
  await saveItem(id, { apps: [...apps, pkg] })
}

export async function forgetApp(id: string, pkg: string): Promise<void> {
  const it = vault.value.items[id]
  if (!it || !Array.isArray(it.apps)) return
  const apps = (it.apps as string[]).filter((p) => p !== pkg)
  await saveItem(id, { apps: apps.length ? apps : undefined })
}

/** 登录后保存：更新已有条目的账号密码，或新建一条 */
export async function saveCredential(c: { updateId?: string; title: string; username?: string; password: string; url?: string; app?: string }): Promise<string> {
  if (c.updateId && vault.value.items[c.updateId]) {
    const patch: Partial<ItemContent> = { password: c.password }
    if (c.username) patch.username = c.username
    await saveItem(c.updateId, patch)
    if (c.app) await rememberApp(c.updateId, c.app)
    return c.updateId
  }
  return addItem({
    type: 'login',
    title: c.title.trim() || '未命名',
    ...(c.username ? { username: c.username } : {}),
    password: c.password,
    ...(c.url ? { urls: [c.url] } : {}),
    ...(c.app ? { apps: [c.app] } : {}),
  })
}

/** 自动填充窗口关掉前尽量把修改传上去，最多等 ms 毫秒；没传完的下次打开金匮时会补传 */
export async function syncBeforeClose(ms = 5000): Promise<void> {
  if (!app.backend || !app.sync.pending) return
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, ms))])
}

export async function copySecret(text: string, label = '密码'): Promise<void> {
  await copyText(text, true, prefs.clipboardSec)
  toast(prefs.clipboardSec ? `已复制${label}，${prefs.clipboardSec} 秒后清空剪贴板` : `已复制${label}`)
}

export async function copyPlain(text: string, label: string): Promise<void> {
  await copyText(text, false, 0)
  toast(`已复制${label}`)
}

// ---------- 同步 ----------

const host: SyncHost = {
  get device() {
    return { id: prefs.deviceId, name: prefs.deviceName }
  },
  get cipher() {
    if (!cipher) throw new Error('已上锁')
    return cipher
  },
  current: () => vault.value,
  async merge(remote) {
    // 同步进行到一半时上锁了：不能再把云端解开的条目放回内存
    if (!cipher) throw new Error('已上锁')
    vault.value = gcTombstones(mergeVaults(vault.value, remote))
    await persistVault()
  },
  async loadSyncState() {
    return syncState
  },
  async saveSyncState(_id, s) {
    syncState = s
    await writeEncrypted('syncstate', s)
  },
}

let syncTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retries = 0
const BACKOFF = [10, 30, 120, 300]

export function requestSync(delayMs: number) {
  clearTimeout(syncTimer)
  if (app.phase !== 'unlocked' || !app.backend) return
  syncTimer = setTimeout(() => void syncNow(), delayMs)
}

function classify(e: unknown): SyncErrorKind {
  if (e instanceof KeyMismatchError) return 'key'
  if (e instanceof NotInitializedError) return 'missing'
  if (e instanceof FormatTooNewError) return 'format'
  if (e instanceof RemoteError) {
    if (e.status === 401 || e.status === 403 || e.status === 404) return 'auth'
    return e.retryable ? 'network' : 'other'
  }
  return 'other'
}

/** 正在进行的同步 */
let inflight: Promise<boolean> | null = null

/**
 * 立即同步，返回是否成功。已经在同步时等它结束；那一轮开始后又有新的修改，就接着再同步一次
 * （以前直接返回“成功”，自动填充窗口关闭前、离开即上锁前的那次同步可能漏掉最新的修改）。
 */
export async function syncNow(): Promise<boolean> {
  if (inflight) {
    const ok = await inflight
    if (!ok || !app.sync.pending) return ok
  }
  if (app.phase !== 'unlocked' || !app.backend || !engine) return false
  // 等待的几个调用者里，第一个已经开始了新的一轮
  if (inflight) return inflight
  inflight = runSync().finally(() => (inflight = null))
  return inflight
}

async function runSync(): Promise<boolean> {
  clearTimeout(syncTimer)
  clearTimeout(retryTimer)
  const backend = app.backend!
  const eng = engine!
  const seq = editSeq
  app.sync.running = true
  try {
    const remote = makeRemote(backend)
    if (prefs.keyUploadPending && keys) {
      await uploadWrappedKey(remote, keys)
      prefs.keyUploadPending = false
      await savePrefs()
    }
    const r = await eng.sync(remote)
    if (app.backend !== backend || engine !== eng) return false
    app.sync.problems = r.problems
    app.sync.devices = Object.values(syncState?.devices ?? {})
    app.sync.last = Date.now()
    app.sync.error = ''
    app.sync.errorKind = ''
    app.sync.tokenExpires = remote.credentialExpiry ?? 0
    if (editSeq === seq && app.sync.pending) {
      app.sync.pending = false
      await persistVault()
    }
    retries = 0
    return true
  } catch (e) {
    // 上锁了、或者同步期间换了后端：这一轮的结果作废，不算出错
    if (app.phase !== 'unlocked' || app.backend !== backend || engine !== eng) return false
    const kind = classify(e)
    app.sync.errorKind = kind
    app.sync.error = (e as Error).message
    if (kind === 'network') {
      const s = BACKOFF[Math.min(retries++, BACKOFF.length - 1)]
      retryTimer = setTimeout(() => void syncNow(), s * 1000)
    }
    return false
  } finally {
    app.sync.running = false
  }
}

/**
 * 更换同步后端（或第一次开启）。云端是空的就在那里建立保险库；
 * 已经有同一把密钥的保险库就直接接上；有另一个保险库则拒绝。
 */
export async function setBackend(cfg: BackendConfig | null): Promise<void> {
  if (!keys) throw new Error('已上锁')
  if (cfg) {
    const remote = makeRemote(cfg)
    await remote.test?.()
    const p = await probeRemote(remote)
    if (p.initialized) {
      const info = await remote.get(KEY_INFO)
      if (!info || parseKeyInfo(info).recipient !== keys.recipient) throw new OtherVaultError()
    } else {
      const wrapped = (await files.read('identity'))!
      await initRemote(remote, { ...keys, wrapped })
    }
  }
  app.backend = cfg
  syncState = null
  await files.remove('syncstate')
  resetSyncStatus()
  app.sync.pending = !!cfg
  await persistConfig()
  await persistVault()
  if (cfg) await syncNow()
}

/** 开启同步时，那里已经有另一个保险库（密钥不同）。界面上让用户输入它的主密码，用 joinOtherVault 加入并合并 */
export class OtherVaultError extends Error {
  constructor() {
    super('这里已经有另一个保险库（密钥不同）')
  }
}

function resetSyncStatus() {
  app.sync.devices = []
  app.sync.problems = []
  app.sync.error = ''
  app.sync.errorKind = ''
  app.sync.tokenExpires = 0
}

/**
 * 换成云端那个保险库的密钥（重新加入、加入另一个保险库）：本机的条目用新密钥重新加密，再同步合并过去，不丢。
 *
 * 防止中途被杀导致本机文件解不开，顺序是：
 * 1. 关掉指纹（指纹里存的是旧密钥）；
 * 2. 本机保险库、同步配置先加密给新旧两把公钥——此后不管磁盘上的身份密钥是哪一把都能解开；
 * 3. 写新的身份密钥和公钥设置（两者之间被杀，下次解锁时 openWith 会补上公钥设置）；
 * 4. 再按新密钥正常保存、同步。
 */
async function switchKeys(k: KeyBundle, backend: BackendConfig): Promise<void> {
  if (!keys || !cipher) throw new Error('已上锁')
  if (k.recipient === keys.recipient) {
    // 其实是同一个保险库（例如云端只是改过主密码）：只更新身份密钥文件
    await files.write('identity', k.wrapped)
    keys = k
  } else {
    prefs.bioData = ''
    await savePrefs()
    await bioRemove()
    await mergeFromDisk()
    const both = [keys.recipient, k.recipient]
    await files.write('vault', await encryptJsonTo(both, { format: FORMAT, vault: vault.value, dirty: true } satisfies LocalVaultFile))
    await files.write('config', await encryptJsonTo(both, { backend }))
    await files.remove('syncstate')
    await files.write('identity', k.wrapped)
    prefs.recipient = k.recipient
    await savePrefs()
    keys = k
    cipher = new VaultCipher(k)
    // 上锁前暂存的编辑草稿是加密给旧公钥的
    draftStash = null
    // 本机的使用记录、图标缓存也换成新密钥加密（写不进去只影响排序和图标）
    await writeEncrypted('usage', { format: 1, used: usedAt.value }).catch(() => {})
    saveIconsSoon()
    diag('换成云端保险库的密钥')
  }
  prefs.keyUploadPending = false
  await savePrefs()
  app.backend = backend
  syncState = null
  resetSyncStatus()
  await persistConfig()
  app.sync.pending = true
  await persistVault()
  app.offerBio = app.bio.available && !prefs.bioData
  await syncNow()
}

/**
 * 开启同步（或换位置）时那里已经有另一个保险库：用它的主密码加入，本机的条目合并过去。
 * 以后本机的主密码就是那个保险库的主密码。
 */
export async function joinOtherVault(cfg: BackendConfig, passphrase: string): Promise<void> {
  const remote = makeRemote(cfg)
  await remote.test?.()
  await switchKeys(await joinRemote(remote, passphrase), cfg)
}

/** 云端的保险库被删了：用本机的密钥在原处重新建立，再上传 */
export async function rebuildRemote(): Promise<void> {
  if (!keys || !app.backend) return
  const wrapped = (await files.read('identity'))!
  await initRemote(makeRemote(app.backend), { ...keys, wrapped })
  syncState = null
  await syncNow()
}

/**
 * 云端换了密钥（别的设备“重新建立”过）：用云端的主密码重新加入，本机的数据合并过去，不丢。
 */
export async function rejoin(passphrase: string): Promise<void> {
  if (!app.backend) return
  await switchKeys(await joinRemote(makeRemote(app.backend), passphrase), app.backend)
}

export async function removeDevice(id: string): Promise<void> {
  if (!engine || !app.backend) return
  await engine.removeDevice(makeRemote(app.backend), id)
  app.sync.devices = Object.values(syncState?.devices ?? {})
}

export async function renameDevice(name: string): Promise<void> {
  const n = name.trim().slice(0, 40)
  if (!n || n === prefs.deviceName) return
  prefs.deviceName = n
  await savePrefs()
  requestSync(0)
}

// ---------- 主密码、指纹 ----------

/** 核对主密码（不改变解锁状态） */
export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  const wrapped = await files.read('identity')
  if (!wrapped) return false
  try {
    await unwrapIdentity(wrapped, passphrase)
    return true
  } catch (e) {
    if (e instanceof WrongPassphraseError) return false
    throw e
  }
}

/** 生成加入码（同步配置用主密码加密），先核对主密码：加入码要用同一个主密码才能在新设备上解开 */
export async function createJoinCode(passphrase: string): Promise<string> {
  if (!keys || !app.backend) throw new Error('还没有开启同步')
  if (!(await verifyPassphrase(passphrase))) throw new WrongPassphraseError()
  return makeJoinCode(app.backend, passphrase)
}

export async function changeMasterPassword(oldPass: string, newPass: string): Promise<void> {
  if (!keys) throw new Error('已上锁')
  const wrapped = (await files.read('identity'))!
  await unwrapIdentity(wrapped, oldPass) // 旧密码不对会抛“主密码不对”
  const k = await rewrap(keys, newPass)
  await files.write('identity', k.wrapped)
  keys = k
  if (app.backend) {
    prefs.keyUploadPending = true
    await savePrefs()
    await syncNow()
  }
}

export async function enableBio(): Promise<void> {
  if (!keys) throw new Error('已上锁')
  // 部分手机弹出指纹框时 app 会收到“切到后台”，这期间不算离开
  setBioPrompting(true)
  try {
    prefs.bioData = await bioEnroll(keys.identity)
  } finally {
    setBioPrompting(false)
  }
  await savePrefs()
}

export async function disableBio(): Promise<void> {
  prefs.bioData = ''
  await savePrefs()
  await bioRemove()
}

/** 抹掉本机的全部数据（云端不动）。之后回到“建立或加入” */
export async function wipeDevice(): Promise<void> {
  lock()
  draftStash = null
  await bioRemove()
  await wipeLocal()
  await resetPrefs()
  app.backend = null
  app.sync.pending = false
  app.phase = 'setup'
}

// ---------- 导出 ----------

/** 导出用的明文 JSON（加密备份的内容） */
export function backupJson(): Uint8Array {
  return utf8(JSON.stringify({ format: FORMAT, exported: new Date().toISOString(), vault: vault.value }, null, 1))
}

// ---------- 前后台 ----------

let hiddenAt = 0
/**
 * 调起系统界面（分享、选文件、开启指纹、安装更新、自动填充设置）时 app 会切到后台，这一次回来不上锁。
 * 记的是到期时间而不是开关：1.0.3 以前用开关，选文件那里靠网页的 focus 事件关掉它，
 * 安卓 WebView 不一定发这个事件，开关一直开着，之后每次离开都不上锁。现在：
 * - 只管下一次离开：回到前台时就作废；
 * - 最多 2 分钟，到点自动作废。
 */
let externalUntil = 0
/** 这一次离开开始时，是不是在调起系统界面或者弹指纹框 */
let hideWasExternal = false

export function expectExternal(maxMs = 120_000): () => void {
  const until = Date.now() + maxMs
  externalUntil = until
  diag('调起系统界面，下一次离开不上锁')
  return () => {
    if (externalUntil === until) externalUntil = 0
  }
}

/** 锁屏、开启指纹时弹出指纹框的期间（部分手机弹指纹框时 app 会收到“切到后台”，不能当成离开） */
export function setBioPrompting(on: boolean) {
  app.bioPrompting = on
}

/**
 * 切到后台（规格 6.4）。自动上锁设为“立即”时，离开就当作退出：先把没上传的修改传完，再上锁、清掉内存里的明文。
 */
function onHide() {
  app.active = false
  hideWasExternal = externalUntil > Date.now() || app.bioPrompting
  if (lifecycleMode === 'main') diag(`切到后台（${app.phase}${hideWasExternal ? '，调起系统界面 / 指纹框，不算离开' : ''}）`)
  if (app.phase !== 'unlocked' || hideWasExternal) return
  hiddenAt = Date.now()
  if (lockDelayMs() === 0) void lockAfterSync()
  else if (app.sync.pending) void syncNow()
}

/** 离开即上锁前，最多等多久把修改传完（网络很慢时不能一直不锁；没传完的已经记在本地，下次解锁后补传） */
const LOCK_SYNC_WAIT_MS = 8000

async function lockAfterSync() {
  if (app.sync.pending || inflight) {
    await Promise.race([syncNow().catch(() => false), new Promise((r) => setTimeout(r, LOCK_SYNC_WAIT_MS))])
  }
  // 同步期间用户已经回来了（hiddenAt 被清零）就不锁；回来时 onShow 会按规则处理
  if (hiddenAt && app.phase === 'unlocked') {
    diag('离开即上锁')
    lock()
  }
}

function onShow() {
  app.active = true
  const wasExternal = hideWasExternal
  hideWasExternal = false
  // 调起系统界面的那一次离开已经过去了：作废，下次离开照常上锁
  if (wasExternal) externalUntil = 0
  if (lifecycleMode === 'main') diag(`回到前台（${app.phase}${wasExternal ? '，从系统界面 / 指纹框回来' : ''}）`)
  void clearIfDue()
  if (app.phase !== 'unlocked') {
    // 锁屏状态下回到前台：通知锁屏弹指纹框（锁屏可能是在后台出现的，那时弹不出来）
    if (!wasExternal) app.foregroundTick++
    return
  }
  const away = Date.now() - hiddenAt
  if (hiddenAt && away >= lockDelayMs()) {
    hiddenAt = 0
    diag('离开超过设定时间，上锁')
    lock()
    return
  }
  hiddenAt = 0
  // 离开期间自动填充窗口可能保存过条目
  if (lifecycleMode === 'main') void mergeFromDisk().then(() => requestSync(0))
}

/** 离开多久后上锁：自动填充窗口总是立即 */
const lockDelayMs = () => (lifecycleMode === 'autofill' ? 0 : prefs.autoLockSec * 1000)

let lifecycleMode: 'main' | 'autofill' | '' = ''
function installLifecycle(mode: 'main' | 'autofill') {
  if (lifecycleMode) return
  lifecycleMode = mode
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('pause', onHide)
    void CapApp.addListener('resume', onShow)
  } else {
    document.addEventListener('visibilitychange', () => (document.hidden ? onHide() : onShow()))
  }
}
