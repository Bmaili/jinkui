/**
 * 指纹解锁（规格 6.4）：原生插件 VaultKey（android/.../VaultKeyPlugin.java）。
 *
 * 在 Android Keystore 里生成一把 AES 密钥，设置为“每次使用都要通过强生物识别”，
 * 用它加密保险库密钥。解锁时由系统的指纹框授权这把密钥解密——授权和解密绑在一起（CryptoObject），
 * 不是由网页判断“认证成功”。换了指纹、关掉锁屏后这把密钥自动失效，需要用主密码重新开启。
 *
 * 浏览器里没有这个能力；端到端测试可以在 window.__vaultKeyMock 上放一个假的实现。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface BioStatus {
  available: boolean
  reason: 'ok' | 'none-enrolled' | 'no-hardware' | 'unavailable' | 'web'
}

interface VaultKeyPlugin {
  status(): Promise<BioStatus>
  /** 弹指纹框，成功后加密 secret，返回密文（base64，含 IV） */
  enroll(o: { secret: string; title: string; cancel: string }): Promise<{ data: string }>
  /** 弹指纹框，成功后解密。错误码：CANCELLED、INVALIDATED（密钥失效）、LOCKOUT（试错太多）、FAILED */
  unlock(o: { data: string; title: string; cancel: string }): Promise<{ secret: string }>
  remove(): Promise<void>
}

const Native = registerPlugin<VaultKeyPlugin>('VaultKey')
const impl = (): VaultKeyPlugin | null =>
  (window as unknown as { __vaultKeyMock?: VaultKeyPlugin }).__vaultKeyMock ?? (Capacitor.isNativePlatform() ? Native : null)

export async function bioStatus(): Promise<BioStatus> {
  const p = impl()
  if (!p) return { available: false, reason: 'web' }
  try {
    return await p.status()
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

export class BioError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function wrap(e: unknown): BioError {
  const err = e as { code?: string; message?: string }
  const code = err.code ?? 'FAILED'
  const msg: Record<string, string> = {
    CANCELLED: '已取消',
    INVALIDATED: '手机的指纹或锁屏设置变了，指纹解锁已失效。请用主密码解锁，再到设置里重新开启',
    LOCKOUT: '试错太多次，指纹暂时不可用，请用主密码',
  }
  return new BioError(code, msg[code] ?? err.message ?? '指纹验证失败')
}

export async function bioEnroll(secret: string): Promise<string> {
  const p = impl()
  if (!p) throw new BioError('UNAVAILABLE', '这台设备不支持指纹')
  try {
    return (await p.enroll({ secret, title: '开启指纹解锁', cancel: '取消' })).data
  } catch (e) {
    throw wrap(e)
  }
}

export async function bioUnlock(data: string): Promise<string> {
  const p = impl()
  if (!p) throw new BioError('UNAVAILABLE', '这台设备不支持指纹')
  try {
    return (await p.unlock({ data, title: '解锁金匮', cancel: '用主密码' })).secret
  } catch (e) {
    throw wrap(e)
  }
}

export async function bioRemove(): Promise<void> {
  await impl()?.remove().catch(() => {})
}

export const BIO_REASON: Record<BioStatus['reason'], string> = {
  ok: '',
  'none-enrolled': '手机还没有录入指纹，先到系统设置里录入',
  'no-hardware': '这台手机没有可用的指纹识别（需要“强”生物识别，部分手机的人脸识别不算）',
  unavailable: '指纹识别暂时不可用',
  web: '只在手机上可用',
}
