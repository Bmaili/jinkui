/**
 * 图案解锁（规格 6.4，1.0.9 起）：给没有指纹的平板用，画图案代替输主密码。
 *
 * 保险库密钥要同时有三样东西才解得开：
 * 1. 本机安全芯片里的一把钥匙（Keystore，导不出来；平台层的 seal / open，这里不管）；
 * 2. 用户画的图案；
 * 3. 云端 keys/unlock/<设备ID>.json 里的一段随机密钥。
 * 本机存的是 seal(PatternRecord)，PatternRecord.inner = age scrypt(保险库密钥，口令 = 图案 + 云端密钥)。
 *
 * - 别的设备删掉云端那段密钥 = “作废图案解锁”：丢了的平板就算被人猜中图案也解不开；断网时也解不开。
 * - 连续画错 5 次作废（本机的图案数据删掉，只能用主密码）。计数在尝试之前加一，尝试中途被杀也算一次。
 * - 距上次输主密码超过 30 天，图案不能用，要输一次主密码（输完自动续期）。
 * - 只有拿到了云端密钥、图案又解不开，才算画错一次；连不上云端不算。
 */
import { Decrypter, Encrypter } from 'age-encryption'
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes'
import { DEFAULT_WORK_FACTOR } from './crypto'
import { RemoteError, type RemoteStore } from './sync/remote'

export const PATTERN_MIN_POINTS = 4
export const PATTERN_MAX_FAILS = 5
export const MASTER_EVERY_DAYS = 30
const DAY = 86_400_000

export const UNLOCK_DIR = 'keys/unlock/'
export const unlockSharePath = (deviceId: string) => `${UNLOCK_DIR}${deviceId}.json`
export const deviceIdOfShare = (path: string): string | null => {
  const m = /^keys\/unlock\/([A-Za-z0-9_-]+)\.json$/.exec(path)
  return m ? m[1] : null
}

// ---------- 图案 ----------

/** 九宫格的点按行编号 0–8 */
const rc = (p: number) => [Math.floor(p / 3), p % 3] as const

/**
 * 连上一个点。和安卓锁屏一样：两点正中间夹着一个没连过的点时（例如 0 → 2 中间的 1），自动把它也连上。
 * 已经连过的点不能再连，返回原样。
 */
export function addPoint(seq: readonly number[], p: number): number[] {
  if (!Number.isInteger(p) || p < 0 || p > 8 || seq.includes(p)) return [...seq]
  const out = [...seq]
  const last = out[out.length - 1]
  if (last !== undefined) {
    const [r1, c1] = rc(last)
    const [r2, c2] = rc(p)
    if ((r1 + r2) % 2 === 0 && (c1 + c2) % 2 === 0) {
      const mid = ((r1 + r2) / 2) * 3 + (c1 + c2) / 2
      if (mid !== last && mid !== p && !out.includes(mid)) out.push(mid)
    }
  }
  out.push(p)
  return out
}

export function patternProblem(seq: readonly number[]): string | null {
  if (seq.length < PATTERN_MIN_POINTS) return `至少连 ${PATTERN_MIN_POINTS} 个点`
  return null
}

/** 图案的文字形式，例如 "0147" */
export function patternCode(seq: readonly number[]): string {
  if (!seq.length || seq.some((p) => !Number.isInteger(p) || p < 0 || p > 8) || new Set(seq).size !== seq.length) {
    throw new Error('图案不对')
  }
  return seq.join('')
}

// ---------- 云端密钥 ----------

interface ShareFile {
  format: 'jinkui-unlock'
  version: 1
  device: string
  /** 32 字节随机数，base64 */
  secret: string
}

/** 新的云端密钥，返回要上传的文件内容 */
export function makeShare(deviceId: string): { secret: string; bytes: Uint8Array } {
  const secret = toBase64(crypto.getRandomValues(new Uint8Array(32)))
  const file: ShareFile = { format: 'jinkui-unlock', version: 1, device: deviceId, secret }
  return { secret, bytes: utf8(JSON.stringify(file, null, 2) + '\n') }
}

export function parseShare(bytes: Uint8Array, deviceId: string): string {
  let v: ShareFile
  try {
    v = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new Error('云端的解锁密钥文件不对')
  }
  if (v?.format !== 'jinkui-unlock' || v.device !== deviceId || typeof v.secret !== 'string' || v.secret.length < 40) {
    throw new Error('云端的解锁密钥文件不对')
  }
  return v.secret
}

/** 读本机的云端密钥：不存在（已作废）返回 null；网络、权限问题抛 RemoteError */
export async function fetchShare(remote: RemoteStore, deviceId: string): Promise<string | null> {
  const b = await remote.get(unlockSharePath(deviceId))
  return b ? parseShare(b, deviceId) : null
}

/**
 * 上传本机的云端密钥（覆盖旧的：重新设置图案时换一段新的，旧图案数据随之失效）。
 * 只写自己的路径。
 */
export async function uploadShare(remote: RemoteStore, deviceId: string): Promise<string> {
  const { secret, bytes } = makeShare(deviceId)
  const path = unlockSharePath(deviceId)
  const cur = (await remote.list()).find((f) => f.path === path)
  await remote.put(path, bytes, { ifVersion: cur ? cur.version : null })
  return secret
}

// ---------- 加密 ----------

const passOf = (code: string, secret: string) => `jinkui-pattern-v1:${code}:${secret}`

export async function sealPattern(identity: string, code: string, secret: string, workFactor = DEFAULT_WORK_FACTOR): Promise<Uint8Array> {
  const e = new Encrypter()
  e.setPassphrase(passOf(code, secret))
  e.setScryptWorkFactor(workFactor)
  return e.encrypt(identity + '\n')
}

export class WrongPatternError extends Error {
  constructor() {
    super('图案不对')
  }
}

export async function openPattern(inner: Uint8Array, code: string, secret: string): Promise<string> {
  const d = new Decrypter()
  d.addPassphrase(passOf(code, secret))
  let identity: string
  try {
    identity = (await d.decrypt(inner, 'text')).trim()
  } catch (e) {
    const m = (e as Error).message
    if (/no identity matched|incorrect|failed to decrypt/i.test(m)) throw new WrongPatternError()
    throw new Error(`图案解锁的数据损坏：${m}`)
  }
  if (!identity.startsWith('AGE-SECRET-KEY-')) throw new Error('图案解锁的数据内容不对')
  return identity
}

// ---------- 本机记录与状态 ----------

/** 本机存的图案数据（再由安全芯片加密一层）。backend 是同步配置的副本：上锁时也要能去云端取密钥 */
export interface PatternRecord {
  format: 1
  device: string
  /** sealPattern 的结果，base64 */
  inner: string
  backend: unknown
}

export function makeRecord(device: string, inner: Uint8Array, backend: unknown): PatternRecord {
  return { format: 1, device, inner: toBase64(inner), backend }
}

export function parseRecord(json: string): PatternRecord {
  let v: PatternRecord
  try {
    v = JSON.parse(json)
  } catch {
    throw new Error('图案解锁的数据损坏')
  }
  if (v?.format !== 1 || typeof v.device !== 'string' || typeof v.inner !== 'string' || !v.backend) throw new Error('图案解锁的数据损坏')
  return v
}

/**
 * 不含秘密的状态，单独存一个键、每次现读（主界面和自动填充窗口是两个网页环境，
 * 不能让一边内存里的旧计数把另一边刚加的覆盖掉）。
 */
export interface PatternState {
  on: boolean
  /** 连续画错的次数 */
  fails: number
  /** 上次输主密码的时间 */
  masterAt: number
  /** 开启（或重新设置）的时间：在这之前开始的同步看到“云端没有密钥”不算作废 */
  enabledAt: number
}

export const emptyPatternState = (): PatternState => ({ on: false, fails: 0, masterAt: 0, enabledAt: 0 })

/** 该输主密码了（手机时间被往回拨、比记录还早一天以上，也当作到期） */
export function masterDue(st: PatternState, now: number): boolean {
  return now - st.masterAt > MASTER_EVERY_DAYS * DAY || st.masterAt - now > DAY
}

/** 还剩几天要输主密码 */
export function daysLeft(st: PatternState, now: number): number {
  return Math.max(0, Math.ceil((st.masterAt + MASTER_EVERY_DAYS * DAY - now) / DAY))
}

// ---------- 解锁 ----------

export type PatternFailure =
  | 'off' // 没开启
  | 'expired' // 该输主密码了
  | 'revoked' // 云端密钥没了（在别的设备上作废了）
  | 'wrong' // 画错了，还能再试
  | 'locked-out' // 错满 5 次
  | 'offline' // 连不上云端
  | 'broken' // 本机数据坏了、安全芯片里的钥匙没了

export class PatternUnlockError extends Error {
  constructor(readonly reason: PatternFailure, message: string, readonly remaining = 0) {
    super(message)
  }
}

export interface PatternHost {
  deviceId: string
  readState(): Promise<PatternState>
  writeState(s: PatternState): Promise<void>
  /** 读本机的图案数据（解开安全芯片那一层）；没有时返回 null，钥匙失效时抛错 */
  readRecord(): Promise<PatternRecord | null>
  remote(backend: unknown): RemoteStore
  /** 删掉本机的图案数据（作废、错满、损坏时） */
  disable(): Promise<void>
  now(): number
}

export const PATTERN_MESSAGES: Record<Exclude<PatternFailure, 'wrong'>, string> = {
  off: '没有开启图案解锁',
  expired: `已经 ${MASTER_EVERY_DAYS} 天没有输入主密码了，这次请用主密码解锁`,
  revoked: '图案解锁已在别的设备上作废，请用主密码解锁',
  'locked-out': `图案连续画错 ${PATTERN_MAX_FAILS} 次，已经作废，请用主密码解锁`,
  offline: '连不上云端，图案解锁要联网。请检查网络，或用主密码',
  broken: '图案解锁的数据解不开了，请用主密码解锁后重新设置',
}

const fail = (r: Exclude<PatternFailure, 'wrong'>) => new PatternUnlockError(r, PATTERN_MESSAGES[r])

/** 读出本机记录对应的云端密钥（锁屏一出现就去取，画完图案时就不用再等网络） */
export async function prefetchShare(host: PatternHost): Promise<string> {
  const st = await host.readState()
  if (!st.on) throw fail('off')
  if (masterDue(st, host.now())) throw fail('expired')
  if (st.fails >= PATTERN_MAX_FAILS) {
    await host.disable()
    throw fail('locked-out')
  }
  let rec: PatternRecord | null
  try {
    rec = await host.readRecord()
  } catch {
    rec = null
  }
  if (!rec || rec.device !== host.deviceId) {
    await host.disable()
    throw fail('broken')
  }
  let secret: string | null
  try {
    secret = await fetchShare(host.remote(rec.backend), host.deviceId)
  } catch (e) {
    if (e instanceof RemoteError) throw fail('offline')
    throw e
  }
  if (!secret) {
    await host.disable()
    throw fail('revoked')
  }
  return secret
}

/** 画完图案：返回保险库密钥（AGE-SECRET-KEY-…）。secret 是 prefetchShare 取到的云端密钥，没有时现取 */
export async function unlockByPattern(host: PatternHost, seq: readonly number[], secret?: string): Promise<string> {
  // 点数不够的（手滑碰了一下）不算画错
  const short = patternProblem(seq)
  if (short) throw new PatternUnlockError('wrong', short, PATTERN_MAX_FAILS - (await host.readState()).fails)
  const code = patternCode(seq)
  const s = secret ?? (await prefetchShare(host))
  const rec = await host.readRecord().catch(() => null)
  if (!rec) {
    await host.disable()
    throw fail('broken')
  }
  // 先记一次失败再尝试：中途被杀也算一次
  const before = await host.readState()
  if (!before.on) throw fail('off')
  if (before.fails >= PATTERN_MAX_FAILS) {
    await host.disable()
    throw fail('locked-out')
  }
  const fails = before.fails + 1
  await host.writeState({ ...before, fails })
  let identity: string
  try {
    identity = await openPattern(fromBase64(rec.inner), code, s)
  } catch (e) {
    if (!(e instanceof WrongPatternError)) {
      await host.disable()
      throw fail('broken')
    }
    const remaining = PATTERN_MAX_FAILS - fails
    if (remaining <= 0) {
      await host.disable()
      throw fail('locked-out')
    }
    throw new PatternUnlockError('wrong', `图案不对，还可以再试 ${remaining} 次`, remaining)
  }
  const after = await host.readState()
  await host.writeState({ ...after, fails: 0 })
  return identity
}
