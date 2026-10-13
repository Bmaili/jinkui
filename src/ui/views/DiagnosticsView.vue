<script setup lang="ts">
/**
 * 诊断记录（规格 6.5）：前后台切换、上锁、自动填充每一步。遇到问题时复制下来反馈。
 * 只有事件和 app 包名、网址域名，没有账号、密码、条目内容。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { copyPlain, toast } from '../../store'
import { clearDiag, diagLines } from '../../diag'
import { autofill } from '../../platform/autofill'
import { currentVersion } from '../../updateService'
import { prefs } from '../../prefs'

const router = useRouter()
const main = ref<string[]>([])
const af = ref<string[]>([])

async function load() {
  main.value = await diagLines()
  af.value = await autofill.diagnostics()
}
onMounted(load)

const text = computed(() =>
  [
    `金匮 ${currentVersion} · 自动上锁 ${prefs.autoLockSec} 秒 · 指纹 ${prefs.bioData ? '开' : '关'} · 防截屏 ${prefs.blockScreenshots ? '开' : '关'}`,
    `UA ${navigator.userAgent}`,
    '',
    '— 主界面 —',
    ...main.value,
    '',
    '— 自动填充 —',
    ...af.value,
  ].join('\n'),
)

async function copy() {
  await copyPlain(text.value, '诊断记录')
}

async function clear() {
  await clearDiag()
  await autofill.clearDiagnostics()
  await load()
  toast('已清空')
}
</script>

<template>
  <div>
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>诊断记录</h1>
      <button class="icon-btn" aria-label="刷新" @click="load"><Icon name="refresh" /></button>
    </header>
    <div class="page">
      <p class="muted small">记下了切到后台、上锁、自动填充每一步发生了什么。遇到问题时点“复制”发给开发者。<b>这里没有任何账号、密码或条目内容</b>，只有 app 包名和网址域名。</p>
      <div class="btns">
        <button class="solid-btn" @click="copy"><Icon name="copy" />复制</button>
        <button class="solid-btn ghost" @click="clear">清空</button>
      </div>
      <pre class="log mono">{{ text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.btns { display: flex; gap: 10px; margin: 12px 0; }
.btns .solid-btn { min-height: 44px; padding: 0 18px; }
.log {
  margin: 0 0 32px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
