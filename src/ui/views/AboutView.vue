<script setup lang="ts">
/** 关于：版本、检查更新（应用内下载，核对 sha256 和签名后调起系统安装）、代码仓库 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import { APP_NAME, REPO_URL } from '../../appInfo'
import { prefs } from '../../prefs'
import { formatSize } from '../../core/update'
import {
  cancelDownload, checkUpdate, currentVersion, dismissUpdate, hasUpdate, installUpdate, openReleasePage, showBadge, startDownload, updateState,
} from '../../updateService'
import { openUrl, timeAgo } from '../format'

const router = useRouter()
const u = updateState
const reopened = ref(false)
const showCard = computed(() => hasUpdate.value && (showBadge.value || reopened.value || u.phase !== 'idle'))
const percent = computed(() => (u.total ? Math.min(100, Math.round((u.done / u.total) * 100)) : 0))

const updateLine = computed(() => {
  if (u.checking) return '正在检查…'
  if (u.error) return `检查失败：${u.error}`
  if (hasUpdate.value) return showCard.value ? `发现新版本 ${u.latest!.version}` : `新版本 ${u.latest!.version} 已选择暂不更新`
  if (u.lastCheck) return `已是最新版本 · ${timeAgo(u.lastCheck)}检查过`
  return '覆盖安装新版本，本机数据不会丢'
})

function later() {
  dismissUpdate()
  reopened.value = false
}
</script>

<template>
  <div>
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>关于</h1>
    </header>
    <div class="page">
      <div class="hero">
        <span class="seal big">匮</span>
        <div class="name">{{ APP_NAME }}</div>
        <p class="muted">版本 <span class="mono">{{ currentVersion }}</span></p>
      </div>

      <div class="group">
        <div class="row">
          <span class="grow">检查更新<span v-if="showBadge" class="dot" />
            <span class="sub" :class="{ danger: !!u.error }">{{ updateLine }}<button v-if="hasUpdate && !showCard" class="link" @click="reopened = true">查看</button></span>
          </span>
          <button class="text-btn" :disabled="u.checking || u.phase !== 'idle'" @click="checkUpdate(true)">{{ u.checking ? '检查中' : '检查' }}</button>
        </div>
        <div v-if="showCard && u.latest" class="upd">
          <div class="upd-head">
            <b>新版本 <span class="mono">{{ u.latest.version }}</span></b>
            <span v-if="u.latest.apk?.size" class="muted small">{{ formatSize(u.latest.apk.size) }}</span>
          </div>
          <div class="notes">{{ u.latest.notes || '这一版没有写更新说明。' }}</div>
          <template v-if="u.phase === 'downloading'">
            <div class="bar" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }" /></div>
            <div class="upd-row">
              <span class="muted small">正在下载 {{ formatSize(u.done) }} / {{ formatSize(u.total) }}</span>
              <button class="text-btn" @click="cancelDownload">取消</button>
            </div>
          </template>
          <div v-else class="upd-row end">
            <button v-if="u.phase === 'ready'" class="solid-btn" @click="installUpdate()">安装</button>
            <template v-else>
              <button class="text-btn" @click="later">暂不</button>
              <button class="solid-btn" @click="startDownload">{{ u.resumable ? '继续下载' : '更新' }}</button>
            </template>
          </div>
          <p v-if="u.note" class="muted small">{{ u.note }}</p>
          <p class="muted small">覆盖安装，本机数据不会丢。下载前后都会核对安装包的 sha256 和签名。应用内下载不了时，可以<button class="link" @click="openReleasePage">在浏览器里下载</button>。</p>
        </div>
        <div class="row">
          <span class="grow">自动检查更新<span class="sub">每天最多一次，有新版本只在设置里显示小红点</span></span>
          <Switch v-model="prefs.autoUpdate" label="自动检查更新" />
        </div>
        <button class="row" @click="openUrl(REPO_URL)">
          <span class="grow">代码仓库<span class="sub mono">{{ REPO_URL.replace('https://', '') }}</span></span>
          <Icon name="right" />
        </button>
        <div class="row">
          <span class="grow">开源许可<span class="sub">MIT。全部代码由 AI 编写。加密使用开放的 age 格式（typage）。</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero { display: flex; flex-direction: column; align-items: center; padding: 16px 0 8px; }
.seal.big { width: 72px; height: 72px; font-size: 36px; border-radius: 16px; }
.name { margin-top: 12px; font-size: 24px; font-weight: 800; letter-spacing: 0.3em; text-indent: 0.3em; }
.hero p { margin: 4px 0 0; }
.dot { display: inline-block; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%; background: var(--danger); vertical-align: 2px; }
.link { border: 0; background: none; padding: 0 0 0 6px; color: var(--accent); font: inherit; text-decoration: underline; }
.upd { padding: 4px 14px 12px; border-top: 1px solid var(--line); }
.upd-head { display: flex; justify-content: space-between; align-items: baseline; margin: 8px 0; }
.notes { white-space: pre-wrap; font-size: 14px; line-height: 1.7; }
.bar { height: 6px; margin: 12px 0 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
.upd-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.upd-row.end { justify-content: flex-end; }
</style>
