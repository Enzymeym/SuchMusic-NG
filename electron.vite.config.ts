import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

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
      plugins: [vue(), wasm(), topLevelAwait()],
      worker: {
        format: 'es'
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
