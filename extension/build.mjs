// 打包电脑端 Chrome 扩展到 extension/dist（用 Chrome 的“加载已解压的扩展程序”装这个目录，或者打成 zip 发布）。
// 用法：node extension/build.mjs        版本号取环境变量 EXT_VERSION（CI 发布时传入，例如 1.0.3），本地是 0.0.1
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = dirname(fileURLToPath(import.meta.url))
const out = resolve(root, 'dist')
const version = process.env.EXT_VERSION || '0.0.1'
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号要写成 1.0.N：${version}`)
const define = { __APP_VERSION__: JSON.stringify(version) }

// 1. 弹窗、offscreen、试验页和后台：ES 模块（后台在 manifest 里声明为 type: module）
await build({
  root,
  base: './',
  configFile: false,
  logLevel: 'warn',
  plugins: [vue()],
  define,
  publicDir: resolve(root, 'public'),
  build: {
    outDir: out,
    emptyOutDir: true,
    target: 'es2022',
    // 不内联成 data: 地址：扩展页面的默认 CSP 不一定允许
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        offscreen: resolve(root, 'offscreen.html'),
        hello: resolve(root, 'hello.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})

// 2. 内容脚本：不能是 ES 模块，单独打成一个文件
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  define,
  publicDir: false,
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'es2022',
    lib: { entry: resolve(root, 'src/content.ts'), formats: ['iife'], name: 'jinkuiContent', fileName: () => 'content.js' },
  },
})

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
manifest.version = version
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`扩展 ${version} 已打包到 extension/dist`)
