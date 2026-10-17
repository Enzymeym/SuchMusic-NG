import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * 单元测试配置
 *
 * 主进程服务依赖 `electron`（app.getPath 等），Node 环境下无法直接加载，
 * 因此把 `electron` 指向轻量替身，使音源插件宿主等纯逻辑可在无 Electron 时被测试。
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/unit/electron-stub.mjs')
    }
  },
  test: {
    environment: 'node',
    // tests/unit 为本地回归（被 .gitignore 忽略）；src/**/__tests__ 为随源码提交的单元测试
    include: ['tests/unit/**/*.test.ts', 'src/**/__tests__/**/*.test.ts']
  }
})
