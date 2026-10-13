<script setup lang="ts">
/**
 * 金匮的标志：和桌面图标同一个匣子（直接用 design/icon.svg），宣纸底圆角方块。
 * 深色模式下也保持宣纸底，看起来就是桌面上那个图标。
 */
import { useId } from 'vue'
import src from '../../../design/icon.svg?raw'

withDefaults(defineProps<{ size?: number }>(), { size: 30 })

// 同一页面上可能有好几个标志：渐变的 id 要各不相同，否则隐藏的那个会让别的取不到渐变
const uid = 'logo' + useId().replace(/[^\w-]/g, '')
// 取 108 格中间的 74.5 格，和旧系统的桌面图标一样大（render.mjs 里放大 1.45 倍）
const html = src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace('viewBox="0 0 108 108"', 'viewBox="16.75 16.75 74.5 74.5" width="100%" height="100%" aria-hidden="true" focusable="false"')
  .replace(/id="([\w-]+)"/g, `id="$1-${uid}"`)
  .replace(/url\(#([\w-]+)\)/g, `url(#$1-${uid})`)
</script>

<template>
  <span class="logo" role="img" aria-label="金匮" :style="{ width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.22)}px` }" v-html="html" />
</template>

<style scoped>
.logo {
  display: inline-block;
  flex: none;
  overflow: hidden;
  background: #f4efe4;
  box-shadow: 0 0 0 1px var(--line);
  vertical-align: middle;
}
.logo :deep(svg) { display: block; }
</style>
