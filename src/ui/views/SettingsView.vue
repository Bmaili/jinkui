<script setup lang="ts">
/** 设置：同步、安全、数据、本机、关于 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import {
  app, backendTitle, disableBio, enableBio, expectExternal, importItems, lock, renameDevice, toast, vault, verifyPassphrase, wipeDevice,
} from '../../store'
import { prefs } from '../../prefs'
import { BIO_REASON } from '../../platform/vaultKey'
import { importCsv } from '../../core/csv'
import { trashedItems } from '../../core/vault'
import { exportBackupFile, exportCsvFile } from '../../exporter'
import { ask, promptText } from '../dialog'
import { timeAgo } from '../format'
import { showBadge } from '../../updateService'

const router = useRouter()
const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref('')
const trashCount = computed(() => trashedItems(vault.value).length)

const LOCK_OPTS = [[0, '立即'], [30, '30 秒'], [60, '1 分钟'], [300, '5 分钟'], [900, '15 分钟']] as const
const CLIP_OPTS = [[15, '15 秒'], [30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [0, '不清空']] as const

const syncSub = computed(() => {
  if (!app.backend) return '未开启：密码只在这台手机上'
  const s = app.sync
  const status = s.running ? '正在同步' : s.errorKind ? '出错了' : s.pending ? '有修改未上传' : `上次同步 ${timeAgo(s.last)}`
  return `${backendTitle(app.backend)} · ${status}`
})

const bio = computed({
  get: () => !!prefs.bioData,
  set: (on: boolean) => void toggleBio(on),
})

async function toggleBio(on: boolean) {
  try {
    if (on) {
      await enableBio()
      toast('已开启指纹解锁')
    } else {
      await disableBio()
      toast('已关闭指纹解锁')
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'CANCELLED') toast((e as Error).message)
  }
}

/** 点一下换到下一个选项 */
function next(opts: readonly (readonly [number, string])[], cur: number): number {
  const i = opts.findIndex((o) => o[0] === cur)
  return opts[(i + 1) % opts.length][0]
}
const cycleLock = () => (prefs.autoLockSec = next(LOCK_OPTS, prefs.autoLockSec))
const cycleClip = () => (prefs.clipboardSec = next(CLIP_OPTS, prefs.clipboardSec))
const label = (opts: readonly (readonly [number, string])[], v: number) => opts.find((o) => o[0] === v)?.[1] ?? `${v} 秒`

async function rename() {
  const n = await promptText({ title: '本机名称', message: '在其他设备的设备列表、历史版本里显示。', input: { value: prefs.deviceName } })
  if (n) await renameDevice(n)
}

function chooseCsv() {
  const done = expectExternal()
  window.addEventListener('focus', () => setTimeout(done, 1500), { once: true })
  fileInput.value?.click()
}

async function onCsv(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  const r = importCsv(await f.text())
  if (r.error) return toast(r.error)
  if (!r.items.length) return toast('文件里没有可以导入的条目')
  const ok = await ask({
    title: `导入 ${r.items.length} 条？`,
    message: '已经有的（标题、用户名、密码、网址都相同）会跳过。\n导入后请删掉手机里的这个 CSV 文件：它是明文的。',
    ok: '导入',
  })
  if (!ok) return
  const res = await importItems(r.items)
  toast(`导入了 ${res.added} 条${res.duplicates ? `，跳过 ${res.duplicates} 条重复的` : ''}`)
}

async function askPass(title: string, message: string): Promise<string | null> {
  const p = await promptText({ title, message, ok: '继续', input: { password: true, placeholder: '主密码' } })
  if (!p) return null
  busy.value = '正在核对主密码…'
  try {
    if (await verifyPassphrase(p)) return p
    toast('主密码不对')
    return null
  } finally {
    busy.value = ''
  }
}

async function exportCsv() {
  const p = await askPass('导出明文 CSV', '导出的文件里密码是明文的，任何人拿到都能看到。只在要迁移到别的密码管理器时使用，用完立刻删除。请输入主密码确认。')
  if (!p) return
  const n = await exportCsvFile()
  toast(`已导出 ${n} 条`)
}

async function exportBackup() {
  const p = await askPass('导出加密备份', '备份文件用主密码加密（age 格式）。电脑上装 age 后运行 age -d 文件名 > vault.json，输入主密码即可解开。请输入主密码。')
  if (!p) return
  busy.value = '正在加密…'
  try {
    await exportBackupFile(p)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = ''
  }
}

async function wipe() {
  const warn = app.backend
    ? '本机的保险库和设置会被删除，云端的不受影响：之后可以用主密码重新加入。'
    : '你没有开启同步：本机就是唯一的一份，删除后无法恢复。'
  const t = await promptText({ title: '抹掉本机数据？', message: `${warn}\n请输入“抹掉”两个字确认。`, ok: '抹掉', danger: true, input: { placeholder: '抹掉' } })
  if (t?.trim() !== '抹掉') return
  await wipeDevice()
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>设置</h1>
    </header>
    <div class="page">
      <p v-if="busy" class="note-box"><span class="spinner" /> {{ busy }}</p>

      <div class="group-title">同步</div>
      <div class="group">
        <button class="row" @click="router.push('/settings/sync')">
          <Icon :name="app.backend ? 'cloud' : 'cloud-off'" />
          <span class="grow">同步与设备<span class="sub">{{ syncSub }}</span></span>
          <Icon name="right" />
        </button>
      </div>

      <div class="group-title">安全</div>
      <div class="group">
        <div class="row">
          <Icon name="fingerprint" />
          <span class="grow">指纹解锁<span class="sub">{{ app.bio.available ? '用系统安全芯片里的密钥解开保险库' : BIO_REASON[app.bio.reason] }}</span></span>
          <Switch v-model="bio" label="指纹解锁" :disabled="!app.bio.available && !prefs.bioData" />
        </div>
        <button class="row" @click="cycleLock">
          <Icon name="clock" />
          <span class="grow">自动上锁<span class="sub">{{ prefs.autoLockSec ? '离开 app 多久后上锁（点按切换）' : '回到桌面或切到别的 app 就上锁（点按切换）' }}</span></span>
          <span class="val">{{ label(LOCK_OPTS, prefs.autoLockSec) }}</span>
        </button>
        <div class="row">
          <Icon name="eye-off" />
          <span class="grow">防止截屏<span class="sub">{{ prefs.blockScreenshots ? '不能截屏、录屏，最近任务里也看不到内容' : '已关闭：可以截屏，最近任务里会显示金匮的画面' }}</span></span>
          <Switch v-model="prefs.blockScreenshots" label="防止截屏" />
        </div>
        <button class="row" @click="cycleClip">
          <Icon name="copy" />
          <span class="grow">清空剪贴板<span class="sub">复制密码后多久清空（点按切换）</span></span>
          <span class="val">{{ label(CLIP_OPTS, prefs.clipboardSec) }}</span>
        </button>
        <button class="row" @click="router.push('/settings/password')">
          <Icon name="key" />
          <span class="grow">修改主密码</span>
          <Icon name="right" />
        </button>
        <button class="row" @click="lock()">
          <Icon name="lock" />
          <span class="grow">立即上锁</span>
        </button>
      </div>

      <div class="group-title">数据</div>
      <div class="group">
        <button class="row" @click="chooseCsv">
          <Icon name="upload" />
          <span class="grow">从 CSV 导入<span class="sub">Chrome、Edge、Bitwarden、KeePassXC 等导出的文件</span></span>
        </button>
        <button class="row" @click="exportBackup">
          <Icon name="shield" />
          <span class="grow">导出加密备份<span class="sub">用主密码加密的完整备份文件</span></span>
        </button>
        <button class="row" @click="exportCsv">
          <Icon name="download" />
          <span class="grow">导出明文 CSV<span class="sub">迁移到其他密码管理器时用</span></span>
        </button>
        <button class="row" @click="router.push('/trash')">
          <Icon name="trash" />
          <span class="grow">最近删除<span class="sub">{{ trashCount ? `${trashCount} 条，180 天内可以恢复` : '没有删除的条目' }}</span></span>
          <Icon name="right" />
        </button>
      </div>
      <input ref="fileInput" type="file" accept=".csv,text/csv,text/comma-separated-values,text/plain" hidden @change="onCsv" />

      <div class="group-title">本机</div>
      <div class="group">
        <button class="row" @click="rename">
          <Icon name="device" />
          <span class="grow">本机名称<span class="sub">{{ prefs.deviceName }}</span></span>
          <Icon name="pen" />
        </button>
        <button class="row" @click="wipe">
          <Icon name="close" class="danger" />
          <span class="grow danger">抹掉本机数据</span>
        </button>
      </div>

      <div class="group-title">关于</div>
      <div class="group">
        <button class="row" @click="router.push('/settings/about')">
          <Icon name="info" />
          <span class="grow">关于金匮<span v-if="showBadge" class="dot" aria-label="有新版本" /><span class="sub">版本、检查更新</span></span>
          <Icon name="right" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.val { flex: none; color: var(--muted); font-size: 14px; }
.dot { display: inline-block; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%; background: var(--danger); vertical-align: 2px; }
.row > svg.danger { color: var(--danger); }
</style>
