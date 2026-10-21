<script setup lang="ts">
/**
 * 设置条目图标（规格 4.6、5.9）：从手机上已装的 app 选、输入网址向那个网站取、从相册选图片，或恢复默认。
 * 选好的图片缩成 96×96 存进保险库，同步到其他设备。
 */
import { computed, ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import ItemAvatar from './ItemAvatar.vue'
import type { Item } from '../../core/item'
import { iconOfItem } from '../../core/itemIcons'
import { hostOf } from '../../core/autofill'
import { appIconMap, expectExternal, fetchSiteIcon, setIcon, siteIcons, toast, vault } from '../../store'
import { prefs } from '../../prefs'
import { appIcons, type InstalledApp } from '../../platform/appIcons'
import { iconFromFile, toItemIcon } from '../iconImage'

const props = defineProps<{ open: boolean; item: Item }>()
const emit = defineEmits<{ close: [] }>()

const mode = ref<'' | 'app' | 'site'>('')
const busy = ref(false)
const error = ref('')
const hasNative = appIcons.available()
const custom = computed(() => iconOfItem(vault.value.icons, props.item.id))
const linkedApps = computed(() => (Array.isArray(props.item.apps) ? (props.item.apps as string[]) : []))

/** 现在显示的是哪种图标 */
const source = computed(() => {
  if (custom.value) return '自定义图标（同步到各设备）'
  if (prefs.appIcons && linkedApps.value.some((p) => appIconMap.value[p])) return 'app 的图标（自动填充记住过的 app）'
  const u = props.item.urls?.[0]
  if (prefs.siteIcons && u && siteIcons.value[hostOf(u)]) return '网站图标'
  return '标题的第一个字'
})

watch(() => props.open, (o) => {
  if (!o) return
  mode.value = ''
  error.value = ''
  site.value = props.item.urls?.[0] ? hostOf(props.item.urls[0]) : ''
  candidate.value = ''
})

async function use(fn: () => Promise<string>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await setIcon(props.item.id, await fn())
    toast('已设置图标')
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function reset() {
  await setIcon(props.item.id, null)
  toast('已恢复默认图标')
  emit('close')
}

// ---------- 从网站获取 ----------

const site = ref('')
const candidate = ref('')

async function fetchSite() {
  const h = hostOf(site.value)
  error.value = ''
  candidate.value = ''
  if (!h || !h.includes('.')) return void (error.value = '请输入网址，例如 icbc.com.cn')
  busy.value = true
  try {
    const d = await fetchSiteIcon(h)
    if (d) candidate.value = await toItemIcon(d, 'pad')
    else error.value = `没能从 ${h} 取到图标。可以换个网址试试（例如官网首页的网址），或者从相册选一张图片`
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

// ---------- 从手机上的 app 选 ----------

const apps = ref<InstalledApp[] | null>(null)
const appIconsLocal = ref<Record<string, string>>({})
const appQ = ref('')

async function openApps() {
  mode.value = 'app'
  error.value = ''
  if (apps.value) return
  const list = await appIcons.list()
  apps.value = list
  // 图标分批取：先取最可能用到的
  const order = [...shownApps.value, ...list].map((a) => a.packageName)
  const seen = new Set<string>()
  const pkgs = order.filter((p) => !seen.has(p) && seen.add(p))
  for (let i = 0; i < pkgs.length; i += 24) {
    const got = await appIcons.icons(pkgs.slice(i, i + 24))
    appIconsLocal.value = { ...appIconsLocal.value, ...got }
  }
}

/** 记住过的 app、名字和标题对得上的排前面；输入了文字就按名字或包名筛 */
const shownApps = computed(() => {
  const list = apps.value ?? []
  const q = appQ.value.trim().toLowerCase()
  if (q) return list.filter((a) => a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q))
  const t = props.item.title.trim().toLowerCase()
  const rank = (a: InstalledApp) => {
    if (linkedApps.value.includes(a.packageName)) return 0
    const l = a.label.toLowerCase()
    return t && (l.includes(t) || t.includes(l)) ? 1 : 2
  }
  return [...list].sort((a, b) => rank(a) - rank(b))
})

function pickApp(a: InstalledApp) {
  const src = appIconsLocal.value[a.packageName]
  if (!src) return toast('这个 app 的图标还没读出来，请稍等')
  void use(() => toItemIcon(src, 'fill'))
}

// ---------- 从相册选 ----------

const fileInput = ref<HTMLInputElement | null>(null)

function pickFile() {
  error.value = ''
  // 选图片会切到系统界面：这一次离开不上锁
  expectExternal()
  fileInput.value?.click()
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) void use(() => iconFromFile(f))
}
</script>

<template>
  <Sheet :open="open" title="设置图标" done="取消" @close="emit('close')">
    <div class="cur">
      <ItemAvatar :item="item" :size="56" />
      <span class="grow"><b>{{ item.title || '未命名' }}</b><span class="sub">现在用的是：{{ source }}</span></span>
    </div>

    <div v-if="!mode" class="group">
      <button v-if="hasNative" class="row" @click="openApps">
        <Icon name="device" />
        <span class="grow">从手机上的 app 选<span class="sub">用已安装 app 的图标，在本机读取</span></span>
      </button>
      <button class="row" @click="mode = 'site'; error = ''">
        <Icon name="globe" />
        <span class="grow">从网站获取<span class="sub">输入网址，直接向那个网站取，不经过第三方</span></span>
      </button>
      <button class="row" :disabled="busy" @click="pickFile">
        <Icon name="image" />
        <span class="grow">从相册选图片<span class="sub">例如从 iconfont 下载的 PNG，裁成正方形</span></span>
      </button>
      <button v-if="custom" class="row" :disabled="busy" @click="reset">
        <Icon name="undo" />
        <span class="grow">恢复默认<span class="sub">去掉自定义图标</span></span>
      </button>
    </div>
    <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="onFile" />

    <button v-if="mode" type="button" class="text-btn back" @click="mode = ''; error = ''"><Icon name="back" />{{ mode === 'app' ? '从手机上的 app 选' : '从网站获取' }}</button>

    <form v-if="mode === 'site'" class="panel" @submit.prevent="fetchSite">
      <label class="lbl" for="icon-site">网址<span class="faint">（直接向这个网站取，不经过第三方）</span></label>
      <div class="line">
        <input id="icon-site" v-model="site" class="field" placeholder="例如 icbc.com.cn" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" />
        <button class="solid-btn" type="submit" :disabled="busy || !site.trim()"><span v-if="busy && !candidate" class="spinner" />获取</button>
      </div>
      <div v-if="candidate" class="cand">
        <span class="preview"><img :src="candidate" alt="取到的图标" /></span>
        <button type="button" class="solid-btn" :disabled="busy" @click="use(async () => candidate)">用这个</button>
      </div>
    </form>

    <div v-if="mode === 'app'" class="panel">
      <input v-model="appQ" class="field" type="search" placeholder="搜索 app" aria-label="搜索 app" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <div v-if="!apps" class="center"><span class="spinner" /></div>
      <p v-else-if="!shownApps.length" class="muted small center">{{ appQ.trim() ? '没有找到' : '没有读到已安装的 app' }}</p>
      <ul v-else class="apps">
        <li v-for="a in shownApps" :key="a.packageName">
          <button class="app" :disabled="busy" :aria-label="a.label" @click="pickApp(a)">
            <span class="ai"><img v-if="appIconsLocal[a.packageName]" :src="appIconsLocal[a.packageName]" alt="" /></span>
            <span class="al">{{ a.label }}</span>
          </button>
        </li>
      </ul>
    </div>

    <p v-if="error" class="note-box err">{{ error }}</p>
  </Sheet>
</template>

<style scoped>
.cur { display: flex; align-items: center; gap: 14px; margin: 4px 2px 14px; }
.cur .grow { display: flex; flex-direction: column; min-width: 0; }
.cur b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cur .sub { color: var(--muted); font-size: 13px; }
.row:disabled { opacity: 0.5; }
.back { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 4px -8px; padding: 0 8px; color: var(--muted); }
.back svg { width: 18px; height: 18px; }
.panel { margin-top: 4px; }
.panel .lbl { margin-top: 6px; }
.line { display: flex; gap: 8px; }
.line .field { flex: 1; min-width: 0; }
.line .solid-btn { flex: none; }
.cand { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.preview { display: grid; place-items: center; width: 56px; height: 56px; overflow: hidden; border-radius: 16px; border: 1px solid var(--line); }
.preview img { width: 100%; height: 100%; }
.apps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; list-style: none; margin: 10px 0 0; padding: 0; }
.app { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; padding: 10px 2px; border: 0; border-radius: 12px; background: transparent; }
.app:active { background: var(--line); }
.ai { display: grid; place-items: center; width: 46px; height: 46px; overflow: hidden; border-radius: 13px; background: var(--line); }
.ai img { width: 100%; height: 100%; }
.al { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ink); }
.center { display: flex; justify-content: center; padding: 20px 0; text-align: center; }
.note-box { margin-top: 12px; }
</style>
