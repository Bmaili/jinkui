import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 打包时由 GitHub Actions 传入，例如 1.0.3；本地开发显示 dev
  define: { __APP_VERSION__: JSON.stringify(process.env.VERSION_NAME || 'dev') },
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
})
