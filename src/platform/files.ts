/**
 * 本地文件：真机上在 app 私有目录（Directory.Data），浏览器预览时由插件自带的 IndexedDB 实现兜底。
 * 上层只通过 SlotStore（core/slots.ts）读写，保证写到一半断电也不坏。
 */
import { Directory, Filesystem } from '@capacitor/filesystem'
import { fromBase64, toBase64 } from '../core/bytes'
import { SlotStore, type RawStore } from '../core/slots'

const D = Directory.Data
const ROOT = 'jinkui'

const raw: RawStore = {
  async read(path) {
    try {
      const r = await Filesystem.readFile({ path: `${ROOT}/${path}`, directory: D })
      if (typeof r.data === 'string') return fromBase64(r.data)
      return new Uint8Array(await (r.data as Blob).arrayBuffer())
    } catch {
      return null
    }
  },
  async write(path, bytes) {
    await Filesystem.writeFile({ path: `${ROOT}/${path}`, data: toBase64(bytes), directory: D, recursive: true })
  },
  async remove(path) {
    await Filesystem.deleteFile({ path: `${ROOT}/${path}`, directory: D })
  },
}

export const files = new SlotStore(raw)

/** 清空全部本地数据（“抹掉本机数据”） */
export async function wipeLocal(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: ROOT, directory: D, recursive: true })
  } catch { /* 不存在 */ }
}

/** 写一个临时文件到缓存目录（导出分享用），返回 file:// 地址 */
export async function writeCacheFile(name: string, bytes: Uint8Array): Promise<string> {
  const r = await Filesystem.writeFile({ path: `export/${name}`, data: toBase64(bytes), directory: Directory.Cache, recursive: true })
  return r.uri
}

/** 删掉上次导出留下的临时文件（导出的明文 CSV 不能一直留在缓存里） */
export async function cleanCacheExports(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: 'export', directory: Directory.Cache, recursive: true })
  } catch { /* 不存在 */ }
}
