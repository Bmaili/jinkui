/**
 * 建立保险库、新设备加入、改主密码（规格 6.2）。
 */
import { Decrypter, Encrypter } from 'age-encryption'
import { fromBase64, toBase64, utf8 } from '../bytes'
import {
  DATA_README, DATA_README_TEXT, DEFAULT_WORK_FACTOR, KEY_IDENTITY, KEY_INFO, WrongPassphraseError, keyInfoOf, parseKeyInfo, unwrapIdentity,
  type KeyBundle,
} from '../crypto'
import type { RemoteStore } from './remote'

/** 这些文件可以和保险库共存（新建 GitHub 仓库时勾选的说明文件等） */
const HARMLESS = new Set(['README.md', '.gitignore', 'LICENSE', '.gitattributes'])

export interface Probe {
  /** 已经有金匮保险库 */
  initialized: boolean
  /** 其他不认识的文件（不是空目录时提醒用户是否选错了仓库 / 前缀） */
  otherFiles: string[]
}

export async function probeRemote(remote: RemoteStore): Promise<Probe> {
  const files = await remote.list()
  const initialized = files.some((f) => f.path === KEY_INFO)
  const otherFiles = files.map((f) => f.path).filter((p) => !HARMLESS.has(p) && !p.startsWith('keys/') && !p.startsWith('devices/'))
  return { initialized, otherFiles }
}

export class AlreadyInitializedError extends Error {
  constructor() {
    super('云端已经有保险库了，请用“加入已有保险库”')
  }
}

/**
 * 在空的云端建立保险库。keys/info.json 最后写：它出现就代表建好了。
 * 两台设备同时建立时，后写的会因为“只能新建”失败，不会互相覆盖密钥。
 */
export async function initRemote(remote: RemoteStore, keys: KeyBundle): Promise<void> {
  const files = await remote.list()
  if (files.some((f) => f.path === KEY_INFO)) throw new AlreadyInitializedError()
  const existing = new Map(files.map((f) => [f.path, f.version]))
  const readme = existing.get(DATA_README)
  await remote.put(DATA_README, utf8(DATA_README_TEXT), { ifVersion: readme ?? null })
  const idVer = existing.get(KEY_IDENTITY)
  // 上次建立到一半（identity.age 写了、info.json 没写）时覆盖它
  await remote.put(KEY_IDENTITY, keys.wrapped, idVer ? { ifVersion: idVer } : { ifVersion: null })
  await remote.put(KEY_INFO, utf8(JSON.stringify(keyInfoOf(keys), null, 2) + '\n'), { ifVersion: null })
}

/** 新设备加入：下载 identity.age，用主密码解开，并核对公钥 */
export async function joinRemote(remote: RemoteStore, passphrase: string): Promise<KeyBundle> {
  const [infoBytes, wrapped] = await Promise.all([remote.get(KEY_INFO), remote.get(KEY_IDENTITY)])
  if (!infoBytes || !wrapped) throw new Error('云端还没有保险库')
  const info = parseKeyInfo(infoBytes)
  const keys = await unwrapIdentity(wrapped, passphrase)
  if (keys.recipient !== info.recipient) throw new Error('云端的密钥文件和公钥不匹配，可能被改动过')
  return keys
}

/**
 * 加入码：把同步配置（含 Token / AccessKey）用主密码加密（age scrypt，和 identity.age 同样强度）成一行文字，
 * 新设备上粘贴、再输入主密码，就不用手抄 Token。没有主密码的人拿到加入码也解不开。
 */
export const JOIN_PREFIX = 'jinkui-join:'

interface JoinPayload {
  format: 'jinkui-join'
  version: 1
  backend: unknown
}

export async function makeJoinCode(backend: unknown, passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Promise<string> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(workFactor)
  const payload: JoinPayload = { format: 'jinkui-join', version: 1, backend }
  return JOIN_PREFIX + toBase64(await e.encrypt(utf8(JSON.stringify(payload))))
}

/** 去掉空白后像不像加入码（粘贴时可能带换行、空格） */
export function normalizeJoinCode(s: string): string | null {
  const t = s.replace(/\s+/g, '')
  return t.startsWith(JOIN_PREFIX) && t.length > JOIN_PREFIX.length + 40 ? t : null
}

/** 用主密码解开加入码，返回里面的同步配置（调用方再校验配置的内容） */
export async function readJoinCode(code: string, passphrase: string): Promise<unknown> {
  const t = normalizeJoinCode(code)
  if (!t) throw new Error('这不是金匮的加入码')
  let bytes: Uint8Array
  try {
    bytes = fromBase64(t.slice(JOIN_PREFIX.length))
  } catch {
    throw new Error('加入码不完整，请重新复制')
  }
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let plain: string
  try {
    plain = await d.decrypt(bytes, 'text')
  } catch (e) {
    const m = (e as Error).message
    if (/no identity matched|incorrect|failed to decrypt/i.test(m)) throw new WrongPassphraseError()
    throw new Error('加入码不完整，请重新复制')
  }
  let v: JoinPayload
  try {
    v = JSON.parse(plain)
  } catch {
    throw new Error('加入码内容不对')
  }
  if (v?.format !== 'jinkui-join' || typeof v.version !== 'number') throw new Error('加入码内容不对')
  if (v.version > 1) throw new Error('这个加入码来自更新版本的金匮，请先升级')
  return v.backend
}

/** 改主密码后上传新的 identity.age（只有它变，数据不用重新加密） */
export async function uploadWrappedKey(remote: RemoteStore, keys: KeyBundle): Promise<void> {
  const files = await remote.list()
  const cur = files.find((f) => f.path === KEY_IDENTITY)
  if (!cur) throw new Error('云端还没有保险库')
  const info = await remote.get(KEY_INFO)
  if (!info || parseKeyInfo(info).recipient !== keys.recipient) throw new Error('云端的保险库密钥和本机不一致')
  await remote.put(KEY_IDENTITY, keys.wrapped, { ifVersion: cur.version })
}
