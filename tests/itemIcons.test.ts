import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/core/item'
import { iconOfItem, isIconData, MAX_ICON_DATA } from '../src/core/itemIcons'
import {
  TOMBSTONE_TTL, createItem, deleteItem, emptyVault, gcTombstones, mergeVaults, parseVault, purgeItem, restoreItem, setItemIcon, updateItem,
  vaultMaxRev, type VaultState,
} from '../src/core/vault'
import { compareRev } from '../src/core/rev'

const T0 = Date.UTC(2026, 9, 21, 3, 0, 0)
const ctx = (d: string, dt = 0, newId?: string) => ({ device: d, now: T0 + dt, newId })
const img = (s: string) => `data:image/webp;base64,${btoa(s)}`
const base = () => createItem(emptyVault(), { type: 'login', title: '某银行', password: 'p' }, ctx('A', 0, 'i1')).state

describe('条目图标', () => {
  it('设置、更换、恢复默认；和现在一样时不产生修改', () => {
    let s = setItemIcon(base(), 'i1', img('a'), ctx('A', 1))
    expect(iconOfItem(s.icons, 'i1')).toBe(img('a'))
    expect(setItemIcon(s, 'i1', img('a'), ctx('A', 2))).toBe(s)
    s = setItemIcon(s, 'i1', img('b'), ctx('A', 3))
    expect(iconOfItem(s.icons, 'i1')).toBe(img('b'))
    s = setItemIcon(s, 'i1', null, ctx('A', 4))
    expect(iconOfItem(s.icons, 'i1')).toBeUndefined()
    expect(s.icons!.i1).toMatchObject({ deleted: true })
    expect(s.icons!.i1.data).toBeUndefined()
    expect(setItemIcon(s, 'i1', null, ctx('A', 5))).toBe(s)
    expect(setItemIcon(base(), 'i1', null, ctx('A', 5)).icons).toBeUndefined()
  })

  it('设置图标不改条目本身（不产生条目历史）', () => {
    const s0 = base()
    const s = setItemIcon(s0, 'i1', img('a'), ctx('A', 1))
    expect(s.items).toBe(s0.items)
  })

  it('只收小的 WebP / PNG / JPEG 的 data 地址', () => {
    expect(isIconData(img('x'))).toBe(true)
    expect(isIconData('data:image/png;base64,AAAA')).toBe(true)
    expect(isIconData('data:image/svg+xml;base64,AAAA')).toBe(false)
    expect(isIconData('https://example.com/a.png')).toBe(false)
    expect(isIconData(`data:image/png;base64,${'A'.repeat(MAX_ICON_DATA)}`)).toBe(false)
    expect(() => setItemIcon(base(), 'i1', 'data:image/svg+xml;base64,AAAA', ctx('A', 1))).toThrow()
  })

  it('版本号排在条目之后：时钟倒退也比见过的新', () => {
    const s = setItemIcon(base(), 'i1', img('a'), ctx('A', -5000))
    expect(compareRev(s.icons!.i1.rev, s.items.i1.rev)).toBeGreaterThan(0)
    expect(vaultMaxRev(s)).toEqual(s.icons!.i1.rev)
  })

  it('两台设备同时换图标：后换的当选，两边结果一样；恢复默认也一样参与比较', () => {
    const s0 = base()
    const a = setItemIcon(s0, 'i1', img('a'), ctx('A', 10))
    const b = setItemIcon(s0, 'i1', img('b'), ctx('B', 20))
    expect(canonicalJson(mergeVaults(a, b))).toBe(canonicalJson(mergeVaults(b, a)))
    expect(iconOfItem(mergeVaults(a, b).icons, 'i1')).toBe(img('b'))
    const cleared = setItemIcon(b, 'i1', null, ctx('B', 30))
    expect(iconOfItem(mergeVaults(a, cleared).icons, 'i1')).toBeUndefined()
  })

  it('放进最近删除时保留图标（可以恢复）；彻底删除时一起清掉', () => {
    let s = setItemIcon(base(), 'i1', img('a'), ctx('A', 1))
    s = deleteItem(s, 'i1', ctx('A', 2))
    expect(iconOfItem(s.icons, 'i1')).toBe(img('a'))
    s = restoreItem(s, 'i1', ctx('A', 3))
    expect(iconOfItem(s.icons, 'i1')).toBe(img('a'))
    const before = s
    s = purgeItem(s, 'i1', ctx('A', 4))
    expect(iconOfItem(s.icons, 'i1')).toBeUndefined()
    // 别的设备还带着旧图标：合并后也不会回来
    expect(iconOfItem(mergeVaults(before, s).icons, 'i1')).toBeUndefined()
    expect(JSON.stringify(mergeVaults(s, before).icons)).not.toContain(img('a').slice(-8))
  })

  it('删除标记 180 天后清掉；条目已经不在的图标也清掉', () => {
    let s = setItemIcon(base(), 'i1', img('a'), ctx('A', 1))
    s = setItemIcon(s, 'i1', null, ctx('A', 2))
    expect(gcTombstones(s, T0 + TOMBSTONE_TTL).icons!.i1).toBeDefined()
    expect(gcTombstones(s, T0 + TOMBSTONE_TTL + 10).icons).toEqual({})
    let t = setItemIcon(base(), 'i1', img('a'), ctx('A', 1))
    t = deleteItem(t, 'i1', ctx('A', 2))
    expect(gcTombstones(t, T0 + TOMBSTONE_TTL + 10)).toMatchObject({ items: {}, icons: {} })
  })

  it('旧数据（没有图标）合并后不会多出空的 icons 字段；解析时结构不对的跳过并报告', () => {
    const old = base()
    expect('icons' in mergeVaults(old, old)).toBe(false)
    const withI = setItemIcon(old, 'i1', img('a'), ctx('B', 5))
    expect(iconOfItem(mergeVaults(old, withI).icons, 'i1')).toBe(img('a'))
    expect(iconOfItem(mergeVaults(withI, old).icons, 'i1')).toBe(img('a'))
    const { state, skipped } = parseVault({
      ...withI,
      icons: { ...withI.icons, bad: { id: 'bad' }, svg: { id: 'svg', data: 'data:image/svg+xml;base64,AA', rev: withI.icons!.i1.rev }, wrong: withI.icons!.i1 },
    })
    expect(Object.keys(state.icons!)).toEqual(['i1'])
    expect(skipped.sort()).toEqual(['icon:bad', 'icon:svg', 'icon:wrong'])
  })

  it('未知字段原样保留', () => {
    const s = setItemIcon(base(), 'i1', img('a'), ctx('A', 1))
    const future: VaultState = { ...s, icons: { i1: { ...s.icons!.i1, crop: 3 } } }
    const s2 = setItemIcon(parseVault(future).state, 'i1', img('b'), ctx('A', 2))
    expect(s2.icons!.i1.crop).toBe(3)
  })

  it('满足交换律、结合律、幂等（含图标的随机测试）', () => {
    let seed = 7
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    for (let round = 0; round < 300; round++) {
      let start = base()
      start = createItem(start, { type: 'login', title: 'y' }, ctx('A', 1, 'i2')).state
      const states = ['A', 'B', 'C'].map((d) => {
        let s: VaultState = start
        const n = 1 + Math.floor(r() * 5)
        for (let i = 0; i < n; i++) {
          const now = 10 + Math.floor(r() * 1000)
          // i1：条目修改、删除和图标交错；i2：只有 A 会彻底删除它，其他设备不知情地给它换图标
          const id = r() < 0.5 ? 'i1' : 'i2'
          const x = r()
          if (s.items[id].purged) continue
          if (x < 0.4) s = setItemIcon(s, id, img(`${d}${i}${Math.floor(r() * 3)}`), ctx(d, now))
          else if (x < 0.55) s = setItemIcon(s, id, null, ctx(d, now))
          else if (id === 'i2') { if (d === 'A') s = purgeItem(s, id, ctx(d, now)) }
          else if (x < 0.7) s = deleteItem(s, id, ctx(d, now))
          else if (x < 0.8) s = restoreItem(s, id, ctx(d, now))
          else s = updateItem(s, id, { notes: `${d}${i}` }, ctx(d, now))
        }
        return s
      })
      const [a, b, c] = states
      const j = (s: VaultState) => canonicalJson(s)
      expect(j(mergeVaults(a, b))).toBe(j(mergeVaults(b, a)))
      expect(j(mergeVaults(mergeVaults(a, b), c))).toBe(j(mergeVaults(a, mergeVaults(b, c))))
      const all = mergeVaults(mergeVaults(a, b), c)
      expect(j(mergeVaults(all, all))).toBe(j(all))
      expect(j(mergeVaults(all, b))).toBe(j(all))
      // 彻底删除的条目，清理后不会有图标（即使别的设备不知情又设了一个）
      const g = gcTombstones(all, T0)
      for (const id of ['i1', 'i2']) if (all.items[id].purged) expect(g.icons?.[id]).toBeUndefined()
    }
  })
})
