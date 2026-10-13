<script setup lang="ts">
/** 修改主密码：只重新加密保险库密钥，条目不用重新加密；新密码会同步到云端，其他设备不受影响 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { app, changeMasterPassword, copyPlain, toast } from '../../store'
import { checkPassphrase, generatePassphrase } from '../../core/crypto'

const router = useRouter()
const oldPass = ref('')
const pass = ref('')
const pass2 = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref('')

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))

function suggest() {
  pass.value = generatePassphrase()
  pass2.value = pass.value
  show.value = true
}

async function save() {
  error.value = ''
  const err = checkPassphrase(pass.value)
  if (err) return void (error.value = err)
  if (pass.value !== pass2.value) return void (error.value = '两次输入的新主密码不一样')
  busy.value = true
  await frame()
  try {
    await changeMasterPassword(oldPass.value, pass.value)
    toast(app.backend && !app.sync.errorKind ? '已修改，并同步到云端' : '已修改')
    router.back()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>修改主密码</h1>
    </header>
    <form class="page" @submit.prevent="save">
      <label class="lbl" for="op">当前主密码</label>
      <input id="op" v-model="oldPass" class="field mono" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" />
      <label class="lbl" for="np">新主密码</label>
      <input id="np" v-model="pass" class="field mono" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
      <div class="tools">
        <button type="button" class="text-btn" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button>
        <button type="button" class="text-btn accent" @click="suggest">帮我生成一个</button>
        <button v-if="show && pass" type="button" class="text-btn" @click="copyPlain(pass, '主密码')">复制</button>
      </div>
      <label class="lbl" for="np2">再输一次新主密码</label>
      <input id="np2" v-model="pass2" class="field mono" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
      <div class="note-box">
        <p>其他设备不用改：它们打开时继续用指纹或旧的解锁方式。之后在新设备上加入时，用新主密码。</p>
        <p>注意：云端以前的密钥文件（GitHub 提交历史、OSS 版本控制）仍然能用<b>旧主密码</b>解开。如果改密码是因为旧密码可能泄露，请同时清理云端的历史，并修改重要网站的密码。</p>
      </div>
      <p v-if="error" class="note-box err">{{ error }}</p>
      <button class="solid-btn block" type="submit" :disabled="busy || !oldPass || !pass">
        <span v-if="busy" class="spinner" />{{ busy ? '正在修改…' : '修改' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.tools { display: flex; gap: 4px; margin: 4px 0 0; }
form .solid-btn { margin-top: 18px; }
</style>
