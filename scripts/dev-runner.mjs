// 开发启动器（跨平台）
//
// 修复 Windows 控制台中文乱码：
// npm → electron-vite → electron 的输出链路共享同一个 conhost。若 conhost 代码页
// 为 GBK(936)，Node/Electron 输出的 UTF-8 字节会被按 GBK 编码转发到终端（conpty/
// Windows Terminal 通常按 UTF-8 解码），导致中文乱码。这里在启动链路“最外层”
// 先把代码页切为 UTF-8，让整条链路后续输出都按 UTF-8 编码。
import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

if (isWin) {
  try {
    execSync('chcp 65001 >nul', { stdio: 'inherit', shell: 'cmd.exe' })
  } catch {
    // 代码页切换失败时忽略，继续启动（例如在受限沙箱中）
  }
}

// 1) 编译 native 模块（与 package.json 中原 dev 脚本行为一致）
const native = spawnSync(process.execPath, [join(__dirname, 'build-native.mjs')], {
  stdio: 'inherit'
})
if (native.status !== 0) process.exit(native.status ?? 1)

// 2) 启动 electron-vite dev
const electronViteBin = join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
if (!existsSync(electronViteBin)) {
  console.error('[dev-runner] 未找到 electron-vite 可执行文件:', electronViteBin)
  process.exit(1)
}
const dev = spawnSync(process.execPath, [electronViteBin, 'dev'], { stdio: 'inherit' })
process.exit(dev.status ?? 0)
