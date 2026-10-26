/**
 * 电脑端 Chrome 扩展的核心（规格 10）：和手机共用 src/core 的加密、合并、同步、匹配，只是换了存储和生命周期。
 *
 * - 扩展是保险库里的一台普通设备：用手机生成的加入码 + 主密码加入，只写自己的 devices/<设备ID>.age。
 * - 本地文件（chrome.storage.local，经过 SlotStore 双槽写入）：identity（主密码加密的保险库密钥）、
 *   vault / config / syncstate（加密给保险库公钥）。和手机一样，磁盘上没有任何能不输主密码就解开的东西。
 * - 解锁后，保险库密钥放在 chrome.storage.session：只在内存里，关掉 Chrome 就没了，网页里的内容脚本读不到。
 *   后台（service worker）随时可能被 Chrome 停掉，醒来时从这里恢复。闲置超过设定时间（默认 4 小时）上锁。
 * - 登录后要保存的账号密码也只放在 storage.session 里，10 分钟过期。
 *
 * 这里不碰 chrome.* 之外的平台细节：Kv 由 background.ts 接到 chrome.storage，测试里用内存实现。
 */
import { identityToRecipient } from 'age-encryption'
import { fromBase64, toBase64 } from '../../src/core/bytes'
import { VaultCipher, WrongPassphraseError, parseKeyInfo, unwrapIdentity, KEY_INFO, type KeyBundle } from '../../src/core/crypto'
import { SlotStore, type RawStore } from '../../src/core/slots'
import { SyncEngine, KeyMismatchError, NotInitializedError, type SyncHost, type SyncState } from '../../src/core/sync/engine'
import { joinRemote, readJoinCode } from '../../src/core/sync/setup'
import { RemoteError, type RemoteStore } from '../../src/core/sync/remote'
import { GitHubStore } from '../../src/core/sync/github'
import { OssStore } from '../../src/core/sync/oss'
import {
  FORMAT, FormatTooNewError, createItem, emptyVault, gcTombstones, liveItems, mergeVaults, parseVault, updateItem, type VaultState,
} from '../../src/core/vault'
import { canonicalJson, type Item, type ItemContent } from '../../src/core/item'
import { baseDomain, hostOf, matchItems } from '../../src/core/autofill'
import { liveFolders } from '../../src/core/folders'
import type { DeviceInfo } from '../../src/core/sync/deviceFile'
import { configFrom, draftFrom } from '../../src/ui/backendDraft'
import type { BackendConfig } from '../../src/store'

export interface Kv {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface ExtPrefs {
  deviceId: string
  deviceName: string
  recipient: string
  /** 闲置多少分钟后上锁；0 表示只在关掉 Chrome 时上锁 */
  idleMin: number
  /** 复制密码后多少秒清空剪贴板；0 不清空 */
  clipboardSec: number
}

export const IDLE_OPTIONS = [60, 240, 480, 0] as const
const defaultPrefs = (): ExtPrefs => ({ deviceId: '', deviceName: '', recipient: '', idleMin: 240, clipboardSec: 30 })

const PREFS_KEY = 'prefs'
const S_IDENTITY = 'identity'
const S_LAST_USED = 'lastUsed'
const S_PENDING = 'pending'
/** 待保存的登录最多留多久 */
export const PENDING_TTL_MS = 10 * 60_000

export function makeRemote(cfg: BackendConfig): RemoteStore {
  return cfg.type === 'github' ? new GitHubStore(cfg.github) : new OssStore(cfg.oss)
}

export function newDeviceId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => a[x % a.length]).join('')
}

/** 登录时网页上填的东西 */
export interface Captured {
  url: string
  username: string
  password: string
}

export interface Pending extends Captured {
  tabId: number
  at: number
  /** 默认更新哪一条（同一个网站、同一个用户名）；没有就新建 */
  updateId?: string
  updateTitle?: string
}

export type CaptureResult = 'saved-already' | 'pending' | 'ignored'

export interface SyncStatus {
  running: boolean
  last: number
  error: string
  /** 需要用户处理：key 密钥换过、missing 云端没了、format 要升级、auth Token 问题 */
  errorKind: '' | 'network' | 'auth' | 'key' | 'missing' | 'format' | 'other'
  pending: boolean
  devices: DeviceInfo[]
}

interface LocalVaultFile {
  format: number
  vault: VaultState
  dirty?: boolean
}

export class VaultService {
  readonly files: SlotStore
  prefs: ExtPrefs = defaultPrefs()
  phase: 'loading' | 'setup' | 'locked' | 'unlocked' = 'loading'
  vault: VaultState = emptyVault()
  backend: BackendConfig | null = null
  sync: SyncStatus = { running: false, last: 0, error: '', errorKind: '', pending: false, devices: [] }

  private keys: Pick<KeyBundle, 'identity' | 'recipient'> | null = null
  private cipher: VaultCipher | null = null
  private syncState: SyncState | null = null
  private engine: SyncEngine | null = null
  private inflight: Promise<boolean> | null = null
  private editSeq = 0
  private loaded: Promise<void> | null = null

  constructor(
    private local: Kv,
    private session: Kv,
    private opts: { now?: () => number; remote?: (cfg: BackendConfig) => RemoteStore } = {},
  ) {
    const raw: RawStore = {
      read: async (p) => {
        const v = await local.get(`file:${p}`)
        return v === null ? null : fromBase64(v)
      },
      write: async (p, b) => local.set(`file:${p}`, toBase64(b)),
      remove: async (p) => local.remove(`file:${p}`),
    }
    this.files = new SlotStore(raw)
  }

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  private remote(cfg: BackendConfig) {
    return this.opts.remote?.(cfg) ?? makeRemote(cfg)
  }

  // ---------- 启动 ----------

  /** 读设置；storage.session 里有解开的密钥（后台被停掉后重新醒来）就直接恢复成解锁状态 */
  ready(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load() {
    try {
      const raw = await this.local.get(PREFS_KEY)
      if (raw) this.prefs = { ...defaultPrefs(), ...(JSON.parse(raw) as Partial<ExtPrefs>) }
    } catch { /* 坏了就用默认值 */ }
    const id = await this.files.read('identity')
    this.phase = id && this.prefs.recipient ? 'locked' : 'setup'
    if (this.phase !== 'locked') return
    const identity = await this.session.get(S_IDENTITY)
    if (!identity) return
    if (await this.idleExpired()) {
      await this.lock()
      return
    }
    try {
      await this.open({ identity, recipient: await identityToRecipient(identity) })
    } catch {
      await this.lock()
    }
  }

  async savePrefs(patch: Partial<ExtPrefs> = {}) {
    this.prefs = { ...this.prefs, ...patch }
    await this.local.set(PREFS_KEY, JSON.stringify(this.prefs))
  }

  // ---------- 加入、解锁、上锁 ----------

  /** 用手机上生成的加入码 + 主密码加入保险库 */
  async join(code: string, passphrase: string, deviceName: string): Promise<void> {
    await this.ready()
    if (this.phase !== 'setup') throw new Error('已经加入过保险库了')
    const r = configFrom(draftFrom((await readJoinCode(code, passphrase)) as BackendConfig))
    if ('error' in r) throw new Error(`加入码里的同步设置不对：${r.error}`)
    const k = await joinRemote(this.remote(r.cfg), passphrase)
    await this.files.write('identity', k.wrapped)
    await this.savePrefs({ deviceId: this.prefs.deviceId || newDeviceId(), deviceName: deviceName.trim().slice(0, 40) || '电脑', recipient: k.recipient })
    this.cipher = new VaultCipher(k)
    this.backend = r.cfg
    await this.files.write('config', await this.cipher.encryptJson({ backend: r.cfg }))
    await this.files.write('vault', await this.cipher.encryptJson({ format: FORMAT, vault: emptyVault(), dirty: true } satisfies LocalVaultFile))
    await this.files.remove('syncstate')
    await this.unlockWith(k)
    // 第一次同步完再返回：弹窗打开时就能看到手机上的条目
    await this.syncNow()
  }

  async unlock(passphrase: string): Promise<void> {
    await this.ready()
    const wrapped = await this.files.read('identity')
    if (!wrapped) throw new Error('还没有加入保险库')
    const k = await unwrapIdentity(wrapped, passphrase)
    if (k.recipient !== this.prefs.recipient) throw new Error('这把密钥不属于本机的保险库')
    await this.unlockWith(k)
  }

  private async unlockWith(k: Pick<KeyBundle, 'identity' | 'recipient'>) {
    await this.session.set(S_IDENTITY, k.identity)
    await this.session.set(S_LAST_USED, String(this.now()))
    await this.open(k)
    void this.syncNow()
  }

  private async open(k: Pick<KeyBundle, 'identity' | 'recipient'>) {
    const cipher = new VaultCipher(k)
    let v = emptyVault()
    let dirty = false
    const lb = await this.files.read('vault')
    if (lb) {
      const local = await cipher.decryptJson<LocalVaultFile>(lb)
      if (local.format > FORMAT) throw new FormatTooNewError(local.format)
      v = parseVault(local.vault).state
      dirty = !!local.dirty
    }
    const cb = await this.files.read('config')
    const sb = await this.files.read('syncstate')
    this.keys = k
    this.cipher = cipher
    this.backend = cb ? (await cipher.decryptJson<{ backend: BackendConfig | null }>(cb)).backend : null
    this.syncState = sb ? await cipher.decryptJson<SyncState>(sb) : null
    this.vault = gcTombstones(v)
    this.sync = { ...this.sync, pending: dirty, last: this.syncState?.lastSync ?? 0, devices: Object.values(this.syncState?.devices ?? {}), error: '', errorKind: '' }
    this.engine = new SyncEngine(this.host)
    this.phase = 'unlocked'
  }

  async lock(): Promise<void> {
    await this.session.remove(S_IDENTITY)
    await this.session.remove(S_LAST_USED)
    await this.session.remove(S_PENDING)
    this.keys = null
    this.cipher = null
    this.syncState = null
    this.engine = null
    this.vault = emptyVault()
    if (this.phase === 'unlocked') this.phase = 'locked'
  }

  /** 用过一次（打开弹窗、填充）：闲置计时从现在算起 */
  async touch(): Promise<void> {
    if (this.phase === 'unlocked') await this.session.set(S_LAST_USED, String(this.now()))
  }

  private async idleExpired(): Promise<boolean> {
    if (!this.prefs.idleMin) return false
    const last = Number((await this.session.get(S_LAST_USED)) ?? 0)
    return this.now() - last > this.prefs.idleMin * 60_000
  }

  /** 定时检查：闲置太久就上锁。返回是否上锁了 */
  async checkIdle(): Promise<boolean> {
    await this.ready()
    if (this.phase !== 'unlocked' || !(await this.idleExpired())) return false
    await this.lock()
    return true
  }

  /** 抹掉本机数据（云端不动） */
  async wipe(): Promise<void> {
    await this.lock()
    for (const n of ['identity', 'vault', 'config', 'syncstate']) await this.files.remove(n)
    await this.local.remove(PREFS_KEY)
    this.prefs = defaultPrefs()
    this.backend = null
    this.phase = 'setup'
  }

  // ---------- 条目 ----------

  items(): Item[] {
    return liveItems(this.vault)
  }

  folders() {
    return liveFolders(this.vault.folders)
  }

  /** 当前网页的推荐 */
  suggest(url: string): Item[] {
    const host = hostOf(url)
    if (!host || !/^https?:/i.test(url)) return []
    return matchItems(this.items(), { webDomain: host })
  }

  item(id: string): Item | null {
    const it = this.vault.items[id]
    return it && !it.deleted && !it.purged ? it : null
  }

  private ctx() {
    return { device: this.prefs.deviceId, now: this.now() }
  }

  private async commit(next: VaultState) {
    if (next === this.vault) return
    this.vault = next
    this.editSeq++
    this.sync.pending = !!this.backend
    await this.persistVault()
  }

  private async persistVault() {
    if (!this.cipher) return
    await this.files.write('vault', await this.cipher.encryptJson({ format: FORMAT, vault: this.vault, dirty: this.sync.pending } satisfies LocalVaultFile))
  }

  /** 新建或更新一条登录（保存提示里点“保存”） */
  async saveLogin(c: { updateId?: string; title: string; username?: string; password: string; url?: string }): Promise<string> {
    if (this.phase !== 'unlocked') throw new Error('已上锁')
    if (c.updateId && this.item(c.updateId)) {
      const patch: Partial<ItemContent> = { password: c.password }
      if (c.username) patch.username = c.username
      await this.commit(updateItem(this.vault, c.updateId, patch, this.ctx()))
      return c.updateId
    }
    const r = createItem(this.vault, {
      type: 'login',
      title: c.title.trim() || '未命名',
      ...(c.username ? { username: c.username } : {}),
      password: c.password,
      ...(c.url ? { urls: [c.url] } : {}),
    }, this.ctx())
    await this.commit(r.state)
    return r.id
  }

  // ---------- 登录后保存 ----------

  private async readPending(): Promise<Pending[]> {
    try {
      const raw = await this.session.get(S_PENDING)
      const list = raw ? (JSON.parse(raw) as Pending[]) : []
      return list.filter((p) => this.now() - p.at < PENDING_TTL_MS)
    } catch {
      return []
    }
  }

  private async writePending(list: Pending[]) {
    if (list.length) await this.session.set(S_PENDING, JSON.stringify(list))
    else await this.session.remove(S_PENDING)
  }

  /**
   * 网页上登录了（内容脚本捕获到账号密码）。已经保存过一模一样的就不打扰；
   * 否则记下来（只在内存里），等用户在网页上的提示条或弹窗里点“保存”。上锁时也记，解锁后再决定新建还是更新。
   */
  async capture(tabId: number, c: Captured): Promise<CaptureResult> {
    await this.ready()
    if (!c.password || !/^https?:/i.test(c.url) || !hostOf(c.url)) return 'ignored'
    if (this.phase === 'unlocked') {
      const same = this.suggest(c.url).find((i) => (i.username ?? '') === c.username && i.password === c.password)
      if (same) return 'saved-already'
    }
    const list = (await this.readPending()).filter((p) => p.tabId !== tabId)
    list.push({ ...c, tabId, at: this.now() })
    await this.writePending(list)
    return 'pending'
  }

  /** 某个标签页待保存的登录（解锁时补上“更新哪一条”） */
  async pendingFor(tabId: number): Promise<Pending | null> {
    const p = (await this.readPending()).find((x) => x.tabId === tabId) ?? null
    if (!p || this.phase !== 'unlocked') return p
    const same = this.suggest(p.url).find((i) => (i.username ?? '') === p.username && i.password === p.password)
    if (same) {
      await this.dropPending(tabId)
      return null
    }
    const up = this.suggest(p.url).find((i) => !p.username || !i.username || i.username === p.username)
    return up ? { ...p, updateId: up.id, updateTitle: up.title } : p
  }

  async dropPending(tabId: number): Promise<void> {
    await this.writePending((await this.readPending()).filter((p) => p.tabId !== tabId))
  }

  /** 保存待保存的登录：mode 'update' 更新推荐的那一条，'new' 新建 */
  async savePending(tabId: number, mode: 'update' | 'new'): Promise<string> {
    const p = await this.pendingFor(tabId)
    if (!p) throw new Error('没有要保存的登录（超过 10 分钟会自动丢弃）')
    const host = hostOf(p.url)
    const id = await this.saveLogin({
      updateId: mode === 'update' ? p.updateId : undefined,
      title: baseDomain(host),
      username: p.username || undefined,
      password: p.password,
      url: `https://${host}`,
    })
    await this.dropPending(tabId)
    void this.syncNow()
    return id
  }

  // ---------- 同步 ----------

  private host: SyncHost = this.makeHost()

  private makeHost(): SyncHost {
    const self = this
    return {
      get device() {
        return { id: self.prefs.deviceId, name: self.prefs.deviceName }
      },
      get cipher() {
        if (!self.cipher) throw new Error('已上锁')
        return self.cipher
      },
      current: () => self.vault,
      merge: async (remote) => {
        const merged = mergeVaults(self.vault, remote)
        if (canonicalJson(merged) !== canonicalJson(self.vault)) {
          self.vault = merged
          await self.persistVault()
        }
      },
      loadSyncState: async () => self.syncState,
      saveSyncState: async (_id, s) => {
        self.syncState = s
        if (self.cipher) await self.files.write('syncstate', await self.cipher.encryptJson(s))
      },
      now: () => self.now(),
    }
  }

  /** 立即同步，返回是否成功。同时只跑一轮；这一轮开始后又改过，就接着再同步一次 */
  async syncNow(): Promise<boolean> {
    if (this.inflight) {
      const ok = await this.inflight
      if (!ok || !this.sync.pending) return ok
    }
    if (this.phase !== 'unlocked' || !this.backend || !this.engine) return false
    if (this.inflight) return this.inflight
    this.inflight = this.runSync().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async runSync(): Promise<boolean> {
    const backend = this.backend!
    const eng = this.engine!
    const seq = this.editSeq
    this.sync.running = true
    try {
      await eng.sync(this.remote(backend))
      if (this.engine !== eng) return false
      this.sync = {
        ...this.sync, last: this.now(), error: '', errorKind: '', devices: Object.values(this.syncState?.devices ?? {}),
      }
      if (this.editSeq === seq && this.sync.pending) {
        this.sync.pending = false
        await this.persistVault()
      }
      return true
    } catch (e) {
      if (this.engine !== eng) return false
      this.sync.errorKind = classify(e)
      this.sync.error = (e as Error).message
      return false
    } finally {
      this.sync.running = false
    }
  }

  /** 核对主密码（不改变解锁状态） */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const wrapped = await this.files.read('identity')
    if (!wrapped) return false
    try {
      await unwrapIdentity(wrapped, passphrase)
      return true
    } catch (e) {
      if (e instanceof WrongPassphraseError) return false
      throw e
    }
  }

  /** 云端的保险库密钥换过了：用云端的主密码重新加入（本机条目合并过去） */
  async checkRemoteKey(): Promise<boolean> {
    if (!this.backend || !this.keys) return true
    const info = await this.remote(this.backend).get(KEY_INFO)
    return !!info && parseKeyInfo(info).recipient === this.keys.recipient
  }
}

function classify(e: unknown): SyncStatus['errorKind'] {
  if (e instanceof KeyMismatchError) return 'key'
  if (e instanceof NotInitializedError) return 'missing'
  if (e instanceof FormatTooNewError) return 'format'
  if (e instanceof RemoteError) {
    if (e.status === 401 || e.status === 403 || e.status === 404) return 'auth'
    return e.retryable ? 'network' : 'other'
  }
  return 'other'
}
