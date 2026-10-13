import { describe, expect, it } from 'vitest'
import { utf8, fromUtf8 } from '../src/core/bytes'
import { SlotStore, type RawStore } from '../src/core/slots'

class MemRaw implements RawStore {
  files = new Map<string, Uint8Array>()
  /** 下一次写入只写进去前 n 个字节（模拟写到一半断电） */
  tearNext: number | null = null
  async read(p: string) {
    return this.files.get(p)?.slice() ?? null
  }
  async write(p: string, b: Uint8Array) {
    if (this.tearNext != null) {
      this.files.set(p, b.slice(0, this.tearNext))
      this.tearNext = null
      throw new Error('断电')
    }
    this.files.set(p, b.slice())
  }
  async remove(p: string) {
    this.files.delete(p)
  }
}

const text = async (s: SlotStore, n: string) => {
  const b = await s.read(n)
  return b && fromUtf8(b)
}

describe('双槽写入', () => {
  it('读到最新写入的内容，两个槽位轮流写', async () => {
    const raw = new MemRaw()
    const s = new SlotStore(raw)
    expect(await s.read('v')).toBeNull()
    await s.write('v', utf8('one'))
    await s.write('v', utf8('two'))
    await s.write('v', utf8('three'))
    expect(await text(s, 'v')).toBe('three')
    expect([...raw.files.keys()].sort()).toEqual(['v.0', 'v.1'])
    // 换一个实例（重启 app）也读得到
    expect(await text(new SlotStore(raw), 'v')).toBe('three')
  })

  it('写到一半断电：读到上一份完整的', async () => {
    const raw = new MemRaw()
    const s = new SlotStore(raw)
    await s.write('v', utf8('good-1'))
    await s.write('v', utf8('good-2'))
    raw.tearNext = 20
    await expect(s.write('v', utf8('broken-3'))).rejects.toThrow('断电')
    expect(await text(new SlotStore(raw), 'v')).toBe('good-2')
    // 断电后接着写，不会覆盖掉 good-2 所在的槽位之外的东西出错
    const s2 = new SlotStore(raw)
    await s2.write('v', utf8('good-4'))
    expect(await text(new SlotStore(raw), 'v')).toBe('good-4')
  })

  it('内容被改坏（校验不过）时用另一个槽位', async () => {
    const raw = new MemRaw()
    const s = new SlotStore(raw)
    await s.write('v', utf8('a'))
    await s.write('v', utf8('b'))
    const latest = [...raw.files].find(([, b]) => fromUtf8(b.slice(44)) === 'b')![0]
    raw.files.get(latest)![44] ^= 1
    expect(await text(new SlotStore(raw), 'v')).toBe('a')
  })

  it('并发写入按顺序执行；删除两个槽位', async () => {
    const raw = new MemRaw()
    const s = new SlotStore(raw)
    await Promise.all([1, 2, 3, 4, 5].map((i) => s.write('v', utf8(String(i)))))
    expect(await text(s, 'v')).toBe('5')
    await s.remove('v')
    expect(raw.files.size).toBe(0)
    expect(await s.read('v')).toBeNull()
  })
})
