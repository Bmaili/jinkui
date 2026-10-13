<script setup lang="ts">
/** 新建或编辑条目。没提到的字段（包括新版本加的未知字段）保持原样 */
import { computed, reactive, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import GeneratorSheet from '../components/GeneratorSheet.vue'
import { addItem, saveItem, toast, vault } from '../../store'
import type { CustomField, ItemContent } from '../../core/item'
import { estimateBits, strengthLabel } from '../../core/generator'
import { ask } from '../dialog'
import { hostOf } from '../format'

const route = useRoute()
const router = useRouter()
const id = route.params.id ? String(route.params.id) : ''
const orig = id ? vault.value.items[id] : undefined

interface Form {
  type: string
  title: string
  username: string
  password: string
  urls: string[]
  notes: string
  totp: string
  fields: CustomField[]
  tags: string
}

const fromItem = (c?: ItemContent): Form => ({
  type: c?.type ?? 'login',
  title: c?.title ?? '',
  username: c?.username ?? '',
  password: c?.password ?? '',
  urls: c?.urls?.length ? [...c.urls] : [''],
  notes: c?.notes ?? '',
  totp: c?.totp ?? '',
  fields: (c?.fields ?? []).map((f) => ({ ...f })),
  tags: (c?.tags ?? []).join('，'),
})

const form = reactive(fromItem(orig))
const initial = JSON.stringify(form)
const dirty = computed(() => JSON.stringify(form) !== initial)
const showPw = ref(!id)
const gen = ref(false)
const error = ref('')
const saving = ref(false)
let leaving = false

const strength = computed(() => strengthLabel(estimateBits(form.password)))
const isNote = computed(() => form.type === 'note')

/** 把表单变成要保存的字段；空字段写成 undefined（删除） */
function toContent(f: Form = form): Partial<ItemContent> {
  const urls = f.urls.map((u) => u.trim()).filter(Boolean)
  const fields = f.fields.filter((x) => x.name.trim() || x.value).map((x) => ({ name: x.name.trim(), value: x.value, ...(x.secret ? { secret: true } : {}) }))
  const tags = f.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
  let title = f.title.trim()
  if (!title) title = urls[0] ? hostOf(urls[0]) : f.username.trim()
  return {
    type: f.type,
    title,
    username: f.username.trim() || undefined,
    password: f.password || undefined,
    urls: urls.length ? urls : undefined,
    notes: f.notes.trim() ? f.notes : undefined,
    totp: f.totp.trim() || undefined,
    fields: fields.length ? fields : undefined,
    tags: tags.length ? tags : undefined,
  }
}

async function save() {
  error.value = ''
  const c = toContent()
  if (!c.title) {
    error.value = '至少填写标题、网址或用户名中的一项'
    return
  }
  saving.value = true
  try {
    if (id) {
      // 只传变了的字段：别的设备同时改了其他字段时，冲突更少
      const before = toContent(fromItem(orig))
      const patch: Partial<ItemContent> = {}
      for (const k of Object.keys(c) as (keyof ItemContent)[]) {
        if (JSON.stringify(c[k]) !== JSON.stringify(before[k])) (patch as Record<string, unknown>)[k] = c[k]
      }
      await saveItem(id, patch)
      leaving = true
      router.back()
    } else {
      const newId = await addItem(c as ItemContent)
      leaving = true
      await router.replace(`/item/${newId}`)
    }
    toast('已保存')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function useGenerated(p: string) {
  form.password = p
  showPw.value = true
  gen.value = false
}

onBeforeRouteLeave(async () => {
  if (leaving || !dirty.value) return true
  return ask({ title: '放弃修改？', message: '还没有保存。', ok: '放弃', danger: true, cancel: '继续编辑' })
})
</script>

<template>
  <div class="edit">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="close" /></button>
      <h1>{{ id ? '编辑' : '新建' }}</h1>
      <button class="text-btn accent" :disabled="saving || (!!id && !dirty)" @click="save">保存</button>
    </header>

    <form class="page" @submit.prevent="save">
      <div v-if="!id" class="types">
        <button type="button" class="chip" :class="{ on: !isNote }" @click="form.type = 'login'"><Icon name="key" />登录</button>
        <button type="button" class="chip" :class="{ on: isNote }" @click="form.type = 'note'"><Icon name="note" />笔记</button>
      </div>

      <label class="lbl" for="e-title">标题</label>
      <input id="e-title" v-model="form.title" class="field" :placeholder="isNote ? '例如：家里的 Wi-Fi' : '例如：招商银行'" />

      <template v-if="!isNote">
        <label class="lbl" for="e-user">用户名</label>
        <input id="e-user" v-model="form.username" class="field mono" placeholder="账号、邮箱或手机号"
          autocapitalize="off" autocomplete="off" spellcheck="false" />

        <label class="lbl" for="e-pw">密码</label>
        <div class="pw">
          <input id="e-pw" v-model="form.password" class="field mono" :type="showPw ? 'text' : 'password'"
            autocapitalize="off" autocomplete="off" spellcheck="false" />
          <button type="button" class="icon-btn sm" :aria-label="showPw ? '隐藏密码' : '显示密码'" @click="showPw = !showPw">
            <Icon :name="showPw ? 'eye-off' : 'eye'" />
          </button>
        </div>
        <div class="pw-tools">
          <span v-if="form.password" :class="`lv lv${strength.level}`">强度：{{ strength.label }}</span>
          <button type="button" class="text-btn accent" @click="gen = true"><Icon name="dice" />生成密码</button>
        </div>

        <label class="lbl">网址</label>
        <div v-for="(_, i) in form.urls" :key="i" class="url-row">
          <input v-model="form.urls[i]" class="field mono" placeholder="https://" inputmode="url" autocapitalize="off" spellcheck="false" :aria-label="`网址 ${i + 1}`" />
          <button v-if="form.urls.length > 1" type="button" class="icon-btn sm" aria-label="删除这个网址" @click="form.urls.splice(i, 1)"><Icon name="close" /></button>
        </div>
        <button type="button" class="text-btn add" @click="form.urls.push('')"><Icon name="plus" />再加一个网址</button>
      </template>

      <label class="lbl" for="e-notes">{{ isNote ? '内容' : '备注' }}</label>
      <textarea id="e-notes" v-model="form.notes" class="field" :rows="isNote ? 8 : 3" />

      <template v-if="!isNote">
        <label class="lbl" for="e-totp">两步验证密钥（可不填）</label>
        <input id="e-totp" v-model="form.totp" class="field mono" placeholder="otpauth:// 或 Base32 密钥" autocapitalize="off" spellcheck="false" />
      </template>

      <label class="lbl">自定义字段</label>
      <div v-for="(f, i) in form.fields" :key="'f' + i" class="cf">
        <input v-model="f.name" class="field" placeholder="名称，例如 PIN" :aria-label="`字段 ${i + 1} 名称`" />
        <input v-model="f.value" class="field mono" :type="f.secret ? 'password' : 'text'" placeholder="值" autocapitalize="off" spellcheck="false" :aria-label="`字段 ${i + 1} 的值`" />
        <div class="cf-tools">
          <span class="small muted">保密</span>
          <Switch :model-value="!!f.secret" :label="`字段 ${i + 1} 保密`" @update:model-value="f.secret = $event || undefined" />
          <button type="button" class="icon-btn sm" aria-label="删除这个字段" @click="form.fields.splice(i, 1)"><Icon name="trash" /></button>
        </div>
      </div>
      <button type="button" class="text-btn add" @click="form.fields.push({ name: '', value: '', secret: true })"><Icon name="plus" />添加字段</button>

      <label class="lbl" for="e-tags">标签（用逗号分开，可不填）</label>
      <input id="e-tags" v-model="form.tags" class="field" placeholder="例如：工作，银行" />

      <p v-if="error" class="note-box err">{{ error }}</p>
      <button class="solid-btn block save" type="submit" :disabled="saving || (!!id && !dirty)">保存</button>
    </form>

    <GeneratorSheet :open="gen" @close="gen = false" @use="useGenerated" />
  </div>
</template>

<style scoped>
.types { display: flex; gap: 8px; margin-top: 6px; }
.types svg { width: 16px; height: 16px; }
.pw { position: relative; }
.pw .field { padding-right: 48px; }
.pw .icon-btn { position: absolute; right: 4px; top: 5px; }
.pw-tools { display: flex; align-items: center; justify-content: space-between; min-height: 42px; font-size: 14px; }
.pw-tools .text-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; }
.pw-tools svg, .add svg { width: 18px; height: 18px; }
.lv0 { color: var(--danger); }
.lv1 { color: var(--warn); }
.lv2, .lv3 { color: var(--ok); }
.url-row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
.add { display: inline-flex; align-items: center; gap: 6px; padding: 0 6px; color: var(--muted); font-weight: 600; }
.cf { display: grid; gap: 8px; margin-bottom: 12px; padding: 10px; border: 1px dashed var(--line); border-radius: 16px; }
.cf-tools { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.save { margin: 24px 0 12px; }
</style>
