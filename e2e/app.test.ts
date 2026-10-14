/**
 * 端到端：两台“手机”（两个独立的浏览器上下文）通过模拟的 GitHub 同步。
 * 截图在 e2e/out/，亮色和暗色各一份。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
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

  // ---------- 离开即上锁（1.0.4 修复） ----------

  async function away(p: Page) {
    await p.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  async function back(p: Page) {
    await p.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  it('选过文件之后，下一次离开照样上锁（1.0.3 会一直不锁）', async () => {
    await a.goto(`${site.url}#/settings`)
    await a.waitForSelector('text=从 CSV 导入')
    const chooser = a.waitForEvent('filechooser')
    await a.click('text=从 CSV 导入')
    await chooser // 打开了系统的选文件界面，用户什么都没选就回来了
    await away(a)
    await back(a)
    // 从选文件界面回来：不上锁
    expect(await a.locator('text=已上锁').count()).toBe(0)
    // 再离开一次：要上锁
    await away(a)
    await back(a)
    await a.waitForSelector('text=已上锁')
    await a.fill('[aria-label="主密码"]', PASS)
    await a.click('button:has-text("解锁")')
    await a.waitForSelector('.shell[data-phase="unlocked"]', { timeout: 30000 })
  })

  it('指纹：在后台上锁时不弹指纹框，回到前台才弹；指纹框引起的切后台不会又锁上', async () => {
    // 同一台“手机”上再开一个主界面，装上假的指纹插件（解锁时模拟部分手机“弹指纹框会切到后台”）
    const p = await a.context().newPage()
    await p.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      w.__bioUnlockCalls = 0
      w.__vaultKeyMock = {
        status: async () => ({ available: true, reason: 'ok' }),
        enroll: async (o: { secret: string }) => ({ data: btoa(o.secret) }),
        unlock: async (o: { data: string }) => {
          w.__bioUnlockCalls = (w.__bioUnlockCalls as number) + 1
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
          document.dispatchEvent(new Event('visibilitychange'))
          await new Promise((r) => setTimeout(r, 50))
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
          document.dispatchEvent(new Event('visibilitychange'))
          return { secret: atob(o.data) }
        },
        remove: async () => {},
      }
    })
    await p.goto(`${site.url}#/settings`)
    await p.waitForSelector('text=已上锁')
    await p.fill('[aria-label="主密码"]', PASS)
    await p.click('button:has-text("解锁")')
    await p.waitForSelector('text=指纹解锁', { timeout: 30000 })
    await p.click('[aria-label="指纹解锁"]')
    await p.waitForSelector('text=已开启指纹解锁')
    // 开启指纹后还在设置页，没有被锁上
    expect(await p.locator('text=已上锁').count()).toBe(0)

    await away(p)
    await p.waitForSelector('text=已上锁')
    await p.waitForTimeout(300)
    expect(await p.evaluate(() => (window as unknown as { __bioUnlockCalls: number }).__bioUnlockCalls)).toBe(0)
    await back(p)
    // 回到前台：自动弹指纹，解开；指纹框引起的那次切后台不算离开，不会又锁上
    await p.waitForSelector('.shell[data-phase="unlocked"]', { timeout: 30000 })
    await p.waitForTimeout(500)
    expect(await p.evaluate(() => (window as unknown as { __bioUnlockCalls: number }).__bioUnlockCalls)).toBe(1)
    expect(await p.locator('.shell[data-phase="unlocked"]').count()).toBe(1)
    await p.goto(`${site.url}#/settings/diagnostics`)
    await p.waitForSelector('text=回到前台')
    await shot(p, 'diagnostics')
    await p.close()
  })

  // ---------- 1.0.6 ----------

  async function unlockMain(p: Page) {
    await p.waitForSelector('text=已上锁')
    await p.fill('[aria-label="主密码"]', PASS)
    await p.click('button:has-text("解锁")')
    await p.waitForSelector('.shell[data-phase="unlocked"]', { timeout: 30000 })
  }

  it('编辑到一半被上锁：解锁回来后恢复没保存的修改', async () => {
    await a.goto(`${site.url}#/edit`)
    await a.fill('#e-title', '还没保存的条目')
    await a.fill('#e-user', 'draft@example.com')
    await away(a)
    await back(a)
    await shot(a, 'lock')
    await unlockMain(a)
    await a.waitForSelector('text=已恢复上锁前没保存的修改')
    expect(await a.inputValue('#e-title')).toBe('还没保存的条目')
    expect(await a.inputValue('#e-user')).toBe('draft@example.com')
    // 只恢复一次：放弃后再进来就是空的
    await a.goto(`${site.url}#/`)
    await a.click('.dlg .btns >> text=放弃')
    await a.waitForSelector('.search')
    await a.goto(`${site.url}#/edit`)
    await a.waitForSelector('#e-title')
    expect(await a.inputValue('#e-title')).toBe('')
    await a.goto(`${site.url}#/`)
  })

  it('自动填充窗口解锁后切走：不管自动上锁设了多久，都立即上锁', async () => {
    await a.goto(`${site.url}#/settings`)
    await a.click('text=自动上锁')
    await a.waitForSelector('.val:text-is("30 秒")')
    const p = await autofillWindow({ mode: 'fill', packageName: 'com.android.chrome', appLabel: 'Chrome', webDomain: 'github.com', hasUsername: true, hasPassword: true })
    await unlockIn(p)
    await away(p)
    await back(p)
    await p.waitForSelector('text=已上锁')
    await p.close()
    // 改回“立即”：经过 1 小时时会问要不要保持解锁，取消就回到“立即”
    for (let i = 0; i < 4; i++) await a.click('text=自动上锁')
    await a.waitForSelector('text=离开 1 小时 内都不用解锁？')
    await a.click('.dlg .btns >> text=取消')
    await a.waitForSelector('.val:text-is("立即")')
  })

  it('GitHub Token 快过期时，首页和同步设置里提醒', async () => {
    gh.tokenExpiry = new Date(Date.now() + 5 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    try {
      for (const [p, name] of [[a, 'home-token'], [b, 'home-token-dark']] as const) {
        await p.goto(`${site.url}#/`)
        if (await p.locator('text=已上锁').count()) await unlockMain(p)
        await p.waitForSelector('.search')
        await p.locator('.topbar .icon-btn').first().click()
        await p.waitForSelector('text=GitHub Token 还有 5 天', { timeout: 30000 })
        await shot(p, name)
      }
      await a.click('.note-box >> text=更新 Token')
      await a.waitForSelector('#gh-token')
      await shot(a, 'sync-token')
    } finally {
      gh.tokenExpiry = ''
    }
    // 换了不会过期的 Token（这里是同一个，响应里没有过期时间了）：保存后提醒消失
    await a.click('.actions .solid-btn')
    await a.waitForSelector('text=立即同步', { timeout: 30000 })
    expect(await a.locator('text=Token 有效期到').count()).toBe(0)
    await a.goto(`${site.url}#/`)
    await waitSynced(a)
    expect(await a.locator('text=GitHub Token 还有').count()).toBe(0)
  })
})

describe('金匮 1.0.7', () => {
  const C_PASS = 'tablet-only-password'
  let a: Page
  let b: Page
  let c: Page
  afterEach(async (t) => {
    if (t.task.result?.state !== 'fail') return
    for (const [n, p] of [['a', a], ['b', b], ['c', c]] as const) await p?.screenshot({ path: `${OUT}/FAIL7-${n}-${t.task.name.slice(0, 6)}.png` }).catch(() => {})
  })

  async function newVault(p: Page) {
    await p.click('text=新建保险库')
    await fillBackend(p)
    await p.click('text=下一步')
    await p.waitForSelector('#mp1')
    await p.fill('#mp1', PASS)
    await p.fill('#mp2', PASS)
    await p.click('text=创建保险库')
    await p.waitForSelector('.search', { timeout: 60000 })
  }

  async function addEntry(p: Page, title: string, url?: string) {
    await p.goto(p.url().replace(/#.*$/, '#/edit'))
    await p.fill('#e-title', title)
    await p.fill('#e-pw', 'pw-' + title)
    if (url) await p.fill('[aria-label="网址 1"]', url)
    await p.click('.save')
    await p.waitForSelector('text=历史版本')
  }

  const home = (p: Page) => p.goto(p.url().replace(/#.*$/, '#/'))
  const setHidden = (p: Page, hidden: boolean) =>
    p.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  const away = (p: Page) => setHidden(p, true)
  const back = (p: Page) => setHidden(p, false)
  const titles = (p: Page) => p.locator('.entry .t').allInnerTexts()
  const rail = async (p: Page) => (await p.locator('.rail .dir:not(.manage) .dn').allInnerTexts()).filter((n) => n !== '未分类')

  it('准备：A 在新的仓库里建保险库，有两个目录', async () => {
    gh.files.clear()
    ;({ page: a } = await phone())
    await newVault(a)
    await addEntry(a, '乙网站')
    await addEntry(a, '丙网站')
    await addEntry(a, '甲网站', 'https://github.com')
    await home(a)
    await a.click('[aria-label="管理目录"]')
    for (const n of ['工作', '生活', '银行']) {
      await a.fill('[aria-label="新目录的名字"]', n)
      await a.click('.add .solid-btn')
      await a.waitForSelector(`.sheet >> text=${n}`)
    }
    await a.click('.sheet .head .text-btn')
    await a.click('.rail >> text=全部')
    expect(await rail(a)).toEqual(['全部', '工作', '生活', '银行'])
    await waitSynced(a)
  })

  it('目录拖动排序，同步到另一台设备', async () => {
    await a.click('[aria-label="管理目录"]')
    // 等面板滑上来停稳了再量位置
    await a.locator('[aria-label="拖动“银行”排序"]').hover()
    await a.waitForTimeout(400)
    const from = (await a.locator('[aria-label="拖动“银行”排序"]').boundingBox())!
    const to = (await a.locator('[aria-label="拖动“工作”排序"]').boundingBox())!
    await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await a.mouse.down()
    for (let i = 1; i <= 8; i++) await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + ((to.y - from.y) * i) / 8)
    await shot(a, 'folders-drag')
    await a.mouse.up()
    await a.waitForFunction(() => document.querySelector('.sheet .row .grow')?.textContent?.startsWith('银行'))
    await a.click('.sheet .head .text-btn')
    expect(await rail(a)).toEqual(['全部', '银行', '工作', '生活'])
    await shot(a, 'folders-ordered')
    await waitSynced(a)

    ;({ page: b } = await phone('dark'))
    await b.click('text=加入已有保险库')
    await fillBackend(b)
    await b.click('text=下一步')
    await b.fill('#mpj', PASS)
    await b.click('.actions .solid-btn')
    await b.waitForSelector('.entry', { timeout: 60000 })
    await b.waitForSelector('.rail >> text=银行')
    expect(await rail(b)).toEqual(['全部', '银行', '工作', '生活'])
  })

  it('每个目录各自的排序方式，只在本机', async () => {
    expect(await titles(a)).toEqual(['丙网站', '甲网站', '乙网站'])
    // 打开过“乙网站”：最近使用排第一
    await a.click('.entry >> text=乙网站')
    await a.waitForSelector('text=历史版本')
    await home(a)
    await a.click('.sort-btn')
    await shot(a, 'sort-sheet')
    await a.click('.sheet .row >> text=最近使用')
    await a.waitForSelector('.sort-btn >> text=最近使用')
    expect((await titles(a))[0]).toBe('乙网站')
    await a.click('.sort-btn')
    await a.click('.sheet .row >> text=添加时间')
    await a.waitForSelector('.sort-btn >> text=添加时间')
    expect(await titles(a)).toEqual(['甲网站', '丙网站', '乙网站'])
    await shot(a, 'home-sorted')
    // 别的目录还是按名称；另一台设备不受影响
    await a.click('.rail >> text=工作')
    await a.waitForSelector('.sort-btn >> text=名称')
    await a.click('.rail >> text=全部')
    await a.waitForSelector('.sort-btn >> text=添加时间')
    expect(await b.locator('.sort-btn >> text=名称').count()).toBe(1)
  })

  it('保持解锁：首页一直提醒；离开回来不用解锁', async () => {
    await a.goto(`${site.url}#/settings`)
    for (let i = 0; i < 5; i++) await a.click('text=自动上锁')
    await a.waitForSelector('text=离开 1 小时 内都不用解锁？')
    await a.click('.dlg .btns >> text=保持解锁')
    await a.waitForSelector('.val:text-is("1 小时")')
    await home(a)
    await a.waitForSelector('text=保持解锁中')
    await shot(a, 'home-keep-unlocked')
    await away(a)
    await back(a)
    expect(await a.locator('text=已上锁').count()).toBe(0)
    await a.click('text=改为离开即上锁')
    expect(await a.locator('text=保持解锁中').count()).toBe(0)
  })

  it('网站图标默认关；开启要确认，内网和取不到的显示首字', async () => {
    await a.goto(`${site.url}#/settings`)
    await a.click('[aria-label="显示网站图标"]')
    await a.waitForSelector('text=显示网站图标？')
    await shot(a, 'icons-confirm')
    // 模拟 github.com 有图标；其他网站一律取不到（测试环境不连外网）
    const png = readFileSync('android/app/src/main/res/mipmap-hdpi/ic_launcher.png')
    await a.context().route(/^https:\/\//, (r) =>
      r.request().url() === 'https://github.com/apple-touch-icon.png'
        ? r.fulfill({ status: 200, body: png, headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } })
        : r.fulfill({ status: 404, body: 'not found', headers: { 'Access-Control-Allow-Origin': '*' } }),
    )
    await a.click('.dlg .btns >> text=开启')
    await a.waitForSelector('[aria-label="显示网站图标"][aria-checked="true"]')
    await home(a)
    await a.waitForSelector('.entry .avatar.site img')
    // 没有网址的还是首字
    expect(await a.locator('.entry .avatar.site').count()).toBe(1)
    await shot(a, 'home-icons')
    await a.goto(`${site.url}#/settings`)
    await a.click('[aria-label="显示网站图标"]')
    await a.waitForSelector('[aria-label="显示网站图标"][aria-checked="false"]')
    await home(a)
  })

  it('先只存本机用了一阵，再接到已有的保险库：输入它的主密码，本机条目合并过去', async () => {
    ;({ page: c } = await phone())
    await c.click('text=新建保险库')
    await c.click('text=先不同步，只存在本机')
    await c.click('.dlg .btns >> text=只存本机')
    await c.fill('#mp1', C_PASS)
    await c.fill('#mp2', C_PASS)
    await c.click('text=创建保险库')
    await c.waitForSelector('.search', { timeout: 60000 })
    await addEntry(c, '平板上的条目')
    await c.goto(`${site.url}#/settings/sync`)
    await fillBackend(c)
    await c.click('.actions .solid-btn')
    await c.waitForSelector('text=这里已经有一个保险库')
    await shot(c, 'join-other-vault')
    await c.fill('.dlg input', PASS)
    await c.click('.dlg .btns >> text=加入并合并')
    await c.waitForSelector('text=立即同步', { timeout: 60000 })
    await home(c)
    await waitSynced(c)
    expect((await titles(c)).sort()).toEqual(['丙网站', '平板上的条目', '甲网站', '乙网站'].sort())
    // 以后用云端保险库的主密码解锁
    await c.click('[aria-label="上锁"]')
    await c.fill('[aria-label="主密码"]', C_PASS)
    await c.click('button:has-text("解锁")')
    await c.waitForSelector('text=主密码不对', { timeout: 30000 })
    await c.fill('[aria-label="主密码"]', PASS)
    await c.click('button:has-text("解锁")')
    await c.waitForSelector('.entry', { timeout: 30000 })
    // A 同步后也有平板上的条目
    await a.goto(`${site.url}#/settings/sync`)
    await a.click('text=立即同步')
    await home(a)
    await a.waitForSelector('.entry >> text=平板上的条目', { timeout: 30000 })
  })

  it('加入码：一台设备生成，新设备粘贴后只要输主密码', async () => {
    await a.goto(`${site.url}#/settings/sync`)
    await a.click('text=生成加入码')
    await a.fill('.dlg input', 'wrong-password-x')
    await a.click('.dlg .btns >> text=生成')
    await a.waitForSelector('text=主密码不对', { timeout: 30000 })
    await a.click('text=生成加入码')
    await a.fill('.dlg input', PASS)
    await a.click('.dlg .btns >> text=生成')
    await a.waitForSelector('.code-box .code', { timeout: 30000 })
    const code = await a.locator('.code-box .code').innerText()
    expect(code.startsWith('jinkui-join:')).toBe(true)
    expect(code).not.toContain('github_pat_test')
    await shot(a, 'join-code')

    const { page: d } = await phone('dark')
    await d.click('text=加入已有保险库')
    await d.fill('[aria-label="加入码"]', code.slice(0, 40) + '\n' + code.slice(40))
    await shot(d, 'join-with-code-dark')
    await d.click('text=下一步')
    await d.fill('#mpj', PASS)
    await d.click('.actions .solid-btn')
    await d.waitForSelector('.entry', { timeout: 60000 })
    await waitSynced(d)
    expect((await titles(d)).length).toBe(4)
    await d.close()
  })
})

async function waitSyncedAfterEdit(page: Page) {
  await page.goto(page.url().replace(/#.*$/, '#/'))
  await waitSynced(page)
}
