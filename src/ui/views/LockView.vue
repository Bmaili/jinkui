<script setup lang="ts">
/**
 * 锁屏：主密码、指纹或图案解锁。打开时如果开了指纹，自动弹出指纹框；
 * 开了图案（1.0.9 起）就先显示图案，同时去云端取解锁要用的那段密钥。
 */
import Logo from '../components/Logo.vue'
import { nextTick, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import PatternPad from '../components/PatternPad.vue'
import { app, preparePattern, setBioPrompting, unlockWithBio, unlockWithPassword, unlockWithPattern, wipeDevice } from '../../store'
import { PATTERN_MESSAGES, PatternUnlockError } from '../../core/pattern'
import { diag } from '../../diag'
import { prefs } from '../../prefs'
import { FormatTooNewError } from '../../core/vault'
import { ask, promptText } from '../dialog'

const pass = ref('')
const busy = ref(false)
const error = ref('')
const input = ref<HTMLInputElement | null>(null)

/** 显示图案还是主密码 */
const mode = ref<'pattern' | 'password'>(app.pattern.on && !app.pattern.due ? 'pattern' : 'password')
/** 图案上方的说明：正在连接、画图案、画错了还剩几次 */
const patternHint = ref('')
const padStatus = ref<'' | 'error' | 'busy'>('')
const padReset = ref(0)
/** 图案暂时用不了的原因（连不上云端、到期、已作废），显示在主密码上面 */
const patternNote = ref(app.pattern.on && app.pattern.due ? PATTERN_MESSAGES.expired : '')

async function prepare() {
  if (!app.pattern.on || app.pattern.due) return
  patternHint.value = '正在连接云端…'
  const why = await preparePattern()
  if (why) {
    patternNote.value = why
    mode.value = 'password'
    await nextTick()
    input.value?.focus()
  } else {
    patternNote.value = ''
    patternHint.value = '画图案解锁'
  }
}

async function withPattern(seq: number[]) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  padStatus.value = 'busy'
  patternHint.value = '正在解锁…'
  await frame()
  try {
    await unlockWithPattern(seq)
  } catch (e) {
    if (e instanceof PatternUnlockError && e.reason === 'wrong') {
      padStatus.value = 'error'
      patternHint.value = e.message
      setTimeout(() => {
        padStatus.value = ''
        padReset.value++
      }, 700)
    } else {
      padStatus.value = ''
      patternNote.value = (e as Error).message
      mode.value = 'password'
      await nextTick()
      input.value?.focus()
    }
  } finally {
    busy.value = false
  }
}

function usePassword() {
  mode.value = 'password'
  void nextTick(() => input.value?.focus())
}

function usePattern() {
  mode.value = 'pattern'
  void prepare()
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

async function withPassword() {
  if (!pass.value || busy.value) return
  busy.value = true
  error.value = ''
  await frame()
  try {
    await unlockWithPassword(pass.value)
  } catch (e) {
    error.value = e instanceof FormatTooNewError ? e.message : (e as Error).message
    pass.value = ''
    await nextTick()
    input.value?.focus()
  } finally {
    busy.value = false
  }
}

async function withBio() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  setBioPrompting(true)
  try {
    await unlockWithBio()
  } catch (e) {
    const code = (e as { code?: string }).code
    diag(`指纹解锁没有成功（${code ?? '错误'}）`)
    if (code !== 'CANCELLED') error.value = (e as Error).message
    await nextTick()
    input.value?.focus()
  } finally {
    setBioPrompting(false)
    busy.value = false
  }
}

/** 自动弹指纹框：只在前台时弹（在后台弹出来会被系统取消，回来时就没有了） */
function autoBio() {
  if (prefs.bioData && app.bio.available && app.active && !busy.value) void withBio()
}

async function forgot() {
  const msg = '主密码没有找回功能。\n\n• 另一台设备还能用指纹打开的话，在那台设备的“设置 → 修改主密码”里设一个新的，再回来用新密码。\n• 都打不开了，只能抹掉这台手机上的数据，重新开始（云端的加密数据仍然在，但没有主密码也解不开）。'
  const wipe = await ask({ title: '忘记主密码', message: msg, ok: '抹掉本机数据…', cancel: '返回', danger: true })
  if (!wipe) return
  const t = await promptText({
    title: '确定抹掉本机数据？',
    message: '本机的保险库、设置都会被删除，不能撤销。请输入“抹掉”两个字确认。',
    ok: '抹掉',
    danger: true,
    input: { placeholder: '抹掉' },
  })
  if (t?.trim() === '抹掉') await wipeDevice()
}

onMounted(() => {
  if (prefs.bioData && app.bio.available) autoBio()
  else if (mode.value === 'password') input.value?.focus()
  if (mode.value === 'pattern') void prepare()
})
// 锁屏状态下回到前台：再弹一次指纹（锁屏可能是在后台出现的）；图案重新去取云端密钥（可能刚连上网）
watch(() => app.foregroundTick, () => {
  autoBio()
  if (mode.value === 'pattern' && !busy.value) void prepare()
})
</script>

<template>
  <div class="lock page">
    <div class="brand">
      <Logo :size="64" />
      <h1>金匮</h1>
      <p class="muted">已上锁</p>
    </div>
    <div v-if="mode === 'pattern'" class="pattern">
      <p class="hint" :class="{ err: padStatus === 'error' }">{{ patternHint }}</p>
      <PatternPad :status="padStatus" :reset-key="padReset" :disabled="busy" @done="withPattern" />
      <button class="text-btn alt" :disabled="busy" @click="usePassword">用主密码</button>
    </div>
    <form v-else class="form" @submit.prevent="withPassword">
      <p v-if="patternNote" class="note-box">{{ patternNote }}</p>
      <input ref="input" v-model="pass" class="field mono" type="password" placeholder="主密码" aria-label="主密码"
        autocomplete="current-password" autocapitalize="off" spellcheck="false" :disabled="busy" />
      <button class="solid-btn block" type="submit" :disabled="busy || !pass">
        <span v-if="busy" class="spinner" />{{ busy ? '正在解锁…' : '解锁' }}
      </button>
    </form>
    <p v-if="error" class="note-box err">{{ error }}</p>
    <button v-if="mode === 'password' && app.pattern.on && !app.pattern.due" class="text-btn alt" :disabled="busy" @click="usePattern">
      <Icon name="pattern" /> 用图案
    </button>
    <button v-if="prefs.bioData && app.bio.available" class="bio" :disabled="busy" @click="withBio">
      <Icon name="fingerprint" />
      <span>指纹解锁</span>
    </button>
    <button class="text-btn forgot" @click="forgot">忘记主密码？</button>
  </div>
</template>

<style scoped>
.lock { display: flex; flex-direction: column; align-items: stretch; min-height: 100vh; padding-top: calc(14vh + var(--safe-top)); }
.brand { text-align: center; }
.brand h1 { margin: 14px 0 2px; font-size: 30px; letter-spacing: 0.3em; text-indent: 0.3em; }
.brand p { margin: 0; }
.form { display: flex; flex-direction: column; gap: 12px; margin-top: 40px; }
.bio { display: flex; flex-direction: column; align-items: center; gap: 6px; margin: 28px auto 0; padding: 10px 18px; border: 0; border-radius: 18px; background: transparent; color: var(--accent); }
.bio:active { background: var(--line); }
.bio svg { width: 44px; height: 44px; }
.forgot { margin: auto auto 16px; color: var(--muted); font-weight: 600; }
.pattern { display: flex; flex-direction: column; align-items: center; margin-top: 28px; }
.pattern .hint { min-height: 1.6em; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
.pattern .hint.err { color: var(--danger); }
.alt { display: inline-flex; align-items: center; gap: 6px; margin: 14px auto 0; color: var(--accent); font-weight: 600; }
.alt svg { width: 20px; height: 20px; }
</style>
