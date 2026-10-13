import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { utf8 } from '../src/core/bytes'
import {
  KEY_IDENTITY, KEY_INFO, VaultCipher, WrongPassphraseError, changePassphrase, createKeys, devicePath, keyInfoOf, type KeyBundle,
} from '../src/core/crypto'
import { canonicalJson } from '../src/core/item'
import { KeyMismatchError, NotInitializedError } from '../src/core/sync/engine'
import { makeDeviceFile } from '../src/core/sync/deviceFile'
import { MemoryRemote, RemoteError } from '../src/core/sync/remote'
import { AlreadyInitializedError, initRemote, joinRemote, probeRemote, uploadWrappedKey } from '../src/core/sync/setup'
import { FormatTooNewError, emptyVault, liveItems } from '../src/core/vault'
import { PASS, TestDevice, WF } from './helpers'

let keys: KeyBundle
let remote: MemoryRemote

beforeAll(async () => {
  keys = await createKeys(PASS, WF)
})

beforeEach(async () => {
  remote = new MemoryRemote()
  await initRemote(remote, keys)
})

async function newDevice(id: string) {
  const k = await joinRemote(remote, PASS)
  return new TestDevice({ id, name: `手机${id}` }, k)
}

const titles = (d: TestDevice) => liveItems(d.state).map((i) => i.title)

describe('建立与加入', () => {
  it('空云端建立保险库后能探测到；不能重复建立', async () => {
    expect(await probeRemote(remote)).toEqual({ initialized: true, otherFiles: [] })
    await expect(initRemote(remote, keys)).rejects.toThrow(AlreadyInitializedError)
    const empty = new MemoryRemote()
    expect((await probeRemote(empty)).initialized).toBe(false)
  })

  it('新建 GitHub 仓库时自带的 README 会被替换成保险库说明，其他文件提醒用户', async () => {
    const r = new MemoryRemote()
    await r.put('README.md', utf8('# my repo'))
    await r.put('notes/todo.md', utf8('x'))
    await initRemote(r, keys)
    expect(new TextDecoder().decode((await r.get('README.md'))!)).toContain('金匮')
    expect((await probeRemote(r)).otherFiles).toEqual(['notes/todo.md'])
  })

  it('主密码错误时加入失败', async () => {
    await expect(joinRemote(remote, 'wrong-password-123')).rejects.toThrow(WrongPassphraseError)
  })

  it('云端没有保险库时同步报“还没有保险库”', async () => {
    const d = new TestDevice({ id: 'A', name: 'A' }, keys)
    await expect(d.sync(new MemoryRemote())).rejects.toThrow(NotInitializedError)
  })

  it('改主密码后，新设备用新密码加入，旧设备照常同步', async () => {
    const a = await newDevice('A')
    a.add({ type: 'login', title: 'GitHub' })
    await a.sync(remote)
    const k2 = await changePassphrase(keys, 'brand-new-passphrase', WF)
    await uploadWrappedKey(remote, k2)
    await expect(joinRemote(remote, PASS)).rejects.toThrow(WrongPassphraseError)
    const b = new TestDevice({ id: 'B', name: 'B' }, await joinRemote(remote, 'brand-new-passphrase'))
    await b.sync(remote)
    expect(titles(b)).toEqual(['GitHub'])
    a.add({ type: 'login', title: 'Bank' })
    await a.sync(remote)
  })
})

describe('两台设备', () => {
  it('A 改了，B 打开后拉到最新', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    const id = a.add({ type: 'login', title: 'GitHub', username: 'me', password: 'p1' })
    await a.sync(remote)
    await b.sync(remote)
    expect(b.state.items[id].password).toBe('p1')

    a.edit(id, { password: 'p2' })
    await a.sync(remote)
    const r = await b.sync(remote)
    expect(r.downloaded).toBe(1)
    expect(b.state.items[id].password).toBe('p2')
    expect(b.state.items[id].history!.map((h) => h.password)).toEqual(['p1'])
  })

  it('没有变化时不下载也不上传', async () => {
    const a = await newDevice('A')
    a.add({ type: 'login', title: 'x' })
    await a.sync(remote)
    remote.calls.length = 0
    const r = await a.sync(remote)
    expect(r).toMatchObject({ downloaded: 0, uploaded: false })
    expect(remote.calls).toEqual(['list'])
  })

  it('离线时各改各的：两边最终一致，输的那份在历史里', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    const id = a.add({ type: 'login', title: 'Bank', password: 'p0' })
    await a.sync(remote)
    await b.sync(remote)

    b.tick(5000)
    a.edit(id, { password: 'fromA' })
    b.edit(id, { password: 'fromB' })
    await a.sync(remote)
    await b.sync(remote)
    await a.sync(remote)
    expect(canonicalJson(a.state)).toBe(canonicalJson(b.state))
    expect(a.state.items[id].password).toBe('fromB')
    expect(a.state.items[id].history!.map((h) => h.password)).toEqual(['fromA', 'p0'])
  })

  it('B 的时钟慢 3 小时：拉到 A 的修改之后再改，B 的修改仍然生效', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    b.skew = -3 * 3600_000
    const id = a.add({ type: 'login', title: 'Mail', password: 'old' })
    await a.sync(remote)
    await b.sync(remote)
    b.edit(id, { password: 'newer' })
    await b.sync(remote)
    await a.sync(remote)
    expect(a.state.items[id].password).toBe('newer')
  })

  it('A 删除、B 没联网时还在看：B 同步后也删掉，不会复活', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    const id = a.add({ type: 'login', title: 'Old' })
    await a.sync(remote)
    await b.sync(remote)
    a.del(id)
    await a.sync(remote)
    await b.sync(remote)
    await a.sync(remote)
    expect(titles(a)).toEqual([])
    expect(titles(b)).toEqual([])
  })

  it('上传中途断网：本地数据不丢，下次同步补传', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    a.add({ type: 'login', title: 'X' })
    remote.failOn = (op) => (op === 'put' ? new RemoteError('网络断了') : null)
    await expect(a.sync(remote)).rejects.toThrow('网络断了')
    expect(titles(a)).toEqual(['X'])
    remote.failOn = null
    expect((await a.sync(remote)).uploaded).toBe(true)
    await b.sync(remote)
    expect(titles(b)).toEqual(['X'])
  })

  it('同步状态丢了（清缓存）：重新下载合并，结果不变', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    a.add({ type: 'login', title: 'X' })
    b.add({ type: 'note', title: 'Y' })
    await a.sync(remote)
    await b.sync(remote)
    await a.sync(remote)
    const before = canonicalJson(a.state)
    a.syncStates.clear()
    const r = await a.sync(remote)
    expect(r.downloaded).toBe(2)
    expect(canonicalJson(a.state)).toBe(before)
  })

  it('自己的文件被人删了或换成旧版本：合并后重新上传', async () => {
    const a = await newDevice('A')
    a.add({ type: 'login', title: 'X' })
    await a.sync(remote)
    const old = remote.files.get(devicePath('A'))!.bytes
    a.add({ type: 'login', title: 'Y' })
    await a.sync(remote)
    await remote.put(devicePath('A'), old) // 例如在 GitHub 上回滚了一个提交
    expect((await a.sync(remote)).uploaded).toBe(true)
    remote.files.delete(devicePath('A'))
    expect((await a.sync(remote)).uploaded).toBe(true)
    const b = await newDevice('B')
    await b.sync(remote)
    expect(titles(b)).toEqual(['X', 'Y'])
  })
})

describe('三台设备随机操作', () => {
  it('不管同步顺序如何，最后全部一致，且每次修改都还在（当前值或历史）', async () => {
    let seed = 7
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const devs = [await newDevice('A'), await newDevice('B'), await newDevice('C')]
    devs[1].skew = 90_000
    devs[2].skew = -600_000
    const written: { id: string; password: string }[] = []
    const ids: string[] = []
    for (let step = 0; step < 150; step++) {
      const d = devs[Math.floor(r() * 3)]
      const x = r()
      const live = liveItems(d.state)
      if (x < 0.15 || !live.length) {
        ids.push(d.add({ type: 'login', title: `t${step}`, password: `c${step}` }))
      } else if (x < 0.7) {
        const it = live[Math.floor(r() * live.length)]
        const password = `${d.device.id}${step}`
        d.edit(it.id, { password })
        written.push({ id: it.id, password })
      } else if (x < 0.75) {
        d.del(live[Math.floor(r() * live.length)].id)
      } else {
        await d.sync(remote)
      }
    }
    for (let i = 0; i < 2; i++) for (const d of devs) await d.sync(remote)
    const ref = canonicalJson(devs[0].state)
    for (const d of devs) expect(canonicalJson(d.state)).toBe(ref)
    const s = devs[0].state
    for (const w of written) {
      const it = s.items[w.id]
      const all = [it.password, ...(it.history ?? []).map((h) => h.password)]
      expect(all).toContain(w.password)
    }
  })
})

describe('异常数据', () => {
  it('云端换了密钥：停下来，不合并也不上传', async () => {
    const a = await newDevice('A')
    a.add({ type: 'login', title: 'X' })
    await a.sync(remote)
    const other = await createKeys('another-passphrase', WF)
    await remote.put(KEY_INFO, utf8(JSON.stringify(keyInfoOf(other))))
    await remote.put(KEY_IDENTITY, other.wrapped)
    a.add({ type: 'login', title: 'Y' })
    remote.calls.length = 0
    await expect(a.sync(remote)).rejects.toThrow(KeyMismatchError)
    expect(remote.calls.some((c) => c.startsWith('put'))).toBe(false)
  })

  it('有设备文件来自更新版本：整次同步停下，什么都不合并', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    b.add({ type: 'login', title: 'fromB' })
    await b.sync(remote)
    const future = { ...makeDeviceFile({ id: 'C', name: 'C' }, { ...emptyVault(), format: 2 }), format: 2 }
    await remote.put(devicePath('C'), await new VaultCipher(keys).encryptJson(future))
    await expect(a.sync(remote)).rejects.toThrow(FormatTooNewError)
    expect(a.merges).toBe(0)
    expect(remote.files.has(devicePath('A'))).toBe(false)
  })

  it('解不开或文件名不符的设备文件跳过并报告，其他照常合并', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    b.add({ type: 'login', title: 'fromB' })
    await b.sync(remote)
    await remote.put(devicePath('X'), utf8('garbage'))
    await remote.put(devicePath('Y'), remote.files.get(devicePath('B'))!.bytes) // 拷贝改名
    const r = await a.sync(remote)
    expect(r.problems.map((p) => p.path).sort()).toEqual([devicePath('X'), devicePath('Y')])
    expect(titles(a)).toEqual(['fromB'])
  })

  it('旧版本 app 编辑过的条目，新版本加的字段不丢', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    const id = a.add({ type: 'login', title: 'X', passkey: { credentialId: 'abc' } })
    a.state = { ...a.state, settingsFromFuture: { theme: 'ink' } }
    await a.sync(remote)
    await b.sync(remote)
    b.edit(id, { password: 'changed' })
    await b.sync(remote)
    await a.sync(remote)
    expect(a.state.items[id].passkey).toEqual({ credentialId: 'abc' })
    expect(a.state.items[id].password).toBe('changed')
    expect(b.state.settingsFromFuture).toEqual({ theme: 'ink' })
  })

  it('移除设备：先合并它的数据，再删除它的文件', async () => {
    const a = await newDevice('A')
    const b = await newDevice('B')
    b.add({ type: 'login', title: 'onlyOnB' })
    await b.sync(remote)
    await a.engine.removeDevice(remote, 'B')
    expect(remote.files.has(devicePath('B'))).toBe(false)
    expect(titles(a)).toEqual(['onlyOnB'])
    const c = await newDevice('C')
    await c.sync(remote)
    expect(titles(c)).toEqual(['onlyOnB'])
    expect(Object.keys(a.syncStates.get('memory')!.devices)).toEqual(['A'])
    await expect(a.engine.removeDevice(remote, 'A')).rejects.toThrow('不能移除本机')
  })

  it('同一时刻重复点同步，只跑一次', async () => {
    const a = await newDevice('A')
    a.add({ type: 'login', title: 'X' })
    const [r1, r2] = await Promise.all([a.sync(remote), a.sync(remote)])
    expect(r1).toBe(r2)
    expect(remote.calls.filter((c) => c === 'list')).toHaveLength(2) // initRemote 一次 + 同步一次
  })
})
