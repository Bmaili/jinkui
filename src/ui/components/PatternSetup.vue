<script setup lang="ts">
/** 设置图案解锁（1.0.9 起）：画两遍，再输主密码开启 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import PatternPad from './PatternPad.vue'
import { enablePattern, toast } from '../../store'
import { MASTER_EVERY_DAYS, PATTERN_MAX_FAILS, PATTERN_MIN_POINTS, patternProblem } from '../../core/pattern'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const step = ref<'draw' | 'confirm' | 'pass'>('draw')
const first = ref<number[]>([])
const second = ref<number[]>([])
const hint = ref('')
const status = ref<'' | 'error' | 'busy'>('')
const reset = ref(0)
const pass = ref('')
const busy = ref(false)
const error = ref('')

watch(() => props.open, (o) => {
  if (!o) return
  step.value = 'draw'
  first.value = []
  second.value = []
  pass.value = ''
  error.value = ''
  status.value = ''
  hint.value = `画一个图案，至少连 ${PATTERN_MIN_POINTS} 个点`
  reset.value++
})

function flash(msg: string) {
  hint.value = msg
  status.value = 'error'
  setTimeout(() => {
    status.value = ''
    reset.value++
  }, 700)
}

function onDraw(seq: number[]) {
  if (step.value === 'draw') {
    const p = patternProblem(seq)
    if (p) return flash(`${p}，请重画`)
    first.value = seq
    step.value = 'confirm'
    hint.value = '再画一遍确认'
    reset.value++
  } else if (step.value === 'confirm') {
    if (seq.join() !== first.value.join()) {
      step.value = 'draw'
      return flash('两次画的不一样，请重新画')
    }
    second.value = seq
    step.value = 'pass'
  }
}

function redraw() {
  step.value = 'draw'
  first.value = []
  hint.value = `画一个图案，至少连 ${PATTERN_MIN_POINTS} 个点`
  reset.value++
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

async function save() {
  if (!pass.value || busy.value) return
  busy.value = true
  error.value = ''
  await frame()
  try {
    await enablePattern(pass.value, second.value)
    toast('已开启图案解锁')
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
    pass.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Sheet :open="open" title="图案解锁" done="取消" @close="emit('close')">
    <div class="setup">
      <template v-if="step !== 'pass'">
        <p class="hint" :class="{ err: status === 'error' }">{{ hint }}</p>
        <PatternPad :status="status" :reset-key="reset" @done="onDraw" />
        <button v-if="step === 'confirm'" class="text-btn accent" @click="redraw">重新画</button>
      </template>
      <form v-else class="pass" @submit.prevent="save">
        <ul class="rules muted small">
          <li>连续画错 {{ PATTERN_MAX_FAILS }} 次，图案作废，要用主密码解锁再重新设置。</li>
          <li>每 {{ MASTER_EVERY_DAYS }} 天要输一次主密码，输完自动续期。</li>
          <li>解锁时要联网，从云端取一段密钥。设备丢了，在另一台设备的“同步与设备”里点“作废图案”，捡到的人猜中图案也解不开。</li>
          <li>画的时候别让人看到；屏幕上的指印也可能留下轨迹，记得擦一擦。</li>
        </ul>
        <input v-model="pass" class="field mono" type="password" placeholder="主密码" aria-label="主密码"
          autocomplete="current-password" autocapitalize="off" spellcheck="false" :disabled="busy" />
        <p v-if="error" class="note-box err">{{ error }}</p>
        <button class="solid-btn block" type="submit" :disabled="busy || !pass">
          <span v-if="busy" class="spinner" />{{ busy ? '正在开启…' : '开启图案解锁' }}
        </button>
        <button type="button" class="text-btn" :disabled="busy" @click="redraw">重新画图案</button>
      </form>
    </div>
  </Sheet>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; align-items: center; padding-top: 4px; }
.hint { min-height: 1.6em; margin: 0 0 6px; color: var(--muted); font-weight: 600; text-align: center; }
.hint.err { color: var(--danger); }
.pass { display: flex; flex-direction: column; gap: 12px; width: 100%; }
.pass .text-btn { align-self: center; }
.rules { margin: 0; padding-left: 1.2em; line-height: 1.7; }
</style>
