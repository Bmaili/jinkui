import { Device } from '@capacitor/device'

/** 默认设备名：系统设置里的设备名（安卓 7.1 起），否则“厂商 型号” */
export async function defaultDeviceName(): Promise<string> {
  try {
    const i = await Device.getInfo()
    const n = (i.name ?? '').trim()
    if (n && !/^(localhost|android)$/i.test(n)) return n.slice(0, 40)
    if (i.platform === 'web') return '浏览器'
    return `${i.manufacturer ?? ''} ${i.model ?? ''}`.trim().slice(0, 40) || '我的手机'
  } catch {
    return '我的手机'
  }
}

/** 随机设备ID：12 位小写字母和数字 */
export function newDeviceId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const b = crypto.getRandomValues(new Uint8Array(12))
  // 256 不是 36 的倍数，取模有极小的偏差；设备ID 只需要不重复，不需要均匀
  return Array.from(b, (x) => a[x % a.length]).join('')
}
