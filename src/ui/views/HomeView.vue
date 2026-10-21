<script setup lang="ts">
/** 首页：左侧目录、搜索、条目列表、同步状态 */
import Logo from '../components/Logo.vue'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import SyncBanner from '../components/SyncBanner.vue'
import FolderSheet from '../components/FolderSheet.vue'
import ItemAvatar from '../components/ItemAvatar.vue'
import { folderOf, liveFolders } from '../../core/folders'
import { app, enableBio, lock, syncNow, toast, usedAt, vault, wantIcons } from '../../store'
import { hostOf as siteHost } from '../../core/autofill'
import { prefs } from '../../prefs'
import { liveItems } from '../../core/vault'
import { SORT_MODES, isSortMode, searchItems, sortItems, type SortMode } from '../../core/search'
import { hostOf } from '../format'
import { showBadge } from '../../updateService'

defineOptions({ name: 'HomeView' })

const router = useRouter()
const q = ref('')
const all = computed(() => liveItems(vault.value))
const folders = computed(() => liveFolders(vault.value.folders))
/** 'all' 全部；'none' 未分类；其他是目录ID */
const sel = ref<string>('all')
const manage = ref(false)

/** 每条实际所在的目录（目录被删了算未分类） */
const placeOf = (it: (typeof all.value)[number]) => folderOf(vault.value.folders, it.folder)?.id ?? 'none'
const counts = computed(() => {
  const m = new Map<string, number>()
  for (const it of all.value) {
    const k = placeOf(it)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
})
const searching = computed(() => !!q.value.trim())

/** 这个目录的排序方式（每个目录各自记住，只在本机） */
const sortMode = computed<SortMode>(() => {
  const m = prefs.sortModes[sel.value]
  return isSortMode(m) ? m : 'name'
})
const sortLabel = computed(() => SORT_MODES.find((x) => x.mode === sortMode.value)!.label)
const sorting = ref(false)
function setSort(m: SortMode) {
  const next = { ...prefs.sortModes }
  if (m === 'name') delete next[sel.value]
  else next[sel.value] = m
  prefs.sortModes = next
  sorting.value = false
}

/** 搜索时查全部目录、按相关度排；不搜索时按选中的目录筛选、按这个目录的排序方式 */
const items = computed(() => {
  if (searching.value) return searchItems(all.value, q.value)
  const pool = sel.value === 'all' ? all.value : all.value.filter((it) => placeOf(it) === sel.value)
  return sortItems(pool, sortMode.value, usedAt.value)
})
/** 网站图标（设置里开启后才有）：列表里看得到的条目才去取 */
watch([items, () => prefs.siteIcons], ([list, on]) => {
  if (on) wantIcons(list.filter((it) => it.type !== 'note' && it.urls?.[0]).map((it) => siteHost(it.urls![0])))
}, { immediate: true })

const selName = computed(() => (sel.value === 'all' ? '全部' : sel.value === 'none' ? '未分类' : folders.value.find((f) => f.id === sel.value)?.name ?? '全部'))

// 选中的目录被删了（包括别的设备上删的）：回到全部
watch(folders, (fs) => {
  if (sel.value !== 'all' && sel.value !== 'none' && !fs.some((f) => f.id === sel.value)) sel.value = 'all'
  // 删掉的目录不用再记排序方式
  const gone = Object.keys(prefs.sortModes).filter((k) => vault.value.folders?.[k]?.deleted)
  if (gone.length) {
    const next = { ...prefs.sortModes }
    for (const k of gone) delete next[k]
    prefs.sortModes = next
  }
})

function addItem() {
  router.push(sel.value !== 'all' && sel.value !== 'none' && !searching.value ? `/edit?folder=${sel.value}` : '/edit')
}

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
      <div class="title"><Logo :size="30" /><h1>金匮</h1></div>
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
      <input v-model="q" type="search" placeholder="搜索全部目录" aria-label="搜索" enterkeyhint="search"
        autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button v-if="q" class="icon-btn sm" aria-label="清空" @click="q = ''"><Icon name="close" /></button>
    </div>

    <div class="body">
      <nav class="rail" aria-label="目录">
        <button class="dir" :class="{ on: sel === 'all' && !searching }" :aria-current="sel === 'all'" @click="sel = 'all'; q = ''">
          <span class="dn">全部</span><span class="dc">{{ all.length }}</span>
        </button>
        <button v-for="f in folders" :key="f.id" class="dir" :class="{ on: sel === f.id && !searching }" :aria-current="sel === f.id" @click="sel = f.id; q = ''">
          <span class="dn">{{ f.name }}</span><span class="dc">{{ counts.get(f.id) ?? 0 }}</span>
        </button>
        <button v-if="folders.length && counts.get('none')" class="dir" :class="{ on: sel === 'none' && !searching }" :aria-current="sel === 'none'" @click="sel = 'none'; q = ''">
          <span class="dn">未分类</span><span class="dc">{{ counts.get('none') }}</span>
        </button>
        <button class="dir manage" aria-label="管理目录" @click="manage = true">
          <Icon :name="folders.length ? 'pen' : 'plus'" /><span class="dn">{{ folders.length ? '管理' : '新建目录' }}</span>
        </button>
      </nav>

      <main class="main">
        <SyncBanner />
        <div v-if="prefs.autoLockSec >= 3600" class="note-box warn keep" role="status">
          <p><Icon name="unlock" class="ki" />保持解锁中：离开 {{ prefs.autoLockSec / 3600 }} 小时内回来不用解锁，拿到这台设备的人能看到全部密码。</p>
          <button class="text-btn accent" @click="prefs.autoLockSec = 0">改为离开即上锁</button>
          <button class="text-btn" @click="lock()">现在上锁</button>
        </div>
        <div v-if="all.length" class="scope-bar">
          <p class="scope faint small">{{ searching ? '在全部目录中搜索' : selName }}</p>
          <button v-if="!searching" class="sort-btn" :aria-label="`排序方式：${sortLabel}`" @click="sorting = true">
            <Icon name="sort" />{{ sortLabel }}
          </button>
        </div>

        <div v-if="!all.length" class="empty">
          <p>还没有保存任何密码。</p>
          <button class="solid-btn" @click="addItem"><Icon name="plus" />添加第一条</button>
          <p class="small">也可以在“设置 → 从 CSV 导入”里，把浏览器或其他密码管理器导出的文件导进来。</p>
        </div>
        <div v-else-if="!items.length" class="empty">{{ searching ? `没有找到“${q}”` : '这个目录是空的' }}</div>
        <ul v-else class="list">
          <li v-for="it in items" :key="it.id">
            <button class="entry" @click="router.push(`/item/${it.id}`)">
              <ItemAvatar :item="it" />
              <span class="text">
                <span class="t">{{ it.title || '未命名' }}</span>
                <span class="s mono">{{ subtitle(it) }}</span>
              </span>
              <Icon v-if="it.favorite" name="star" class="fav" />
            </button>
          </li>
        </ul>
        <p v-if="items.length" class="count faint small">共 {{ items.length }} 条</p>
      </main>
    </div>

    <button class="fab" aria-label="添加" @click="addItem"><Icon name="plus" /></button>
    <FolderSheet :open="manage" @close="manage = false" @created="(id) => (sel = id)" />

    <Sheet :open="sorting" :title="`“${selName}”的排序方式`" @close="sorting = false">
      <div class="group">
        <button v-for="m in SORT_MODES" :key="m.mode" class="row" :aria-pressed="sortMode === m.mode" @click="setSort(m.mode)">
          <span class="grow">{{ m.label }}<span class="sub">{{ m.hint }}</span></span>
          <Icon v-if="sortMode === m.mode" name="check" class="on" />
        </button>
      </div>
      <p class="muted small">每个目录各自记住，只影响这台设备。收藏的条目总在最前面。</p>
    </Sheet>

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

/* 左侧目录栏 + 右侧列表 */
.body { display: flex; align-items: flex-start; }
.rail {
  position: sticky;
  top: calc(56px + 54px + var(--safe-top));
  flex: none;
  display: flex;
  flex-direction: column;
  width: 92px;
  max-height: calc(100vh - 56px - 54px - var(--safe-top));
  overflow-y: auto;
  padding: 2px 0 96px 8px;
  scrollbar-width: none;
}
.rail::-webkit-scrollbar { display: none; }
.dir {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  min-height: 52px;
  padding: 8px 8px 8px 12px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--muted);
  text-align: left;
  position: relative;
}
.dir:active { background: var(--line); }
.dir.on { background: var(--surface); color: var(--ink); font-weight: 700; box-shadow: 0 1px 0 var(--line); }
.dir.on::before { content: ''; position: absolute; left: 3px; top: 14px; bottom: 14px; width: 3px; border-radius: 2px; background: var(--accent); }
.dn { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
.dc { color: var(--faint); font-size: 12px; font-weight: 400; }
.dir.manage { flex-direction: row; align-items: center; gap: 4px; min-height: 44px; margin-top: 6px; color: var(--accent); }
.dir.manage svg { flex: none; width: 16px; height: 16px; }
.dir.manage .dn { font-size: 13px; }
.main { flex: 1; min-width: 0; padding: 0 14px 0 8px; }
.keep { margin: 4px 0 8px; }
.keep p { margin: 0 0 2px; line-height: 1.6; }
.ki { width: 16px; height: 16px; margin-right: 4px; vertical-align: -3px; }
.scope-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.scope { margin: 2px 4px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sort-btn { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 4px 6px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font-size: 13px; }
.sort-btn:active { background: var(--line); }
.sort-btn svg { width: 15px; height: 15px; }
.row .on { color: var(--ok); }

.list { list-style: none; margin: 0; padding: 0; }
.entry {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 8px 4px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  text-align: left;
}
.entry:active { background: var(--line); }
.text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.t, .s { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t { font-size: 16px; font-weight: 700; }
.s { color: var(--muted); font-size: 13px; word-break: normal; }
.fav { flex: none; width: 18px; height: 18px; color: var(--accent); fill: currentColor; }
.count { margin: 14px 0 96px; text-align: center; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 48px 8px; }
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
