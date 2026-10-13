<script setup lang="ts">
/** 最近删除：可以恢复；彻底删除后只留下一个标记（防止别的设备同步回来） */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { purge, restore, toast, vault } from '../../store'
import { trashedItems, TOMBSTONE_TTL } from '../../core/vault'
import { ask } from '../dialog'
import { timeAgo } from '../format'

const router = useRouter()
const items = computed(() => trashedItems(vault.value))
const daysLeft = (t: number) => Math.max(0, Math.ceil((t + TOMBSTONE_TTL - Date.now()) / 86400_000))

async function doRestore(id: string) {
  await restore(id)
  toast('已恢复')
}

async function doPurge(id: string, title: string) {
  const ok = await ask({
    title: `彻底删除“${title}”？`,
    message: '内容和历史版本都会清除，不能恢复。\n注意：云端以前上传过的加密文件（GitHub 提交历史、OSS 版本控制）里仍然有旧内容。',
    ok: '彻底删除',
    danger: true,
  })
  if (!ok) return
  await purge(id)
  toast('已彻底删除')
}
</script>

<template>
  <div class="trash">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>最近删除</h1>
    </header>
    <div class="page">
      <div v-if="!items.length" class="empty">没有删除的条目。</div>
      <div v-else class="group">
        <div v-for="it in items" :key="it.id" class="row">
          <button class="grow plain" @click="router.push(`/item/${it.id}`)">
            {{ it.title || '未命名' }}
            <span class="sub">{{ timeAgo(it.rev.t) }} 删除 · 还剩 {{ daysLeft(it.rev.t) }} 天</span>
          </button>
          <button class="text-btn accent" @click="doRestore(it.id)">恢复</button>
          <button class="icon-btn sm" aria-label="彻底删除" @click="doPurge(it.id, it.title)"><Icon name="trash" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plain { border: 0; background: transparent; padding: 0; text-align: left; color: inherit; }
</style>
