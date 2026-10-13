/**
 * 导出（规格 5.7）：明文 CSV、用主密码加密的备份。都要先输入主密码，防止别人拿到解锁的手机直接导出。
 * 真机上写到缓存目录再调起系统分享；下次启动时清掉缓存里的导出文件。浏览器里直接下载。
 */
import { Capacitor } from '@capacitor/core'
import { Share } from '@capacitor/share'
import { Encrypter } from 'age-encryption'
import { utf8 } from './core/bytes'
import { exportCsv } from './core/csv'
import { DEFAULT_WORK_FACTOR } from './core/crypto'
import { liveItems } from './core/vault'
import { folderOf } from './core/folders'
import { backupJson, expectExternal, vault } from './store'
import { writeCacheFile } from './platform/files'

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')

async function deliver(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const uri = await writeCacheFile(name, bytes)
    const done = expectExternal()
    try {
      await Share.share({ title: name, files: [uri] })
    } finally {
      setTimeout(done, 1500)
    }
    return
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function exportCsvFile(): Promise<number> {
  const items = liveItems(vault.value)
  // 加 BOM：Excel 打开中文不乱码
  const name = (id: string | undefined) => folderOf(vault.value.folders, id)?.name
  await deliver(`jinkui-${stamp()}.csv`, utf8('\uFEFF' + exportCsv(items, name)), 'text/csv')
  return items.length
}

/** 用主密码加密的完整备份：电脑上 `age -d jinkui-backup.age > vault.json` 输入主密码即可解开 */
export async function exportBackupFile(passphrase: string): Promise<void> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(DEFAULT_WORK_FACTOR)
  await deliver(`jinkui-backup-${stamp()}.age`, await e.encrypt(backupJson()), 'application/octet-stream')
}
