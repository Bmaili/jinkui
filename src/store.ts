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
  KEY_INFO, VaultCipher, WrongPassphraseError, changePassphrase as rewrap, createKeys, parseKeyInfo, unwrapIdentity, type KeyBundle,
} from './core/crypto'
import { identityToRecipient } from 'age-encryption'
import { canonicalJson, type ItemContent } from './core/item'
import { GitHubStore, type GitHubConfig } from './core/sync/github'
import { OssStore, type OssConfig } from './core/sync/oss'
import { RemoteError, type RemoteStore } from './core/sync/remote'
import { KeyMismatchError, NotInitializedError, SyncEngine, type SyncHost, type SyncProblem, type SyncState } from './core/sync/engine'
import type { DeviceInfo } from './core/sync/deviceFile'
import { initRemote, joinRemote, probeRemote, uploadWrappedKey, type Probe } from './core/sync/setup'
import {
  FORMAT, FormatTooNewError, createFolder, createItem, deleteFolder, deleteItem, emptyVault, gcTombstones, mergeVaults, parseVault,
  purgeItem, renameFolder, restoreItem, revertTo, updateItem, type VaultState,
} from './core/vault'
import { liveFolders } from './core/folders'
import type { ImportedItem } from './core/csv'
import type { Rev } from './core/rev'
import { files, wipeLocal } from './platform/files'
import { bioEnroll, bioRemove, bioStatus, bioUnlock, type BioStatus } from './platform/vaultKey'
import { clearIfDue, copyText } from './platform/clipboard'
import { setScreenshotBlocking } from './platform/privacy'
import { defaultDeviceName, newDeviceId } from './platform/device'
import { loadPrefs, prefs, resetPrefs, savePrefs } from './prefs'
import { watch } from 'vue'

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
  },
  bio: { available: false, reason: 'web' as BioStatus['reason'] },
  /** 刚建立或加入保险库，首页提示开启指纹 */
  offerBio: false,
  toast: '',
})

/** 当前保险库（不可变对象，整个替换；shallowRef 避免把上千个条目都变成响应式） */
export const vault = shallowRef<VaultState>(emptyVault())

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
 * 启动。mode 为 'autofill' 时是自动填充窗口（AutofillActivity）：不装前后台的自动上锁逻辑，
 * 窗口用完就关，每次打开都要重新解锁。
 */
export async function init(mode: 'main' | 'autofill' = 'main'): Promise<void> {
  await loadPrefs()
  app.bio = await bioStatus()
  const id = await files.read('identity')
  app.phase = id && prefs.recipient ? 'locked' : 'setup'
  watch(() => prefs.blockScreenshots, (on) => void setScreenshotBlocking(on), { immediate: true })
  if (mode === 'main') installLifecycle()
}

async function openWith(k: KeyBundle): Promise<void> {
  if (prefs.recipient && k.recipient !== prefs.recipient) throw new Error('这把密钥不属于本机的保险库')
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
  app.backend = cfg?.backend ?? null
  app.sync.pending = dirty
  app.sync.devices = Object.values(syncState?.devices ?? {})
  app.sync.last = syncState?.lastSync ?? 0
  app.sync.error = ''
  app.sync.errorKind = ''
  engine = new SyncEngine(host)
  hiddenAt = 0
  app.phase = 'unlocked'
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
  clearTimeout(syncTimer)
  clearTimeout(retryTimer)
  keys = null
  cipher = null
  syncState = null
  engine = null
  vault.value = emptyVault()
  app.phase = 'locked'
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

/** 立即同步。返回是否成功 */
export async function syncNow(): Promise<boolean> {
  if (app.phase !== 'unlocked' || !app.backend || !engine) return false
  if (app.sync.running) return true
  clearTimeout(syncTimer)
  clearTimeout(retryTimer)
  const backend = app.backend
  const seq = editSeq
  app.sync.running = true
  try {
    const remote = makeRemote(backend)
    if (prefs.keyUploadPending && keys) {
      await uploadWrappedKey(remote, keys)
      prefs.keyUploadPending = false
    }
    const r = await engine.sync(remote)
    if (app.backend !== backend) return false
    app.sync.problems = r.problems
    app.sync.devices = Object.values(syncState?.devices ?? {})
    app.sync.last = Date.now()
    app.sync.error = ''
    app.sync.errorKind = ''
    if (editSeq === seq && app.sync.pending) {
      app.sync.pending = false
      await persistVault()
    }
    retries = 0
    return true
  } catch (e) {
    if (app.phase !== 'unlocked') return false
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
      if (!info || parseKeyInfo(info).recipient !== keys.recipient) {
        throw new Error('这里已经有另一个保险库（密钥不同）。请换一个空的仓库或路径前缀，或者在本机抹掉数据后用“加入已有保险库”')
      }
    } else {
      const wrapped = (await files.read('identity'))!
      await initRemote(remote, { ...keys, wrapped })
    }
  }
  app.backend = cfg
  syncState = null
  await files.remove('syncstate')
  app.sync.devices = []
  app.sync.problems = []
  app.sync.error = ''
  app.sync.errorKind = ''
  app.sync.pending = !!cfg
  await persistConfig()
  await persistVault()
  if (cfg) await syncNow()
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
  const k = await joinRemote(makeRemote(app.backend), passphrase)
  keys = k
  cipher = new VaultCipher(k)
  await files.write('identity', k.wrapped)
  prefs.recipient = k.recipient
  prefs.bioData = ''
  await bioRemove()
  syncState = null
  await files.remove('syncstate')
  await persistConfig()
  app.sync.pending = true
  await persistVault()
  await syncNow()
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
  // 部分手机弹出指纹框时 app 会收到“切到后台”，这一次不上锁
  const done = expectExternal()
  try {
    prefs.bioData = await bioEnroll(keys.identity)
  } finally {
    setTimeout(done, 1500)
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
/** 调起系统界面（分享、安装更新、选文件）时会切到后台，这一次回来不上锁 */
let external = false

export function expectExternal(): () => void {
  external = true
  return () => {
    external = false
  }
}

/**
 * 切到后台（规格 6.4）。自动上锁设为“立即”时，离开就当作退出：先把没上传的修改传完，再上锁、清掉内存里的明文。
 * 调起系统分享、选文件、指纹框、安装更新时不算离开（expectExternal）。
 */
function onHide() {
  if (app.phase !== 'unlocked' || external) return
  hiddenAt = Date.now()
  if (prefs.autoLockSec === 0) void lockAfterSync()
  else if (app.sync.pending) void syncNow()
}

async function lockAfterSync() {
  if (app.sync.pending) await syncNow().catch(() => false)
  // 同步期间用户已经回来了（hiddenAt 被清零）就不锁；回来时 onShow 会按规则处理
  if (hiddenAt && app.phase === 'unlocked' && !external) lock()
}

function onShow() {
  void clearIfDue()
  if (app.phase !== 'unlocked') return
  const away = Date.now() - hiddenAt
  if (hiddenAt && !external && away >= prefs.autoLockSec * 1000) {
    hiddenAt = 0
    lock()
    return
  }
  hiddenAt = 0
  // 离开期间自动填充窗口可能保存过条目
  void mergeFromDisk().then(() => requestSync(0))
}

let lifecycle = false
function installLifecycle() {
  if (lifecycle) return
  lifecycle = true
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('pause', onHide)
    void CapApp.addListener('resume', onShow)
  } else {
    document.addEventListener('visibilitychange', () => (document.hidden ? onHide() : onShow()))
  }
}
