// Cross-platform native build wrapper
// On Windows: uses powershell. On Linux/macOS: uses pwsh if available, otherwise skips gracefully.
// Delegates to build-native.ps1, which builds media-control-napi (all platforms)
// and audio-napi (Windows only), so no platform-specific flag is needed here.
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, 'build-native.ps1')
const verifyScriptPath = join(__dirname, 'verify-native.mjs')
const isRelease = process.argv.includes('-Release')

// 构建后校验 resources/native 的完整性与导出。
// 使用诊断模式（不因缺失而中断），避免在没有 Rust 工具链的机器上阻断开发流程；
// 发布流程由 CI 以 --strict 做硬校验。
function verifyNatives() {
  try {
    execSync(`${process.execPath} ${JSON.stringify(verifyScriptPath)}`, { stdio: 'inherit' })
  } catch {
    console.log('[native-build] 原生模块校验未通过，请检查 resources/native')
  }
}

// Check if native directory exists (gitignored, may not be present on CI).
// 注意：源码目录缺失不代表产物缺失 —— resources/native 下的 .node 已入库，
// 此时应当直接沿用已提交的产物，而不是让整个打包流程失去原生模块。
const rustDir = join(__dirname, '..', 'native', 'rust-audio-engine')
if (!existsSync(rustDir)) {
  console.log('[native-build] Rust 源码目录不存在，跳过编译，沿用 resources/native 中已提交的产物')
  verifyNatives()
  process.exit(0)
}

let shell
if (process.platform === 'win32') {
  shell = 'powershell'
} else {
  // On Linux/macOS, try pwsh (PowerShell Core), otherwise skip
  try {
    execSync('which pwsh', { stdio: 'ignore' })
    shell = 'pwsh'
  } catch {
    console.log('[native-build] PowerShell not available on this platform, skipping native build')
    verifyNatives()
    process.exit(0)
  }
}

const args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath]
if (isRelease) args.push('-Release')

try {
  execSync([shell, ...args].join(' '), { stdio: 'inherit' })
} catch (e) {
  console.log('[native-build] Native build failed, continuing without it')
}

verifyNatives()
