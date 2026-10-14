<script setup lang="ts">
/** 管理目录：新建、改名、删除、拖动排序（顺序同步到其他设备）。删除目录不删里面的条目，它们变成“未分类” */
import { computed, reactive, ref } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import { addFolder, moveFolderTo, removeFolder, renameFolderById, toast, vault } from '../../store'
import { checkFolderName, liveFolders } from '../../core/folders'
import { liveItems } from '../../core/vault'
import { ask, promptText } from '../dialog'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [string] }>()

const folders = computed(() => liveFolders(vault.value.folders))
const counts = computed(() => {
  const m = new Map<string, number>()
  for (const it of liveItems(vault.value)) if (it.folder) m.set(it.folder, (m.get(it.folder) ?? 0) + 1)
  return m
})
const name = ref('')
const error = ref('')

const adding = ref(false)

async function add() {
  if (adding.value) return
  error.value = checkFolderName(name.value, vault.value.folders) ?? ''
  if (error.value) return
  // 先取走名字、清空输入框：保存要一点时间，期间用户可能已经在输下一个
  const n = name.value
  name.value = ''
  adding.value = true
  try {
    emit('created', await addFolder(n))
  } catch (e) {
    name.value = n
    error.value = (e as Error).message
  } finally {
    adding.value = false
  }
}

async function rename(id: string, old: string) {
  const n = await promptText({ title: '目录改名', ok: '保存', input: { value: old } })
  if (n == null || n.trim() === old) return
  const err = checkFolderName(n, vault.value.folders, id)
  if (err) return toast(err)
  await renameFolderById(id, n)
}

// ---------- 拖动排序（按住右边的把手上下拖） ----------

const drag = reactive({ id: '', from: 0, startY: 0, dy: 0, h: 56 })
/** 松手时会落到的位置 */
const dropAt = computed(() =>
  drag.id ? Math.max(0, Math.min(folders.value.length - 1, drag.from + Math.round(drag.dy / drag.h))) : -1,
)

function grab(e: PointerEvent, id: string, i: number) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  Object.assign(drag, { id, from: i, startY: e.clientY, dy: 0, h: (el.closest('.row') as HTMLElement | null)?.offsetHeight || 56 })
}

function dragMove(e: PointerEvent) {
  if (drag.id) drag.dy = e.clientY - drag.startY
}

async function drop() {
  if (!drag.id) return
  const { id, from } = drag
  const to = dropAt.value
  drag.id = ''
  drag.dy = 0
  if (to !== from) {
    try {
      await moveFolderTo(id, to)
    } catch (e) {
      toast((e as Error).message)
    }
  }
}

/** 拖动时每一行的位移：被拖的跟着手指，经过的让开一格 */
function shift(i: number): string | undefined {
  if (!drag.id) return undefined
  if (i === drag.from) return `translateY(${drag.dy}px)`
  const to = dropAt.value
  if (drag.from < to && i > drag.from && i <= to) return `translateY(${-drag.h}px)`
  if (drag.from > to && i < drag.from && i >= to) return `translateY(${drag.h}px)`
  return 'translateY(0)'
}

async function del(id: string, n: string) {
  const c = counts.value.get(id) ?? 0
  const ok = await ask({
    title: `删除目录“${n}”？`,
    message: c ? `里面的 ${c} 条不会被删除，会变成“未分类”。` : '这个目录是空的。',
    ok: '删除',
    danger: true,
  })
  if (ok) await removeFolder(id)
}
</script>

<template>
  <Sheet :open="open" title="管理目录" @close="emit('close')">
    <div class="group">
      <div v-if="!folders.length" class="row muted">还没有目录。目录会同步到其他设备。</div>
      <div v-for="(f, i) in folders" :key="f.id" class="row" :class="{ dragging: drag.id === f.id, moving: !!drag.id }"
        :style="{ transform: shift(i) }">
        <Icon name="folder" />
        <span class="grow">{{ f.name }}<span class="sub">{{ counts.get(f.id) ?? 0 }} 条</span></span>
        <button class="icon-btn sm" :aria-label="`给“${f.name}”改名`" @click="rename(f.id, f.name)"><Icon name="pen" /></button>
        <button class="icon-btn sm" :aria-label="`删除“${f.name}”`" @click="del(f.id, f.name)"><Icon name="trash" /></button>
        <span v-if="folders.length > 1" class="grip" role="button" :aria-label="`拖动“${f.name}”排序`"
          @pointerdown.prevent="grab($event, f.id, i)" @pointermove="dragMove" @pointerup="drop" @pointercancel="drop">
          <Icon name="grip" />
        </span>
      </div>
    </div>
    <p v-if="folders.length > 1" class="muted small hint">按住右边的 <Icon name="grip" class="inline" /> 上下拖动排序，顺序会同步到其他设备。</p>
    <form class="add" @submit.prevent="add">
      <input v-model="name" class="field" placeholder="新目录的名字，例如 银行" aria-label="新目录的名字" maxlength="20" @input="error = ''" />
      <button class="solid-btn" type="submit" :disabled="!name.trim() || adding">添加</button>
    </form>
    <p v-if="error" class="danger small">{{ error }}</p>
  </Sheet>
</template>

<style scoped>
.add { display: flex; gap: 8px; margin-top: 12px; }
.grip { display: grid; place-items: center; width: 40px; height: 40px; margin-right: -8px; color: var(--muted); touch-action: none; cursor: grab; }
.grip svg { width: 22px; height: 22px; stroke-width: 2.6; }
.row.moving { transition: transform 0.15s ease; }
.row.dragging { position: relative; z-index: 1; transition: none; background: var(--surface); box-shadow: 0 6px 20px rgb(0 0 0 / 0.18); }
.hint { margin: 2px 6px 0; line-height: 1.6; }
.inline { width: 14px; height: 14px; vertical-align: -2px; }
.add .field { flex: 1; }
.add .solid-btn { min-height: 48px; padding: 0 18px; }
</style>
