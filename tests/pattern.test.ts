import { describe, expect, it } from 'vitest'
import { generateX25519Identity } from 'age-encryption'
import {
  MASTER_EVERY_DAYS, PATTERN_MAX_FAILS, PatternUnlockError, addPoint, daysLeft, deviceIdOfShare, emptyPatternState, makeRecord, masterDue,
  openPattern, parseRecord, patternCode, patternProblem, prefetchShare, sealPattern, unlockByPattern, unlockSharePath, uploadShare,
  WrongPatternError, type PatternHost, type PatternRecord, type PatternState,
} from '../src/core/pattern'
import { MemoryRemote, RemoteError } from '../src/core/sync/remote'
import { probeRemote } from '../src/core/sync/setup'
import { WF, T0 } from './helpers'

const DAY = 86_400_000
const draw = (s: string) => [...s].map(Number).reduce<number[]>((acc, p) => addPoint(acc, p), [])

describe('图案', () => {
  it('跨过中间没连过的点时自动连上（和安卓锁屏一样）', () => {
    expect(draw('02')).toEqual([0, 1, 2])
    expect(draw('08')).toEqual([0, 4, 8])
    expect(draw('26')).toEqual([2, 4, 6])
    expect(draw('17')).toEqual([1, 4, 7])
    // 中间的点已经连过：直接跳过去
    expect(draw('102')).toEqual([1, 0, 2])
    // 马步不经过任何点
    expect(draw('05')).toEqual([0, 5])
    // 同一个点不能连两次
    expect(draw('0110')).toEqual([0, 1])
  })

  it('至少 4 个点；图案转成文字', () => {
    expect(patternProblem([0, 1, 2])).toMatch(/至少/)
    expect(patternProblem([0, 1, 2, 5])).toBeNull()
    expect(patternCode([0, 1, 2, 5])).toBe('0125')
    expect(() => patternCode([0, 0])).toThrow()
    expect(() => patternCode([9])).toThrow()
  })

  it('云端密钥的路径只认合法的设备ID', () => {
    expect(unlockSharePath('abc_1')).toBe('keys/unlock/abc_1.json')
    expect(deviceIdOfShare('keys/unlock/abc_1.json')).toBe('abc_1')
    expect(deviceIdOfShare('keys/unlock/../x.json')).toBeNull()
    expect(deviceIdOfShare('devices/abc.age')).toBeNull()
  })

  it('图案和云端密钥两样都对才解得开', async () => {
    const id = await generateX25519Identity()
    const inner = await sealPattern(id, '0125', 'secret-a'.repeat(6), WF)
    expect(await openPattern(inner, '0125', 'secret-a'.repeat(6))).toBe(id)
    await expect(openPattern(inner, '0126', 'secret-a'.repeat(6))).rejects.toBeInstanceOf(WrongPatternError)
    await expect(openPattern(inner, '0125', 'secret-b'.repeat(6))).rejects.toBeInstanceOf(WrongPatternError)
  })

  it('30 天要输一次主密码；时间被往回拨也算到期', () => {
    const st = { ...emptyPatternState(), on: true, masterAt: T0 }
    expect(masterDue(st, T0 + (MASTER_EVERY_DAYS - 1) * DAY)).toBe(false)
    expect(daysLeft(st, T0 + (MASTER_EVERY_DAYS - 1) * DAY)).toBe(1)
    expect(masterDue(st, T0 + (MASTER_EVERY_DAYS + 0.1) * DAY)).toBe(true)
    expect(masterDue(st, T0 - 2 * DAY)).toBe(true)
  })

  it('本机记录：结构不对时报错', () => {
    const r = makeRecord('dev', new Uint8Array([1, 2, 3]), { type: 'github' })
    expect(parseRecord(JSON.stringify(r))).toEqual(r)
    expect(() => parseRecord('{"format":1}')).toThrow()
    expect(() => parseRecord('nope')).toThrow()
  })
})

/** 模拟一台平板：本机记录 + 状态都在内存里，云端是 MemoryRemote */
async function tablet(seq = draw('0125'), deviceId = 'tab1') {
  const remote = new MemoryRemote()
  const identity = await generateX25519Identity()
  const secret = await uploadShare(remote, deviceId)
  let record: PatternRecord | null = makeRecord(deviceId, await sealPattern(identity, patternCode(seq), secret, WF), { type: 'memory' })
  let state: PatternState = { on: true, fails: 0, masterAt: T0, enabledAt: T0 }
  const t = {
    remote,
    identity,
    clock: T0 + DAY,
    disabled: 0,
    get state() {
      return state
    },
    set state(s: PatternState) {
      state = s
    },
    get record() {
      return record
    },
    host: null as unknown as PatternHost,
  }
  t.host = {
    deviceId,
    readState: async () => ({ ...state }),
    writeState: async (s) => void (state = { ...s }),
    readRecord: async () => record,
    remote: () => remote,
    disable: async () => {
      t.disabled++
      record = null
      state = { ...state, on: false, fails: 0 }
    },
    now: () => t.clock,
  }
  return t
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    if (e instanceof PatternUnlockError) return e.reason
    throw e
  }
}

describe('图案解锁', () => {
  it('画对了就解开，失败计数清零', async () => {
    const t = await tablet()
    expect(await reason(unlockByPattern(t.host, draw('0126')))).toBe('wrong')
    expect(t.state.fails).toBe(1)
    expect(await unlockByPattern(t.host, draw('0125'))).toBe(t.identity)
    expect(t.state.fails).toBe(0)
  })

  it('先取云端密钥，再画图案（锁屏一出现就去取）', async () => {
    const t = await tablet()
    const s = await prefetchShare(t.host)
    t.remote.failOn = () => new RemoteError('断网了')
    expect(await unlockByPattern(t.host, draw('0125'), s)).toBe(t.identity)
  })

  it('连续画错 5 次作废；中途画对一次会清零', async () => {
    const t = await tablet()
    for (let i = 0; i < PATTERN_MAX_FAILS - 1; i++) {
      const e = (await unlockByPattern(t.host, draw('0126')).catch((x: unknown) => x)) as PatternUnlockError
      expect(e.reason).toBe('wrong')
      expect(e.remaining).toBe(PATTERN_MAX_FAILS - 1 - i)
    }
    expect(await reason(unlockByPattern(t.host, draw('0126')))).toBe('locked-out')
    expect(t.disabled).toBe(1)
    expect(t.record).toBeNull()
    // 作废后再画对的也没用
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('off')
  })

  it('点数不够的不算画错', async () => {
    const t = await tablet()
    expect(await reason(unlockByPattern(t.host, draw('012')))).toBe('wrong')
    expect(t.state.fails).toBe(0)
  })

  it('尝试之前就记一次失败：中途被杀也算', async () => {
    const t = await tablet()
    const writes: number[] = []
    const orig = t.host.writeState
    t.host.writeState = async (s) => {
      writes.push(s.fails)
      await orig(s)
    }
    await unlockByPattern(t.host, draw('0125'))
    expect(writes).toEqual([1, 0])
  })

  it('别的设备删掉云端密钥 = 作废：画对了也解不开，本机数据删掉', async () => {
    const t = await tablet()
    await t.remote.remove(unlockSharePath('tab1'))
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('revoked')
    expect(t.record).toBeNull()
  })

  it('换了一段云端密钥（在本机重新设置过图案），旧数据解不开', async () => {
    const t = await tablet()
    await uploadShare(t.remote, 'tab1')
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('wrong')
  })

  it('断网：不能用，不算画错，也不删本机数据', async () => {
    const t = await tablet()
    t.remote.failOn = () => new RemoteError('断网了')
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('offline')
    expect(t.state.fails).toBe(0)
    expect(t.record).not.toBeNull()
    t.remote.failOn = null
    expect(await unlockByPattern(t.host, draw('0125'))).toBe(t.identity)
  })

  it('超过 30 天没输主密码：不能用，但不删（输了主密码就续期）', async () => {
    const t = await tablet()
    t.clock = T0 + (MASTER_EVERY_DAYS + 1) * DAY
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('expired')
    expect(t.record).not.toBeNull()
    t.state = { ...t.state, masterAt: t.clock }
    expect(await unlockByPattern(t.host, draw('0125'))).toBe(t.identity)
  })

  it('安全芯片里的钥匙失效、本机数据坏了：删掉，用主密码', async () => {
    const t = await tablet()
    t.host.readRecord = async () => {
      throw new Error('钥匙没了')
    }
    expect(await reason(unlockByPattern(t.host, draw('0125')))).toBe('broken')
    expect(t.disabled).toBe(1)
  })

  it('云端的 keys/unlock/ 不算陌生文件（1.0.8 也认 keys/ 目录）', async () => {
    const t = await tablet()
    expect((await probeRemote(t.remote)).otherFiles).toEqual([])
  })
})
