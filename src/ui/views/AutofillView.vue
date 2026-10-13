<script setup lang="ts">
/** 自动填充：状态、一键设为自动填充服务、各处的设置方法和使用说明（规格 5.8） */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import Icon from '../components/Icon.vue'
import { expectExternal, toast } from '../../store'
import { autofill, type AutofillStatus } from '../../platform/autofill'
import { ask } from '../dialog'

const router = useRouter()
const st = ref<AutofillStatus | null>(null)
const manual = ref(false)
let resumeHandle: PluginListenerHandle | null = null
let done: (() => void) | null = null

async function refresh() {
  st.value = await autofill.status()
}

async function enable() {
  // 系统弹窗会让 app 切到后台，这一次回来不上锁
  done = expectExternal()
  const opened = await autofill.openSettings()
  if (!opened) {
    done()
    done = null
    manual.value = true
    toast('这台手机打不开设置弹窗，请按下面的步骤手动设置')
  }
}

async function disable() {
  const ok = await ask({ title: '停用自动填充？', message: '之后在登录页不会再出现“用金匮填充”。金匮里的数据不受影响。', ok: '停用', danger: true })
  if (!ok) return
  await autofill.disable()
  await refresh()
}

onMounted(async () => {
  await refresh()
  if (Capacitor.isNativePlatform()) {
    resumeHandle = await CapApp.addListener('resume', () => {
      setTimeout(() => {
        done?.()
        done = null
      }, 800)
      void refresh().then(() => {
        if (st.value?.enabled) toast('已开启自动填充')
      })
    })
  }
})
onBeforeUnmount(() => void resumeHandle?.remove())
</script>

<template>
  <div>
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>自动填充</h1>
    </header>
    <div class="page">
      <div class="status group">
        <div class="row">
          <Icon :name="st?.enabled ? 'check' : 'key'" :class="{ on: st?.enabled }" />
          <span class="grow">
            <template v-if="!st">正在检查…</template>
            <template v-else-if="st.enabled">已开启：金匮是这台手机的自动填充服务</template>
            <template v-else-if="st.supported">还没开启</template>
            <template v-else>这台设备不支持自动填充（需要安卓 8 以上，且系统没有关掉这个功能）</template>
            <span class="sub">在其他 app 和浏览器的登录页，点输入框就能填入金匮里的账号密码，不用来回切换。</span>
          </span>
        </div>
      </div>
      <button v-if="!st?.enabled" class="solid-btn block" :disabled="st ? !st.supported && !manual : true" @click="enable">设为自动填充服务</button>
      <button v-else class="text-btn danger stop" @click="disable">停用</button>

      <div class="group-title">1. 开启</div>
      <div class="note-box" :class="{ warn: manual }">
        <p>点上面的按钮，在系统弹窗里选<b>金匮</b>，再点<b>确定</b>。</p>
        <p>没有弹窗时，手动设置：打开手机的<b>设置</b> → 在顶部搜索框搜<b>自动填充</b> → 进入<b>自动填充服务</b> → 选<b>金匮</b>。
          不同品牌的位置不一样，一般在“语言和输入法”“密码与安全”或“隐私”里。</p>
        <p>同一时间只能有一个自动填充服务。选了金匮之后，原来的（例如 Google 密码管理工具）就不再弹出。有的手机自带的“密码保险箱 / 密码管理”不走这套机制，如果它还会弹出“保存密码”，可以在系统设置里把它关掉，免得两边都问。</p>
      </div>

      <div class="group-title">2. 浏览器里也要打开</div>
      <div class="note-box">
        <p><b>Chrome</b>：打开 Chrome → 右上角 ⋮ → 设置 → <b>自动填充服务</b> → 选<b>使用其他服务自动填充</b>，然后关掉 Chrome 重新打开。</p>
        <p><b>Firefox</b>：不用设置，直接可以用。</p>
        <p><b>其他浏览器</b>（包括很多国产浏览器）：支持程度不一。填不上的话，用下面第 4 条的办法。</p>
      </div>

      <div class="group-title">3. 怎么用</div>
      <div class="note-box">
        <p><b>填充</b>：在登录页点账号或密码输入框，输入框下方（或键盘上方）会出现<b>用金匮填充</b>。点它，验证指纹，选一个账号，就填好了。</p>
        <p>在 app 里选过一次，金匮会记住这个 app 和这个账号的对应关系，下次排在最前面。网站按网址的域名自动匹配。</p>
        <p><b>保存</b>：登录了一个金匮里没有的账号，系统会问<b>保存到金匮？</b>，点保存，可以新建一条或更新已有条目的密码（安卓 9 起）。</p>
        <p>填充和保存的窗口每次都要重新验证，用完自动关掉，回到原来的 app。</p>
      </div>

      <div class="group-title">4. 填不上的时候</div>
      <div class="note-box">
        <p>部分银行、支付类 app 禁止自动填充；有的 app 输入框是自己画的，系统认不出来；华为的纯血鸿蒙不支持这套机制。</p>
        <p>这时打开金匮，在条目详情里点<b>复制密码并返回</b>：复制后自动回到原来的 app，粘贴即可，30 秒后剪贴板自动清空。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status .row svg.on { color: var(--ok); }
.stop { display: block; margin: 0 auto; }
.note-box b { font-weight: 700; }
</style>
