<script setup lang="ts">
/** 同步设置：状态、立即同步、后端配置、设备列表 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import BackendForm from '../components/BackendForm.vue'
import SyncBanner from '../components/SyncBanner.vue'
import {
  OtherVaultError, app, backendTitle, copyPlain, createJoinCode, joinOtherVault, removeDevice, setBackend, syncNow, toast, vault, type BackendConfig,
} from '../../store'
import { liveItems } from '../../core/vault'
import { prefs } from '../../prefs'
import { configFrom, draftFrom } from '../backendDraft'
import { ask, promptText } from '../dialog'
import { timeAgo } from '../format'

const router = useRouter()
const route = useRoute()
// 首页提示“更新 Token”时带着 ?edit=1 过来，直接打开修改配置
const editing = ref(!app.backend || route.query.edit === '1')
const draft = reactive(draftFrom(app.backend))
const busy = ref('')
const error = ref('')

const others = computed(() => app.sync.devices.filter((d) => d.id !== prefs.deviceId).sort((a, b) => b.written - a.written))
const self = computed(() => app.sync.devices.find((d) => d.id === prefs.deviceId))

async function save() {
  error.value = ''
  const r = configFrom(draft)
  if ('error' in r) return void (error.value = r.error)
  busy.value = '正在连接…'
  try {
    await setBackend(r.cfg)
    editing.value = false
    toast(app.sync.errorKind ? '已保存，但同步出错了' : '已开启同步')
  } catch (e) {
    if (e instanceof OtherVaultError) {
      busy.value = ''
      await joinOther(r.cfg)
    } else error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

/** 让浏览器先画出“正在…”再开始耗时的 scrypt */
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

/** 那里已经有另一个保险库：输入它的主密码加入，本机条目合并过去（以前只能抹掉本机数据再加入，本机条目会丢） */
async function joinOther(cfg: BackendConfig) {
  const n = liveItems(vault.value).length
  const p = await promptText({
    title: '这里已经有一个保险库',
    message: `输入它的主密码加入它，本机的${n ? ` ${n} 条` : '条目'}会合并过去，不会丢。\n加入后，这台设备的主密码就是那个保险库的主密码${prefs.bioData ? '；指纹解锁要重新开启' : ''}。\n如果不想加入，请换一个空的仓库或路径前缀。`,
    ok: '加入并合并',
    input: { password: true, placeholder: '那个保险库的主密码' },
  })
  if (!p) return
  busy.value = '正在加入…'
  await frame()
  try {
    await joinOtherVault(cfg, p)
    editing.value = false
    toast(app.sync.errorKind ? '已加入，但同步出错了' : '已加入，本机的条目已合并')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

async function stop() {
  const ok = await ask({ title: '停止同步？', message: '本机的数据保留，云端的数据也不删除。之后可以重新开启。', ok: '停止', danger: true })
  if (!ok) return
  await setBackend(null)
  Object.assign(draft, draftFrom(null))
  editing.value = true
}

/** 生成好的加入码（只在这个页面上显示，离开就没了） */
const joinCode = ref('')

async function makeCode() {
  const p = await promptText({
    title: '生成加入码',
    message: '加入码里有同步设置（包括 Token），用主密码加密。新手机上粘贴加入码、再输入主密码，就不用手抄 Token。',
    ok: '生成',
    input: { password: true, placeholder: '主密码' },
  })
  if (!p) return
  busy.value = '正在生成加入码…'
  await frame()
  try {
    joinCode.value = await createJoinCode(p)
    await copyPlain(joinCode.value, '加入码')
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = ''
  }
}

async function sync() {
  const ok = await syncNow()
  toast(ok ? '已同步' : '同步失败')
}

async function remove(id: string, name: string) {
  const ok = await ask({
    title: `移除“${name}”？`,
    message: '它的数据会先合并进本机，再从云端删掉它的文件。适合丢了或不再使用的设备。\n如果那台设备之后又联网，它会重新出现。',
    ok: '移除',
    danger: true,
  })
  if (!ok) return
  busy.value = '正在移除…'
  try {
    await removeDevice(id)
    toast('已移除')
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="sync">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>同步与设备</h1>
    </header>
    <div class="page">
      <SyncBanner here :editing="editing" @edit="editing = true" />

      <template v-if="app.backend && !editing">
        <div class="group">
          <div class="row">
            <Icon name="cloud" />
            <span class="grow">{{ backendTitle(app.backend) }}
              <span class="sub">
                <template v-if="app.sync.running">正在同步…</template>
                <template v-else>上次同步：{{ timeAgo(app.sync.last) }}{{ app.sync.pending ? ' · 有修改未上传' : '' }}</template>
                <template v-if="app.sync.tokenExpires"><br />Token 有效期到 {{ new Date(app.sync.tokenExpires).toLocaleDateString('zh-CN') }}</template>
              </span>
            </span>
          </div>
          <button class="row" :disabled="app.sync.running" @click="sync">
            <Icon name="refresh" />
            <span class="grow">立即同步</span>
          </button>
          <button class="row" @click="editing = true">
            <Icon name="pen" />
            <span class="grow">修改配置<span class="sub">Token 过期、换仓库时</span></span>
          </button>
          <button class="row" @click="stop">
            <Icon name="cloud-off" />
            <span class="grow danger">停止同步</span>
          </button>
        </div>
        <p class="muted small hint">打开 app、回到前台、修改后几秒、切到后台时都会自动同步。</p>

        <div class="group-title">设备</div>
        <div class="group">
          <div class="row">
            <Icon name="device" />
            <span class="grow">{{ prefs.deviceName }}（本机）<span class="sub">{{ self ? `上次上传 ${timeAgo(self.written)}` : '还没有上传' }}</span></span>
          </div>
          <div v-for="d in others" :key="d.id" class="row">
            <Icon name="device" />
            <span class="grow">{{ d.name }}<span class="sub">上次上传 {{ timeAgo(d.written) }}</span></span>
            <button class="text-btn danger" :disabled="!!busy" @click="remove(d.id, d.name)">移除</button>
          </div>
        </div>
        <div class="group" style="margin-top: 12px">
          <button class="row" :disabled="!!busy" @click="makeCode">
            <Icon name="key" />
            <span class="grow">生成加入码<span class="sub">新手机上粘贴，不用手抄 Token</span></span>
          </button>
        </div>
        <div v-if="joinCode" class="note-box code-box">
          <p>加入码已复制。发到新手机上（例如发给自己），在新手机上选“加入已有保险库 → 粘贴加入码”，再输入主密码。</p>
          <p class="mono small code">{{ joinCode }}</p>
          <button class="text-btn accent" @click="copyPlain(joinCode, '加入码')">再复制一次</button>
        </div>
        <p class="muted small hint">要在新手机上使用：装好金匮，选“加入已有保险库”，粘贴加入码，或者填一样的同步设置；再输入主密码。</p>

        <template v-if="app.sync.problems.length">
          <div class="group-title">解不开的文件</div>
          <div class="group">
            <div v-for="p in app.sync.problems" :key="p.path" class="row">
              <span class="grow mono small">{{ p.path }}<span class="sub">{{ p.message }}</span></span>
            </div>
          </div>
        </template>
      </template>

      <template v-else>
        <p class="muted lead">{{ app.backend ? '修改同步设置。换到另一个位置时，那里要么是空的，要么是这个保险库。' : '开启后，密码加密上传到你自己的仓库或 Bucket，多台设备互相同步。' }}</p>
        <BackendForm v-model="draft" />
        <p v-if="error" class="note-box err">{{ error }}</p>
        <div class="actions">
          <button class="solid-btn block" :disabled="!!busy" @click="save"><span v-if="busy" class="spinner" />{{ busy || (app.backend ? '保存' : '开启同步') }}</button>
          <button v-if="app.backend" class="text-btn" @click="editing = false; Object.assign(draft, draftFrom(app.backend))">取消</button>
        </div>
      </template>
      <p v-if="busy && !editing" class="note-box"><span class="spinner" /> {{ busy }}</p>
    </div>
  </div>
</template>

<style scoped>
.hint { margin: 6px 6px 0; line-height: 1.6; }
.lead { margin: 4px 2px 8px; line-height: 1.7; }
.code-box { margin-top: 10px; }
.code { word-break: break-all; max-height: 6.5em; overflow: auto; margin: 8px 0; opacity: 0.8; }
.actions { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 24px; }
</style>
