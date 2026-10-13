<script setup lang="ts">
/** 管理目录：新建、改名、删除。删除目录不删里面的条目，它们变成“未分类” */
import { computed, ref } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import { addFolder, removeFolder, renameFolderById, toast, vault } from '../../store'
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

async function add() {
  error.value = checkFolderName(name.value, vault.value.folders) ?? ''
  if (error.value) return
  const id = await addFolder(name.value)
  name.value = ''
  emit('created', id)
}

async function rename(id: string, old: string) {
  const n = await promptText({ title: '目录改名', ok: '保存', input: { value: old } })
  if (n == null || n.trim() === old) return
  const err = checkFolderName(n, vault.value.folders, id)
  if (err) return toast(err)
  await renameFolderById(id, n)
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
      <div v-for="f in folders" :key="f.id" class="row">
        <Icon name="folder" />
        <span class="grow">{{ f.name }}<span class="sub">{{ counts.get(f.id) ?? 0 }} 条</span></span>
        <button class="icon-btn sm" :aria-label="`给“${f.name}”改名`" @click="rename(f.id, f.name)"><Icon name="pen" /></button>
        <button class="icon-btn sm" :aria-label="`删除“${f.name}”`" @click="del(f.id, f.name)"><Icon name="trash" /></button>
      </div>
    </div>
    <form class="add" @submit.prevent="add">
      <input v-model="name" class="field" placeholder="新目录的名字，例如 银行" aria-label="新目录的名字" maxlength="20" @input="error = ''" />
      <button class="solid-btn" type="submit" :disabled="!name.trim()">添加</button>
    </form>
    <p v-if="error" class="danger small">{{ error }}</p>
  </Sheet>
</template>

<style scoped>
.add { display: flex; gap: 8px; margin-top: 12px; }
.add .field { flex: 1; }
.add .solid-btn { min-height: 48px; padding: 0 18px; }
</style>
