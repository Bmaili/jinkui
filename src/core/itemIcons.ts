/**
 * 条目的自定义图标（1.0.8 起，规格 4.6）。保险库顶层的 icons：条目ID → 图标。
 *
 * 不放进条目本身：条目每改一次，旧版本整个进历史（最多 50 个），图片会被复制几十份。
 * 合并规则和目录一样按版本号取新，满足交换律、结合律、幂等。图标没有历史：换掉的只是一张小图。
 * “恢复默认”和条目彻底删除都是加删除标记（去掉图片），防止别的设备把旧图同步回来。
 */
import { canonicalJson } from './item'
import { compareRev, isRev, nextRev, type Rev } from './rev'

export interface ItemIcon {
  /** 条目ID */
  id: string
  /** data:image/webp|png|jpeg;base64,…；删除标记没有 */
  data?: string
  rev: Rev
  deleted?: boolean
  /** 未知字段原样保留 */
  [extra: string]: unknown
}

export type ItemIcons = Record<string, ItemIcon>

/** 存进保险库的图标边长（像素）。列表里显示 38px，高分屏上要 96 才清楚 */
export const ICON_SIZE = 96
/** 单个图标 data 地址的最大长度（96×96 的 WebP 一般 3–8 KB） */
export const MAX_ICON_DATA = 24 * 1024

const DATA_RE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/

export function isIconData(x: unknown): x is string {
  return typeof x === 'string' && x.length <= MAX_ICON_DATA && DATA_RE.test(x)
}

export function isItemIcon(x: unknown): x is ItemIcon {
  const i = x as ItemIcon
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !i.id || !isRev(i.rev)) return false
  return i.deleted === true ? i.data === undefined : isIconData(i.data)
}

export function mergeIcon(a: ItemIcon, b: ItemIcon): ItemIcon {
  const c = compareRev(a.rev, b.rev)
  if (c !== 0) return c > 0 ? a : b
  return canonicalJson(a) >= canonicalJson(b) ? a : b
}

export function mergeIcons(a: ItemIcons = {}, b: ItemIcons = {}): ItemIcons {
  const out: ItemIcons = { ...a }
  for (const [id, i] of Object.entries(b)) out[id] = out[id] ? mergeIcon(out[id], i) : i
  return out
}

/** 条目当前的自定义图标；没有或已恢复默认返回 undefined */
export function iconOfItem(icons: ItemIcons | undefined, id: string): string | undefined {
  const i = icons?.[id]
  return i && !i.deleted && isIconData(i.data) ? i.data : undefined
}

/** 设置（data 有值）或清除（data 为 null）一个条目的图标 */
export function putIcon(icons: ItemIcons = {}, id: string, data: string | null, seen: Rev | null, device: string, now?: number): ItemIcons {
  const prev = icons[id]
  const { rev: _r, data: _d, deleted: _x, ...extra } = prev ?? ({} as Partial<ItemIcon>)
  void _r, void _d, void _x
  const rev = nextRev(seen, device, now)
  const next: ItemIcon = data === null ? { ...extra, id, rev, deleted: true } : { ...extra, id, data, rev }
  return { ...icons, [id]: next }
}
