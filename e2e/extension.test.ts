/**
 * 端到端：在真的 Chromium 里装上电脑端扩展（extension/dist，先 node extension/build.mjs），
 * 用手机生成的加入码加入模拟 GitHub 上的保险库，然后在一个本地登录页上填充、登录后保存，再同步回云端。
 * 截图在 e2e/out/ext-*.png。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { startGitHubMock, type GitHubMock } from '../tests/mocks/githubServer'
import { GitHubStore } from '../src/core/sync/github'
import { VaultCipher, createKeys } from '../src/core/crypto'
import { initRemote, makeJoinCode } from '../src/core/sync/setup'
import { SyncEngine, type SyncState } from '../src/core/sync/engine'
import { createItem, emptyVault, mergeVaults, type VaultState } from '../src/core/vault'

const OUT = 'e2e/out'
const DIST = resolve('extension/dist')
const ID = 'majdcmhhlcckemgcnpoaopamfifcnnko'
const PASS = 'correct-horse-battery'
const WF = 10

let gh: GitHubMock
let site: { port: number; close: () => Promise<void> }
let ctx: BrowserContext
let pop: Page
let code: string
let phone: { state: VaultState; sync: () => Promise<unknown> }

/** 一个有登录表单的本地网站；里面嵌了一个别的网站（localhost）的框架，也有密码框 */
async function startSite() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x')
    const page = (body: string) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">${body}</body>`)
    if (u.pathname === '/login') {
      return page(`<h2>示例网站登录</h2>
        <form action="/welcome" method="post">
          <p><input name="email" type="email" placeholder="邮箱"></p>
          <p><input name="pw" type="password" placeholder="密码"></p>
          <p><button type="submit">登录</button></p>
        </form>
        <iframe src="http://localhost:${port}/evil" style="width:300px;height:80px"></iframe>`)
    }
    if (u.pathname === '/evil') return page('<input id="evil-pw" type="password" placeholder="别的网站的密码框">')
    if (u.pathname === '/welcome') return page('<h2>欢迎回来</h2>')
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/ext-${name}.png` })

const run = existsSync(resolve(DIST, 'manifest.json')) ? describe : describe.skip

run('电脑端扩展', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    gh = await startGitHubMock({ owner: 'me', repo: 'jinkui-data', token: 'github_pat_test' })
    site = await startSite()
    const backend = { type: 'github', github: { owner: 'me', repo: 'jinkui-data', token: 'github_pat_test', branch: 'main', prefix: '', apiBase: `http://127.0.0.1:${gh.port}` } }
    const remote = new GitHubStore(backend.github)
    const keys = await createKeys(PASS, WF)
    await initRemote(remote, keys)
    // “手机”：建了保险库，有一条示例网站的账号
    let state = createItem(emptyVault(), { type: 'login', title: '示例网站', username: 'me@example.com', password: 'old-pass-1', urls: [`http://127.0.0.1:${site.port}/login`] }, { device: 'phone' }).state
    state = createItem(state, { type: 'login', title: 'GitHub', username: 'me', password: 'gh-pass', urls: ['https://github.com'] }, { device: 'phone' }).state
    let ss: SyncState | null = null
    const engine = new SyncEngine({
      device: { id: 'phone', name: '手机' },
      cipher: new VaultCipher(keys),
      current: () => state,
      merge: async (v) => void (state = mergeVaults(state, v)),
      loadSyncState: async () => ss,
      saveSyncState: async (_id, s) => void (ss = s),
    })
    phone = { get state() { return state }, sync: () => engine.sync(remote) }
    await phone.sync()
    code = await makeJoinCode(backend, PASS, WF)

    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 380, height: 600 },
      locale: 'zh-CN',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    })
    pop = await ctx.newPage()
    pop.on('pageerror', (e) => console.error('弹窗错误', e.message))
  })

  afterAll(async () => {
    await ctx?.close()
    await site?.close()
    await gh?.close()
  })

  const send = <T = unknown>(m: unknown) => pop.evaluate((x) => chrome.runtime.sendMessage(x), m) as Promise<T>
  async function loginTab(): Promise<{ page: Page; tabId: number }> {
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${site.port}/login`)
    const tabs = await pop.evaluate(() => chrome.tabs.query({}))
    const t = (tabs as { id: number; url: string }[]).find((x) => x.url?.includes('/login'))!
    return { page, tabId: t.id }
  }

  it('用加入码加入，拉到手机上的条目', async () => {
    await pop.goto(`chrome-extension://${ID}/popup.html`)
    await pop.waitForSelector('text=加入保险库')
    await shot(pop, 'join')
    await pop.fill('[aria-label="加入码"]', code)
    await pop.fill('[aria-label="主密码"]', PASS)
    await pop.click('button:has-text("加入保险库")')
    await pop.waitForSelector('.entry:has-text("示例网站")', { timeout: 60000 })
    await pop.waitForFunction(() => document.querySelector('.foot')?.textContent?.includes('上次同步'), null, { timeout: 30000 })
    await shot(pop, 'list')
    // 扩展作为一台新设备上传了自己的文件
    expect([...gh.files.keys()].filter((p) => p.startsWith('devices/'))).toHaveLength(2)
    // 本地存的都是密文
    const dump = JSON.stringify(await pop.evaluate(() => chrome.storage.local.get(null)))
    expect(dump).not.toContain('old-pass-1')
    expect(dump).not.toContain('AGE-SECRET-KEY')
  })

  it('详情、生成器、设置（亮色、暗色）', async () => {
    await pop.click('.entry .plain:has-text("GitHub")')
    await pop.waitForSelector('h1:has-text("GitHub")')
    await pop.click('[aria-label="显示"]')
    await pop.waitForSelector('text=gh-pass')
    await shot(pop, 'item')
    await pop.click('[aria-label="返回"]')
    await pop.click('[aria-label="生成密码"]')
    await pop.waitForSelector('text=换一个')
    await shot(pop, 'gen')
    await pop.click('[aria-label="返回"]')
    await pop.click('[aria-label="设置"]')
    await pop.waitForSelector('text=自动上锁')
    await shot(pop, 'settings')
    await pop.emulateMedia({ colorScheme: 'dark' })
    await shot(pop, 'settings-dark')
    await pop.click('[aria-label="返回"]')
    await shot(pop, 'list-dark')
    await pop.emulateMedia({ colorScheme: 'light' })
  })

  it('填充：只填进同一个网站的框，嵌在里面的别的网站拿不到', async () => {
    const { page, tabId } = await loginTab()
    const items = (await send<{ items: { id: string; title: string }[] }>({ t: 'items' })).items
    const id = items.find((i) => i.title === '示例网站')!.id
    const r = await send({ t: 'fill', tabId, url: page.url(), id })
    expect(r).toEqual({})
    expect(await page.inputValue('input[name=email]')).toBe('me@example.com')
    expect(await page.inputValue('input[name=pw]')).toBe('old-pass-1')
    expect(await page.frameLocator('iframe').locator('#evil-pw').inputValue()).toBe('')
    // 网页已经跳走了：不填
    const r2 = await send<{ error?: string }>({ t: 'fill', tabId, url: 'https://github.com/login', id })
    expect(r2.error).toMatch(/网页已经变了/)
    await page.close()
  })

  it('登录后提示保存：改了密码就更新那一条，旧密码进历史，同步回云端', async () => {
    const { page, tabId } = await loginTab()
    await page.fill('input[name=email]', 'me@example.com')
    await page.fill('input[name=pw]', 'new-pass-2')
    await page.click('button:has-text("登录")')
    await page.waitForSelector('text=欢迎回来')
    // 跳转后的页面上出现提示条（在 Shadow DOM 里）
    await page.waitForSelector('[data-jinkui]', { state: 'attached', timeout: 15000 })
    await page.setViewportSize({ width: 900, height: 360 })
    await shot(page, 'save-bar')
    const st = await send<{ pending: { updateTitle?: string } | null }>({ t: 'state', tabId, url: page.url() })
    expect(st.pending?.updateTitle).toBe('示例网站')
    // 待保存的密码只留在后台：弹窗拿到的信息里也没有
    expect(JSON.stringify(st.pending)).not.toContain('new-pass-2')
    await send({ t: 'savePending', tabId, mode: 'update' })
    const items = (await send<{ items: { title: string; password: string; history?: { password: string }[] }[] }>({ t: 'items' })).items
    const it = items.find((i) => i.title === '示例网站')!
    expect(it.password).toBe('new-pass-2')
    expect(it.history?.[0].password).toBe('old-pass-1')
    expect(await send({ t: 'sync' })).toEqual({ ok: true })
    await phone.sync()
    expect(Object.values(phone.state.items).find((i) => i.title === '示例网站')?.password).toBe('new-pass-2')
    await page.close()
  })

  it('复制：借 offscreen 页面写剪贴板，不报错', async () => {
    expect(await send({ t: 'copy', text: 'copied-secret', secret: true })).toEqual({})
    expect(await send({ t: 'copy', text: 'me', secret: false })).toEqual({})
  })

  it('上锁后要主密码；解开后条目还在', async () => {
    await pop.goto(`chrome-extension://${ID}/popup.html`)
    await pop.waitForSelector('.entry')
    await pop.click('[aria-label="上锁"]')
    await pop.waitForSelector('text=已上锁')
    await shot(pop, 'locked')
    await pop.emulateMedia({ colorScheme: 'dark' })
    await shot(pop, 'locked-dark')
    await pop.emulateMedia({ colorScheme: 'light' })
    // 上锁后后台不给条目
    expect((await send<{ items: unknown[] }>({ t: 'items' })).items).toEqual([])
    await pop.fill('[aria-label="主密码"]', 'wrong-password-1')
    await pop.click('button:has-text("解锁")')
    await pop.waitForSelector('text=主密码不对')
    await pop.fill('[aria-label="主密码"]', PASS)
    await pop.click('button:has-text("解锁")')
    await pop.waitForSelector('.entry:has-text("示例网站")', { timeout: 30000 })
  })
})
