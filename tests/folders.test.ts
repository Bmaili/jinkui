import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/core/item'
import { folderOf, liveFolders } from '../src/core/folders'
import {
  createFolder, createItem, deleteFolder, emptyVault, gcTombstones, mergeVaults, parseVault, renameFolder, TOMBSTONE_TTL, updateItem,
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
