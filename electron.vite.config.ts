import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL),
        'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify(env.VITE_SUPABASE_KEY)
      }
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
      plugins: [vue(), wasm(), topLevelAwait()]
    }
  }
})
