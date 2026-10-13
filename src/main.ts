import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import App from './ui/App.vue'
import { router } from './ui/router'
import './ui/style.css'
import { setHttpImpl } from './core/http'
import { nativeHttpImpl } from './platform/nativeHttp'
import { init } from './store'
import { initUpdate } from './updateService'
import { cleanCacheExports } from './platform/files'

// 真机上用原生 HTTP：不受跨域限制，二进制不损坏
if (Capacitor.isNativePlatform()) setHttpImpl(nativeHttpImpl)

createApp(App).use(router).mount('#app')
void init().then(() => {
  initUpdate()
  void cleanCacheExports()
})
