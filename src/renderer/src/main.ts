import './styles/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import { performanceMonitor } from './utils/performanceMonitor'
import { rendererMemoryMonitor } from './utils/memoryMonitor'
import PageTransition from './components/common/PageTransition.vue'
import { webAudioOutputEngine } from './audio/web-audio-engine'

// 记录应用启动标记，用于后续测量首屏渲染时间
performanceMonitor.mark('app-init-start')

// 接收主进程发送的日志
if (window.electron) {
  const { ipcRenderer } = window.electron

  ipcRenderer.on('plugin:log', (_event, level, ...args) => {
    console[level](...args)
  })
}

// 创建应用并挂载 Pinia
const app = createApp(App)
const pinia = createPinia()

app.component('PageTransition', PageTransition)
app.use(pinia).use(router).mount('#app')

// 启动渲染进程内存监控（用于验证内存优化效果）
rendererMemoryMonitor.start()
if (import.meta.env.DEV) {
  setInterval(() => {
    const report = rendererMemoryMonitor.getReport()
    if (report.count === 0) return
    console.log(
      `[内存监控] 渲染进程 JS堆 used=${rendererMemoryMonitor.toMB(
        report.current
      )} (min=${rendererMemoryMonitor.toMB(report.min)}, max=${rendererMemoryMonitor.toMB(
        report.max
      )}, avg=${rendererMemoryMonitor.toMB(report.avg)}, 样本=${report.count})`
    )
  }, 60000)
}

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

// HMR 热重载时强制停止所有音频播放，防止旧音频残留
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    // 停止 Web Audio 引擎并关闭 AudioContext
    webAudioOutputEngine.stop()
    webAudioOutputEngine.dispose()
    // 同时通过 IPC 紧急停止主进程中的原生音频引擎（WASAPI 等）
    emergencyStopNativeAudio()
  })
}

// 页面卸载前（刷新、关闭等）紧急停止所有原生音频输出
// 使用 fire-and-forget 方式确保消息发送不阻塞页面卸载
window.addEventListener('beforeunload', () => {
  webAudioOutputEngine.stop()
  webAudioOutputEngine.dispose()
  emergencyStopNativeAudio()
})

/**
 * 紧急停止主进程中的原生音频引擎（Fire-and-forget）
 * 使用 ipcRenderer.send 确保不依赖异步响应，消息发出即成功
 */
function emergencyStopNativeAudio(): void {
  try {
    const { ipcRenderer } = window.electron || (window as any).electron || {}
    if (ipcRenderer) {
      ipcRenderer.send('audio-engine:emergency-stop-all')
    }
  } catch {
    // 静默失败，页面即将卸载
  }
}
