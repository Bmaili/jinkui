<script setup lang="ts">
/**
 * 条目头像（规格 5.9）。依次用：自定义图标（同步）→ 自动填充记住过的 app 的图标（本机读）
 * → 网站图标（设置里开启后）→ 标题的第一个字（笔记是笔记图标）。
 */
import { computed, ref, watch, watchEffect } from 'vue'
import Icon from './Icon.vue'
import type { Item } from '../../core/item'
import { iconOfItem } from '../../core/itemIcons'
import { hostOf } from '../../core/autofill'
import { initialOf } from '../../core/search'
import { appIconMap, siteIcons, vault, wantAppIcons } from '../../store'
import { prefs } from '../../prefs'
import { avatarColor } from '../format'

const props = defineProps<{ item: Item; size?: number }>()

const apps = computed(() => (Array.isArray(props.item.apps) ? (props.item.apps as unknown[]).filter((p): p is string => typeof p === 'string') : []))
const custom = computed(() => iconOfItem(vault.value.icons, props.item.id))

const icon = computed<{ src: string; kind: 'full' | 'site' } | null>(() => {
  if (custom.value) return { src: custom.value, kind: 'full' }
  if (prefs.appIcons) {
    const p = apps.value.find((x) => appIconMap.value[x])
    if (p) return { src: appIconMap.value[p], kind: 'full' }
  }
  const u = props.item.urls?.[0]
  if (prefs.siteIcons && props.item.type !== 'note' && u) {
    const s = siteIcons.value[hostOf(u)]
    if (s) return { src: s, kind: 'site' }
  }
  return null
})

watchEffect(() => {
  if (!custom.value && prefs.appIcons && apps.value.length) wantAppIcons(apps.value)
})

// 图片坏了（例如网站给的 ico 浏览器解不出来）就退回首字
const broken = ref('')
watch(() => icon.value?.src, () => (broken.value = ''))

const box = computed(() => (props.size ? { width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.round(props.size * 0.47)}px`, borderRadius: `${Math.round(props.size * 0.29)}px` } : {}))
</script>

<template>
  <span v-if="icon && broken !== icon.src" class="avatar" :class="icon.kind" :style="box">
    <img :src="icon.src" alt="" @error="broken = icon.src" />
  </span>
  <span v-else class="avatar" :style="{ ...box, background: avatarColor(item.title) }">
    <Icon v-if="item.type === 'note'" name="note" />
    <template v-else>{{ initialOf(item.title) }}</template>
  </span>
</template>

<style scoped>
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 38px;
  height: 38px;
  overflow: hidden;
  border-radius: 11px;
  color: #fbf8f1;
  font-size: 18px;
  font-weight: 700;
}
.avatar svg { width: 58%; height: 58%; }
.avatar.full img { width: 100%; height: 100%; object-fit: cover; }
.avatar.site { background: #fff; border: 1px solid var(--line); }
.avatar.site img { width: 68%; height: 68%; object-fit: contain; }
</style>
