/**
 * 目录（规格 4.5）。保险库顶层的 folders：目录ID → 目录。条目用 folder 字段指向目录ID。
 *
 * 合并规则和条目一样按版本号取新（新建、改名、删除都是一次修改），满足交换律、结合律、幂等。
 * 目录没有历史：改名、删除丢失的只是一个名字，条目本身不受影响。
 * 删除目录只是加删除标记，不去改里面的条目：条目指向的目录不存在或已删除时，当作“未分类”。
 * 这样删除目录不会给每个条目都产生一次修改，也不会和别的设备上对这些条目的修改冲突。
 */
import { canonicalJson } from './item'
import { compareRev, isRev, nextRev, type Rev } from './rev'

export interface Folder {
  id: string
  name: string
  rev: Rev
  deleted?: boolean
  /** 未知字段原样保留 */
  [extra: string]: unknown
}

export type Folders = Record<string, Folder>

export const MAX_FOLDER_NAME = 20

export function isFolder(x: unknown): x is Folder {
  const f = x as Folder
  return !!f && typeof f === 'object' && typeof f.id === 'string' && f.id.length > 0 && typeof f.name === 'string' && isRev(f.rev)
}

export function mergeFolder(a: Folder, b: Folder): Folder {
  const c = compareRev(a.rev, b.rev)
  if (c !== 0) return c > 0 ? a : b
  return canonicalJson(a) >= canonicalJson(b) ? a : b
}

export function mergeFolders(a: Folders = {}, b: Folders = {}): Folders {
  const out: Folders = { ...a }
  for (const [id, f] of Object.entries(b)) out[id] = out[id] ? mergeFolder(out[id], f) : f
  return out
}

/** 没删除的目录，按名字排序（中文按拼音） */
export function liveFolders(folders: Folders = {}): Folder[] {
  return Object.values(folders).filter((f) => !f.deleted).sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'))
}

/** 条目实际所在的目录：指向的目录不存在或已删除时返回 null（未分类） */
export function folderOf(folders: Folders | undefined, folderId: unknown): Folder | null {
  if (typeof folderId !== 'string' || !folderId) return null
  const f = folders?.[folderId]
  return f && !f.deleted ? f : null
}

export function checkFolderName(name: string, folders: Folders = {}, exceptId?: string): string | null {
  const n = name.trim()
  if (!n) return '请输入目录名'
  if ([...n].length > MAX_FOLDER_NAME) return `目录名最多 ${MAX_FOLDER_NAME} 个字`
  const dup = liveFolders(folders).some((f) => f.id !== exceptId && f.name.trim().toLowerCase() === n.toLowerCase())
  return dup ? '已经有同名的目录了' : null
}

export function putFolder(folders: Folders = {}, f: { id: string; name: string; deleted?: boolean; [extra: string]: unknown }, seen: Rev | null, device: string, now?: number): Folders {
  return { ...folders, [f.id]: { ...f, rev: nextRev(seen, device, now) } as Folder }
}
