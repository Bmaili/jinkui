/**
 * 端到端：两台“手机”（两个独立的浏览器上下文）通过模拟的 GitHub 同步。
 * 截图在 e2e/out/，亮色和暗色各一份。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startGitHubMock, type GitHubMock } from '../tests/mocks/githubServer'
import { serveDist } from './serve'

const OUT = 'e2e/out'
const PASS = 'correct-horse-battery'
let browser: Browser
let gh: GitHubMock
let site: { url: string; close: () => Promise<void> }

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  gh = await startGitHubMock({ owner: 'me', repo: 'jinkui-data', token: 'github_pat_test' })
  site = await serveDist()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  await site?.close()
  await gh?.close()
})

async function phone(scheme: 'light' | 'dark' = 'light'): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: scheme, reducedMotion: 'reduce', locale: 'zh-CN',
  })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('页面错误', e.message))
  await page.goto(site.url)
  await page.waitForSelector('.shell')
  return { ctx, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` })

async function fillBackend(page: Page) {
  await page.fill('#gh-repo', 'me/jinkui-data')
  await page.fill('#gh-token', 'github_pat_test')
  await page.click('text=更多设置')
  await page.fill('#gh-api', `http://127.0.0.1:${gh.port}`)
}

async function waitSynced(page: Page) {
  await page.waitForFunction(() => document.querySelector('[aria-label="已同步"]'), null, { timeout: 30000 })
}

describe('金匮', () => {
  let a: Page
  let b: Page
  afterEach(async (c) => {
    if (c.task.result?.state !== 'fail') return
    await a?.screenshot({ path: `${OUT}/FAIL-a-${c.task.name.slice(0, 6)}.png` }).catch(() => {})
    await b?.screenshot({ path: `${OUT}/FAIL-b-${c.task.name.slice(0, 6)}.png` }).catch(() => {})
  })

  it('A 新建保险库并同步到 GitHub', async () => {
    ;({ page: a } = await phone())
    await shot(a, 'welcome')
    await a.click('text=新建保险库')
    await fillBackend(a)
    await shot(a, 'setup-backend')
    await a.click('text=下一步')
    await a.waitForSelector('#mp1')
    await a.fill('#mp1', PASS)
    await a.fill('#mp2', PASS)
    await shot(a, 'setup-password')
    await a.click('text=创建保险库')
    await a.waitForSelector('.search', { timeout: 60000 })
    await waitSynced(a)
    expect([...gh.files.keys()].sort()).toEqual(expect.arrayContaining(['README.md', 'keys/identity.age', 'keys/info.json']))
    expect([...gh.files.keys()].some((p) => p.startsWith('devices/'))).toBe(true)
    await shot(a, 'home-empty')
  })

  it('A 添加条目（用生成器）', async () => {
    await a.click('[aria-label="添加"]')
    await a.fill('#e-title', 'GitHub')
    await a.fill('#e-user', 'octocat')
    await a.click('text=生成密码')
    await a.waitForSelector('text=使用这个密码')
    await shot(a, 'generator')
    await a.click('text=使用这个密码')
    await a.fill('[aria-label="网址 1"]', 'https://github.com/login')
    await shot(a, 'edit')
    await a.click('.save')
    await a.waitForSelector('text=历史版本')
    await shot(a, 'item')
    for (const t of ['招商银行', '家里 Wi-Fi', 'Apple ID', '淘宝']) {
      await a.goto(`${site.url}#/edit`)
      await a.fill('#e-title', t)
      if (t === '家里 Wi-Fi') {
        await a.click('.types >> text=笔记')
        await a.fill('#e-notes', '名称 HOME-5G\n密码 12345678')
      } else {
        await a.fill('#e-user', `me@${t.length}.com`)
        await a.fill('#e-pw', 'pw-' + t)
      }
      await a.click('.save')
      await a.waitForSelector('text=历史版本')
    }
    await a.goto(`${site.url}#/`)
    await a.waitForSelector('.entry')
    expect(await a.locator('.entry').count()).toBe(5)
    await waitSynced(a)
    await shot(a, 'home')
  })

  it('B 用主密码加入，拉到 A 的条目', async () => {
    ;({ page: b } = await phone('dark'))
    await b.click('text=加入已有保险库')
    await fillBackend(b)
    await b.click('text=下一步')
    await b.waitForSelector('#mpj')
    await b.fill('#mpj', 'wrong-password-1')
    await b.click('.actions .solid-btn')
    await b.waitForSelector('text=主密码不对', { timeout: 30000 })
    await b.fill('#mpj', PASS)
    await b.click('.actions .solid-btn')
    await b.waitForSelector('.entry', { timeout: 60000 })
    expect(await b.locator('.entry').count()).toBe(5)
    await shot(b, 'home-dark')
  })

  it('B 改了密码，A 回到前台后拉到最新；历史里有旧密码', async () => {
    await b.click('.entry >> text=GitHub')
    await b.click('[aria-label="编辑"]')
    await b.fill('#e-pw', 'changed-on-B')
    await b.click('.save')
    await b.waitForSelector('text=历史版本')
    await waitSyncedAfterEdit(b)

    // 模拟 A 回到桌面再打开：离开就上锁，回来要先解锁；解锁后同步拉到 B 的修改
    await a.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await a.waitForSelector('text=已上锁')
    await a.fill('[aria-label="主密码"]', PASS)
    await a.click('button:has-text("解锁")')
    await a.waitForSelector('.entry', { timeout: 30000 })
    await a.click('.entry >> text=GitHub')
    await a.click('[aria-label="显示密码"]')
    await a.waitForSelector('text=changed-on-B', { timeout: 30000 })
    await shot(a, 'item-synced')
    await a.click('text=历史版本')
    await a.waitForSelector('text=当前')
    await a.locator('.ver .row').nth(0).click()
    await shot(a, 'history')
    await a.goto(`${site.url}#/`)
  })

  it('上锁后用主密码解锁', async () => {
    await a.click('[aria-label="上锁"]')
    await a.waitForSelector('text=已上锁')
    await shot(a, 'lock')
    await a.fill('[aria-label="主密码"]', 'not-it-at-all')
    await a.click('button:has-text("解锁")')
    await a.waitForSelector('text=主密码不对', { timeout: 30000 })
    await a.fill('[aria-label="主密码"]', PASS)
    await a.click('button:has-text("解锁")')
    await a.waitForSelector('.entry', { timeout: 30000 })
    expect(await a.locator('.entry').count()).toBe(5)
  })

  it('目录：新建、把条目放进去、按目录筛选；B 同步后也有', async () => {
    await a.click('[aria-label="管理目录"]')
    await a.fill('[aria-label="新目录的名字"]', '工作')
    await a.click('.add .solid-btn')
    await a.fill('[aria-label="新目录的名字"]', '生活')
    await a.click('.add .solid-btn')
    await a.waitForSelector('.sheet >> text=生活')
    await shot(a, 'folders-manage')
    await a.click('.sheet .head .text-btn')
    // 刚建好的“生活”是选中的，里面还是空的
    await a.waitForSelector('text=这个目录是空的')
    await a.click('.rail >> text=全部')
    for (const [title, dir] of [['GitHub', '工作'], ['招商银行', '生活'], ['淘宝', '生活']]) {
      await a.click(`.entry >> text=${title}`)
      await a.click('[aria-label="编辑"]')
      await a.click(`.folders >> text=${dir}`)
      await a.click('.save')
      await a.waitForSelector('text=历史版本')
      await a.goBack()
      await a.waitForSelector('.rail')
    }
    await a.click('.rail >> text=生活')
    expect(await a.locator('.entry').count()).toBe(2)
    await a.click('.rail >> text=未分类')
    expect(await a.locator('.entry').count()).toBe(2)
    // 在目录里点“添加”：新条目默认放进这个目录
    await a.click('.rail >> text=工作')
    await a.click('[aria-label="添加"]')
    await a.fill('#e-title', '公司邮箱')
    await a.waitForSelector('.folders .chip.on >> text=工作')
    await a.click('.save')
    await a.waitForSelector('text=历史版本')
    await a.goBack()
    await a.waitForSelector('.rail')
    expect(await a.locator('.entry').count()).toBe(2)
    await shot(a, 'home-folders')
    // 搜索查全部目录
    await a.fill('[aria-label="搜索"]', '淘宝')
    expect(await a.locator('.entry').count()).toBe(1)
    await a.fill('[aria-label="搜索"]', '')
    await a.click('.rail >> text=全部')
    await waitSynced(a)

    await b.goto(`${site.url}#/settings/sync`)
    await b.click('text=立即同步')
    await b.goto(`${site.url}#/`)
    await b.waitForSelector('.rail >> text=生活', { timeout: 30000 })
    await b.click('.rail >> text=生活')
    expect(await b.locator('.entry').count()).toBe(2)
    await shot(b, 'home-folders-dark')
    await b.click('.rail >> text=全部')
  })

  it('搜索、删除、恢复；设置页和同步页', async () => {
    await a.fill('[aria-label="搜索"]', 'wi-fi')
    expect(await a.locator('.entry').count()).toBe(1)
    await a.fill('[aria-label="搜索"]', '')
    await a.click('.entry >> text=淘宝')
    await a.click('button.del')
    await a.click('.dlg .btns >> text=删除')
    await a.waitForSelector('.search')
    expect(await a.locator('.entry').count()).toBe(5)
    await a.click('[aria-label="设置"]')
    await a.waitForSelector('text=同步与设备')
    await shot(a, 'settings')
    await a.click('text=最近删除')
    await a.click('text=恢复')
    await a.goBack()
    await a.click('text=同步与设备')
    await a.waitForSelector('text=立即同步')
    await a.click('text=立即同步')
    await a.waitForSelector('text=（本机）')
    await a.waitForFunction(() => document.body.innerText.includes('上次上传'))
    await shot(a, 'sync')
  })

  it('B 同步后，两台设备的设备列表都有对方', async () => {
    await b.goto(`${site.url}#/settings/sync`)
    await b.click('text=立即同步')
    await b.waitForFunction(() => document.querySelectorAll('.row .text-btn.danger').length >= 1, null, { timeout: 30000 })
    await shot(b, 'sync-dark')
    await b.goto(`${site.url}#/`)
    await b.waitForSelector('.entry')
    expect(await b.locator('.entry').count()).toBe(6)
  })

  // ---------- 自动填充（原生插件用 window.__autofillMock 模拟） ----------

  /** 在 A 的浏览器环境里打开一个“自动填充窗口”：和 A 共用本地数据，就像同一台手机上的 AutofillActivity */
  async function autofillWindow(req: Record<string, unknown>): Promise<Page> {
    const p = await a.context().newPage()
    p.on('pageerror', (e) => console.error('自动填充窗口错误', e.message))
    await p.addInitScript((r) => {
      const w = window as unknown as Record<string, unknown>
      w.__autofillMock = {
        status: async () => ({ supported: true, enabled: false }),
        openSettings: async () => ({ opened: false }),
        disable: async () => {},
        getRequest: async () => r,
        fill: async (o: unknown) => void (w.__afResult = { kind: 'fill', ...(o as object) }),
        close: async () => void (w.__afResult = { kind: 'close' }),
      }
    }, req)
    await p.goto(site.url)
    await p.waitForSelector('.af')
    return p
  }
  const result = (p: Page) => p.waitForFunction(() => (window as unknown as { __afResult?: unknown }).__afResult).then((h) => h.jsonValue())

  async function unlockIn(p: Page) {
    await p.waitForSelector('text=已上锁')
    await p.fill('[aria-label="主密码"]', PASS)
    await p.click('button:has-text("解锁")')
    await p.waitForSelector('.page .target, .save', { timeout: 30000 })
  }

  it('自动填充：网页按域名推荐；app 里选过一次就记住，下次排在推荐里', async () => {
    // 网页：github.com 的登录页
    let p = await autofillWindow({ mode: 'fill', packageName: 'com.android.chrome', appLabel: 'Chrome', webDomain: 'github.com', hasUsername: true, hasPassword: true })
    await shot(p, 'autofill-lock')
    await unlockIn(p)
    await p.waitForSelector('.group-title:text-is("推荐")')
    await shot(p, 'autofill-pick')
    await p.click('.entry >> text=GitHub')
    expect(await result(p)).toEqual({ kind: 'fill', username: 'octocat', password: 'changed-on-B' })
    await p.close()

    // app：淘宝。第一次没有推荐，搜索后选，默认记住
    p = await autofillWindow({ mode: 'fill', packageName: 'com.taobao.taobao', appLabel: '淘宝', hasUsername: true, hasPassword: true })
    await unlockIn(p)
    expect(await p.locator('.group-title:text-is("推荐")').count()).toBe(0)
    await p.fill('[aria-label="搜索"]', '淘宝')
    await p.click('.entry >> text=淘宝')
    expect(await result(p)).toEqual({ kind: 'fill', username: 'me@2.com', password: 'pw-淘宝' })
    await p.close()

    p = await autofillWindow({ mode: 'fill', packageName: 'com.taobao.taobao', appLabel: '淘宝', hasUsername: true, hasPassword: true })
    await unlockIn(p)
    await p.waitForSelector('.group-title:text-is("推荐")')
    expect(await p.locator('.list').first().locator('.entry').count()).toBe(1)
    expect(await p.locator('.list').first().textContent()).toContain('淘宝')
    // 只有密码框时只填密码
    await p.close()
    p = await autofillWindow({ mode: 'fill', packageName: 'com.taobao.taobao', appLabel: '淘宝', hasUsername: false, hasPassword: true })
    await unlockIn(p)
    await p.click('.list >> nth=0 >> .entry')
    expect(await result(p)).toEqual({ kind: 'fill', password: 'pw-淘宝' })
    await p.close()
  })

  it('自动填充：登录后保存新账号；再次保存同样的账号时提示已保存', async () => {
    const req = { mode: 'save', packageName: 'com.android.chrome', appLabel: 'Chrome', webDomain: 'accounts.example.com', hasUsername: true, hasPassword: true, username: 'new@ex.com', password: 'Sav3d-Pass!' }
    let p = await autofillWindow(req)
    await unlockIn(p)
    await p.waitForSelector('#af-title')
    expect(await p.inputValue('#af-title')).toBe('example.com')
    await shot(p, 'autofill-save')
    await p.click('.submit')
    expect(await result(p)).toEqual({ kind: 'close' })
    await p.close()

    p = await autofillWindow(req)
    await unlockIn(p)
    await p.waitForSelector('text=已经保存在')
    await p.close()

    // 主界面回到前台后看得到新条目
    await a.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await a.waitForSelector('text=已上锁')
    await a.fill('[aria-label="主密码"]', PASS)
    await a.click('button:has-text("解锁")')
    // 解锁后回到离开前的页面（同步与设备），再回首页看条目
    await a.waitForSelector('.shell[data-phase="unlocked"]', { timeout: 30000 })
    await a.goto(`${site.url}#/`)
    await a.waitForSelector('.entry', { timeout: 30000 })
    await a.click('.rail >> text=全部')
    await a.waitForSelector('.entry >> text=example.com')
    await a.click('.entry >> text=淘宝')
    await a.waitForSelector('text=com.taobao.taobao')
    await shot(a, 'item-apps')
    await a.goto(`${site.url}#/settings/autofill`)
    await a.waitForSelector('text=怎么用')
    await shot(a, 'autofill-guide')
  })
})

async function waitSyncedAfterEdit(page: Page) {
  await page.goto(page.url().replace(/#.*$/, '#/'))
  await waitSynced(page)
}
