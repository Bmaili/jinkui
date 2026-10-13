<script setup lang="ts">
import Logo from './components/Logo.vue'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { app } from '../store'
import { popBack } from './backStack'
import SetupView from './views/SetupView.vue'
import LockView from './views/LockView.vue'
import Dialog from './components/Dialog.vue'

const router = useRouter()

onMounted(() => {
  if (!Capacitor.isNativePlatform()) return
  // 安卓返回键：先关覆盖层，再按页面返回；首页时退到后台（不结束进程）
  void CapApp.addListener('backButton', () => {
    if (popBack()) return
    if (app.phase === 'unlocked' && router.currentRoute.value.path !== '/') router.back()
    else void CapApp.minimizeApp()
  })
})
</script>

<template>
  <div class="shell" :data-phase="app.phase">
    <div v-if="app.phase === 'loading'" class="splash"><Logo :size="72" /></div>
    <SetupView v-else-if="app.phase === 'setup'" />
    <LockView v-else-if="app.phase === 'locked'" />
    <div v-else-if="app.phase === 'broken'" class="broken page">
      <h1>无法打开</h1>
      <p>{{ app.fatal }}</p>
    </div>
    <RouterView v-else v-slot="{ Component }">
      <KeepAlive include="HomeView">
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
    <Transition name="toast">
      <div v-if="app.toast" class="toast" role="status">{{ app.toast }}</div>
    </Transition>
    <Dialog />
  </div>
</template>

<style scoped>
.splash { display: grid; place-items: center; min-height: 100vh; }
.broken { padding-top: calc(60px + var(--safe-top)); }
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(28px + var(--safe-bottom));
  z-index: 300;
  max-width: calc(100% - 48px);
  padding: 10px 18px;
  border-radius: 20px;
  background: var(--ink);
  color: var(--bg);
  font-size: 14px;
  transform: translateX(-50%);
  box-shadow: 0 8px 24px -10px rgba(0, 0, 0, 0.4);
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.25s var(--ease-out); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 10px); }
</style>
