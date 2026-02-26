import './styles/main.css'
import 'mingcute_icon/font/Mingcute.css'

import { createApp } from 'vue'
import App from './App.vue'
import naive from 'naive-ui'
import router from './router'
import { createPinia } from 'pinia'

// 创建应用并挂载 Pinia
const app = createApp(App)
const pinia = createPinia()

app.use(pinia).use(naive).use(router).mount('#app')
