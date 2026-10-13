/**
 * 防止截屏（规格 6.4）：原生插件 PrivacyScreen 开关 FLAG_SECURE。
 * MainActivity 启动时默认就开着（网页加载前也受保护），这里按设置同步一次。浏览器里没有这个能力。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

const Native = registerPlugin<{ set(o: { on: boolean }): Promise<void> }>('PrivacyScreen')

export async function setScreenshotBlocking(on: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  await Native.set({ on }).catch(() => {})
}
