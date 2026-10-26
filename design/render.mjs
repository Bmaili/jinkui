// 由 design/icon.svg 渲染安卓图标和启动图（用 Playwright 的 Chromium）。
// 用法：PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> node design/render.mjs
//       只生成电脑端扩展的图标：node design/render.mjs extension
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const RES = 'android/app/src/main/res'
const PAPER = '#f4efe4'
const svg = readFileSync('design/icon.svg', 'utf8')
const DPI = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

const browser = await chromium.launch()
const page = await browser.newPage()

async function render(file, w, h, body, transparent = false) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : PAPER}">${body}</body></html>`)
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } })
}

const icon = (size) => svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)

/** 圆角方形、宣纸底、主体放大一些（和旧系统的桌面图标一样） */
const tile = (n, radius) => {
  const big = n * 1.45
  return `<div style="position:relative;width:${n}px;height:${n}px;background:${PAPER};border-radius:${radius};overflow:hidden"><div style="position:absolute;left:${(n - big) / 2}px;top:${(n - big) / 2}px">${icon(big)}</div></div>`
}

if (process.argv.includes('extension')) {
  for (const n of [16, 32, 48, 128]) await render(`extension/public/icons/${n}.png`, n, n, tile(n, `${n * 0.18}px`), true)
  await browser.close()
  console.log('扩展图标已生成')
  process.exit(0)
}

for (const [d, s] of Object.entries(DPI)) {
  // 自适应图标的前景层（108dp，透明底；底色在 values/ic_launcher_background.xml）
  await render(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, 108 * s, 108 * s, icon(108 * s), true)
  // 旧系统的图标（48dp）：圆角方形和圆形，宣纸底，主体放大一些
  const n = 48 * s
  const big = n * 1.45
  const inner = `<div style="position:relative;width:${n}px;height:${n}px;background:${PAPER};border-radius:RADIUS;overflow:hidden"><div style="position:absolute;left:${(n - big) / 2}px;top:${(n - big) / 2}px">${icon(big)}</div></div>`
  await render(`${RES}/mipmap-${d}/ic_launcher.png`, n, n, inner.replace('RADIUS', `${n * 0.18}px`), true)
  await render(`${RES}/mipmap-${d}/ic_launcher_round.png`, n, n, inner.replace('RADIUS', '50%'), true)
}

// 启动图：宣纸底，正中一个匣子
const SPLASH = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] }
const center = (w, h) => `<div style="width:${w}px;height:${h}px;display:grid;place-items:center">${icon(Math.round(Math.min(w, h) * 0.75))}</div>`
for (const [d, [w, h]] of Object.entries(SPLASH)) {
  await render(`${RES}/drawable-port-${d}/splash.png`, w, h, center(w, h))
  await render(`${RES}/drawable-land-${d}/splash.png`, h, w, center(h, w))
}
await render(`${RES}/drawable/splash.png`, 480, 320, center(480, 320))

await browser.close()
console.log('图标和启动图已生成')
