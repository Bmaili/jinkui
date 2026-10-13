import { defineConfig } from 'vitest/config'

// 端到端测试：先 npm run build，再 PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e
export default defineConfig({
  test: { environment: 'node', include: ['e2e/**/*.test.ts'], testTimeout: 180000, hookTimeout: 60000, fileParallelism: false },
})
