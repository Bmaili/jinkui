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

/** 收藏在前，然后按标题（中文按拼音） */
export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.title.localeCompare(b.title, 'zh-CN'))
}

/** 列表里头像显示的字：标题第一个字（英文大写） */
export function initialOf(title: string): string {
  const c = [...title.trim()][0] ?? '?'
  return c.toUpperCase()
}
