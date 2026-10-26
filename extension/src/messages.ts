/**
 * 扩展里各部分之间的消息。
 *
 * - 弹窗 → 后台：PopupMsg（弹窗是扩展自己的页面，可以拿到条目）。
 * - 网页里的内容脚本 → 后台：ContentMsg。内容脚本跑在网页的进程里，只能上报“登录时填了什么”、
 *   问“这个标签页有没有待保存的登录”，拿不到任何条目；后台按 sender.tab 认标签页，不信消息里自报的。
 * - 后台 → 内容脚本：FillMsg（用户点了“填充”或按了快捷键才发），内容脚本先核对自己所在的网站再填。
 */
import type { Item } from '../../src/core/item'
import type { Folder } from '../../src/core/folders'
import type { ExtPrefs, Pending, SyncStatus } from './service'

export type PopupMsg =
  | { t: 'state'; tabId?: number; url?: string }
  | { t: 'items' }
  | { t: 'join'; code: string; pass: string; name: string }
  | { t: 'unlock'; pass: string }
  | { t: 'lock' }
  | { t: 'sync' }
  | { t: 'fill'; tabId: number; url: string; id: string }
  | { t: 'fillPassword'; tabId: number; url: string; password: string }
  | { t: 'copy'; text: string; secret: boolean }
  | { t: 'savePending'; tabId: number; mode: 'update' | 'new' }
  | { t: 'dropPending'; tabId: number }
  | { t: 'prefs'; patch: Partial<Pick<ExtPrefs, 'idleMin' | 'clipboardSec' | 'deviceName'>> }
  | { t: 'wipe'; pass: string }

export type ContentMsg =
  | { t: 'capture'; url: string; username: string; password: string }
  | { t: 'pendingHere' }
  | { t: 'savePendingHere'; mode: 'update' | 'new' }
  | { t: 'dropPendingHere' }
  | { t: 'openPopup' }

export type OffscreenMsg = { t: 'clip'; text: string; clearAfterSec: number; target: 'offscreen' }

export interface FillMsg {
  t: 'fill'
  /** 条目匹配的是哪个网站（标签页的主机名）；内容脚本所在网页的主域名必须和它一样才填 */
  host: string
  username?: string
  password?: string
}

export interface ShowSaveMsg {
  t: 'showSave'
}

export interface StateReply {
  phase: 'loading' | 'setup' | 'locked' | 'unlocked'
  prefs: Pick<ExtPrefs, 'deviceName' | 'idleMin' | 'clipboardSec'>
  sync: SyncStatus
  backendTitle: string
  /** 当前网页的推荐（条目ID） */
  suggested: string[]
  pending: Omit<Pending, 'password'> | null
  version: string
}

export interface ItemsReply {
  items: Item[]
  folders: Folder[]
}

export interface PendingHereReply {
  phase: StateReply['phase']
  pending: Pick<Pending, 'username' | 'url' | 'updateId' | 'updateTitle'> | null
}

export type Reply<T> = T | { error: string }

export function isError(r: unknown): r is { error: string } {
  return !!r && typeof r === 'object' && 'error' in r
}
