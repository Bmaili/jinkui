/**
 * 加密（规格第 6 节）。用开放的 age 格式（https://age-encryption.org），不靠这个 app 也能在电脑上解开。
 *
 * - 保险库密钥：一把 X25519 身份密钥（AGE-SECRET-KEY-…）。所有数据都加密给它的公钥。
 * - 保险库密钥用主密码（scrypt）加密，存成云端的 keys/identity.age。新设备加入时下载它、输一次主密码即可。
 * - 改主密码只需重新包一次保险库密钥，数据不用重新加密。但云端的旧版本 identity.age（GitHub 提交历史、OSS 版本控制）
 *   仍然能用旧密码解开，所以“怀疑主密码泄露”时要换保险库密钥，而不只是改密码（规格 6.3）。
 * - 本机：保险库密钥由 Android Keystore 里的密钥再包一层（平台层实现），本文件只管与平台无关的部分。
 */
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { fromUtf8, utf8 } from './bytes'

export const KEY_INFO = 'keys/info.json'
export const KEY_IDENTITY = 'keys/identity.age'
export const DATA_README = 'README.md'
export const DEVICES_DIR = 'devices/'
export const devicePath = (deviceId: string) => `${DEVICES_DIR}${deviceId}.age`
export const deviceIdOf = (path: string): string | null => {
  const m = /^devices\/([A-Za-z0-9_-]+)\.age$/.exec(path)
  return m ? m[1] : null
}

/** 默认 scrypt 强度 2^18（age 命令行的默认值）。JS 版 age 解密时最多接受 2^20 */
export const DEFAULT_WORK_FACTOR = 18
export const MIN_PASSPHRASE = 12

export interface KeyInfo {
  format: 'jinkui-keys'
  version: 1
  /** age1…，公开 */
  recipient: string
}

export interface KeyBundle {
  /** AGE-SECRET-KEY-…，只在内存和本机加密存储里 */
  identity: string
  recipient: string
  /** 用主密码加密后的身份密钥，等同于云端的 keys/identity.age */
  wrapped: Uint8Array
}

export function checkPassphrase(p: string): string | null {
  if (p.length < MIN_PASSPHRASE) return `主密码至少 ${MIN_PASSPHRASE} 个字符`
  if (/^(.)\1*$/.test(p)) return '主密码太简单'
  if (/^\d+$/.test(p) && p.length < 20) return '纯数字的主密码太容易被猜到，请加上字母'
  return null
}

/** 约 100 位熵的随机主密码，形如 k7mq-3vxe-…（不含容易看混的 l、o、0、1） */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

export async function wrapIdentity(identity: string, passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Promise<Uint8Array> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(workFactor)
  return e.encrypt(identity + '\n')
}

export async function createKeys(passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Promise<KeyBundle> {
  const err = checkPassphrase(passphrase)
  if (err) throw new Error(err)
  const identity = await generateX25519Identity()
  return { identity, recipient: await identityToRecipient(identity), wrapped: await wrapIdentity(identity, passphrase, workFactor) }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('主密码不对')
  }
}

/** 用主密码解开 identity.age */
export async function unwrapIdentity(wrapped: Uint8Array, passphrase: string): Promise<KeyBundle> {
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let identity: string
  try {
    identity = (await d.decrypt(wrapped, 'text')).trim()
  } catch (e) {
    const m = (e as Error).message
    if (/no identity matched|incorrect|failed to decrypt/i.test(m)) throw new WrongPassphraseError()
    throw new Error(`密钥文件损坏：${m}`)
  }
  if (!identity.startsWith('AGE-SECRET-KEY-')) throw new Error('密钥文件内容不对')
  return { identity, recipient: await identityToRecipient(identity), wrapped }
}

/** 换主密码：只重新包装身份密钥 */
export async function changePassphrase(keys: KeyBundle, passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Promise<KeyBundle> {
  const err = checkPassphrase(passphrase)
  if (err) throw new Error(err)
  return { ...keys, wrapped: await wrapIdentity(keys.identity, passphrase, workFactor) }
}

export function keyInfoOf(keys: Pick<KeyBundle, 'recipient'>): KeyInfo {
  return { format: 'jinkui-keys', version: 1, recipient: keys.recipient }
}

export function parseKeyInfo(bytes: Uint8Array): KeyInfo {
  let v: KeyInfo
  try {
    v = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new Error('keys/info.json 不是合法的 JSON')
  }
  if (v?.format !== 'jinkui-keys' || typeof v.recipient !== 'string' || !v.recipient.startsWith('age1')) {
    throw new Error('keys/info.json 内容不对')
  }
  return v
}

export class DecryptError extends Error {}

/** 用保险库密钥加解密数据文件 */
export class VaultCipher {
  constructor(readonly keys: Pick<KeyBundle, 'identity' | 'recipient'>) {}

  async encrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const e = new Encrypter()
    e.addRecipient(this.keys.recipient)
    return e.encrypt(bytes)
  }

  async decrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const d = new Decrypter()
    d.addIdentity(this.keys.identity)
    try {
      return await d.decrypt(bytes)
    } catch (e) {
      throw new DecryptError(`解密失败（可能是用另一把密钥加密的，或文件已损坏）：${(e as Error).message}`)
    }
  }

  async encryptJson(v: unknown): Promise<Uint8Array> {
    return this.encrypt(utf8(JSON.stringify(v)))
  }

  async decryptJson<T = unknown>(bytes: Uint8Array): Promise<T> {
    const plain = await this.decrypt(bytes)
    try {
      return JSON.parse(fromUtf8(plain)) as T
    } catch {
      throw new DecryptError('解密后的内容不是合法的 JSON')
    }
  }
}

/**
 * 同时加密给几把公钥（任意一把私钥都能解开）。换保险库密钥（重新加入）时，
 * 本机文件先加密给新旧两把：中途 app 被杀，不管磁盘上的身份密钥是哪一把都还能解开。
 */
export async function encryptJsonTo(recipients: string[], v: unknown): Promise<Uint8Array> {
  const e = new Encrypter()
  for (const r of recipients) e.addRecipient(r)
  return e.encrypt(utf8(JSON.stringify(v)))
}

/** 数据仓库根目录的说明（明文），告诉人不用 app 怎么解开 */
export const DATA_README_TEXT = `# 金匮 保险库

这个仓库（或 Bucket 目录）由密码管理器“金匮”自动维护，请不要手动修改。

- \`keys/identity.age\`：保险库密钥，用你的**主密码**加密。
- \`keys/info.json\`：保险库公钥。
- \`devices/<设备ID>.age\`：每台设备各自上传的完整保险库，用保险库密钥加密（[age](https://age-encryption.org) 格式）。
  各设备的文件合并后就是全部数据；任意一个最新的文件通常已经包含全部条目。

## 不用金匮，在电脑上解开

1. 安装 age：macOS \`brew install age\`；Windows \`winget install FiloSottile.age\`；Linux 用系统的包管理器。
2. 用主密码解出保险库密钥：

   \`\`\`
   age -d -o key.txt keys/identity.age
   \`\`\`

3. 解开某台设备的文件，得到 JSON：

   \`\`\`
   age -d -i key.txt devices/<设备ID>.age > vault.json
   \`\`\`

   \`items\` 里每个条目的 \`title\`、\`username\`、\`password\`、\`urls\`、\`notes\` 就是你保存的内容；
   \`deleted: true\` 的是已删除的条目，\`history\` 是以前的版本。

**用完立刻删掉 key.txt 和 vault.json：有了它们就能看到全部密码。**
`
