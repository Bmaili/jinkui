<script setup lang="ts">
/** 第一次打开：新建保险库，或用主密码加入已有的保险库 */
import Logo from '../components/Logo.vue'
import { computed, reactive, ref } from 'vue'
import BackendForm from '../components/BackendForm.vue'
import { configFrom, draftFrom } from '../backendDraft'
import { probeBackend, setupJoin, setupNew, type BackendConfig } from '../../store'
import { checkPassphrase, generatePassphrase } from '../../core/crypto'
import { normalizeJoinCode, readJoinCode } from '../../core/sync/setup'
import { estimateBits, strengthLabel } from '../../core/generator'
import { ask } from '../dialog'
import { copyPlain } from '../../store'

type Step = 'welcome' | 'backend' | 'password'
const step = ref<Step>('welcome')
const mode = ref<'new' | 'join'>('new')
const draft = reactive(draftFrom(null))
/** 新建且“先不同步”时为 null */
const backend = ref<BackendConfig | null>(null)
const busy = ref('')
const error = ref('')
const pass = ref('')
const pass2 = ref('')
const show = ref(false)
const generated = ref(false)
/** 加入时粘贴的加入码（有它就不用填同步设置） */
const code = ref('')
const codeOk = computed(() => !!normalizeJoinCode(code.value))

const strength = computed(() => strengthLabel(estimateBits(pass.value)))
const passError = computed(() => (pass.value ? checkPassphrase(pass.value) : null))

function start(m: 'new' | 'join') {
  mode.value = m
  error.value = ''
  step.value = 'backend'
}

async function nextFromBackend() {
  error.value = ''
  if (mode.value === 'join' && code.value.trim()) {
    if (!codeOk.value) return void (error.value = '这不是完整的加入码，请在另一台设备上重新复制')
    backend.value = null
    pass.value = ''
    step.value = 'password'
    return
  }
  const r = configFrom(draft)
  if ('error' in r) {
    error.value = r.error
    return
  }
  busy.value = '正在连接…'
  try {
    const p = await probeBackend(r.cfg)
    busy.value = ''
    if (mode.value === 'new' && p.initialized) {
      const join = await ask({ title: '这里已经有保险库了', message: '要用主密码加入它吗？\n（新建会被拒绝：一个位置只能放一个保险库）', ok: '加入' })
      if (!join) return
      mode.value = 'join'
    }
    if (mode.value === 'join' && !p.initialized) {
      error.value = '这里还没有保险库。如果这是第一台设备，请返回选“新建保险库”'
      return
    }
    if (mode.value === 'new' && p.otherFiles.length) {
      const ok = await ask({
        title: '这里已经有别的文件',
        message: `${p.otherFiles.slice(0, 5).join('\n')}${p.otherFiles.length > 5 ? `\n…共 ${p.otherFiles.length} 个` : ''}\n\n保险库最好放在一个单独的空仓库里。确定用这里吗？`,
        ok: '仍然使用',
      })
      if (!ok) return
    }
    backend.value = r.cfg
    pass.value = ''
    pass2.value = ''
    step.value = 'password'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

async function localOnly() {
  const ok = await ask({
    title: '先不同步？',
    message: '密码只存在这台手机上。手机丢了或卸载 app，数据就没了。之后可以随时在设置里开启同步。',
    ok: '只存本机',
  })
  if (!ok) return
  backend.value = null
  step.value = 'password'
}

function suggest() {
  pass.value = generatePassphrase()
  pass2.value = pass.value
  show.value = true
  generated.value = true
}

/** 让浏览器先画出“正在…”再开始耗时的 scrypt */
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

async function finish() {
  error.value = ''
  if (mode.value === 'new') {
    const err = checkPassphrase(pass.value)
    if (err) return void (error.value = err)
    if (pass.value !== pass2.value) return void (error.value = '两次输入的主密码不一样')
    busy.value = '正在生成密钥…'
    await frame()
    try {
      await setupNew(pass.value, backend.value)
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      busy.value = ''
    }
  } else {
    if (!pass.value) return
    busy.value = '正在解开保险库…'
    await frame()
    try {
      let cfg = backend.value
      if (!cfg) {
        // 用加入码：先用主密码解开里面的同步配置，再按正常的加入走
        const r = configFrom(draftFrom((await readJoinCode(code.value, pass.value)) as BackendConfig))
        if ('error' in r) throw new Error(`加入码里的同步设置不对：${r.error}`)
        cfg = r.cfg
      }
      await setupJoin(pass.value, cfg)
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      busy.value = ''
    }
  }
}

function back() {
  error.value = ''
  step.value = step.value === 'password' ? 'backend' : 'welcome'
}
</script>

<template>
  <div class="setup">
    <header v-if="step !== 'welcome'" class="topbar">
      <button class="icon-btn" aria-label="返回" :disabled="!!busy" @click="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <h1>{{ mode === 'new' ? '新建保险库' : '加入已有保险库' }}</h1>
    </header>

    <section v-if="step === 'welcome'" class="welcome page">
      <div class="brand rise">
        <Logo :size="72" />
        <h1>金匮</h1>
        <p class="tag">密码藏于金匮，钥匙只在你手里</p>
      </div>
      <ul class="points rise" style="animation-delay: 60ms">
        <li>本机和云端都只存加密后的数据，没有服务器，也没有账号。</li>
        <li>同步到你自己的 GitHub 私有仓库或阿里云 OSS，多台手机互相同步。</li>
        <li>只有主密码能解开。<b>主密码忘了没有任何办法找回。</b></li>
      </ul>
      <div class="actions rise" style="animation-delay: 120ms">
        <button class="solid-btn block" @click="start('new')">新建保险库</button>
        <button class="solid-btn block ghost" @click="start('join')">加入已有保险库</button>
        <p class="muted small center">另一台设备上已经在用金匮？选“加入”，用同一个主密码。</p>
      </div>
    </section>

    <section v-else-if="step === 'backend'" class="page">
      <template v-if="mode === 'join'">
        <p class="muted lead">在另一台设备的“设置 → 同步与设备 → 生成加入码”复制加入码，粘贴在这里：</p>
        <textarea v-model="code" class="field mono code" rows="3" placeholder="jinkui-join:…" aria-label="加入码"
          autocapitalize="off" spellcheck="false" @input="error = ''" />
        <p v-if="!code.trim()" class="muted lead or">没有加入码？填写和另一台设备相同的同步设置：</p>
      </template>
      <p v-else class="muted lead">选一个存放加密数据的地方。建议用一个单独的私有仓库，例如 jinkui-data。</p>
      <BackendForm v-if="mode === 'new' || !code.trim()" v-model="draft" />
      <p v-if="error" class="note-box err">{{ error }}</p>
      <div class="actions">
        <button class="solid-btn block" :disabled="!!busy" @click="nextFromBackend">
          <span v-if="busy" class="spinner" />{{ busy || '下一步' }}
        </button>
        <button v-if="mode === 'new'" class="text-btn" :disabled="!!busy" @click="localOnly">先不同步，只存在本机</button>
      </div>
    </section>

    <section v-else class="page">
      <template v-if="mode === 'new'">
        <p class="muted lead">设置主密码。以后在新手机上加入、指纹失效时都要用它。</p>
        <label class="lbl" for="mp1">主密码</label>
        <div class="pw">
          <input id="mp1" v-model="pass" class="field mono" :type="show ? 'text' : 'password'" autocomplete="new-password"
            autocapitalize="off" spellcheck="false" @input="generated = false" />
          <button type="button" class="icon-btn sm" :aria-label="show ? '隐藏' : '显示'" @click="show = !show">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path :d="show ? 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM4 4l16 16' : 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'" /></svg>
          </button>
        </div>
        <div class="meter">
          <span v-if="pass" :class="`lv lv${strength.level}`">强度：{{ strength.label }}</span>
          <span v-if="passError" class="danger">{{ passError }}</span>
          <button class="text-btn accent gen" @click="suggest">帮我生成一个</button>
        </div>
        <template v-if="!generated">
          <label class="lbl" for="mp2">再输一次</label>
          <input id="mp2" v-model="pass2" class="field mono" :type="show ? 'text' : 'password'" autocomplete="new-password"
            autocapitalize="off" spellcheck="false" />
        </template>
        <div v-else class="note-box">
          <p>请把这个主密码<b>抄在纸上</b>，或存进另一个你信得过的地方。</p>
          <button class="text-btn accent" @click="copyPlain(pass, '主密码')">复制</button>
        </div>
        <div class="note-box warn">
          <p>主密码不会上传，也没有找回功能。忘了它，又换了手机，保险库就再也打不开。</p>
        </div>
      </template>
      <template v-else>
        <p class="muted lead">输入这个保险库的主密码{{ backend ? '' : '（加入码也用它解开）' }}。</p>
        <label class="lbl" for="mpj">主密码</label>
        <input id="mpj" v-model="pass" class="field mono" type="password" autocomplete="current-password" autocapitalize="off"
          spellcheck="false" @keyup.enter="finish" />
      </template>
      <p v-if="error" class="note-box err">{{ error }}</p>
      <div class="actions">
        <button class="solid-btn block" :disabled="!!busy || !pass" @click="finish">
          <span v-if="busy" class="spinner" />{{ busy || (mode === 'new' ? '创建保险库' : '加入') }}
        </button>
        <p v-if="busy" class="muted small center">需要几秒钟，请不要离开</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.setup { min-height: 100vh; }
.welcome { display: flex; flex-direction: column; min-height: 100vh; padding-top: calc(12vh + var(--safe-top)); }
.brand { text-align: center; }
.brand h1 { margin: 14px 0 4px; font-size: 34px; letter-spacing: 0.3em; text-indent: 0.3em; }
.tag { margin: 0; color: var(--muted); }
.points { margin: 36px 0 0; padding-left: 1.2em; color: var(--muted); line-height: 1.8; }
.points b { color: var(--ink); }
.actions { display: flex; flex-direction: column; gap: 12px; margin-top: 28px; align-items: center; }
.welcome .actions { margin-top: auto; padding-bottom: 24px; }
.center { text-align: center; margin: 0; }
.lead { margin: 4px 2px 8px; line-height: 1.7; }
.code { width: 100%; resize: none; font-size: 13px; line-height: 1.5; word-break: break-all; }
.or { margin-top: 18px; }
.pw { position: relative; }
.pw .field { padding-right: 48px; }
.pw .icon-btn { position: absolute; right: 4px; top: 5px; }
.meter { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-height: 40px; margin-top: 4px; font-size: 14px; }
.gen { margin-left: auto; }
.lv0 { color: var(--danger); }
.lv1 { color: var(--warn); }
.lv2, .lv3 { color: var(--ok); }
</style>
