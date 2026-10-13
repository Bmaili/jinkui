<script setup lang="ts">
/** 首页：搜索、条目列表、同步状态 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import SyncBanner from '../components/SyncBanner.vue'
import { app, enableBio, lock, syncNow, toast, vault } from '../../store'
import { liveItems } from '../../core/vault'
import { initialOf, searchItems } from '../../core/search'
import { avatarColor, hostOf } from '../format'
import { showBadge } from '../../updateService'

defineOptions({ name: 'HomeView' })

const router = useRouter()
const q = ref('')
const all = computed(() => liveItems(vault.value))
const items = computed(() => searchItems(all.value, q.value))

const syncIcon = computed(() => {
  if (!app.backend) return 'cloud-off'
  if (app.sync.running) return 'cloud'
  if (app.sync.errorKind) return 'cloud-err'
  if (app.sync.pending) return 'cloud-up'
  return 'cloud-ok'
})
const syncLabel = computed(() => {
  if (!app.backend) return '未开启同步'
  if (app.sync.running) return '正在同步'
  if (app.sync.errorKind) return '同步出错'
  if (app.sync.pending) return '有修改未上传'
  return '已同步'
})

function subtitle(it: (typeof all.value)[number]) {
  if (it.type === 'note') return '笔记'
  return it.username || (it.urls?.[0] ? hostOf(it.urls[0]) : '')
}

async function onSyncTap() {
  if (!app.backend) return void router.push('/settings/sync')
  const ok = await syncNow()
  if (ok) toast('已同步')
}

async function turnOnBio() {
  app.offerBio = false
  try {
    await enableBio()
    toast('已开启指纹解锁')
  } catch (e) {
    if ((e as { code?: string }).code !== 'CANCELLED') toast((e as Error).message)
  }
}
</script>

<template>
  <div class="home">
    <header class="topbar">
      <div class="title"><span class="seal">匮</span><h1>金匮</h1></div>
      <button class="icon-btn" :class="{ spin: app.sync.running }" :aria-label="syncLabel" :title="syncLabel" @click="onSyncTap">
        <Icon :name="syncIcon" />
      </button>
      <button class="icon-btn" aria-label="上锁" @click="lock()"><Icon name="lock" /></button>
      <button class="icon-btn badge-wrap" aria-label="设置" @click="router.push('/settings')">
        <Icon name="settings" /><span v-if="showBadge" class="badge" />
      </button>
    </header>

    <div class="search">
      <Icon name="search" />
      <input v-model="q" type="search" placeholder="搜索标题、用户名、网址、备注" aria-label="搜索" enterkeyhint="search"
        autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button v-if="q" class="icon-btn sm" aria-label="清空" @click="q = ''"><Icon name="close" /></button>
    </div>

    <div class="page">
      <SyncBanner />

      <div v-if="!all.length" class="empty">
        <p>还没有保存任何密码。</p>
        <button class="solid-btn" @click="router.push('/edit')"><Icon name="plus" />添加第一条</button>
        <p class="small">也可以在“设置 → 从 CSV 导入”里，把浏览器或其他密码管理器导出的文件导进来。</p>
      </div>
      <div v-else-if="!items.length" class="empty">没有找到“{{ q }}”</div>
      <ul v-else class="list">
        <li v-for="it in items" :key="it.id">
          <button class="entry" @click="router.push(`/item/${it.id}`)">
            <span class="avatar" :style="{ background: avatarColor(it.title) }">
              <Icon v-if="it.type === 'note'" name="note" />
              <template v-else>{{ initialOf(it.title) }}</template>
            </span>
            <span class="text">
              <span class="t">{{ it.title || '未命名' }}</span>
              <span class="s mono">{{ subtitle(it) }}</span>
            </span>
            <Icon v-if="it.favorite" name="star" class="fav" />
          </button>
        </li>
      </ul>
      <p v-if="all.length" class="count faint small">共 {{ all.length }} 条</p>
    </div>

    <button class="fab" aria-label="添加" @click="router.push('/edit')"><Icon name="plus" /></button>

    <Sheet :open="app.offerBio" title="开启指纹解锁？" done="以后再说" @close="app.offerBio = false">
      <p class="muted">以后打开金匮只要按一下指纹。指纹由系统的安全芯片校验，金匮接触不到指纹数据。</p>
      <p class="muted small">换了指纹或关掉锁屏密码后，指纹解锁会自动失效，用主密码解锁后重新开启即可。</p>
      <button class="solid-btn block" @click="turnOnBio"><Icon name="fingerprint" />开启</button>
    </Sheet>
  </div>
</template>

<style scoped>
.title { display: flex; align-items: center; flex: 1; gap: 10px; padding-left: 10px; min-width: 0; }
.title h1 { flex: none; margin: 0; letter-spacing: 0.2em; }
.spin :deep(svg) { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.badge-wrap { position: relative; }
.badge { position: absolute; top: 9px; right: 9px; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }

.search {
  position: sticky;
  top: calc(56px + var(--safe-top));
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 16px 8px;
  padding: 0 4px 0 14px;
  min-height: 46px;
  border: 1.5px solid var(--line);
  border-radius: 23px;
  background: var(--surface);
}
.search:focus-within { border-color: var(--accent); }
.search > svg { flex: none; width: 20px; height: 20px; color: var(--faint); }
.search input { flex: 1; min-width: 0; height: 42px; border: 0; background: transparent; outline: none; }
.search input::-webkit-search-cancel-button { display: none; }

.list { list-style: none; margin: 0; padding: 0; }
.entry {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 66px;
  padding: 8px 6px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  text-align: left;
}
.entry:active { background: var(--line); }
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  color: #fbf8f1;
  font-size: 18px;
  font-weight: 700;
}
.avatar svg { width: 22px; height: 22px; }
.text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.t, .s { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t { font-size: 16px; font-weight: 700; }
.s { color: var(--muted); font-size: 13px; word-break: normal; }
.fav { flex: none; width: 18px; height: 18px; color: var(--accent); fill: currentColor; }
.count { margin: 14px 0 80px; text-align: center; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.empty p { margin: 0; }

.fab {
  position: fixed;
  right: 20px;
  bottom: calc(24px + var(--safe-bottom));
  z-index: 15;
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border: 0;
  border-radius: 18px;
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: 0 10px 24px -10px rgba(60, 40, 10, 0.6);
  transition: transform 0.18s var(--spring);
}
.fab:active { transform: scale(0.92); }
.fab svg { width: 28px; height: 28px; }
</style>
