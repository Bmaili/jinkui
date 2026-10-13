import { describe, expect, it } from 'vitest'
import { canonicalJson, type Item } from '../src/core/item'
import { mergeItem, mergeItems } from '../src/core/merge'
import { compareRev, nextRev } from '../src/core/rev'
import {
  FormatTooNewError, HISTORY_MAX, TOMBSTONE_TTL, createItem, deleteItem, emptyVault, gcTombstones, liveItems, mergeVaults,
  parseVault, purgeItem, restoreItem, revertTo, trashedItems, updateItem, type VaultState,
} from '../src/core/vault'

const T0 = Date.UTC(2026, 9, 13, 3, 0, 0)

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('版本号', () => {
  it('按时间、计数、设备ID 全序比较', () => {
    expect(compareRev({ t: 1, c: 0, d: 'b' }, { t: 2, c: 0, d: 'a' })).toBeLessThan(0)
    expect(compareRev({ t: 2, c: 1, d: 'a' }, { t: 2, c: 0, d: 'z' })).toBeGreaterThan(0)
    expect(compareRev({ t: 2, c: 0, d: 'a' }, { t: 2, c: 0, d: 'b' })).toBeLessThan(0)
  })

  it('新版本号总比见过的大，即使本机时钟落后', () => {
    const seen = { t: T0 + 3600_000, c: 4, d: 'fast' }
    const r = nextRev(seen, 'slow', T0)
    expect(compareRev(r, seen)).toBeGreaterThan(0)
    expect(nextRev(seen, 'x', T0 + 7200_000)).toEqual({ t: T0 + 7200_000, c: 0, d: 'x' })
  })
})

describe('编辑', () => {
  const ctx = (d = 'A', dt = 0) => ({ device: d, now: T0 + dt })

  it('修改时旧版本进历史，没提到的字段（包括未知字段）保留', () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'GitHub', username: 'me', password: 'p1', future: { x: 1 } }, ctx())
    s = updateItem(s, id, { password: 'p2' }, ctx('A', 1000))
    const it = s.items[id]
    expect(it.password).toBe('p2')
    expect(it.username).toBe('me')
    expect(it.future).toEqual({ x: 1 })
    expect(it.history?.map((h) => h.password)).toEqual(['p1'])
  })

  it('内容没变不产生新版本；值为 undefined 的字段被删掉', () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a', notes: 'n' }, ctx())
    expect(updateItem(s, id, { title: 'a' }, ctx('A', 5))).toBe(s)
    s = updateItem(s, id, { notes: undefined }, ctx('A', 10))
    expect('notes' in s.items[id]).toBe(false)
  })

  it('编辑不能改 id、版本号、历史', () => {
    const { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a' }, ctx())
    const s2 = updateItem(s, id, { title: 'b', id: 'evil', history: [], rev: { t: 0, c: 0, d: 'x' } } as never, ctx('A', 5))
    expect(s2.items[id].id).toBe(id)
    expect(s2.items[id].rev.t).toBe(T0 + 5)
  })

  it('删除进“最近删除”，可以恢复；彻底删除清空内容和历史', () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a', password: 'secret' }, ctx())
    s = deleteItem(s, id, ctx('A', 1))
    expect(liveItems(s)).toHaveLength(0)
    expect(trashedItems(s).map((i) => i.id)).toEqual([id])
    s = restoreItem(s, id, ctx('A', 2))
    expect(liveItems(s)[0].password).toBe('secret')
    s = purgeItem(s, id, ctx('A', 3))
    const it = s.items[id]
    expect(it.purged).toBe(true)
    expect(it.password).toBeUndefined()
    expect(it.history).toBeUndefined()
    expect(trashedItems(s)).toHaveLength(0)
  })

  it('恢复到历史版本', () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a', password: 'old' }, ctx())
    s = updateItem(s, id, { password: 'new' }, ctx('A', 1))
    s = revertTo(s, id, s.items[id].history![0].rev, ctx('A', 2))
    expect(s.items[id].password).toBe('old')
    expect(s.items[id].history!.map((h) => h.password)).toEqual(['new', 'old'])
  })

  it(`历史最多 ${HISTORY_MAX} 个`, () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a', password: '0' }, ctx())
    for (let i = 1; i <= HISTORY_MAX + 10; i++) s = updateItem(s, id, { password: String(i) }, ctx('A', i))
    expect(s.items[id].history).toHaveLength(HISTORY_MAX)
    expect(s.items[id].history![0].password).toBe(String(HISTORY_MAX + 9))
  })

  it('删除标记 180 天后清掉，未删除的不动', () => {
    let { state: s, id } = createItem(emptyVault(), { type: 'login', title: 'a' }, ctx())
    const { state: s2, id: keep } = createItem(s, { type: 'login', title: 'b' }, ctx('A', 1))
    s = deleteItem(s2, id, ctx('A', 2))
    expect(gcTombstones(s, T0 + TOMBSTONE_TTL)).toBe(s)
    const g = gcTombstones(s, T0 + TOMBSTONE_TTL + 10)
    expect(Object.keys(g.items)).toEqual([keep])
  })
})

describe('合并', () => {
  const base = () => createItem(emptyVault(), { type: 'login', title: 'Bank', password: 'p0' }, { device: 'A', now: T0, newId: 'i1' }).state

  it('两台设备同时改同一条：新的当选，另一个进历史，两边结果一样', () => {
    const s0 = base()
    const a = updateItem(s0, 'i1', { password: 'fromA' }, { device: 'A', now: T0 + 100 })
    const b = updateItem(s0, 'i1', { password: 'fromB' }, { device: 'B', now: T0 + 200 })
    const ab = mergeVaults(a, b)
    const ba = mergeVaults(b, a)
    expect(canonicalJson(ab)).toBe(canonicalJson(ba))
    expect(ab.items.i1.password).toBe('fromB')
    expect(ab.items.i1.history!.map((h) => h.password)).toEqual(['fromA', 'p0'])
  })

  it('删除和修改冲突：后发生的当选，另一个仍在历史里', () => {
    const s0 = base()
    const del = deleteItem(s0, 'i1', { device: 'A', now: T0 + 100 })
    const edit = updateItem(s0, 'i1', { password: 'late' }, { device: 'B', now: T0 + 200 })
    const m = mergeVaults(del, edit)
    expect(m.items.i1.deleted).toBeUndefined()
    expect(m.items.i1.password).toBe('late')
    expect(m.items.i1.history!.some((h) => h.deleted)).toBe(true)

    const edit2 = updateItem(s0, 'i1', { password: 'early' }, { device: 'B', now: T0 + 50 })
    const m2 = mergeVaults(edit2, del)
    expect(m2.items.i1.deleted).toBe(true)
    expect(m2.items.i1.history!.map((h) => h.password)).toContain('early')
  })

  it('彻底删除后，别的设备带来的历史也不保留', () => {
    const s0 = updateItem(base(), 'i1', { password: 'p1' }, { device: 'A', now: T0 + 10 })
    const purged = purgeItem(s0, 'i1', { device: 'A', now: T0 + 20 })
    const m = mergeVaults(s0, purged)
    expect(m.items.i1.purged).toBe(true)
    expect(m.items.i1.history).toBeUndefined()
    expect(JSON.stringify(m)).not.toContain('p1')
  })

  it('满足交换律、结合律、幂等（随机测试）', () => {
    const r = rng(42)
    const devices = ['A', 'B', 'C']
    for (let round = 0; round < 200; round++) {
      // 三台设备从同一个起点各自随机改几次
      const start = base()
      const states = devices.map((d, k) => {
        let s = start
        const n = 1 + Math.floor(r() * 4)
        for (let i = 0; i < n; i++) {
          const now = T0 + Math.floor(r() * 1000)
          const x = r()
          if (x < 0.15) s = deleteItem(s, 'i1', { device: d, now })
          else if (x < 0.25) s = restoreItem(s, 'i1', { device: d, now })
          else if (x < 0.3) s = createItem(s, { type: 'login', title: `${d}${i}` }, { device: d, now, newId: `${d}-${round}-${i}` }).state
          else s = updateItem(s, 'i1', { password: `${d}${k}-${i}-${Math.floor(r() * 3)}` }, { device: d, now })
        }
        return s
      })
      const [a, b, c] = states
      const j = (s: VaultState) => canonicalJson(s)
      expect(j(mergeVaults(a, b))).toBe(j(mergeVaults(b, a)))
      expect(j(mergeVaults(mergeVaults(a, b), c))).toBe(j(mergeVaults(a, mergeVaults(b, c))))
      const all = mergeVaults(mergeVaults(a, b), c)
      expect(j(mergeVaults(all, all))).toBe(j(all))
      expect(j(mergeVaults(all, a))).toBe(j(all))
      // 没有任何一个版本消失：每台设备的当前值，要么是合并后的当前值，要么在历史里
      for (const s of states) {
        const mine = s.items.i1
        const merged = all.items.i1
        const revs = [merged.rev, ...(merged.history ?? []).map((h) => h.rev)].map((x) => `${x.t}.${x.c}.${x.d}`)
        expect(revs).toContain(`${mine.rev.t}.${mine.rev.c}.${mine.rev.d}`)
      }
    }
  })

  it('同一版本号内容却不同（被手工改过）时，各设备仍得到同样结果', () => {
    const s0 = base().items.i1
    const x: Item = { ...s0, password: 'x' }
    const y: Item = { ...s0, password: 'y' }
    expect(canonicalJson(mergeItem(x, y))).toBe(canonicalJson(mergeItem(y, x)))
  })

  it('只在一边存在的条目直接并入', () => {
    const a = createItem(emptyVault(), { type: 'note', title: 'n' }, { device: 'A', now: T0, newId: 'a' }).state
    const b = createItem(emptyVault(), { type: 'login', title: 'l' }, { device: 'B', now: T0, newId: 'b' }).state
    expect(Object.keys(mergeItems(a.items, b.items)).sort()).toEqual(['a', 'b'])
  })
})

describe('解析', () => {
  it('格式版本比 app 新时拒绝', () => {
    expect(() => parseVault({ format: 2, items: {} })).toThrow(FormatTooNewError)
  })

  it('结构不对的条目跳过并报告，其余正常；未知顶层字段保留', () => {
    const good = base1()
    const { state, skipped } = parseVault({ format: 1, items: { ...good.items, bad: { id: 'bad' }, wrongKey: { ...good.items.i1 } }, extra: 7 })
    expect(Object.keys(state.items)).toEqual(['i1'])
    expect(skipped.sort()).toEqual(['bad', 'wrongKey'])
    expect(state.extra).toBe(7)
  })
})

function base1() {
  return createItem(emptyVault(), { type: 'login', title: 'x' }, { device: 'A', now: T0, newId: 'i1' }).state
}
