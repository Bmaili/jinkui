/**
 * 本机已装 app 的名字和图标（1.0.8 起，规格 5.9）：原生插件 AppIcons（android/.../AppIconsPlugin.java）。
 * 全部在本机读，不联网。浏览器里没有这个能力；端到端测试可以在 window.__appIconsMock 上放一个假的实现。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface InstalledApp {
  packageName: string
  label: string
}

interface AppIconsPlugin {
  listApps(): Promise<{ apps: InstalledApp[] }>
  icons(o: { packages: string[]; size?: number }): Promise<{ icons: Record<string, string> }>
}

const Native = registerPlugin<AppIconsPlugin>('AppIcons')
const impl = (): AppIconsPlugin | null =>
  (window as unknown as { __appIconsMock?: AppIconsPlugin }).__appIconsMock ?? (Capacitor.isNativePlatform() ? Native : null)

/** 原生端一次最多返回这么多个 */
const BATCH = 60

export const appIcons = {
  available: () => !!impl(),
  /** 桌面上有图标的 app，按名字排（中文按拼音） */
  async list(): Promise<InstalledApp[]> {
    try {
      const apps = (await impl()?.listApps())?.apps ?? []
      return apps.filter((a) => a && typeof a.packageName === 'string').sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    } catch {
      return []
    }
  },
  /** 包名 → data:image/png 地址；没装的不返回。不抛错 */
  async icons(packages: string[], size = 96): Promise<Record<string, string>> {
    const p = impl()
    if (!p || !packages.length) return {}
    const out: Record<string, string> = {}
    for (let i = 0; i < packages.length; i += BATCH) {
      try {
        const r = (await p.icons({ packages: packages.slice(i, i + BATCH), size }))?.icons ?? {}
        for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && v.startsWith('data:image/png;base64,')) out[k] = v
      } catch { /* 这一批取不到就算了 */ }
    }
    return out
  },
}
