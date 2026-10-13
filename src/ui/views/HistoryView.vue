<script setup lang="ts">
/** 历史版本：每个以前的版本改了什么、在哪台设备上改的；可以恢复 */
import { computed, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { app, copySecret, revert, toast, vault } from '../../store'
import { prefs } from '../../prefs'
import type { Snapshot } from '../../core/item'
import { ask } from '../dialog'
import { timeAgo } from '../format'

const route = useRoute()
const router = useRouter()
const item = computed(() => vault.value.items[String(route.params.id)])
const open = reactive<Record<string, boolean>>({})
const shown = reactive<Record<string, boolean>>({})

const LABELS: Record<string, string> = {
  title: '标题', username: '用户名', password: '密码', urls: '网址', notes: '备注', totp: '两步验证', fields: '自定义字段', tags: '标签', favorite: '收藏', deleted: '删除', type: '类型',
}
const key = (s: Snapshot) => `${s.rev.t}.${s.rev.c}.${s.rev.d}`
const deviceName = (id: string) =>
  id === prefs.deviceId ? '本机' : app.sync.devices.find((d) => d.id === id)?.name ?? `设备 ${id.slice(0, 4)}`

/** 从新到旧：当前值，然后是历史 */
const versions = computed<Snapshot[]>(() => (item.value ? [item.value, ...(item.value.history ?? [])] : []))

/** 这个版本相对于它之前一个版本改了哪些字段 */
function changes(i: number): string {
  const cur = versions.value[i] as unknown as Record<string, unknown>
  const prev = versions.value[i + 1] as unknown as Record<string, unknown> | undefined
  if (!prev) return '最早的版本'
  if (cur.deleted && !prev.deleted) return '删除'
  if (!cur.deleted && prev.deleted) return '恢复'
  const keys = new Set([...Object.keys(cur), ...Object.keys(prev)])
  const out: string[] = []
  for (const k of keys) {
    if (k === 'rev' || k === 'history' || k === 'id' || k === 'created') continue
    if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) out.push(LABELS[k] ?? k)
  }
  return out.length ? `改了${out.join('、')}` : '内容相同（另一台设备同时保存）'
}

async function restoreVersion(s: Snapshot) {
  const ok = await ask({ title: '恢复到这个版本？', message: '当前内容会保存为一个历史版本，不会丢。', ok: '恢复' })
  if (!ok || !item.value) return
  await revert(item.value.id, s.rev)
  toast('已恢复')
  router.back()
}
</script>

<template>
  <div class="history">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>历史版本</h1>
    </header>
    <div v-if="!item" class="empty">这个条目不存在。</div>
    <div v-else class="page">
      <p class="muted small intro">保留最近 50 个版本。两台设备同时修改时，没被采用的那份也在这里。</p>
      <div class="group">
        <div v-for="(v, i) in versions" :key="key(v)" class="ver">
          <button class="row" @click="open[key(v)] = !open[key(v)]">
            <span class="grow">
              {{ i === 0 ? '当前' : timeAgo(v.rev.t) }}<span v-if="i === 0" class="faint small"> · {{ timeAgo(v.rev.t) }}</span>
              <span class="sub">{{ deviceName(v.rev.d) }} · {{ changes(i) }}</span>
            </span>
            <Icon :name="open[key(v)] ? 'back' : 'right'" :class="{ down: open[key(v)] }" />
          </button>
          <div v-if="open[key(v)]" class="detail">
            <div v-if="v.title"><span class="k">标题</span>{{ v.title }}</div>
            <div v-if="v.username"><span class="k">用户名</span><span class="mono">{{ v.username }}</span></div>
            <div v-if="v.password" class="pwline">
              <span class="k">密码</span>
              <span class="mono">{{ shown[key(v)] ? v.password : '••••••••' }}</span>
              <button class="icon-btn sm" :aria-label="shown[key(v)] ? '隐藏' : '显示'" @click="shown[key(v)] = !shown[key(v)]"><Icon :name="shown[key(v)] ? 'eye-off' : 'eye'" /></button>
              <button class="icon-btn sm" aria-label="复制这个版本的密码" @click="copySecret(v.password!)"><Icon name="copy" /></button>
            </div>
            <div v-for="u in v.urls ?? []" :key="u"><span class="k">网址</span>{{ u }}</div>
            <div v-if="v.notes" class="notes"><span class="k">备注</span>{{ v.notes }}</div>
            <div v-if="v.deleted" class="muted">（这个版本是已删除的状态）</div>
            <button v-if="i > 0" class="text-btn accent" @click="restoreVersion(v)">恢复到这个版本</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.intro { margin: 4px 4px 0; }
.ver + .ver { border-top: 1px solid var(--line); }
.ver .row { border-top: 0; }
.down { transform: rotate(-90deg); }
.detail { display: grid; gap: 6px; padding: 0 14px 12px; font-size: 15px; overflow-wrap: anywhere; }
.k { display: inline-block; min-width: 4.5em; color: var(--muted); font-size: 13px; }
.pwline { display: flex; align-items: center; gap: 4px; }
.pwline .mono { flex: 1; }
.notes { white-space: pre-wrap; }
.detail .text-btn { justify-self: start; padding: 0 4px; }
</style>
