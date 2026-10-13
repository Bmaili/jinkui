<script setup lang="ts">
/** 同步出了需要用户处理的问题时，在首页和同步设置页顶部提示，并给出处理办法 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { app, rebuildRemote, rejoin, syncNow, toast } from '../../store'
import { ask, promptText } from '../dialog'
import { openReleasePage } from '../../updateService'

const router = useRouter()
const busy = ref(false)

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
  <div v-if="app.backend && app.sync.errorKind" class="note-box" :class="app.sync.errorKind === 'network' ? 'warn' : 'err'" role="alert">
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
      <p>同步失败：{{ app.sync.error }}</p>
      <button class="text-btn accent" @click="router.push('/settings/sync')">检查设置</button>
    </template>
    <template v-else>
      <p>同步失败，稍后会自动重试：{{ app.sync.error }}</p>
      <button class="text-btn accent" :disabled="app.sync.running" @click="syncNow()">现在重试</button>
    </template>
  </div>
  <div v-else-if="app.sync.problems.length" class="note-box warn">
    <p>云端有 {{ app.sync.problems.length }} 个文件解不开，已跳过（其他数据正常同步）。详情见“设置 → 同步”。</p>
  </div>
</template>
