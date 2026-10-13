import { VaultCipher, type KeyBundle } from '../src/core/crypto'
import type { ItemContent } from '../src/core/item'
import { SyncEngine, type SyncHost, type SyncState } from '../src/core/sync/engine'
import type { RemoteStore } from '../src/core/sync/remote'
import {
  createItem, deleteItem, emptyVault, mergeVaults, updateItem, type VaultState,
} from '../src/core/vault'

/** 测试里的 scrypt 强度（正式是 18） */
export const WF = 10
export const PASS = 'correct-horse-battery'
export const T0 = Date.UTC(2026, 9, 13, 3, 0, 0)

/** 模拟一台设备：内存里的保险库 + 同步状态，时钟可以单独拨 */
export class TestDevice implements SyncHost {
  state: VaultState = emptyVault()
  syncStates = new Map<string, SyncState>()
  readonly cipher: VaultCipher
  readonly engine: SyncEngine
  clock = T0
  /** 时钟偏差（毫秒），模拟手机时间不准 */
  skew = 0
  merges = 0

  constructor(readonly device: { id: string; name: string }, keys: KeyBundle) {
    this.cipher = new VaultCipher(keys)
    this.engine = new SyncEngine(this)
  }

  now() {
    return this.clock + this.skew
  }

  tick(ms = 1000) {
    this.clock += ms
    return this
  }

  current() {
    return this.state
  }

  async merge(remote: VaultState) {
    this.merges++
    this.state = mergeVaults(this.state, remote)
  }

  async loadSyncState(id: string) {
    return this.syncStates.get(id) ?? null
  }

  async saveSyncState(id: string, s: SyncState) {
    this.syncStates.set(id, structuredClone(s))
  }

  private ctx(newId?: string) {
    return { device: this.device.id, now: this.tick(1000).now(), newId }
  }

  add(content: ItemContent, id?: string): string {
    const r = createItem(this.state, content, this.ctx(id))
    this.state = r.state
    return r.id
  }

  edit(id: string, patch: Partial<ItemContent>) {
    this.state = updateItem(this.state, id, patch, this.ctx())
  }

  del(id: string) {
    this.state = deleteItem(this.state, id, this.ctx())
  }

  sync(remote: RemoteStore) {
    return this.engine.sync(remote)
  }
}
