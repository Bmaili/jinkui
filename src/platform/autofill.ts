/**
 * 自动填充（规格 5.8）：原生插件 Autofill（android/.../AutofillPlugin.java）。
 * 浏览器里没有这个能力；端到端测试可以在 window.__autofillMock 上放一个假的实现。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface AutofillRequest {
  mode: 'fill' | 'save' | null
  packageName?: string
  /** app 的名字（例如“淘宝”）；拿不到时是包名 */
  appLabel?: string
  /** 网页的域名（浏览器、app 内嵌网页） */
  webDomain?: string
  hasUsername?: boolean
  hasPassword?: boolean
  /** 保存模式：用户刚输入的账号密码 */
  username?: string
  password?: string
}

export interface AutofillStatus {
  supported: boolean
  enabled: boolean
}

interface AutofillPlugin {
  status(): Promise<AutofillStatus>
  openSettings(): Promise<{ opened: boolean }>
  disable(): Promise<void>
  getRequest(): Promise<AutofillRequest>
  fill(o: { username?: string; password?: string }): Promise<void>
  close(): Promise<void>
  diagnostics(): Promise<{ lines: string[] }>
  clearDiagnostics(): Promise<void>
  log(o: { message: string }): Promise<void>
}

const Native = registerPlugin<AutofillPlugin>('Autofill')
const impl = (): AutofillPlugin | null =>
  (window as unknown as { __autofillMock?: AutofillPlugin }).__autofillMock ?? (Capacitor.isNativePlatform() ? Native : null)

export const autofill = {
  async status(): Promise<AutofillStatus> {
    const p = impl()
    if (!p) return { supported: false, enabled: false }
    try {
      return await p.status()
    } catch {
      return { supported: false, enabled: false }
    }
  },
  async openSettings(): Promise<boolean> {
    const p = impl()
    if (!p) return false
    try {
      return (await p.openSettings()).opened
    } catch {
      return false
    }
  },
  async disable(): Promise<void> {
    await impl()?.disable().catch(() => {})
  },
  /** 当前窗口是不是自动填充窗口；主界面返回 mode: null */
  async request(): Promise<AutofillRequest> {
    const p = impl()
    if (!p) return { mode: null }
    try {
      return await p.getRequest()
    } catch {
      return { mode: null }
    }
  },
  fill: (o: { username?: string; password?: string }) => impl()!.fill(o),
  close: async () => {
    await impl()?.close().catch(() => {})
  },
  /** 原生端的自动填充诊断记录（规格 6.5） */
  async diagnostics(): Promise<string[]> {
    try {
      return (await impl()?.diagnostics())?.lines ?? []
    } catch {
      return []
    }
  },
  clearDiagnostics: async () => {
    await impl()?.clearDiagnostics().catch(() => {})
  },
  /** 填充窗口的网页环境用完就没了：诊断信息记到原生端。不要传账号、密码、条目内容 */
  log(message: string): void {
    try {
      void impl()?.log?.({ message })?.catch(() => {})
    } catch { /* 记不了就算了 */ }
  },
}
