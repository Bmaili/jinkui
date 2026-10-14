<script setup lang="ts">
/** 条目详情：复制用户名、密码，打开网址，查看备注和自定义字段 */
import { computed, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { app, copyPlain, copySecret, forgetApp, markUsed, removeItem, saveItem, toast, vault } from '../../store'
import { prefs } from '../../prefs'
import { folderOf } from '../../core/folders'
import { ask } from '../dialog'
import { hostOf, openUrl, timeAgo } from '../format'

const route = useRoute()
const router = useRouter()
const item = computed(() => vault.value.items[String(route.params.id)])
const folder = computed(() => folderOf(vault.value.folders, item.value?.folder))
const shown = reactive<Record<string, boolean>>({})

// 打开详情算一次“使用”（“最近使用”排序用，只记在本机）
watch(() => [String(route.params.id), app.phase] as const, ([id, ph]) => {
  if (ph === 'unlocked') void markUsed(id)
}, { immediate: true })

const deviceName = (id: string) =>
  id === prefs.deviceId ? '本机' : app.sync.devices.find((d) => d.id === id)?.name ?? `设备 ${id.slice(0, 4)}`

const mask = (s: string) => '•'.repeat(Math.min(Math.max(s.length, 8), 16))

async function toggleFav() {
  if (!item.value) return
  await saveItem(item.value.id, { favorite: item.value.favorite ? undefined : true })
}

/** 复制密码，然后退到后台：回到刚才的 app 直接粘贴（自动填充用不了时的办法） */
async function copyAndReturn() {
  if (!item.value?.password) return
  await copySecret(item.value.password)
  if (Capacitor.isNativePlatform()) await CapApp.minimizeApp()
}

const apps = computed(() => (Array.isArray(item.value?.apps) ? (item.value!.apps as string[]) : []))

async function unlinkApp(pkg: string) {
  if (!item.value) return
  const ok = await ask({ title: '不再关联这个 app？', message: `${pkg}\n以后在这个 app 里填充时，不会再优先推荐这一条。`, ok: '取消关联' })
  if (ok) await forgetApp(item.value.id, pkg)
}

async function del() {
  if (!item.value) return
  const ok = await ask({ title: `删除“${item.value.title}”？`, message: '会放进“最近删除”，180 天内可以恢复。', ok: '删除', danger: true })
  if (!ok) return
  await removeItem(item.value.id)
  toast('已删除')
  router.back()
}
</script>

<template>
  <div class="item-view">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ item?.title || '条目' }}</h1>
      <template v-if="item && !item.deleted">
        <button class="icon-btn" :class="{ on: item.favorite }" :aria-label="item.favorite ? '取消收藏' : '收藏'" @click="toggleFav">
          <Icon name="star" :class="{ filled: item.favorite }" />
        </button>
        <button class="icon-btn" aria-label="编辑" @click="router.push(`/edit/${item.id}`)"><Icon name="pen" /></button>
      </template>
    </header>

    <div v-if="!item" class="empty">这个条目不存在或已被彻底删除。</div>
    <div v-else class="page">
      <p v-if="item.deleted" class="note-box warn">这个条目在“最近删除”里。</p>

      <div class="group">
        <div v-if="item.username" class="row">
          <div class="grow"><span class="sub">用户名</span><span class="mono val">{{ item.username }}</span></div>
          <button class="icon-btn sm" aria-label="复制用户名" @click="copyPlain(item.username!, '用户名')"><Icon name="copy" /></button>
        </div>
        <div v-if="item.password" class="row">
          <div class="grow">
            <span class="sub">密码</span>
            <span class="mono val pw">{{ shown.pw ? item.password : mask(item.password) }}</span>
          </div>
          <button class="icon-btn sm" :aria-label="shown.pw ? '隐藏密码' : '显示密码'" @click="shown.pw = !shown.pw">
            <Icon :name="shown.pw ? 'eye-off' : 'eye'" />
          </button>
          <button class="icon-btn sm" aria-label="复制密码" @click="copySecret(item.password!)"><Icon name="copy" /></button>
        </div>
        <div v-for="(u, i) in item.urls ?? []" :key="'u' + i" class="row">
          <div class="grow"><span class="sub">网址</span><span class="val url">{{ u }}</span></div>
          <button class="icon-btn sm" :aria-label="`打开 ${hostOf(u)}`" @click="openUrl(u)"><Icon name="globe" /></button>
          <button class="icon-btn sm" aria-label="复制网址" @click="copyPlain(u, '网址')"><Icon name="copy" /></button>
        </div>
        <div v-if="item.totp" class="row">
          <div class="grow">
            <span class="sub">两步验证密钥</span>
            <span class="mono val">{{ shown.totp ? item.totp : mask(item.totp) }}</span>
          </div>
          <button class="icon-btn sm" :aria-label="shown.totp ? '隐藏' : '显示'" @click="shown.totp = !shown.totp"><Icon :name="shown.totp ? 'eye-off' : 'eye'" /></button>
          <button class="icon-btn sm" aria-label="复制密钥" @click="copySecret(item.totp!, '密钥')"><Icon name="copy" /></button>
        </div>
        <div v-for="(f, i) in item.fields ?? []" :key="'f' + i" class="row">
          <div class="grow">
            <span class="sub">{{ f.name || '字段' }}</span>
            <span class="mono val">{{ f.secret && !shown['f' + i] ? mask(f.value) : f.value }}</span>
          </div>
          <button v-if="f.secret" class="icon-btn sm" :aria-label="shown['f' + i] ? '隐藏' : '显示'" @click="shown['f' + i] = !shown['f' + i]">
            <Icon :name="shown['f' + i] ? 'eye-off' : 'eye'" />
          </button>
          <button class="icon-btn sm" :aria-label="`复制${f.name}`" @click="f.secret ? copySecret(f.value, f.name || '字段') : copyPlain(f.value, f.name || '字段')"><Icon name="copy" /></button>
        </div>
        <div v-if="!item.username && !item.password && !item.urls?.length && !item.totp && !item.fields?.length && !item.notes" class="row muted">没有内容</div>
      </div>
      <button v-if="item.password && !item.deleted" class="solid-btn block ghost back-btn" @click="copyAndReturn">
        <Icon name="copy" />复制密码并返回
      </button>

      <template v-if="item.notes">
        <div class="group-title">备注</div>
        <div class="group notes">
          <p>{{ item.notes }}</p>
          <button class="icon-btn sm copy-note" aria-label="复制备注" @click="copyPlain(item.notes!, '备注')"><Icon name="copy" /></button>
        </div>
      </template>

      <div v-if="folder" class="tags">
        <span class="chip"><Icon name="folder" />{{ folder.name }}</span>
      </div>

      <template v-if="apps.length">
        <div class="group-title">自动填充时优先推荐的 app</div>
        <div class="group">
          <div v-for="p in apps" :key="p" class="row">
            <Icon name="device" />
            <span class="grow mono small">{{ p }}</span>
            <button class="icon-btn sm" :aria-label="`取消关联 ${p}`" @click="unlinkApp(p)"><Icon name="close" /></button>
          </div>
        </div>
      </template>

      <div class="group">
        <button class="row" @click="router.push(`/item/${item.id}/history`)">
          <Icon name="history" />
          <span class="grow">历史版本<span class="sub">{{ item.history?.length ? `${item.history.length} 个以前的版本` : '还没有以前的版本' }}</span></span>
          <Icon name="right" />
        </button>
      </div>

      <p class="meta faint small">
        修改于 {{ timeAgo(item.rev.t) }} · {{ deviceName(item.rev.d) }}<br />
        创建于 {{ timeAgo(item.created) }}
      </p>

      <button v-if="!item.deleted" class="text-btn danger del" @click="del"><Icon name="trash" />删除</button>
    </div>
  </div>
</template>

<style scoped>
.val { display: block; font-size: 16px; line-height: 1.5; }
.val.pw { letter-spacing: 0.06em; }
.url { overflow-wrap: anywhere; color: var(--ink); }
.notes { position: relative; padding: 12px 48px 12px 14px; }
.notes p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.copy-note { position: absolute; top: 6px; right: 6px; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.tags svg { width: 16px; height: 16px; }
.meta { margin: 18px 4px 6px; line-height: 1.7; }
.back-btn { margin: 4px 0 8px; min-height: 46px; }
.del { display: inline-flex; align-items: center; gap: 6px; margin: 8px 0 20px; padding: 0 10px; }
.del svg { width: 18px; height: 18px; }
:deep(.filled) { fill: currentColor; }
</style>
