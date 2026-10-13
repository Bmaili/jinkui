import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { utf8 } from '../src/core/bytes'
import { createKeys, devicePath, type KeyBundle } from '../src/core/crypto'
import { GitHubStore } from '../src/core/sync/github'
import { OssStore } from '../src/core/sync/oss'
import { RemoteConflictError, type RemoteStore } from '../src/core/sync/remote'
import { initRemote, joinRemote, probeRemote } from '../src/core/sync/setup'
import { liveItems } from '../src/core/vault'
import { startGitHubMock, type GitHubMock } from './mocks/githubServer'
import { startOssMock, type OssMock } from './mocks/ossServer'
import { PASS, TestDevice, WF } from './helpers'

const OSS = { id: 'LTAI5tJinkuiTest', secret: 'ossSecret', bucket: 'my-vault', region: 'cn-hangzhou' }
let oss: OssMock
let gh: GitHubMock
let keys: KeyBundle
const realFetch = globalThis.fetch

beforeAll(async () => {
  keys = await createKeys(PASS, WF)
  oss = await startOssMock({ bucket: OSS.bucket, region: OSS.region, id: OSS.id, secret: OSS.secret })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const m = /^https:\/\/([^.]+)\.oss-cn-hangzhou\.aliyuncs\.com\/(.*)$/.exec(url)
    return realFetch(m ? `http://127.0.0.1:${oss.port}/${m[1]}/${m[2]}` : url, init)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await oss.close()
})
beforeEach(async () => {
  oss.objects.clear()
  gh = await startGitHubMock({ owner: 'me', repo: 'jinkui-data', token: 'tok' })
})
afterEach(() => gh.close())

const ossStore = (over: Partial<{ secret: string; prefix: string }> = {}) =>
  new OssStore({ endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: OSS.bucket, prefix: over.prefix ?? 'jinkui/', accessKeyId: OSS.id, accessKeySecret: over.secret ?? OSS.secret })
const ghStore = (over: Partial<{ token: string; branch: string; prefix: string }> = {}) =>
  new GitHubStore({ owner: 'me', repo: 'jinkui-data', branch: over.branch ?? 'main', token: over.token ?? 'tok', apiBase: `http://127.0.0.1:${gh.port}`, prefix: over.prefix })

const backends: [string, () => RemoteStore][] = [
  ['GitHub', () => ghStore()],
  ['OSS', () => ossStore()],
]

describe.each(backends)('%s', (_name, make) => {
  it('读、写、列表、条件写入、删除', async () => {
    const r = make()
    expect(await r.list()).toEqual([])
    expect(await r.get('a/b.txt')).toBeNull()
    const v1 = await r.put('a/b.txt', utf8('one'), { ifVersion: null })
    await expect(r.put('a/b.txt', utf8('again'), { ifVersion: null })).rejects.toThrow(RemoteConflictError)
    const list = await r.list()
    expect(list).toEqual([{ path: 'a/b.txt', version: v1, size: 3 }])
    expect(new TextDecoder().decode((await r.get('a/b.txt'))!)).toBe('one')
    const v2 = await r.put('a/b.txt', utf8('two'), { ifVersion: v1 })
    expect(v2).not.toBe(v1)
    expect((await r.list())[0].version).toBe(v2)
    await r.remove('a/b.txt')
    await r.remove('a/b.txt') // 不存在不报错
    expect(await r.list()).toEqual([])
  })

  it('二进制内容原样往返', async () => {
    const r = make()
    const bytes = new Uint8Array(70000).map((_, i) => (i * 31) & 255)
    await r.put('bin.age', bytes)
    expect(await r.get('bin.age')).toEqual(bytes)
  })

  it('两台设备通过它同步', async () => {
    const r = make()
    expect((await probeRemote(r)).initialized).toBe(false)
    await initRemote(r, keys)
    const a = new TestDevice({ id: 'A', name: 'A' }, await joinRemote(r, PASS))
    const b = new TestDevice({ id: 'B', name: 'B' }, await joinRemote(make(), PASS))
    const id = a.add({ type: 'login', title: 'GitHub', password: 'p1' })
    await a.sync(r)
    await b.sync(make())
    expect(b.state.items[id].password).toBe('p1')
    b.edit(id, { password: 'p2' })
    a.edit(id, { username: 'concurrent' })
    await b.sync(make())
    await a.sync(r)
    await b.sync(make())
    // 同一条目被两边同时改：整条比较，后改的（A）当选，B 的修改在历史里
    expect(a.state.items[id].username).toBe('concurrent')
    expect(a.state.items[id].history!.map((h) => h.password)).toContain('p2')
    expect(liveItems(a.state)).toHaveLength(1)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
    const paths = (await r.list()).map((f) => f.path).sort()
    expect(paths).toEqual(['README.md', devicePath('A'), devicePath('B'), 'keys/identity.age', 'keys/info.json'])
    // A 拉到 B 的合并结果，内容和自己一样，不再上传；之后两边都不再有任何传输
    expect(await a.sync(make())).toMatchObject({ downloaded: 1, uploaded: false })
    expect(await b.sync(make())).toMatchObject({ downloaded: 0, uploaded: false })
    expect(await a.sync(make())).toMatchObject({ downloaded: 0, uploaded: false })
  })
})

describe('GitHub', () => {
  it('公开仓库拒绝使用', async () => {
    gh.isPrivate = false
    await expect(ghStore().test()).rejects.toThrow(/公开/)
    gh.isPrivate = true
    await expect(ghStore().test()).resolves.toBeUndefined()
  })

  it('Token 不对、分支不存在时给出明确的提示', async () => {
    await expect(ghStore({ token: 'bad' }).list()).rejects.toThrow(/Token 无效/)
    await expect(ghStore({ branch: 'dev' }).list()).rejects.toThrow(/分支 dev 不存在/)
  })

  it('路径前缀', async () => {
    const r = ghStore({ prefix: '/vault/' })
    await r.put('x.txt', utf8('1'))
    expect([...gh.files.keys()]).toEqual(['vault/x.txt'])
    expect((await r.list()).map((f) => f.path)).toEqual(['x.txt'])
  })

  it('别人先改了文件：sha 对不上，抛冲突；不带 sha 也能覆盖（用列表里的 sha）', async () => {
    const r = ghStore()
    const v1 = await r.put('f', utf8('1'))
    await ghStore().put('f', utf8('2'), { ifVersion: v1 })
    await expect(r.put('f', utf8('3'), { ifVersion: v1 })).rejects.toThrow(RemoteConflictError)
    await r.list()
    await r.put('f', utf8('4'))
    expect(gh.files.get('f')!.toString()).toBe('4')
  })

  it('服务器出错时报可重试的错误', async () => {
    gh.failNext(1)
    await expect(ghStore().list()).rejects.toMatchObject({ status: 502, retryable: true })
  })
})

describe('OSS', () => {
  it('Secret 不对时提示', async () => {
    await expect(ossStore({ secret: 'wrong' }).list()).rejects.toThrow(/AccessKey Secret 不对/)
  })

  it('只列出前缀下的文件', async () => {
    await ossStore({ prefix: 'other/' }).put('x', utf8('1'))
    await ossStore().put('y', utf8('2'))
    expect((await ossStore().list()).map((f) => f.path)).toEqual(['y'])
    expect([...oss.objects.keys()].sort()).toEqual(['jinkui/y', 'other/x'])
  })

  it('服务器出错时报可重试的错误', async () => {
    oss.failNext(1)
    await expect(ossStore().list()).rejects.toMatchObject({ status: 500, retryable: true })
  })
})
