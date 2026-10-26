<script setup lang="ts">
/**
 * 扩展的弹窗：加入保险库、解锁、当前网站的推荐、全部条目、详情、生成器、设置。
 * 保险库只在后台解开；这里每次打开向后台要一份条目（弹窗是扩展自己的页面，网页拿不到）。
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import Logo from '../../../src/ui/components/Logo.vue'
import Icon from '../../../src/ui/components/Icon.vue'
import Switch from '../../../src/ui/components/Switch.vue'
import type { Item } from '../../../src/core/item'
import { searchItems, sortItems, initialOf } from '../../../src/core/search'
import { hostOf, scoreItem } from '../../../src/core/autofill'
import { DEFAULT_GEN, estimateBits, generatePassword, strengthLabel, type GenOptions } from '../../../src/core/generator'
import { normalizeJoinCode } from '../../../src/core/sync/setup'
import type { ItemsReply, StateReply } from '../messages'
import { RELEASES_URL, activeTab, call, compareVersions, latestExtVersion } from './api'

type View = 'list' | 'item' | 'gen' | 'settings'

const st = ref<StateReply | null>(null)
const tab = ref<{ id?: number; url: string }>({ url: '' })
const items = ref<Item[]>([])
const view = ref<View>('list')
const current = ref<Item | null>(null)
const q = ref('')
const busy = ref('')
const error = ref('')
const toastMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined

function toast(m: string) {
  toastMsg.value = m
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 2400)
}

const isWeb = computed(() => /^https?:/i.test(tab.value.url))
const host = computed(() => hostOf(tab.value.url))

async function refresh() {
  tab.value = await activeTab()
  st.value = await call<StateReply>({ t: 'state', tabId: tab.value.id, url: tab.value.url })
  if (st.value.phase === 'unlocked') items.value = (await call<ItemsReply>({ t: 'items' })).items
  else items.value = []
  // 正在同步：过一会儿再拿一次（同步完可能多了别的设备上的条目）
  clearTimeout(pollTimer)
  if (st.value.sync.running) pollTimer = setTimeout(() => void refresh().catch(() => {}), 800)
}
let pollTimer: ReturnType<typeof setTimeout> | undefined

onMounted(async () => {
  try {
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
  await nextTick()
  document.querySelector<HTMLInputElement>('[data-autofocus]')?.focus()
  void checkUpdate()
})

/** scrypt 会卡住一两秒：先把“正在…”画出来 */
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

async function run(label: string, f: () => Promise<void>) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  await frame()
  try {
    await f()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

// ---------- 加入、解锁 ----------

const join = reactive({ code: '', pass: '', name: defaultName() })
function defaultName() {
  const ua = navigator.userAgent
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '电脑'
  const br = /Edg\//.test(ua) ? 'Edge' : 'Chrome'
  return `${br} · ${os}`
}
const codeOk = computed(() => !!normalizeJoinCode(join.code))

const doJoin = () =>
  run('正在加入…（要几秒）', async () => {
    await call({ t: 'join', code: join.code, pass: join.pass, name: join.name })
    join.code = ''
    join.pass = ''
    await refresh()
  })

const pass = ref('')
const doUnlock = () =>
  run('正在解锁…', async () => {
    try {
      await call({ t: 'unlock', pass: pass.value })
    } finally {
      pass.value = ''
    }
    await refresh()
  })

async function lockNow() {
  await call({ t: 'lock' })
  view.value = 'list'
  current.value = null
  await refresh()
}

// ---------- 列表 ----------

const suggested = computed(() => {
  const ids = st.value?.suggested ?? []
  return ids.map((id) => items.value.find((i) => i.id === id)).filter((i): i is Item => !!i)
})
const shown = computed(() => (q.value.trim() ? searchItems(items.value, q.value) : sortItems(items.value, 'name')))

function open(it: Item) {
  current.value = it
  showPw.value = false
  view.value = 'item'
}

async function copy(text: string | undefined, label: string, secret: boolean) {
  if (!text) return
  try {
    await call({ t: 'copy', text, secret })
    const sec = st.value?.prefs.clipboardSec ?? 0
    toast(secret && sec ? `已复制${label}，${sec} 秒后清空剪贴板` : `已复制${label}`)
  } catch (e) {
    toast((e as Error).message)
  }
}

/** 填充前：条目的网址和当前网页对不上时先确认（防止在仿冒网站上填进真网站的密码） */
const confirmFill = ref<Item | null>(null)

function matchesHere(it: Item) {
  return scoreItem(it, { webDomain: host.value }) > 0
}

async function fill(it: Item, confirmed = false) {
  if (!tab.value.id || !isWeb.value) return
  if (!confirmed && !matchesHere(it)) {
    confirmFill.value = it
    return
  }
  confirmFill.value = null
  try {
    await call({ t: 'fill', tabId: tab.value.id, url: tab.value.url, id: it.id })
    window.close()
  } catch (e) {
    toast((e as Error).message)
  }
}

const itemHosts = (it: Item) => (it.urls ?? []).map(hostOf).filter(Boolean).join('、') || '没有网址'

// ---------- 待保存的登录 ----------

async function savePending(mode: 'update' | 'new') {
  if (!tab.value.id) return
  await run('正在保存…', async () => {
    await call({ t: 'savePending', tabId: tab.value.id!, mode })
    toast('已保存')
    await refresh()
  })
}

async function dropPending() {
  if (!tab.value.id) return
  await call({ t: 'dropPending', tabId: tab.value.id })
  await refresh()
}

// ---------- 详情 ----------

const showPw = ref(false)
const fieldsOf = (it: Item) => (Array.isArray(it.fields) ? it.fields : [])

function openUrl(u: string) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`
  if (!/^https?:/i.test(url)) return
  void chrome.tabs.create({ url })
  window.close()
}

// ---------- 生成器 ----------

const gen = reactive<GenOptions>({ ...DEFAULT_GEN })
const generated = ref(generatePassword(gen))
const regen = () => (generated.value = generatePassword(gen))
const genStrength = computed(() => strengthLabel(estimateBits(generated.value)))

async function fillGenerated() {
  if (!tab.value.id || !isWeb.value) return
  try {
    await call({ t: 'fillPassword', tabId: tab.value.id, url: tab.value.url, password: generated.value })
    await call({ t: 'copy', text: generated.value, secret: true })
    toast('已填入密码框，并复制了一份（登录或注册后会提示保存）')
  } catch (e) {
    toast((e as Error).message)
  }
}

// ---------- 设置 ----------

const IDLE = [[60, '1 小时'], [240, '4 小时'], [480, '8 小时'], [0, '关掉 Chrome 时']] as const
const CLIP = [[15, '15 秒'], [30, '30 秒'], [60, '1 分钟'], [0, '不清空']] as const
const label = (opts: readonly (readonly [number, string])[], v: number) => opts.find((o) => o[0] === v)?.[1] ?? `${v}`
function next(opts: readonly (readonly [number, string])[], v: number) {
  const i = opts.findIndex((o) => o[0] === v)
  return opts[(i + 1) % opts.length][0]
}

async function setPref(patch: { idleMin?: number; clipboardSec?: number; deviceName?: string }) {
  await call({ t: 'prefs', patch })
  await refresh()
}

async function rename() {
  const n = window.prompt('本机名称（在手机的设备列表里显示）', st.value?.prefs.deviceName ?? '')
  if (n?.trim()) await setPref({ deviceName: n.trim().slice(0, 40) })
}

async function syncNow() {
  await run('正在同步…', async () => {
    const r = await call<{ ok: boolean }>({ t: 'sync' })
    await refresh()
    toast(r.ok ? '已同步' : `同步失败：${st.value?.sync.error ?? ''}`)
  })
}

function openHello() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('hello.html') })
  window.close()
}

const wipePass = ref('')
const wiping = ref(false)
const doWipe = () =>
  run('正在抹掉…', async () => {
    await call({ t: 'wipe', pass: wipePass.value })
    wipePass.value = ''
    wiping.value = false
    view.value = 'list'
    await refresh()
  })

const update = ref<{ version: string; url: string } | null>(null)
async function checkUpdate() {
  try {
    const last = Number(localStorage.getItem('updateCheckedAt') ?? 0)
    const cached = localStorage.getItem('updateLatest')
    let latest: { version: string; url: string } | null = cached ? JSON.parse(cached) : null
    if (Date.now() - last > 12 * 3600_000) {
      latest = await latestExtVersion()
      localStorage.setItem('updateCheckedAt', String(Date.now()))
      localStorage.setItem('updateLatest', JSON.stringify(latest))
    }
    const mine = chrome.runtime.getManifest().version
    update.value = latest && compareVersions(latest.version, mine) > 0 ? latest : null
  } catch { /* 查不到就算了 */ }
}

const syncLine = computed(() => {
  const s = st.value?.sync
  if (!s) return ''
  if (s.running) return '正在同步…'
  if (s.errorKind === 'key') return '云端的保险库密钥换过了：请在设置里抹掉本机数据，再用新的加入码加入'
  if (s.errorKind === 'auth') return 'Token 无效或过期：请在手机上更新同步设置，再生成加入码重新加入'
  if (s.errorKind) return `同步出错：${s.error}`
  if (!s.last) return s.pending ? '有修改未上传' : '还没有同步'
  const min = Math.round((Date.now() - s.last) / 60_000)
  return `${s.pending ? '有修改未上传 · ' : ''}上次同步 ${min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`}`
})
</script>

<template>
  <div class="pop">
    <!-- 加载中 -->
    <div v-if="!st" class="center"><span v-if="!error" class="spinner" /><p v-else class="note-box err">{{ error }}</p></div>

    <!-- 加入 -->
    <form v-else-if="st.phase === 'setup'" class="pad gate" @submit.prevent="doJoin">
      <div class="brand"><Logo :size="44" /><h1>金匮</h1></div>
      <p class="muted lead">在手机上打开金匮：设置 → 同步与设备 → 生成加入码，把加入码发到这台电脑上，粘贴到下面。</p>
      <textarea v-model="join.code" class="field mono code" rows="3" placeholder="jinkui-join:…" aria-label="加入码" data-autofocus />
      <input v-model="join.pass" class="field mono" type="password" placeholder="主密码" aria-label="主密码" autocomplete="off" />
      <input v-model="join.name" class="field" placeholder="本机名称" aria-label="本机名称" />
      <p v-if="error" class="note-box err">{{ error }}</p>
      <button class="solid-btn block" type="submit" :disabled="!!busy || !codeOk || !join.pass">
        <span v-if="busy" class="spinner" />{{ busy || '加入保险库' }}
      </button>
      <p class="faint small">这台电脑会作为一台新设备加入，只上传自己的加密文件；主密码不会保存。</p>
    </form>

    <!-- 解锁 -->
    <form v-else-if="st.phase === 'locked' || st.phase === 'loading'" class="pad gate" @submit.prevent="doUnlock">
      <div class="brand"><Logo :size="44" /><h1>金匮</h1><p class="muted">已上锁</p></div>
      <p v-if="st.pending" class="note-box">解锁后可以保存刚才在 {{ hostOf(st.pending.url) }} 的登录。</p>
      <input v-model="pass" class="field mono" type="password" placeholder="主密码" aria-label="主密码" autocomplete="off" data-autofocus :disabled="!!busy" />
      <p v-if="error" class="note-box err">{{ error }}</p>
      <button class="solid-btn block" type="submit" :disabled="!!busy || !pass">
        <span v-if="busy" class="spinner" />{{ busy || '解锁' }}
      </button>
      <p class="faint small">{{ st.prefs.idleMin ? `关掉 Chrome，或 ${label(IDLE, st.prefs.idleMin)}没用时上锁` : '关掉 Chrome 时上锁' }}</p>
    </form>

    <!-- 已解锁 -->
    <template v-else>
      <!-- 列表 -->
      <div v-if="view === 'list'" class="main">
        <header class="bar">
          <input v-model="q" class="field search" placeholder="搜索" aria-label="搜索" data-autofocus />
          <button class="icon-btn" aria-label="生成密码" title="生成密码" @click="regen(); view = 'gen'"><Icon name="dice" /></button>
          <button class="icon-btn" aria-label="设置" title="设置" @click="view = 'settings'"><Icon name="settings" /></button>
          <button class="icon-btn" aria-label="上锁" title="上锁" @click="lockNow"><Icon name="lock" /></button>
        </header>

        <div class="scroll">
          <div v-if="st.pending" class="note-box pending">
            <p><b>保存这个登录？</b><br /><span class="small">{{ st.pending.username || '（没有用户名）' }} · {{ hostOf(st.pending.url) }}</span></p>
            <div class="btns">
              <button class="text-btn" :disabled="!!busy" @click="dropPending">不保存</button>
              <button v-if="st.pending.updateId" class="text-btn" :disabled="!!busy" @click="savePending('new')">另存一条</button>
              <button class="solid-btn" :disabled="!!busy" @click="savePending(st.pending.updateId ? 'update' : 'new')">
                {{ st.pending.updateId ? `更新“${st.pending.updateTitle}”` : '保存' }}
              </button>
            </div>
          </div>

          <div v-if="confirmFill" class="note-box warn">
            <p>“{{ confirmFill.title }}”的网址是 {{ itemHosts(confirmFill) }}，当前网页是 <b>{{ host }}</b>。确定要填进去？仿冒网站常常长得和真的一样。</p>
            <div class="btns">
              <button class="text-btn" @click="confirmFill = null">取消</button>
              <button class="solid-btn" @click="fill(confirmFill!, true)">仍然填充</button>
            </div>
          </div>

          <template v-if="!q.trim() && suggested.length">
            <div class="group-title">{{ host }}</div>
            <div class="group">
              <div v-for="it in suggested" :key="it.id" class="row entry">
                <span class="avatar">{{ initialOf(it.title) }}</span>
                <button class="grow plain" @click="open(it)">{{ it.title }}<span class="sub">{{ it.username || '—' }}</span></button>
                <button class="text-btn accent" @click="fill(it)">填充</button>
                <button class="icon-btn" aria-label="复制密码" title="复制密码" @click="copy(it.password, '密码', true)"><Icon name="copy" /></button>
              </div>
            </div>
          </template>

          <div class="group-title">{{ q.trim() ? '搜索结果' : '全部' }}</div>
          <div v-if="shown.length" class="group">
            <div v-for="it in shown" :key="it.id" class="row entry">
              <span class="avatar">{{ initialOf(it.title) }}</span>
              <button class="grow plain" @click="open(it)">{{ it.title }}<span class="sub">{{ it.username || itemHosts(it) }}</span></button>
              <button v-if="isWeb && it.type !== 'note'" class="text-btn accent" @click="fill(it)">填充</button>
              <button v-if="it.password" class="icon-btn" aria-label="复制密码" title="复制密码" @click="copy(it.password, '密码', true)"><Icon name="copy" /></button>
            </div>
          </div>
          <p v-else class="muted small empty-note">{{ q.trim() ? '没有找到' : '还没有条目：在手机上添加，或在网页上登录后保存' }}</p>
        </div>

        <footer class="foot" :class="{ err: st.sync.errorKind && st.sync.errorKind !== 'network' }">
          <span class="grow">{{ syncLine }}</span>
          <button class="text-btn" :disabled="st.sync.running || !!busy" @click="syncNow">立即同步</button>
        </footer>
      </div>

      <!-- 详情 -->
      <div v-else-if="view === 'item' && current" class="main">
        <header class="bar">
          <button class="icon-btn" aria-label="返回" @click="view = 'list'"><Icon name="back" /></button>
          <h1 class="title">{{ current.title }}</h1>
        </header>
        <div class="scroll">
          <div class="group">
            <div v-if="current.username" class="row">
              <span class="grow">用户名<span class="sub val">{{ current.username }}</span></span>
              <button class="icon-btn" aria-label="复制用户名" @click="copy(current.username, '用户名', false)"><Icon name="copy" /></button>
            </div>
            <div v-if="current.password" class="row">
              <span class="grow">密码<span class="sub val mono">{{ showPw ? current.password : '••••••••••' }}</span></span>
              <button class="icon-btn" :aria-label="showPw ? '隐藏' : '显示'" @click="showPw = !showPw"><Icon :name="showPw ? 'eye-off' : 'eye'" /></button>
              <button class="icon-btn" aria-label="复制密码" @click="copy(current.password, '密码', true)"><Icon name="copy" /></button>
            </div>
            <div v-for="u in current.urls ?? []" :key="u" class="row">
              <span class="grow">网址<span class="sub val">{{ u }}</span></span>
              <button class="icon-btn" aria-label="打开" @click="openUrl(u)"><Icon name="link" /></button>
            </div>
            <div v-for="(f, i) in fieldsOf(current)" :key="i" class="row">
              <span class="grow">{{ f.name }}<span class="sub val" :class="{ mono: f.secret }">{{ f.secret ? '••••••' : f.value }}</span></span>
              <button class="icon-btn" :aria-label="`复制${f.name}`" @click="copy(f.value, f.name, !!f.secret)"><Icon name="copy" /></button>
            </div>
          </div>
          <template v-if="current.notes">
            <div class="group-title">备注</div>
            <p class="notes">{{ current.notes }}</p>
          </template>
          <p class="faint small hint">编辑、历史版本、目录请在手机上操作。</p>
          <button v-if="isWeb && current.type !== 'note'" class="solid-btn block" @click="fill(current)">填到当前网页</button>
          <div v-if="confirmFill" class="note-box warn" style="margin-top: 10px">
            <p>这一条的网址是 {{ itemHosts(confirmFill) }}，当前网页是 <b>{{ host }}</b>。确定要填进去？</p>
            <div class="btns">
              <button class="text-btn" @click="confirmFill = null">取消</button>
              <button class="solid-btn" @click="fill(confirmFill!, true)">仍然填充</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 生成器 -->
      <div v-else-if="view === 'gen'" class="main">
        <header class="bar">
          <button class="icon-btn" aria-label="返回" @click="view = 'list'"><Icon name="back" /></button>
          <h1 class="title">生成密码</h1>
        </header>
        <div class="scroll">
          <p class="gen mono">{{ generated }}</p>
          <p class="small muted">强度：{{ genStrength.label }}</p>
          <div class="group">
            <div class="row"><span class="grow">长度 {{ gen.length }}</span><input v-model.number="gen.length" type="range" min="8" max="64" aria-label="长度" @input="regen" /></div>
            <div class="row"><span class="grow">大写字母</span><Switch v-model="gen.upper" label="大写字母" @update:model-value="regen" /></div>
            <div class="row"><span class="grow">数字</span><Switch v-model="gen.digits" label="数字" @update:model-value="regen" /></div>
            <div class="row"><span class="grow">符号</span><Switch v-model="gen.symbols" label="符号" @update:model-value="regen" /></div>
          </div>
          <div class="gen-btns">
            <button class="text-btn" @click="regen"><Icon name="refresh" /> 换一个</button>
            <button class="text-btn accent" @click="copy(generated, '密码', true)"><Icon name="copy" /> 复制</button>
          </div>
          <button v-if="isWeb" class="solid-btn block" @click="fillGenerated">填进当前网页的密码框</button>
        </div>
      </div>

      <!-- 设置 -->
      <div v-else class="main">
        <header class="bar">
          <button class="icon-btn" aria-label="返回" @click="view = 'list'"><Icon name="back" /></button>
          <h1 class="title">设置</h1>
        </header>
        <div class="scroll">
          <div v-if="update" class="note-box">
            <p>有新版本 {{ update.version }}。下载 zip 解压，覆盖原来的文件夹，再到 chrome://extensions 点金匮的“重新加载”。</p>
            <button class="text-btn accent" @click="openUrl(update.url)">去下载</button>
          </div>
          <div class="group">
            <button class="row" @click="setPref({ idleMin: next(IDLE, st.prefs.idleMin) })">
              <Icon name="clock" /><span class="grow">自动上锁<span class="sub">没用多久后上锁（点按切换）；关掉 Chrome 总会上锁</span></span><span class="v">{{ label(IDLE, st.prefs.idleMin) }}</span>
            </button>
            <button class="row" @click="setPref({ clipboardSec: next(CLIP, st.prefs.clipboardSec) })">
              <Icon name="copy" /><span class="grow">清空剪贴板<span class="sub">复制密码后多久清空</span></span><span class="v">{{ label(CLIP, st.prefs.clipboardSec) }}</span>
            </button>
            <button class="row" @click="rename">
              <Icon name="device" /><span class="grow">本机名称<span class="sub">{{ st.prefs.deviceName }}</span></span><Icon name="pen" />
            </button>
          </div>
          <div class="group-title">同步</div>
          <div class="group">
            <div class="row"><Icon name="cloud" /><span class="grow">{{ st.backendTitle }}<span class="sub">{{ syncLine }}</span></span></div>
            <button class="row" :disabled="!!busy" @click="syncNow"><Icon name="refresh" /><span class="grow">立即同步</span></button>
          </div>
          <p class="faint small hint">换 Token、换仓库请在手机上改，再生成加入码；这里抹掉本机数据后重新加入。</p>
          <div class="group-title">关于</div>
          <div class="group">
            <div class="row"><Icon name="info" /><span class="grow">版本 {{ st.version }}<span class="sub">快捷键 Ctrl+Shift+L：填当前网页（只有一条推荐时）</span></span></div>
            <button class="row" @click="openUrl(RELEASES_URL)"><Icon name="download" /><span class="grow">所有版本</span><Icon name="right" /></button>
            <button class="row" @click="openHello"><Icon name="fingerprint" /><span class="grow">试试 Windows Hello<span class="sub">看这台电脑能不能用人脸、指纹代替主密码（试验）</span></span><Icon name="right" /></button>
          </div>
          <div class="group" style="margin-top: 12px">
            <button v-if="!wiping" class="row" @click="wiping = true"><Icon name="close" /><span class="grow danger">抹掉本机数据</span></button>
            <form v-else class="row col" @submit.prevent="doWipe">
              <span class="small">这台电脑上的保险库和设置会被删除，云端和手机不受影响，之后可以重新加入。请输入主密码确认。</span>
              <input v-model="wipePass" class="field mono" type="password" placeholder="主密码" aria-label="确认抹掉的主密码" />
              <div class="btns">
                <button type="button" class="text-btn" @click="wiping = false">取消</button>
                <button type="submit" class="text-btn danger" :disabled="!wipePass || !!busy">抹掉</button>
              </div>
            </form>
          </div>
          <p v-if="error" class="note-box err">{{ error }}</p>
        </div>
      </div>
    </template>

    <Transition name="toast"><div v-if="toastMsg" class="toast" role="status">{{ toastMsg }}</div></Transition>
  </div>
</template>

<style scoped>
.pop { width: 380px; min-height: 480px; max-height: 600px; display: flex; flex-direction: column; }
.center { display: grid; place-items: center; min-height: 480px; padding: 16px; }
.pad { padding: 18px 16px; }
.gate { display: flex; flex-direction: column; gap: 10px; }
.brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 6px; }
.brand h1 { margin: 8px 0 0; font-size: 22px; letter-spacing: 0.3em; text-indent: 0.3em; }
.brand p { margin: 2px 0 0; }
.lead { margin: 0; line-height: 1.7; font-size: 14px; }
.code { resize: none; font-size: 12px; }
.main { display: flex; flex-direction: column; height: 600px; }
.bar { display: flex; align-items: center; gap: 2px; padding: 10px 10px 6px 12px; }
.bar .title { margin: 0 0 0 4px; font-size: 17px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search { flex: 1; min-width: 0; height: 40px; }
.scroll { flex: 1; overflow-y: auto; padding: 0 12px 12px; }
.entry { gap: 8px; }
.plain { all: unset; cursor: pointer; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plain .sub { overflow: hidden; text-overflow: ellipsis; }
.avatar { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--line); color: var(--accent); font-weight: 800; font-family: var(--serif); }
.val { word-break: break-all; white-space: normal; }
.notes { white-space: pre-wrap; word-break: break-word; margin: 0 4px 8px; line-height: 1.6; }
.hint { margin: 6px 4px 12px; }
.pending, .warn { margin: 6px 0 10px; }
.btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.foot.err { color: var(--danger); }
.empty-note { margin: 10px 6px; }
.gen { margin: 6px 4px 2px; font-size: 18px; word-break: break-all; line-height: 1.5; }
.gen-btns { display: flex; justify-content: space-between; margin: 8px 0 12px; }
.gen-btns .text-btn { display: inline-flex; align-items: center; gap: 4px; }
.gen-btns svg { width: 18px; height: 18px; }
.v { flex: none; color: var(--muted); font-size: 13px; }
.col { flex-direction: column; align-items: stretch; gap: 8px; }
.toast { position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%); max-width: 340px; padding: 9px 16px; border-radius: 18px; background: var(--ink); color: var(--bg); font-size: 13px; box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.4); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; }
</style>
