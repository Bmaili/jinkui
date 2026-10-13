/**
 * 复制密码（规格 6.4）：原生插件 SecureClipboard 把内容标记为“敏感”（安卓 13 起不在剪贴板预览里显示），
 * 并在设定时间后清空（如果剪贴板里还是我们复制的内容）。浏览器里用 navigator.clipboard 兜底。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

interface SecureClipboardPlugin {
  copy(o: { text: string; sensitive: boolean; clearAfterMs: number }): Promise<void>
  clear(): Promise<void>
}

const Native = registerPlugin<SecureClipboardPlugin>('SecureClipboard')
let webTimer: ReturnType<typeof setTimeout> | undefined
/** 应该清空的时间：app 在后台被冻结时原生定时器可能没跑，回到前台时再补一次 */
let clearAt = 0

export async function copyText(text: string, sensitive: boolean, clearAfterSec: number): Promise<void> {
  const ms = sensitive && clearAfterSec > 0 ? clearAfterSec * 1000 : 0
  if (Capacitor.isNativePlatform()) {
    await Native.copy({ text, sensitive, clearAfterMs: ms })
  } else {
    await navigator.clipboard?.writeText(text).catch(() => {})
    clearTimeout(webTimer)
    if (ms) webTimer = setTimeout(() => void navigator.clipboard?.writeText('').catch(() => {}), ms)
  }
  clearAt = ms ? Date.now() + ms : 0
}

/** 回到前台时调用：过了清空时间却没清的，补清一次 */
export async function clearIfDue(): Promise<void> {
  if (!clearAt || Date.now() < clearAt) return
  clearAt = 0
  if (Capacitor.isNativePlatform()) await Native.clear().catch(() => {})
}
