import './styles/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import { performanceMonitor } from './utils/performanceMonitor'

// 记录应用启动标记，用于后续测量首屏渲染时间
performanceMonitor.mark('app-init-start')

// 接收主进程发送的日志
if (window.electron) {
  const { ipcRenderer } = window.electron

  ipcRenderer.on('plugin:log', (event, level, ...args) => {
    console[level](...args)
  })
}

// 创建应用并挂载 Pinia
const app = createApp(App)
const pinia = createPinia()

app.use(pinia).use(router).mount('#app')

// 记录挂载完成时间
performanceMonitor.mark('app-mounted')
const appInitDuration = performanceMonitor.measure('app-init', 'app-init-start', 'app-mounted')

// 采集 Web Vitals 指标并在开发环境输出
performanceMonitor.getWebVitals().then((vitals) => {
  performanceMonitor.logEvent('FCP', vitals.fcp)
  performanceMonitor.logEvent('LCP', vitals.lcp)
  performanceMonitor.logEvent('CLS', vitals.cls * 1000)
  performanceMonitor.logEvent('INP', vitals.inp)
  performanceMonitor.logEvent('TTFB', vitals.ttfb)

  if (import.meta.env.DEV) {
    console.group('📊 Such Music 性能指标')
    console.log(`  🎨 FCP (首次内容绘制): ${vitals.fcp.toFixed(1)}ms`)
    console.log(`  🖼 LCP (最大内容绘制): ${vitals.lcp.toFixed(1)}ms`)
    console.log(`  📐 CLS (累积布局偏移): ${(vitals.cls * 1000).toFixed(2)}`)
    console.log(`  👆 INP (交互延迟): ${vitals.inp.toFixed(1)}ms`)
    console.log(`  ⚡ TTFB (首字节时间): ${vitals.ttfb.toFixed(1)}ms`)
    console.log(`  🚀 应用初始化: ${appInitDuration.toFixed(1)}ms`)
    console.groupEnd()
  }
})
