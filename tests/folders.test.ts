import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/core/item'
import { folderOf, liveFolders } from '../src/core/folders'
import {
  createFolder, createItem, deleteFolder, emptyVault, gcTombstones, mergeVaults, moveFolder, parseVault, renameFolder, TOMBSTONE_TTL, updateItem,
  type VaultState,
} from '../src/core/vault'

const T0 = Date.UTC(2026, 9, 13, 3, 0, 0)
const ctx = (d: string, dt = 0, newId?: string) => ({ device: d, now: T0 + dt, newId })

describe('目录', () => {
  it('新建、改名、删除；同名拒绝；删除后条目算未分类，条目本身不变', () => {
    let { state: s, id } = createFolder(emptyVault(), '工作', ctx('A', 0, 'f1'))
    expect(() => createFolder(s, ' 工作 ', ctx('A', 1))).toThrow('同名')
    expect(() => createFolder(s, '', ctx('A', 1))).toThrow('目录名')
    s = renameFolder(s, id, '公司', ctx('A', 2))
    expect(liveFolders(s.folders).map((f) => f.name)).toEqual(['公司'])
    const r = createItem(s, { type: 'login', title: '邮箱', folder: id }, ctx('A', 3, 'i1'))
    s = r.state
    expect(folderOf(s.folders, s.items.i1.folder)?.name).toBe('公司')
    const before = canonicalJson(s.items)
    s = deleteFolder(s, id, ctx('A', 4))
    expect(liveFolders(s.folders)).toEqual([])
    expect(folderOf(s.folders, s.items.i1.folder)).toBeNull()
    expect(canonicalJson(s.items)).toBe(before)
    // 删除后可以再建同名目录
    expect(() => createFolder(s, '公司', ctx('A', 5))).not.toThrow()
  })

  it('目录的版本号排在条目之后：新操作总比见过的新', () => {
    let s = createItem(emptyVault(), { type: 'login', title: 'x' }, ctx('A', 1000, 'i1')).state
    s = createFolder(s, '甲', ctx('A', 0, 'f1')).state // 时钟倒退
    expect(s.folders!.f1.rev.t).toBe(T0 + 1000)
    expect(s.folders!.f1.rev.c).toBe(1)
  })

  it('两台设备同时改名、一边删一边改名：后发生的当选，两边结果一样', () => {
    const base = createFolder(emptyVault(), '旧名', ctx('A', 0, 'f1')).state
    const a = renameFolder(base, 'f1', '甲', ctx('A', 10))
    const b = renameFolder(base, 'f1', '乙', ctx('B', 20))
    expect(canonicalJson(mergeVaults(a, b))).toBe(canonicalJson(mergeVaults(b, a)))
    expect(mergeVaults(a, b).folders!.f1.name).toBe('乙')
    const del = deleteFolder(base, 'f1', ctx('A', 30))
    expect(mergeVaults(b, del).folders!.f1.deleted).toBe(true)
  })

  it('旧数据（没有目录）合并后不会多出空的 folders 字段；一边有目录时合并进来', () => {
    const old = createItem(emptyVault(), { type: 'login', title: 'x' }, ctx('A', 0, 'i1')).state
    expect('folders' in mergeVaults(old, old)).toBe(false)
    const withF = createFolder(old, '甲', ctx('B', 5, 'f1')).state
    expect(mergeVaults(old, withF).folders!.f1.name).toBe('甲')
    expect(mergeVaults(withF, old).folders!.f1.name).toBe('甲')
  })

  it('解析：结构不对的目录跳过并报告', () => {
    const s = createFolder(emptyVault(), '甲', ctx('A', 0, 'f1')).state
    const { state, skipped } = parseVault({ ...s, folders: { ...s.folders, bad: { id: 'bad' } } })
    expect(Object.keys(state.folders!)).toEqual(['f1'])
    expect(skipped).toEqual(['folder:bad'])
  })

  it('删除标记 180 天后清掉', () => {
    let s = createFolder(emptyVault(), '甲', ctx('A', 0, 'f1')).state
    s = deleteFolder(s, 'f1', ctx('A', 1))
    expect(gcTombstones(s, T0 + TOMBSTONE_TTL).folders!.f1).toBeDefined()
    expect(gcTombstones(s, T0 + TOMBSTONE_TTL + 10).folders).toEqual({})
  })

  it('把条目移到目录是一次条目修改，旧位置进历史', () => {
    let s = createFolder(emptyVault(), '甲', ctx('A', 0, 'f1')).state
    s = createItem(s, { type: 'login', title: 'x' }, ctx('A', 1, 'i1')).state
    s = updateItem(s, 'i1', { folder: 'f1' }, ctx('A', 2))
    expect(s.items.i1.folder).toBe('f1')
    expect(s.items.i1.history![0].folder).toBeUndefined()
  })

  it('满足交换律、结合律、幂等（含目录的随机测试）', () => {
    let seed = 99
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    for (let round = 0; round < 200; round++) {
      let start = createFolder(emptyVault(), '共同', ctx('A', 0, 'f0')).state
      start = createItem(start, { type: 'login', title: 'x' }, ctx('A', 1, 'i1')).state
      const states = ['A', 'B', 'C'].map((d) => {
        let s: VaultState = start
        const n = 1 + Math.floor(r() * 5)
        for (let i = 0; i < n; i++) {
          const now = 10 + Math.floor(r() * 1000)
          const x = r()
          const live = liveFolders(s.folders)
          try {
            if (x < 0.25) s = createFolder(s, `${d}${round}-${i}`, ctx(d, now, `${d}-${round}-${i}`)).state
            else if (x < 0.5 && live.length) s = renameFolder(s, live[Math.floor(r() * live.length)].id, `${d}改${i}-${round}`, ctx(d, now))
            else if (x < 0.65 && live.length) s = deleteFolder(s, live[Math.floor(r() * live.length)].id, ctx(d, now))
            else {
              const target = live.length ? live[Math.floor(r() * live.length)].id : undefined
              s = updateItem(s, 'i1', { folder: target, notes: `${d}${i}` }, ctx(d, now))
            }
          } catch { /* 随机出了同名，跳过 */ }
        }
        return s
      })
      const [a, b, c] = states
      const j = (s: VaultState) => canonicalJson(s)
      expect(j(mergeVaults(a, b))).toBe(j(mergeVaults(b, a)))
      expect(j(mergeVaults(mergeVaults(a, b), c))).toBe(j(mergeVaults(a, mergeVaults(b, c))))
      const all = mergeVaults(mergeVaults(a, b), c)
      expect(j(mergeVaults(all, all))).toBe(j(all))
      expect(j(mergeVaults(all, c))).toBe(j(all))
    }
  })
})

describe('目录顺序（1.0.7）', () => {
  const names = (s: VaultState) => liveFolders(s.folders).map((f) => f.name)
  const setup = () => {
    let s = emptyVault()
    for (const [n, id] of [['乙', 'f2'], ['甲', 'f1'], ['丙', 'f3']]) s = createFolder(s, n, ctx('A', 0, id)).state
    return s
  }

  it('没拖动过时按名字排，和老版本一样；新建也不带位置', () => {
    const s = setup()
    expect(names(s)).toEqual(['丙', '甲', '乙'])
    expect(Object.values(s.folders!).some((f) => 'order' in f)).toBe(false)
  })

  it('第一次拖动给全部目录编号；之后拖动只改被拖的那一个；新建的放最后', () => {
    let s = moveFolder(setup(), 'f2', 0, ctx('A', 10))
    expect(names(s)).toEqual(['乙', '丙', '甲'])
    expect(Object.values(s.folders!).every((f) => typeof f.order === 'number')).toBe(true)
    const before = { ...s.folders! }
    s = moveFolder(s, 'f1', 1, ctx('A', 20))
    expect(names(s)).toEqual(['乙', '甲', '丙'])
    const changed = Object.keys(s.folders!).filter((id) => s.folders![id] !== before[id])
    expect(changed).toEqual(['f1'])
    s = createFolder(s, '丁', ctx('A', 30, 'f4')).state
    expect(names(s)).toEqual(['乙', '甲', '丙', '丁'])
    expect(moveFolder(s, 'f4', 3, ctx('A', 40))).toBe(s)
  })

  it('间隔用完了会全部重新编号，顺序仍然对', () => {
    let s = moveFolder(setup(), 'f1', 0, ctx('A', 1))
    for (let i = 0; i < 80; i++) {
      const list = liveFolders(s.folders)
      s = moveFolder(s, list[2].id, 1, ctx('A', 2 + i))
      const want = [list[0], list[2], list[1]].map((f) => f.name)
      expect(names(s)).toEqual(want)
    }
  })

  it('老版本新建的目录（没有位置）排在后面按名字排；改名保留位置', () => {
    let s = moveFolder(setup(), 'f3', 2, ctx('A', 1))
    s = { ...s, folders: { ...s.folders, old: { id: 'old', name: '阿', rev: { t: T0 + 5, c: 0, d: 'B' } } } }
    expect(names(s).at(-1)).toBe('阿')
    const order = s.folders!.f1.order
    s = renameFolder(s, 'f1', '甲甲', ctx('A', 10))
    expect(s.folders!.f1.order).toBe(order)
  })

  it('两台设备各拖各的目录：两个改动都保留；拖同一个目录时后拖的当选，两边一样', () => {
    const base = moveFolder(setup(), 'f1', 0, ctx('A', 1)) // 甲 丙 乙
    const a = moveFolder(base, 'f2', 0, ctx('A', 10)) // 乙 甲 丙
    const b = moveFolder(base, 'f3', 0, ctx('B', 20)) // 丙 甲 乙
    const m = mergeVaults(a, b)
    expect(canonicalJson(m)).toBe(canonicalJson(mergeVaults(b, a)))
    expect(m.folders!.f2.order).toBe(a.folders!.f2.order)
    expect(m.folders!.f3.order).toBe(b.folders!.f3.order)
    const a2 = moveFolder(base, 'f2', 0, ctx('A', 30))
    const b2 = moveFolder(base, 'f2', 1, ctx('B', 40))
    expect(names(mergeVaults(a2, b2))).toEqual(names(b2))
  })

  it('随机拖动、改名、删除：交换律、结合律、幂等', () => {
    let seed = 7
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    for (let round = 0; round < 200; round++) {
      const start = setup()
      const [a, b, c] = ['A', 'B', 'C'].map((d) => {
        let s: VaultState = start
        for (let i = 0; i < 1 + Math.floor(r() * 6); i++) {
          const now = 10 + Math.floor(r() * 1000)
          const live = liveFolders(s.folders)
          const x = r()
          try {
            if (x < 0.5 && live.length) s = moveFolder(s, live[Math.floor(r() * live.length)].id, Math.floor(r() * live.length), ctx(d, now))
            else if (x < 0.7) s = createFolder(s, `${d}${round}-${i}`, ctx(d, now, `${d}-${round}-${i}`)).state
            else if (x < 0.85 && live.length) s = renameFolder(s, live[Math.floor(r() * live.length)].id, `${d}改${i}-${round}`, ctx(d, now))
            else if (live.length) s = deleteFolder(s, live[Math.floor(r() * live.length)].id, ctx(d, now))
          } catch { /* 同名，跳过 */ }
        }
        return s
      })
      const j = (s: VaultState) => canonicalJson(s)
      expect(j(mergeVaults(a, b))).toBe(j(mergeVaults(b, a)))
      expect(j(mergeVaults(mergeVaults(a, b), c))).toBe(j(mergeVaults(a, mergeVaults(b, c))))
      const all = mergeVaults(mergeVaults(a, b), c)
      expect(j(mergeVaults(all, all))).toBe(j(all))
      // 显示顺序只取决于合并结果
      expect(names(mergeVaults(c, mergeVaults(b, a)))).toEqual(names(all))
    }
  })
})
