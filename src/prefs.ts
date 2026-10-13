/**
 * 不含秘密的设置，存在 Preferences（app 私有目录）。
 * 读取时只合并已有的键：新版本加的设置有默认值。
 */
import { reactive, watch } from 'vue'
import { Preferences } from '@capacitor/preferences'

export interface Prefs {
  /** 本机的设备ID（第一次建立或加入保险库时生成，之后不变） */
  deviceId: string
  deviceName: string
  /** 保险库公钥（公开），用来核对解开的密钥是不是这个保险库的 */
  recipient: string
  /** 切到后台多少秒后自动上锁；0 表示一离开就锁（1.0.2 起默认） */
  autoLockSec: number
  /** 防止截屏、录屏，最近任务里不显示内容（FLAG_SECURE），默认开 */
  blockScreenshots: boolean
  /** 设置的版本，用来给老用户迁移默认值 */
  prefsVersion: number
  /** 复制密码后多少秒清空剪贴板；0 表示不清空 */
  clipboardSec: number
  /** 指纹解锁：Keystore 加密后的保险库密钥（没有 Keystore 里的那把钥匙就是废数据） */
  bioData: string
  /** 改了主密码但还没成功上传 identity.age，下次同步时补传 */
  keyUploadPending: boolean
  /** 自动检查更新 */
  autoUpdate: boolean
}

const KEY = 'jinkui.prefs.v1'

export const defaults = (): Prefs => ({
  deviceId: '',
  deviceName: '',
  recipient: '',
  autoLockSec: 0,
  blockScreenshots: true,
  prefsVersion: 2,
  clipboardSec: 30,
  bioData: '',
  keyUploadPending: false,
  autoUpdate: true,
})

export const prefs = reactive<Prefs>(defaults())

let loaded = false

export async function loadPrefs(): Promise<void> {
  try {
    const raw = (await Preferences.get({ key: KEY })).value
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Prefs>
      for (const k of Object.keys(prefs) as (keyof Prefs)[]) {
        if (k in saved && typeof saved[k] === typeof prefs[k]) (prefs as Record<string, unknown>)[k] = saved[k]
      }
      // 1.0.1 的设置（没有 prefsVersion）：自动上锁改成新的默认值“立即”
      if (!saved.prefsVersion) {
        prefs.autoLockSec = 0
        prefs.prefsVersion = 2
      }
    }
  } catch { /* 坏了就用默认值 */ }
  loaded = true
}

export async function savePrefs(): Promise<void> {
  if (!loaded) return
  await Preferences.set({ key: KEY, value: JSON.stringify(prefs) })
}

watch(prefs, () => void savePrefs(), { deep: true })

export async function resetPrefs(): Promise<void> {
  Object.assign(prefs, defaults())
  await Preferences.remove({ key: KEY })
}
