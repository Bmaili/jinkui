/**
 * 条目（规格 4.2）。条目就是一个 JSON 对象：已知字段见下，**未知字段原样保留**，
 * 以便新版本加的字段经过旧版本合并、编辑后不丢失。
 */
import type { Rev } from './rev'
import { isRev } from './rev'

export type ItemType = 'login' | 'card' | 'note'

export interface CustomField {
  name: string
  value: string
  /** 显示时打码、复制后自动清空剪贴板 */
  secret?: boolean
}

/** 用户能编辑的内容 */
export interface ItemContent {
  /** 已知类型之外的值原样保留，界面按 login 显示 */
  type: ItemType | (string & {})
  title: string
  username?: string
  password?: string
  urls?: string[]
  notes?: string
  /** otpauth:// 链接或 Base32 密钥（第二阶段才显示动态码） */
  totp?: string
  fields?: CustomField[]
  /** 所在目录的 ID（规格 4.5）；没有、或指向已删除的目录时是“未分类” */
  folder?: string
  /** 1.0.1 的标签，1.0.2 起界面上不再显示，数据原样保留 */
  tags?: string[]
  favorite?: boolean
  [extra: string]: unknown
}

/** 某个版本的完整内容（历史里存的就是这个） */
export interface Snapshot extends ItemContent {
  rev: Rev
  /** 已删除（在“最近删除”里，可以恢复） */
  deleted?: boolean
  /** 彻底删除：内容和历史都已清空，只留下这个标记，防止别的设备把它同步回来 */
  purged?: boolean
}

export interface Item extends Snapshot {
  /** 随机 UUID，与内容无关（云端看不到网站名） */
  id: string
  /** 创建时间（毫秒），不参与合并比较 */
  created: number
  /** 以前的版本，按版本号从新到旧，最多 HISTORY_MAX 个 */
  history?: Snapshot[]
}

export const HISTORY_MAX = 50

/** 不属于“内容”的字段：比较内容、生成快照时去掉 */
const NON_CONTENT = new Set(['id', 'rev', 'history', 'created'])

/** 按键名排序的 JSON，用于比较内容和计算哈希（同样的数据永远得到同样的字符串） */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

/** 内容部分（含 deleted / purged），用来判断两个版本是否“看起来一样” */
export function contentOf(x: Snapshot | Item): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(x)) if (!NON_CONTENT.has(k) && v !== undefined) out[k] = v
  return out
}

export const sameContent = (a: Snapshot | Item, b: Snapshot | Item) => canonicalJson(contentOf(a)) === canonicalJson(contentOf(b))

/** 条目的这个版本，作为历史快照（去掉 id / created / history） */
export function snapshotOf(item: Item | Snapshot): Snapshot {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) if (k !== 'id' && k !== 'created' && k !== 'history' && v !== undefined) out[k] = v
  return out as unknown as Snapshot
}

/** 结构是否能参与合并：有 id、合法的版本号、标题是字符串。其余字段不做要求（宽进，保留未知内容） */
export function isItem(x: unknown): x is Item {
  const i = x as Item
  return !!i && typeof i === 'object' && typeof i.id === 'string' && i.id.length > 0 && isRev(i.rev)
    && typeof i.title === 'string' && typeof i.type === 'string'
    && (i.history === undefined || (Array.isArray(i.history) && i.history.every((h) => !!h && isRev((h as Snapshot).rev))))
}
