/**
 * 合并（规格 5.2）。
 *
 * 把一个条目的所有版本看成一个集合：版本号最大的是当前值，其余（去掉当前值后按版本号从新到旧，最多 HISTORY_MAX 个）
 * 是历史。合并就是取并集，所以满足交换律、结合律、幂等：
 * 不管各设备以什么顺序、合并多少次，最后都得到同样的结果，而且**任何一方的修改都不会悄悄消失**——
 * 输掉的版本一定出现在历史里。
 *
 * 唯一的例外是“彻底删除”（purged）：当前值是彻底删除时，历史清空。
 */
import { HISTORY_MAX, canonicalJson, snapshotOf, type Item, type Snapshot } from './item'
import { compareRev, revKey } from './rev'

/** 同一个版本号却内容不同（正常不会出现，只可能是文件被手工改过）：按内容字符串决定，保证各设备结果一致 */
function pickSameRev(a: Item, b: Item): Item {
  return canonicalJson(a) >= canonicalJson(b) ? a : b
}

export function mergeItem(a: Item, b: Item): Item {
  const c = compareRev(a.rev, b.rev)
  const winner = c > 0 ? a : c < 0 ? b : pickSameRev(a, b)
  const all: Snapshot[] = [snapshotOf(a), snapshotOf(b), ...(a.history ?? []), ...(b.history ?? [])]
  const history = winner.purged ? [] : normalizeHistory(all, winner)
  const { history: _drop, ...rest } = winner
  void _drop
  return history.length ? { ...rest, history } : (rest as Item)
}

/** 去掉当前版本、按版本号去重、从新到旧排序、截断 */
export function normalizeHistory(snaps: Snapshot[], current: { rev: Item['rev'] }): Snapshot[] {
  const cur = revKey(current.rev)
  const byKey = new Map<string, Snapshot>()
  for (const s of snaps) {
    const k = revKey(s.rev)
    if (k === cur) continue
    const prev = byKey.get(k)
    // 同版本号内容不同时同样按内容字符串决定
    if (!prev || canonicalJson(s) > canonicalJson(prev)) byKey.set(k, s)
  }
  return [...byKey.values()].sort((x, y) => compareRev(y.rev, x.rev)).slice(0, HISTORY_MAX)
}

/** 合并两组条目（按 id 取并集，同 id 的用 mergeItem） */
export function mergeItems(a: Record<string, Item>, b: Record<string, Item>): Record<string, Item> {
  const out: Record<string, Item> = { ...a }
  for (const [id, item] of Object.entries(b)) out[id] = out[id] ? mergeItem(out[id], item) : item
  return out
}
