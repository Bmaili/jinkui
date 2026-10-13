<script setup lang="ts">
/** 密码生成器：长度、字符种类，生成后点“使用” */
import { reactive, ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import Switch from './Switch.vue'
import Icon from './Icon.vue'
import { DEFAULT_GEN, estimateBits, generatePassword, strengthLabel, type GenOptions } from '../../core/generator'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; use: [string] }>()

const KEY = 'jinkui.gen'
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<GenOptions> | null
  } catch {
    return null
  }
})()
const opts = reactive<GenOptions>({ ...DEFAULT_GEN, ...(saved ?? {}) })
const value = ref('')

function regen() {
  try {
    value.value = generatePassword(opts)
  } catch {
    opts.lower = true
    value.value = generatePassword(opts)
  }
}

watch(() => props.open, (o) => o && regen(), { immediate: true })
watch(opts, () => {
  regen()
  try {
    localStorage.setItem(KEY, JSON.stringify(opts))
  } catch { /* 存不了就算了 */ }
})
</script>

<template>
  <Sheet :open="open" title="生成密码" done="取消" @close="emit('close')">
    <div class="out">
      <span class="mono val">{{ value }}</span>
      <button class="icon-btn" aria-label="换一个" @click="regen"><Icon name="refresh" /></button>
    </div>
    <p class="muted small">强度：{{ strengthLabel(estimateBits(value)).label }}（约 {{ estimateBits(value) }} 位）</p>
    <label class="len">
      <span>长度 <b class="mono">{{ opts.length }}</b></span>
      <input v-model.number="opts.length" type="range" min="8" max="64" step="1" aria-label="长度" />
    </label>
    <div class="opt"><span>小写字母</span><Switch v-model="opts.lower" label="小写字母" /></div>
    <div class="opt"><span>大写字母</span><Switch v-model="opts.upper" label="大写字母" /></div>
    <div class="opt"><span>数字</span><Switch v-model="opts.digits" label="数字" /></div>
    <div class="opt"><span>符号 <span class="muted small mono">!@#$%^&amp;*-_=+?.</span></span><Switch v-model="opts.symbols" label="符号" /></div>
    <div class="opt"><span>去掉易混字符 <span class="muted small mono">0 O 1 l I</span></span><Switch v-model="opts.avoidAmbiguous" label="去掉易混字符" /></div>
    <button class="solid-btn block use" @click="emit('use', value)">使用这个密码</button>
  </Sheet>
</template>

<style scoped>
.out { display: flex; align-items: center; gap: 8px; padding: 14px; border: 1.5px solid var(--line); border-radius: 16px; background: var(--surface); }
.val { flex: 1; font-size: 18px; line-height: 1.5; }
.len { display: block; margin: 14px 0 6px; }
.len span { display: block; margin-bottom: 4px; }
.len input { width: 100%; accent-color: var(--accent); }
.opt { display: flex; align-items: center; justify-content: space-between; min-height: 50px; border-top: 1px solid var(--line); }
.use { margin-top: 16px; }
</style>
