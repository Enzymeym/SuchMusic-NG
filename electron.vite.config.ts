import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// 构建时注入 package.json 字段，避免渲染进程依赖 IPC 获取版本信息
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig(() => {
  return {
    main: {
      plugins: [externalizeDepsPlugin()]
    },
    preload: {
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          'suth-lyric-kit': resolve('packages/suth-lyric-kit/src/index.ts')
        }
      },
      // 将 package.json 的应用元信息在构建时注入为全局常量
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __APP_NAME__: JSON.stringify(pkg.name),
        __APP_DESCRIPTION__: JSON.stringify(pkg.description || ''),
        __APP_HOMEPAGE__: JSON.stringify(pkg.homepage || '')
      },
      plugins: [vue(), wasm(), topLevelAwait()],
      worker: {
        format: 'es' as const
      },
      build: {
        cssCodeSplit: false,
        chunkSizeWarningLimit: 500,
        rollupOptions: {
          output: {
            manualChunks: {
              'vue-vendor': ['vue', 'vue-router', 'pinia'],
              'naive-ui': ['naive-ui'],
              'amll-lyric': ['@applemusic-like-lyrics/lyric', '@applemusic-like-lyrics/vue'],
              pixi: [
                '@pixi/app',
                '@pixi/core',
                '@pixi/display',
                '@pixi/sprite',
                '@pixi/filter-blur',
                '@pixi/filter-color-matrix'
              ],
              highlight: ['highlight.js'],
              markdown: ['markdown-it']
            }
          }
        }
      }
    }
  }
})
