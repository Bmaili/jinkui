/**
 * 设备文件 devices/<设备ID>.age 的内容（规格 4.4）：这台设备知道的完整保险库，加上设备信息。
 * 每台设备只写自己的文件，永远不改别人的。
 */
import { FORMAT, FormatTooNewError, VaultFormatError, parseVault, type VaultState } from '../vault'

export interface DeviceInfo {
  id: string
  /** 设备名，例如“小米 14”，在设备列表里显示 */
  name: string
  /** 写入时间（毫秒），只用于显示“最后同步” */
  written: number
}

export interface DeviceFile {
  format: number
  device: DeviceInfo
  vault: VaultState
}

export function makeDeviceFile(device: Omit<DeviceInfo, 'written'>, vault: VaultState, now = Date.now()): DeviceFile {
  return { format: FORMAT, device: { ...device, written: now }, vault }
}

export function parseDeviceFile(json: unknown, expectedId: string): { file: DeviceFile; skipped: string[] } {
  const f = json as DeviceFile
  if (!f || typeof f !== 'object' || !Number.isInteger(f.format)) throw new VaultFormatError('设备文件结构不对')
  if (f.format > FORMAT) throw new FormatTooNewError(f.format)
  const d = f.device
  if (!d || typeof d.id !== 'string' || typeof d.name !== 'string' || typeof d.written !== 'number') {
    throw new VaultFormatError('设备文件缺少设备信息')
  }
  // 文件名和内容里的设备ID对不上：可能是被人改名或拷贝过，不信任它
  if (d.id !== expectedId) throw new VaultFormatError(`设备文件名与内容不符（${expectedId} ≠ ${d.id}）`)
  const { state, skipped } = parseVault(f.vault)
  return { file: { ...f, vault: state }, skipped }
}
