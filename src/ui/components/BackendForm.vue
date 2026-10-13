<script setup lang="ts">
import { ref } from 'vue'
import type { Draft } from '../backendDraft'

const d = defineModel<Draft>({ required: true })
const advanced = ref(false)
const showSecret = ref(false)
</script>

<template>
  <div class="backend">
    <div class="tabs" role="tablist">
      <button type="button" class="chip" :class="{ on: d.type === 'github' }" role="tab" :aria-selected="d.type === 'github'" @click="d.type = 'github'">GitHub 私有仓库</button>
      <button type="button" class="chip" :class="{ on: d.type === 'oss' }" role="tab" :aria-selected="d.type === 'oss'" @click="d.type = 'oss'">阿里云 OSS</button>
    </div>

    <template v-if="d.type === 'github'">
      <label class="lbl" for="gh-repo">仓库</label>
      <input id="gh-repo" v-model="d.repo" class="field mono" placeholder="用户名/仓库名，例如 yourname/jinkui-data"
        autocapitalize="off" autocomplete="off" spellcheck="false" />
      <label class="lbl" for="gh-token">Token</label>
      <div class="pw">
        <input id="gh-token" v-model="d.token" class="field mono" :type="showSecret ? 'text' : 'password'" placeholder="github_pat_…"
          autocapitalize="off" autocomplete="off" spellcheck="false" />
        <button type="button" class="icon-btn sm" :aria-label="showSecret ? '隐藏' : '显示'" @click="showSecret = !showSecret">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path :d="showSecret ? 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM4 4l16 16' : 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'" /></svg>
        </button>
      </div>
      <details class="help">
        <summary>怎么生成 Token？</summary>
        <ol>
          <li>电脑或手机浏览器打开 github.com → 右上角头像 → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token。</li>
          <li>Expiration 选 No expiration（或一年，到期前记得换）。</li>
          <li>Repository access 选 <b>Only select repositories</b>，只勾保存数据的那个<b>私有</b>仓库。</li>
          <li>Permissions → Repository permissions → <b>Contents</b> 选 Read and write，其他都不用开。</li>
          <li>生成后复制 github_pat_ 开头的那串，粘贴到上面。</li>
        </ol>
        <p>数据仓库必须是私有的，不要用放代码的仓库。</p>
      </details>
    </template>

    <template v-else>
      <label class="lbl" for="oss-ep">Endpoint</label>
      <input id="oss-ep" v-model="d.endpoint" class="field mono" placeholder="oss-cn-hangzhou.aliyuncs.com" autocapitalize="off" spellcheck="false" />
      <label class="lbl" for="oss-bucket">Bucket</label>
      <input id="oss-bucket" v-model="d.bucket" class="field mono" autocapitalize="off" spellcheck="false" />
      <label class="lbl" for="oss-id">AccessKey ID</label>
      <input id="oss-id" v-model="d.akId" class="field mono" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <label class="lbl" for="oss-secret">AccessKey Secret</label>
      <input id="oss-secret" v-model="d.akSecret" class="field mono" type="password" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <details class="help">
        <summary>注意事项</summary>
        <ul>
          <li>用 RAM 子账号的 AccessKey，只授予这个 Bucket（最好只授予下面的路径前缀）的读写权限。</li>
          <li>Bucket 设为私有。</li>
          <li>开了版本控制的 Bucket 会保留每次上传的旧文件（都是加密的）。</li>
        </ul>
      </details>
    </template>

    <button type="button" class="text-btn adv" @click="advanced = !advanced">{{ advanced ? '收起' : '更多设置' }}</button>
    <template v-if="advanced">
      <template v-if="d.type === 'github'">
        <label class="lbl" for="gh-branch">分支</label>
        <input id="gh-branch" v-model="d.branch" class="field mono" placeholder="main" autocapitalize="off" spellcheck="false" />
        <label class="lbl" for="gh-prefix">仓库里的目录（可不填）</label>
        <input id="gh-prefix" v-model="d.ghPrefix" class="field mono" placeholder="放在根目录" autocapitalize="off" spellcheck="false" />
        <label class="lbl" for="gh-api">API 地址（可不填）</label>
        <input id="gh-api" v-model="d.apiBase" class="field mono" placeholder="https://api.github.com" autocapitalize="off" spellcheck="false" />
      </template>
      <template v-else>
        <label class="lbl" for="oss-prefix">路径前缀</label>
        <input id="oss-prefix" v-model="d.ossPrefix" class="field mono" placeholder="jinkui/" autocapitalize="off" spellcheck="false" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.pw { position: relative; }
.pw .field { padding-right: 48px; }
.pw .icon-btn { position: absolute; right: 4px; top: 5px; }
.help { margin: 10px 2px 0; color: var(--muted); font-size: 14px; line-height: 1.65; }
.help summary { color: var(--accent); cursor: pointer; }
.help ol, .help ul { padding-left: 1.3em; margin: 8px 0; }
.help p { margin: 6px 0 0; }
.adv { margin-top: 8px; padding: 0 4px; color: var(--muted); font-weight: 600; }
</style>
