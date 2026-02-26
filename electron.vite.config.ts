import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        'suth-lyric-kit': resolve('packages/suth-lyric-kit/src/index.ts')
      }
    },
    plugins: [vue(), wasm(), topLevelAwait()]
  }
})
