import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import App from './ui/App.vue'
import AutofillApp from './ui/AutofillApp.vue'
import { router } from './ui/router'
import './ui/style.css'
import { setHttpImpl } from './core/http'
import { nativeHttpImpl } from './platform/nativeHttp'
import { init } from './store'
import { initUpdate } from './updateService'
import { cleanCacheExports } from './platform/files'
import { autofill } from './platform/autofill'

// 真机上用原生 HTTP：不受跨域限制，二进制不损坏
if (Capacitor.isNativePlatform()) setHttpImpl(nativeHttpImpl)

async function start() {
  // 自动填充窗口（AutofillActivity）和主界面用同一份网页，靠插件告诉我们是哪一种
  const req = await autofill.request()
  if (req.mode) {
    createApp(AutofillApp, { req }).mount('#app')
    await init('autofill')
    return
  }
  createApp(App).use(router).mount('#app')
  await init()
  initUpdate()
  void cleanCacheExports()
}

void start()
