/**
 * 保险库状态与编辑操作（规格 4.1、5.1）。全部是纯函数：传入旧状态，返回新状态，不改原对象。
 */
import { HISTORY_MAX, contentOf, isItem, sameContent, snapshotOf, type Item, type ItemContent } from './item'
import { mergeItems, normalizeHistory } from './merge'
import { maxRev, nextRev, type Rev } from './rev'
import { ORDER_STEP, checkFolderName, hasOrder, isFolder, liveFolders, mergeFolders, putFolder, type Folder, type Folders } from './folders'

/** 当前格式版本。只能加字段，不能改已有字段的含义；真要不兼容地改才加一 */
export const FORMAT = 1

export interface VaultState {
  format: number
  items: Record<string, Item>
  /** 目录（1.0.2 起，规格 4.5）。旧数据没有这个字段 */
  folders?: Folders
  /** 未知的顶层字段原样保留 */
  [extra: string]: unknown
}

/** 删除标记保留 180 天，之后从保险库中清掉（规格 5.2） */
export const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000

export class FormatTooNewError extends Error {
  constructor(readonly format: number) {
    super('数据来自更新版本的金匮，请先升级 app')
  }
}

export class VaultFormatError extends Error {}

export const emptyVault = (): VaultState => ({ format: FORMAT, items: {} })

/**
 * 解析保险库 JSON。格式版本比本 app 新时抛 FormatTooNewError（不能用旧代码去改新格式）。
 * 单个条目结构不对时跳过它并记在 skipped 里，不让一条坏数据挡住全部。
 */
export function parseVault(json: unknown): { state: VaultState; skipped: string[] } {
  const v = json as VaultState
  if (!v || typeof v !== 'object' || !Number.isInteger(v.format) || !v.items || typeof v.items !== 'object' || Array.isArray(v.items)) {
    throw new VaultFormatError('保险库文件结构不对')
  }
  if (v.format > FORMAT) throw new FormatTooNewError(v.format)
  const items: Record<string, Item> = {}
  const skipped: string[] = []
  for (const [k, item] of Object.entries(v.items)) {
    if (isItem(item) && item.id === k) items[k] = item
    else skipped.push(k)
  }
  const state: VaultState = { ...v, format: FORMAT, items }
  if (v.folders !== undefined) {
    const folders: Folders = {}
    if (v.folders && typeof v.folders === 'object' && !Array.isArray(v.folders)) {
      for (const [k, f] of Object.entries(v.folders)) {
        if (isFolder(f) && f.id === k) folders[k] = f
        else skipped.push(`folder:${k}`)
      }
    }
    state.folders = folders
  }
  return { state, skipped }
}

export function mergeVaults(local: VaultState, remote: VaultState): VaultState {
  // 顶层未知字段：本地已有的优先，其次补上远端的
  const out: VaultState = { ...remote, ...local, format: FORMAT, items: mergeItems(local.items, remote.items) }
  if (local.folders || remote.folders) out.folders = mergeFolders(local.folders, remote.folders)
  else delete out.folders
  return out
}

/** 保险库里见过的最大版本号（含历史），新修改的版本号要比它大 */
export function vaultMaxRev(state: VaultState): Rev | null {
  function* revs() {
    for (const it of Object.values(state.items)) {
      yield it.rev
      for (const h of it.history ?? []) yield h.rev
    }
    for (const f of Object.values(state.folders ?? {})) yield f.rev
  }
  return maxRev(revs())
}

export interface EditCtx {
  device: string
  now?: number
  /** 测试用：指定新条目的 id */
  newId?: string
}

/** 把当前版本推进历史，换上新内容 */
function bump(state: VaultState, prev: Item, next: Omit<Item, 'rev' | 'history'>, ctx: EditCtx): VaultState {
  const rev = nextRev(vaultMaxRev(state), ctx.device, ctx.now)
  const history = next.purged ? [] : normalizeHistory([snapshotOf(prev), ...(prev.history ?? [])], { rev })
  const item = { ...next, rev } as Item
  if (history.length) item.history = history
  return { ...state, items: { ...state.items, [prev.id]: item } }
}

function existing(state: VaultState, id: string): Item {
  const it = state.items[id]
  if (!it) throw new Error(`条目不存在：${id}`)
  return it
}

/** 去掉 id / rev / history / created 这些不能由编辑直接改的字段 */
function stripMeta(c: Partial<ItemContent>): Partial<ItemContent> {
  const out: Record<string, unknown> = { ...c }
  for (const k of ['id', 'rev', 'history', 'created', 'deleted', 'purged']) delete out[k]
  return out as Partial<ItemContent>
}

export function createItem(state: VaultState, content: ItemContent, ctx: EditCtx): { state: VaultState; id: string } {
  const id = ctx.newId ?? crypto.randomUUID()
  if (state.items[id]) throw new Error(`条目已存在：${id}`)
  const now = ctx.now ?? Date.now()
  const rev = nextRev(vaultMaxRev(state), ctx.device, now)
  const item: Item = { ...(stripMeta(content) as ItemContent), id, created: now, rev }
  return { state: { ...state, items: { ...state.items, [id]: item } }, id }
}

/**
 * 修改条目：patch 里给出的字段覆盖旧值，值为 undefined 的字段删除，没提到的字段（包括未知字段）保留。
 * 内容没有变化时不产生新版本。
 */
export function updateItem(state: VaultState, id: string, patch: Partial<ItemContent>, ctx: EditCtx): VaultState {
  const prev = existing(state, id)
  if (prev.purged) throw new Error('条目已彻底删除')
  const next: Record<string, unknown> = { ...prev, ...stripMeta(patch) }
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  delete next.rev
  delete next.history
  if (sameContent(next as unknown as Item, prev)) return state
  return bump(state, prev, next as unknown as Item, ctx)
}

/** 删除：放进“最近删除”，内容保留，可以恢复 */
export function deleteItem(state: VaultState, id: string, ctx: EditCtx): VaultState {
  const prev = existing(state, id)
  if (prev.deleted) return state
  const { rev: _r, history: _h, ...rest } = prev
  void _r, void _h
  return bump(state, prev, { ...rest, deleted: true }, ctx)
}

export function restoreItem(state: VaultState, id: string, ctx: EditCtx): VaultState {
  const prev = existing(state, id)
  if (!prev.deleted || prev.purged) return state
  const { rev: _r, history: _h, deleted: _d, ...rest } = prev
  void _r, void _h, void _d
  return bump(state, prev, rest, ctx)
}

/**
 * 彻底删除：只留下 id、类型和删除标记，内容和历史全部清空。
 * 注意：云端以前上传过的文件（GitHub 提交历史、OSS 版本控制）里仍有旧内容，界面上要提示。
 */
export function purgeItem(state: VaultState, id: string, ctx: EditCtx): VaultState {
  const prev = existing(state, id)
  if (prev.purged) return state
  return bump(state, prev, { id, created: prev.created, type: prev.type, title: '', deleted: true, purged: true }, ctx)
}

/** 恢复到历史里的某个版本（作为一次新的修改，当前值进历史） */
export function revertTo(state: VaultState, id: string, historyRev: Rev, ctx: EditCtx): VaultState {
  const prev = existing(state, id)
  const snap = (prev.history ?? []).find((h) => h.rev.t === historyRev.t && h.rev.c === historyRev.c && h.rev.d === historyRev.d)
  if (!snap) throw new Error('找不到这个历史版本')
  const content = stripMeta(contentOf(snap) as ItemContent) as ItemContent
  return bump(state, prev, { ...content, id, created: prev.created }, ctx)
}

/** 清掉超过 TOMBSTONE_TTL 的删除标记。超过这个时间才联网的旧设备可能把条目带回来（规格 5.2 已知限制） */
export function gcTombstones(state: VaultState, now: number = Date.now()): VaultState {
  let changed = false
  const items: Record<string, Item> = {}
  for (const [id, it] of Object.entries(state.items)) {
    if (it.deleted && it.rev.t < now - TOMBSTONE_TTL) changed = true
    else items[id] = it
  }
  let folders = state.folders
  if (folders) {
    const kept: Folders = {}
    for (const [id, f] of Object.entries(folders)) {
      if (f.deleted && f.rev.t < now - TOMBSTONE_TTL) changed = true
      else kept[id] = f
    }
    folders = kept
  }
  return changed ? { ...state, items, ...(folders ? { folders } : {}) } : state
}

// ---------- 目录（规格 4.5） ----------

export function createFolder(state: VaultState, name: string, ctx: EditCtx): { state: VaultState; id: string } {
  const err = checkFolderName(name, state.folders)
  if (err) throw new Error(err)
  const id = ctx.newId ?? crypto.randomUUID()
  // 拖动排过序之后新建的目录放在最后；从没排过序时不给位置，和老版本一样按名字排
  const ordered = liveFolders(state.folders).filter(hasOrder)
  const f: { id: string; name: string; order?: number } = { id, name: name.trim() }
  if (ordered.length) f.order = Math.floor(Math.max(...ordered.map((x) => x.order)) / ORDER_STEP + 1) * ORDER_STEP
  const folders = putFolder(state.folders, f, vaultMaxRev(state), ctx.device, ctx.now)
  return { state: { ...state, folders }, id }
}

/**
 * 把目录拖到第 to 个位置（在没删除的目录里数，从 0 开始）。一般只改这一个目录的位置（取前后两个的中间值），
 * 合并时和别的设备拖动别的目录互不影响；还有目录没有位置、或者间隔用完了，才给全部目录重新编号。
 */
export function moveFolder(state: VaultState, id: string, to: number, ctx: EditCtx): VaultState {
  const list = liveFolders(state.folders)
  const from = list.findIndex((f) => f.id === id)
  if (from < 0) throw new Error('目录不存在')
  to = Math.max(0, Math.min(list.length - 1, Math.round(to)))
  if (from === to) return state
  const moved = list[from]
  const rest = list.filter((f) => f.id !== id)
  const prev = rest[to - 1]
  const next = rest[to]
  let target: number | null = null
  if (rest.every(hasOrder) && (prev || next)) {
    if (prev && next) {
      const m = (prev.order! + next.order!) / 2
      if (m > prev.order! && m < next.order! && next.order! - prev.order! > 1e-6) target = m
    } else target = prev ? prev.order! + ORDER_STEP : next.order! - ORDER_STEP
  }
  const without = ({ rev: _r, ...f }: Folder) => (void _r, f)
  let folders = state.folders
  let seen = vaultMaxRev(state)
  const put = (f: Folder, order: number) => {
    folders = putFolder(folders, { ...without(f), order }, seen, ctx.device, ctx.now)
    seen = folders[f.id].rev
  }
  if (target !== null) put(moved, target)
  else {
    rest.splice(to, 0, moved)
    rest.forEach((f, i) => {
      if (f.order !== (i + 1) * ORDER_STEP) put(f, (i + 1) * ORDER_STEP)
    })
  }
  return { ...state, folders }
}

function existingFolder(state: VaultState, id: string): Folder {
  const f = state.folders?.[id]
  if (!f || f.deleted) throw new Error('目录不存在')
  return f
}

export function renameFolder(state: VaultState, id: string, name: string, ctx: EditCtx): VaultState {
  const f = existingFolder(state, id)
  if (name.trim() === f.name) return state
  const err = checkFolderName(name, state.folders, id)
  if (err) throw new Error(err)
  const { rev: _r, ...rest } = f
  void _r
  return { ...state, folders: putFolder(state.folders, { ...rest, name: name.trim() }, vaultMaxRev(state), ctx.device, ctx.now) }
}

/** 删除目录：只加删除标记，里面的条目变成“未分类”，条目本身不改 */
export function deleteFolder(state: VaultState, id: string, ctx: EditCtx): VaultState {
  const f = existingFolder(state, id)
  const { rev: _r, ...rest } = f
  void _r
  return { ...state, folders: putFolder(state.folders, { ...rest, deleted: true }, vaultMaxRev(state), ctx.device, ctx.now) }
}

/** 界面上显示的条目（未删除），按标题排序 */
export function liveItems(state: VaultState): Item[] {
  return Object.values(state.items).filter((i) => !i.deleted).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

export function trashedItems(state: VaultState): Item[] {
  return Object.values(state.items).filter((i) => i.deleted && !i.purged).sort((a, b) => b.rev.t - a.rev.t)
}

export { HISTORY_MAX }
