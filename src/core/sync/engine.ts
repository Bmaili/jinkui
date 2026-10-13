/**
 * 同步引擎（规格第 5 节）：双向，每台设备只写自己的文件。
 *
 * 一次同步：
 * 1. 列出云端文件；keys/info.json 的公钥必须和本机一致，否则停下（密钥在别处换过）。
 * 2. 下载版本变了的设备文件（包括自己的：可能被人恢复过旧版本），全部解密、解析成功后一次性合并进本地。
 *    有文件来自更新版本的格式 → 整次同步停下，什么都不合并、不上传。
 *    单个文件解不开或结构不对 → 跳过它、报告出来，不影响其他文件。
 * 3. 本地内容和上次上传的不同（或云端自己的文件不见了、被改了）→ 加密后覆盖写自己的文件。
 *
 * 同步状态（看过哪些文件的哪个版本、上次上传的哈希）随时可以丢掉：丢了就是全部重新下载合并一次，
 * 合并是幂等的，结果不变。
 */
import { sha256Hex } from '../bytes'
import { KEY_INFO, VaultCipher, deviceIdOf, devicePath, parseKeyInfo } from '../crypto'
import { canonicalJson } from '../item'
import { FormatTooNewError, emptyVault, mergeVaults, type VaultState } from '../vault'
import { makeDeviceFile, parseDeviceFile, type DeviceInfo } from './deviceFile'
import { RemoteConflictError, type RemoteStore } from './remote'

export interface SyncState {
  /** 已合并过的云端文件版本：路径 → 版本 */
  seen: Record<string, string>
  /** 上次上传的内容哈希 */
  uploadedHash?: string
  /** 上次上传后云端给的版本 */
  uploadedVersion?: string
  /** 核对过的公钥 */
  recipient?: string
  /** 云端各设备的信息（设备列表用） */
  devices: Record<string, DeviceInfo>
  lastSync?: number
}

export interface SyncHost {
  readonly device: { id: string; name: string }
  readonly cipher: VaultCipher
  /** 当前本地保险库 */
  current(): VaultState
  /** 把云端状态合并进本地并保存；保存成功后才返回 */
  merge(remote: VaultState): Promise<void>
  loadSyncState(remoteId: string): Promise<SyncState | null>
  saveSyncState(remoteId: string, s: SyncState): Promise<void>
  now?(): number
}

export interface SyncProblem {
  path: string
  message: string
}

export interface SyncResult {
  /** 下载并合并的设备文件数 */
  downloaded: number
  uploaded: boolean
  /** 跳过的文件（解不开、结构不对） */
  problems: SyncProblem[]
  /** 结构不对、没能合并的条目 id */
  skippedItems: string[]
}

export class NotInitializedError extends Error {
  constructor() {
    super('云端还没有保险库')
  }
}

export class KeyMismatchError extends Error {
  constructor() {
    super('云端的保险库密钥和本机不一致：可能在别的设备上更换过密钥，请重新输入主密码加入')
  }
}

const emptySyncState = (): SyncState => ({ seen: {}, devices: {} })

export class SyncEngine {
  private busy = new Map<string, Promise<SyncResult>>()

  constructor(private host: SyncHost) {}

  private now() {
    return this.host.now?.() ?? Date.now()
  }

  isBusy(remoteId: string) {
    return this.busy.has(remoteId)
  }

  /** 同一后端同时只跑一次；正在跑时再调用，拿到的是同一个结果 */
  sync(remote: RemoteStore): Promise<SyncResult> {
    const running = this.busy.get(remote.id)
    if (running) return running
    const job = (async () => {
      try {
        return await this.run(remote)
      } catch (e) {
        // 写自己的文件时撞上并发（例如同一台设备的两个进程，或云端被人改过）：重来一次即可
        if (e instanceof RemoteConflictError) return this.run(remote)
        throw e
      }
    })()
    this.busy.set(remote.id, job)
    return job.finally(() => this.busy.delete(remote.id))
  }

  private async run(remote: RemoteStore): Promise<SyncResult> {
    const { host } = this
    const st: SyncState = { ...emptySyncState(), ...((await host.loadSyncState(remote.id)) ?? {}) }
    st.seen = { ...st.seen }
    st.devices = { ...st.devices }
    const listing = await remote.list()
    const ver = new Map(listing.map((f) => [f.path, f.version]))

    // 1. 核对公钥
    const infoVer = ver.get(KEY_INFO)
    if (!infoVer) throw new NotInitializedError()
    const recipient = host.cipher.keys.recipient
    if (st.seen[KEY_INFO] !== infoVer || st.recipient !== recipient) {
      const bytes = await remote.get(KEY_INFO)
      if (!bytes) throw new NotInitializedError()
      if (parseKeyInfo(bytes).recipient !== recipient) throw new KeyMismatchError()
      st.seen[KEY_INFO] = infoVer
      st.recipient = recipient
    }

    // 2. 下载变了的设备文件，全部成功解析后再合并
    const problems: SyncProblem[] = []
    const skippedItems: string[] = []
    const fetched: { path: string; version: string; info: DeviceInfo; vault: VaultState }[] = []
    for (const f of listing) {
      const id = deviceIdOf(f.path)
      if (!id || st.seen[f.path] === f.version) continue
      const bytes = await remote.get(f.path)
      if (!bytes) continue // 列出之后被删了
      try {
        const { file, skipped } = parseDeviceFile(await host.cipher.decryptJson(bytes), id)
        fetched.push({ path: f.path, version: f.version, info: file.device, vault: file.vault })
        skippedItems.push(...skipped)
      } catch (e) {
        if (e instanceof FormatTooNewError) throw e
        problems.push({ path: f.path, message: (e as Error).message })
      }
    }
    if (fetched.length) {
      const combined = fetched.reduce((acc, x) => mergeVaults(acc, x.vault), emptyVault())
      await host.merge(combined)
      for (const x of fetched) {
        st.seen[x.path] = x.version
        st.devices[x.info.id] = x.info
      }
    }
    // 云端已经没有的文件不再记着
    for (const p of Object.keys(st.seen)) if (!ver.has(p)) delete st.seen[p]
    for (const id of Object.keys(st.devices)) if (!ver.has(devicePath(id))) delete st.devices[id]

    // 3. 上传自己的文件
    const own = devicePath(host.device.id)
    const state = host.current()
    const hash = await sha256Hex(canonicalJson({ vault: state, name: host.device.name }))
    const ownVer = ver.get(own)
    let uploaded = false
    if (hash !== st.uploadedHash || !ownVer || ownVer !== st.uploadedVersion) {
      const file = makeDeviceFile(host.device, state, this.now())
      const version = await remote.put(own, await host.cipher.encryptJson(file), { ifVersion: ownVer ?? null })
      st.uploadedHash = hash
      st.uploadedVersion = version
      st.seen[own] = version
      st.devices[host.device.id] = file.device
      uploaded = true
    }
    st.lastSync = this.now()
    await host.saveSyncState(remote.id, st)
    return { downloaded: fetched.length, uploaded, problems, skippedItems }
  }

  /**
   * 移除一台设备（丢了、不用了）：先同步一次，确保它的数据已经合并进本机并上传，再删除它的文件。
   * 不能移除自己。被移除的设备如果之后又联网，会重新上传自己的文件（数据不会丢，只是又出现在列表里）。
   */
  async removeDevice(remote: RemoteStore, deviceId: string): Promise<void> {
    if (deviceId === this.host.device.id) throw new Error('不能移除本机')
    await this.sync(remote)
    await remote.remove(devicePath(deviceId))
    const st = await this.host.loadSyncState(remote.id)
    if (st) {
      const seen = { ...st.seen }
      delete seen[devicePath(deviceId)]
      const devices = { ...st.devices }
      delete devices[deviceId]
      await this.host.saveSyncState(remote.id, { ...st, seen, devices })
    }
  }
}
