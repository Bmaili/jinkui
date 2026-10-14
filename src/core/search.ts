/** 搜索（规格 5.5）：按空格分词，每个词都要在标题、用户名、网址、备注、标签、自定义字段名里出现（不区分大小写）。 */
import type { Item } from './item'

const hay = (it: Item) =>
  [it.title, it.username ?? '', ...(it.urls ?? []), it.notes ?? '', ...(it.tags ?? []), ...(it.fields ?? []).map((f) => f.name)]
    .join('\n')
    .toLowerCase()

export function searchItems(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return sortItems(items)
  const hits = items.filter((it) => {
    const h = hay(it)
    return words.every((w) => h.includes(w))
  })
  // 标题里命中的排前面
  const inTitle = (it: Item) => words.every((w) => it.title.toLowerCase().includes(w))
  return sortItems(hits).sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)))
}

/** 列表的排序方式（1.0.7 起每个目录各自选，只存在本机） */
export type SortMode = 'name' | 'used' | 'modified' | 'created'
export const SORT_MODES: { mode: SortMode; label: string; hint: string }[] = [
  { mode: 'name', label: '名称', hint: '按标题，中文按拼音' },
  { mode: 'used', label: '最近使用', hint: '最近打开过、自动填充过的在前' },
  { mode: 'modified', label: '最近修改', hint: '最近改过的在前（包括别的设备上改的）' },
  { mode: 'created', label: '添加时间', hint: '最新添加的在前' },
]
export const isSortMode = (m: unknown): m is SortMode => SORT_MODES.some((x) => x.mode === m)

/**
 * 收藏总在最前，其余按排序方式；时间相同（或从没用过）的按标题。
 * used：条目ID → 最近使用的时间（本机记录）
 */
export function sortItems(items: Item[], mode: SortMode = 'name', used: Record<string, number> = {}): Item[] {
  const key = (it: Item): number =>
    mode === 'used' ? used[it.id] ?? 0 : mode === 'modified' ? it.rev?.t ?? 0 : mode === 'created' ? it.created ?? 0 : 0
  return [...items].sort(
    (a, b) => Number(!!b.favorite) - Number(!!a.favorite) || key(b) - key(a) || a.title.localeCompare(b.title, 'zh-CN'),
  )
}

/** 列表里头像显示的字：标题第一个字（英文大写） */
export function initialOf(title: string): string {
  const c = [...title.trim()][0] ?? '?'
  return c.toUpperCase()
}
