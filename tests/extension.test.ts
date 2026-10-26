/**
 * 电脑端扩展的核心（extension/src/service.ts）：加入、解锁、后台被停掉后恢复、闲置上锁、登录后保存、和手机互相同步。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createKeys } from '../src/core/crypto'
import { MemoryRemote } from '../src/core/sync/remote'
import { initRemote, makeJoinCode } from '../src/core/sync/setup'
import { VaultService, PENDING_TTL_MS, type Kv } from '../extension/src/service'
import { PASS, T0, TestDevice, WF } from './helpers'

class MemKv implements Kv {
  m = new Map<string, string>()
  async get(k: string) {
    return this.m.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.m.set(k, v)
  }
  async remove(k: string) {
    this.m.delete(k)
  }
}

const BACKEND = { type: 'github', github: { owner: 'me', repo: 'jinkui-data', token: 'github_pat_test', branch: 'main', prefix: '' } }

let remote: MemoryRemote
let phone: TestDevice
let code: string
let local: MemKv
let session: MemKv
let clock: number

beforeEach(async () => {
  remote = new MemoryRemote()
  const keys = await createKeys(PASS, WF)
  await initRemote(remote, keys)
  phone = new TestDevice({ id: 'phone', name: '手机' }, keys)
  phone.add({ type: 'login', title: 'GitHub', username: 'me', password: 'gh-pass', urls: ['https://github.com/login'] })
  phone.add({ type: 'login', title: '淘宝', username: 'tb', password: 'tb-pass', urls: ['https://www.taobao.com'] })
  await phone.sync(remote)
  code = await makeJoinCode(BACKEND, PASS, WF)
  local = new MemKv()
  session = new MemKv()
  clock = T0 + 86_400_000
})

const make = () => new VaultService(local, session, { now: () => clock, remote: () => remote })

async function joined() {
  const s = make()
  await s.join(code, PASS, '办公室电脑')
  await s.syncNow()
  return s
}

describe('扩展：加入与解锁', () => {
  it('用加入码 + 主密码加入，拉到手机上的条目，并上传自己的设备文件', async () => {
    const s = await joined()
    expect(s.phase).toBe('unlocked')
    expect(s.items().map((i) => i.title).sort()).toEqual(['GitHub', '淘宝'])
    expect([...remote.files.keys()].filter((p) => p.startsWith('devices/'))).toHaveLength(2)
    expect(s.sync.devices.map((d) => d.name).sort()).toEqual(['办公室电脑', '手机'])
  })

  it('主密码不对：加入码解不开', async () => {
    await expect(make().join(code, 'wrong-password-123', '电脑')).rejects.toThrow(/主密码不对/)
  })

  it('本地只有密文：存储里找不到任何条目内容和保险库密钥', async () => {
    await joined()
    const all = [...local.m.values()].join('\n')
    expect(all).not.toContain('gh-pass')
    expect(all).not.toContain('AGE-SECRET-KEY')
  })

  it('后台被停掉后醒来：从内存里的会话恢复成解锁状态；关掉浏览器（会话清空）后要主密码', async () => {
    await joined()
    const again = make()
    await again.ready()
    expect(again.phase).toBe('unlocked')
    expect(again.items()).toHaveLength(2)

    session.m.clear() // 关掉了 Chrome
    const fresh = make()
    await fresh.ready()
    expect(fresh.phase).toBe('locked')
    await expect(fresh.unlock('wrong-password-123')).rejects.toThrow(/主密码不对/)
    await fresh.unlock(PASS)
    expect(fresh.items()).toHaveLength(2)
  })

  it('闲置超过设定时间上锁；用过一次就重新计时；设成 0 只在关掉浏览器时上锁', async () => {
    const s = await joined()
    clock += 3 * 3600_000
    await s.touch()
    clock += 3 * 3600_000
    expect(await s.checkIdle()).toBe(false)
    clock += 2 * 3600_000
    expect(await s.checkIdle()).toBe(true)
    expect(s.phase).toBe('locked')
    expect(await session.get('identity')).toBeNull()

    await s.unlock(PASS)
    await s.savePrefs({ idleMin: 0 })
    clock += 100 * 3600_000
    expect(await s.checkIdle()).toBe(false)
  })

  it('后台醒来时已经闲置太久：直接上锁', async () => {
    await joined()
    clock += 5 * 3600_000
    const again = make()
    await again.ready()
    expect(again.phase).toBe('locked')
  })

  it('抹掉本机数据：回到加入前，云端不动', async () => {
    const s = await joined()
    const files = remote.files.size
    await s.wipe()
    expect(s.phase).toBe('setup')
    expect([...local.m.keys()]).toEqual([])
    expect(remote.files.size).toBe(files)
  })
})

describe('扩展：登录后保存', () => {
  it('已经保存过一模一样的：不打扰', async () => {
    const s = await joined()
    expect(await s.capture(7, { url: 'https://github.com/session', username: 'me', password: 'gh-pass' })).toBe('saved-already')
    expect(await s.pendingFor(7)).toBeNull()
  })

  it('同一网站同一用户名、密码变了：默认更新那一条，旧密码进历史，同步到手机', async () => {
    const s = await joined()
    expect(await s.capture(7, { url: 'https://github.com/session', username: 'me', password: 'new-pass' })).toBe('pending')
    const p = await s.pendingFor(7)
    expect(p?.updateTitle).toBe('GitHub')
    const id = await s.savePending(7, 'update')
    await s.syncNow()
    expect(s.item(id)?.password).toBe('new-pass')
    expect(s.item(id)?.history?.[0].password).toBe('gh-pass')
    await phone.sync(remote)
    expect(phone.state.items[id].password).toBe('new-pass')
    expect(await s.pendingFor(7)).toBeNull()
  })

  it('新网站：新建一条，标题取主域名', async () => {
    const s = await joined()
    await s.capture(3, { url: 'https://login.example.com/x?y=1', username: 'alice', password: 'pw-1' })
    expect((await s.pendingFor(3))?.updateId).toBeUndefined()
    const id = await s.savePending(3, 'new')
    expect(s.item(id)).toMatchObject({ title: 'example.com', username: 'alice', password: 'pw-1', urls: ['https://login.example.com'] })
  })

  it('上锁时也记下来，解锁后再决定；只在内存里，10 分钟过期；不是网页的不记', async () => {
    const s = await joined()
    await s.lock()
    expect(await s.capture(5, { url: 'https://github.com/session', username: 'me', password: 'pw-2' })).toBe('pending')
    expect(await s.capture(5, { url: 'chrome://settings', username: 'x', password: 'y' })).toBe('ignored')
    await s.unlock(PASS)
    expect((await s.pendingFor(5))?.updateTitle).toBe('GitHub')
    expect([...local.m.values()].join('')).not.toContain('pw-2')
    clock += PENDING_TTL_MS + 1
    expect(await s.pendingFor(5)).toBeNull()
  })

  it('上锁时清掉待保存的登录', async () => {
    const s = await joined()
    await s.capture(5, { url: 'https://github.com/session', username: 'me', password: 'pw-2' })
    await s.lock()
    await s.unlock(PASS)
    expect(await s.pendingFor(5)).toBeNull()
  })
})

describe('扩展：推荐', () => {
  it('按当前网页的域名推荐；非网页不推荐', async () => {
    const s = await joined()
    expect(s.suggest('https://github.com/login').map((i) => i.title)).toEqual(['GitHub'])
    expect(s.suggest('https://buy.taobao.com/x').map((i) => i.title)).toEqual(['淘宝'])
    expect(s.suggest('chrome://extensions')).toEqual([])
  })
})
