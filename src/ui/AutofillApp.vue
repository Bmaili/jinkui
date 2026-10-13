<script setup lang="ts">
/**
 * 自动填充窗口（规格 5.8）。系统在用户点“用金匮填充”或“保存到金匮”时打开。
 * 先解锁（自动弹指纹），然后：
 * - 填充：推荐对得上的条目，也可以搜全部；点一条就把账号密码交回系统，窗口关掉，回到原来的 app。
 *   在 app 里（不是网页）选过一次，默认记住这个 app，下次直接推荐。
 * - 保存：新建一条，或更新已有条目的密码。
 */
import { computed, reactive, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import Switch from './components/Switch.vue'
import Dialog from './components/Dialog.vue'
import LockView from './views/LockView.vue'
import { app, rememberApp, saveCredential, syncBeforeClose, vault } from '../store'
import { autofill, type AutofillRequest } from '../platform/autofill'
import { baseDomain, hostOf, matchItems, remembersApp } from '../core/autofill'
import { liveItems } from '../core/vault'
import { initialOf, searchItems } from '../core/search'
import { generatePassword } from '../core/generator'
import type { Item } from '../core/item'
import { avatarColor } from './format'

const props = defineProps<{ req: AutofillRequest }>()
const req = props.req
const isWeb = !!req.webDomain
const target = req.webDomain ? hostOf(req.webDomain) || req.webDomain : req.appLabel || req.packageName || '这个 app'

const q = ref('')
const busy = ref(false)
const error = ref('')
const remember = ref(!isWeb && !!req.packageName)

const logins = computed(() => liveItems(vault.value).filter((i) => i.type !== 'note'))
const suggested = computed(() => matchItems(logins.value, { packageName: req.packageName, webDomain: req.webDomain }))
const others = computed(() => {
  if (q.value.trim()) return searchItems(logins.value, q.value)
  const s = new Set(suggested.value.map((i) => i.id))
  return searchItems(logins.value.filter((i) => !s.has(i.id)), '')
})

async function pick(it: Item) {
  if (busy.value) return
  error.value = ''
  const username = req.hasUsername ? it.username : undefined
  const password = req.hasPassword ? it.password : undefined
  if (!username && !password) {
    error.value = `“${it.title}”没有${req.hasPassword ? '密码' : '用户名'}可以填`
    return
  }
  busy.value = true
  try {
    if (remember.value && req.packageName && !isWeb && !remembersApp(it, req.packageName)) await rememberApp(it.id, req.packageName)
    await autofill.fill({ username, password })
  } catch (e) {
    error.value = (e as Error).message
    busy.value = false
  }
}

// ---------- 新建 / 保存 ----------

const creating = ref(req.mode === 'save')
const form = reactive({
  title: isWeb ? baseDomain(hostOf(req.webDomain!)) : req.appLabel ?? '',
  username: req.username ?? '',
  password: req.password ?? '',
  show: false,
})
/** 保存时可以更新的已有条目：对得上这个 app / 网站，且用户名相同（或没填用户名） */
const updatable = computed(() =>
  suggested.value.filter((i) => !form.username || !i.username || i.username === form.username),
)
const updateId = ref<string>('')
const sameAsSaved = computed(() => updatable.value.find((i) => i.username === form.username && i.password === form.password))
// 解锁后才知道有哪些条目：保存时默认更新第一个对得上的
let defaulted = false
watch(updatable, (list) => {
  if (defaulted || req.mode !== 'save' || app.phase !== 'unlocked') return
  defaulted = true
  updateId.value = list[0]?.id ?? ''
}, { immediate: true })

async function save() {
  if (!form.password) return void (error.value = '密码不能为空')
  busy.value = true
  error.value = ''
  try {
    const id = await saveCredential({
      updateId: updateId.value || undefined,
      title: form.title,
      username: form.username || undefined,
      password: form.password,
      url: isWeb ? `https://${hostOf(req.webDomain!)}` : undefined,
      app: !isWeb ? req.packageName : undefined,
    })
    if (req.mode === 'fill') {
      // 填充时新建：存好直接填进去
      await autofill.fill({ username: req.hasUsername ? form.username || undefined : undefined, password: req.hasPassword ? form.password : undefined })
      void id
    } else {
      await syncBeforeClose(5000)
      await autofill.close()
    }
  } catch (e) {
    error.value = (e as Error).message
    busy.value = false
  }
}

function generate() {
  form.password = generatePassword()
  form.show = true
}
</script>

<template>
  <div class="shell af" :data-phase="app.phase">
    <header class="topbar">
      <button class="icon-btn" aria-label="取消" @click="autofill.close()"><Icon name="close" /></button>
      <h1>{{ req.mode === 'save' ? '保存到金匮' : '用金匮填充' }}</h1>
    </header>

    <div v-if="app.phase === 'loading'" class="empty"><span class="spinner" /></div>

    <div v-else-if="app.phase === 'setup'" class="page empty">
      <p>还没有建立保险库。请先打开金匮，新建或加入保险库。</p>
      <button class="solid-btn" @click="autofill.close()">好的</button>
    </div>

    <template v-else-if="app.phase === 'locked'">
      <p class="target muted">{{ req.mode === 'save' ? '保存' : '填充到' }} <b>{{ target }}</b></p>
      <LockView />
    </template>

    <div v-else-if="app.phase === 'unlocked'" class="page">
      <!-- 新建 / 保存 -->
      <form v-if="creating" class="save" @submit.prevent="save">
        <p class="muted">{{ req.mode === 'save' ? `在 ${target} 上登录用的账号` : `新建一条，保存后直接填到 ${target}` }}</p>
        <div v-if="req.mode === 'save' && sameAsSaved" class="note-box">
          <p>这个账号和密码已经保存在“{{ sameAsSaved.title }}”里了。</p>
          <button type="button" class="text-btn accent" @click="autofill.close()">不用保存</button>
        </div>
        <template v-if="updatable.length">
          <label class="lbl">保存到</label>
          <div class="choices">
            <button type="button" class="chip" :class="{ on: !updateId }" @click="updateId = ''">新建一条</button>
            <button v-for="it in updatable" :key="it.id" type="button" class="chip" :class="{ on: updateId === it.id }" @click="updateId = it.id">
              更新“{{ it.title }}”
            </button>
          </div>
        </template>
        <template v-if="!updateId">
          <label class="lbl" for="af-title">标题</label>
          <input id="af-title" v-model="form.title" class="field" />
        </template>
        <label class="lbl" for="af-user">用户名</label>
        <input id="af-user" v-model="form.username" class="field mono" autocapitalize="off" autocomplete="off" spellcheck="false" />
        <label class="lbl" for="af-pw">密码</label>
        <div class="pw">
          <input id="af-pw" v-model="form.password" class="field mono" :type="form.show ? 'text' : 'password'" autocapitalize="off" autocomplete="off" spellcheck="false" />
          <button type="button" class="icon-btn sm" :aria-label="form.show ? '隐藏密码' : '显示密码'" @click="form.show = !form.show"><Icon :name="form.show ? 'eye-off' : 'eye'" /></button>
        </div>
        <button v-if="req.mode === 'fill'" type="button" class="text-btn accent gen" @click="generate"><Icon name="dice" />生成密码</button>
        <p v-if="error" class="note-box err">{{ error }}</p>
        <button class="solid-btn block submit" type="submit" :disabled="busy || !form.password">
          <span v-if="busy" class="spinner" />{{ req.mode === 'save' ? (updateId ? '更新' : '保存') : '保存并填充' }}
        </button>
        <button v-if="req.mode === 'fill'" type="button" class="text-btn back" @click="creating = false">返回选择</button>
      </form>

      <!-- 选择 -->
      <template v-else>
        <p class="target muted">填充到 <b>{{ target }}</b></p>
        <div class="search">
          <Icon name="search" />
          <input v-model="q" type="search" placeholder="搜索全部条目" aria-label="搜索" autocapitalize="off" autocomplete="off" spellcheck="false" />
        </div>
        <div v-if="!isWeb && req.packageName" class="row remember">
          <span class="grow small" :class="{ muted: !remember }">记住选择：以后在“{{ target }}”里优先推荐</span>
          <Switch v-model="remember" label="记住选择" />
        </div>
        <p v-if="error" class="note-box err">{{ error }}</p>

        <template v-if="!q.trim() && suggested.length">
          <div class="group-title">推荐</div>
          <ul class="list">
            <li v-for="it in suggested" :key="it.id">
              <button class="entry" :disabled="busy" @click="pick(it)">
                <span class="avatar" :style="{ background: avatarColor(it.title) }">{{ initialOf(it.title) }}</span>
                <span class="text"><span class="t">{{ it.title }}</span><span class="s mono">{{ it.username || '（没有用户名）' }}</span></span>
              </button>
            </li>
          </ul>
        </template>
        <div class="group-title">{{ q.trim() ? '搜索结果' : suggested.length ? '其他' : '全部' }}</div>
        <ul class="list">
          <li v-for="it in others" :key="it.id">
            <button class="entry" :disabled="busy" @click="pick(it)">
              <span class="avatar" :style="{ background: avatarColor(it.title) }">{{ initialOf(it.title) }}</span>
              <span class="text"><span class="t">{{ it.title }}</span><span class="s mono">{{ it.username || '（没有用户名）' }}</span></span>
            </button>
          </li>
        </ul>
        <p v-if="!others.length" class="muted small center">{{ q.trim() ? '没有找到' : '还没有保存任何账号' }}</p>
        <button class="solid-btn block ghost new" @click="creating = true"><Icon name="plus" />新建一条并填充</button>
      </template>
    </div>
    <Transition name="toast">
      <div v-if="app.toast" class="toast" role="status">{{ app.toast }}</div>
    </Transition>
    <Dialog />
  </div>
</template>

<style scoped>
.af { min-height: 100vh; }
.target { margin: 0 20px; font-size: 14px; }
.target b { color: var(--ink); }
.af :deep(.lock) { min-height: auto; padding-top: 6vh; }
.search {
  display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; padding: 0 14px; min-height: 46px;
  border: 1.5px solid var(--line); border-radius: 23px; background: var(--surface);
}
.search:focus-within { border-color: var(--accent); }
.search > svg { width: 20px; height: 20px; color: var(--faint); }
.search input { flex: 1; min-width: 0; height: 42px; border: 0; background: transparent; outline: none; }
.remember { padding: 6px 4px; border-top: 0; min-height: 48px; }
.list { list-style: none; margin: 0; padding: 0; }
.entry { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 62px; padding: 8px 4px; border: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: left; }
.entry:active { background: var(--line); }
.avatar { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border-radius: 11px; color: #fbf8f1; font-weight: 700; }
.text { display: flex; flex-direction: column; min-width: 0; }
.t, .s { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t { font-weight: 700; }
.s { color: var(--muted); font-size: 13px; }
.center { text-align: center; }
.new { margin: 20px 0 32px; }
.new svg { width: 18px; height: 18px; }
.save p { margin: 6px 2px; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.pw { position: relative; }
.pw .field { padding-right: 48px; }
.pw .icon-btn { position: absolute; right: 4px; top: 5px; }
.gen { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 0 6px; }
.gen svg { width: 18px; height: 18px; }
.submit { margin-top: 22px; }
.back { display: block; margin: 10px auto 0; color: var(--muted); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 64px 24px; text-align: center; }
.toast {
  position: fixed; left: 50%; bottom: calc(28px + var(--safe-bottom)); z-index: 300; max-width: calc(100% - 48px);
  padding: 10px 18px; border-radius: 20px; background: var(--ink); color: var(--bg); font-size: 14px; transform: translateX(-50%);
}
</style>
