<script setup lang="ts">
/**
 * 同步出了需要用户处理的问题时，在首页和同步设置页顶部提示，并给出处理办法（规格 5.4）：
 * 同步出错（出错超过一天时写明多久没同步成功了）、GitHub Token 两周内过期。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { app, rebuildRemote, rejoin, syncNow, toast } from '../../store'
import { ask, promptText } from '../dialog'
import { openReleasePage } from '../../updateService'

/** here：就在同步设置页里（按钮直接打开修改配置）；editing：已经在修改配置了（不再显示按钮） */
const props = defineProps<{ here?: boolean; editing?: boolean }>()
const emit = defineEmits<{ edit: [] }>()
const router = useRouter()
const busy = ref(false)
const DAY = 86_400_000

/** 多少天没同步成功了（出错时才有意义） */
const staleDays = computed(() => (app.sync.errorKind && app.sync.last ? Math.floor((Date.now() - app.sync.last) / DAY) : 0))
/** Token 还有几天过期；不会过期或不知道时为 null */
const expiresIn = computed(() => (app.sync.tokenExpires ? Math.max(0, Math.ceil((app.sync.tokenExpires - Date.now()) / DAY)) : null))
const expiryDate = computed(() => {
  const d = new Date(app.sync.tokenExpires)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})
const isGitHub = computed(() => app.backend?.type === 'github')
function openSettings() {
  if (props.here) emit('edit')
  else void router.push({ path: '/settings/sync', query: { edit: '1' } })
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  try {
    await fn()
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function doRejoin() {
  const p = await promptText({
    title: '重新加入',
    message: '云端的保险库换了密钥（可能在别的设备上抹掉重建过）。输入云端保险库的主密码，本机的条目会合并过去，不会丢。',
    ok: '加入',
    input: { password: true, placeholder: '云端保险库的主密码' },
  })
  if (p) await run(() => rejoin(p))
}

async function doRebuild() {
  const ok = await ask({
    title: '在云端重新建立？',
    message: '云端找不到保险库了（可能被删除，或配置指向了别的位置）。用本机的密钥在那里重新建立，并上传本机的全部条目。',
    ok: '重新建立',
  })
  if (ok) await run(rebuildRemote)
}
</script>

<template>
  <div v-if="app.backend && app.sync.errorKind" class="note-box" :class="app.sync.errorKind === 'network' && staleDays < 1 ? 'warn' : 'err'" role="alert">
    <template v-if="app.sync.errorKind === 'key'">
      <p>云端的保险库密钥和本机不一致，同步已暂停。</p>
      <button class="text-btn accent" :disabled="busy" @click="doRejoin">重新加入</button>
    </template>
    <template v-else-if="app.sync.errorKind === 'missing'">
      <p>云端找不到保险库，同步已暂停。</p>
      <button class="text-btn accent" :disabled="busy" @click="doRebuild">重新建立</button>
      <button class="text-btn" @click="router.push('/settings/sync')">检查设置</button>
    </template>
    <template v-else-if="app.sync.errorKind === 'format'">
      <p>别的设备用了更新版本的金匮，请先升级本机的 app。升级前不会同步，本机的修改不会丢。</p>
      <button class="text-btn accent" @click="openReleasePage">去下载</button>
    </template>
    <template v-else-if="app.sync.errorKind === 'auth'">
      <p>同步已停止：{{ app.sync.error }}。本机的修改不会丢，{{ isGitHub ? '在 GitHub 生成新的 Token 后' : '' }}更新同步设置就会补传。</p>
      <button v-if="!editing" class="text-btn accent" @click="openSettings">{{ isGitHub ? '更新 Token' : '检查设置' }}</button>
    </template>
    <template v-else>
      <p>同步失败，稍后会自动重试：{{ app.sync.error }}</p>
      <button class="text-btn accent" :disabled="app.sync.running" @click="syncNow()">现在重试</button>
    </template>
    <p v-if="staleDays >= 1" class="stale">已经 {{ staleDays }} 天没有同步成功，这期间的修改只在这台手机上。</p>
  </div>
  <div v-else-if="app.backend && isGitHub && expiresIn !== null && expiresIn <= 14" class="note-box" :class="expiresIn <= 3 ? 'err' : 'warn'" role="alert">
    <p>GitHub Token {{ expiresIn === 0 ? '今天' : `还有 ${expiresIn} 天（${expiryDate}）` }}过期，过期后同步会停止。请在 GitHub 上重新生成（Regenerate token）或新建一个，再到同步设置里更新。</p>
    <button v-if="!editing" class="text-btn accent" @click="openSettings">更新 Token</button>
  </div>
  <div v-else-if="app.sync.problems.length" class="note-box warn">
    <p>云端有 {{ app.sync.problems.length }} 个文件解不开，已跳过（其他数据正常同步）。详情见“设置 → 同步”。</p>
  </div>
</template>

<style scoped>
.stale { margin-top: 6px; font-weight: 700; }
</style>
