// 原生模块完整性校验
//
// 背景：项目中 `resources/native/` 存放随包发布的 NAPI 原生模块（.node）。
// 它曾因 .gitignore 里一条未锚定的 `native` 规则而被整体忽略，导致 CI 检出后
// 该目录不存在：构建脚本静默跳过、electron-builder 的 extraResources 无从拷贝，
// 最终发布出去的安装包里没有任何原生模块，用户侧表现为
// 「Windows 音频会话 API 不可用」「系统媒体控制降级」「标签读取/解码回退」。
//
// 本脚本用于在打包前做硬校验，避免同类问题再次静默发布。
//
// 用法：
//   node scripts/verify-native.mjs            # 诊断模式：只报告，不因缺失而失败
//   node scripts/verify-native.mjs --strict   # 严格模式：任何缺失/导出不符即退出码 1
//
// Windows 上默认即为严格模式（原生模块是音频输出与媒体控制的必要依赖）。

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const nativeDir = join(projectRoot, 'resources', 'native')

const isWindows = process.platform === 'win32'
const strict = process.argv.includes('--strict') || isWindows

/**
 * 期望随包发布的原生模块。
 * - exports + exportMode：必须存在的导出，'all' 表示全部命中。
 */
const EXPECTED = [
  {
    file: 'audio_napi.node',
    label: 'WASAPI / 解码引擎',
    exports: ['WasapiOutputEngine', 'AudioEngine'],
    exportMode: 'all'
  },
  {
    file: 'media_control_napi.node',
    label: '系统媒体控制',
    exports: ['MediaControl'],
    exportMode: 'all'
  },
  {
    file: 'music_tag_reader.node',
    label: '标签读取',
    exports: ['readTags'],
    exportMode: 'all'
  },
  {
    file: 'symphonia_napi_decoder.node',
    label: 'Symphonia 解码器',
    exports: ['decodeAudioToPcm', 'decodeAudioStream'],
    exportMode: 'any'
  }
]

const missingFiles = []
const loadErrors = []
const exportErrors = []
const ok = []

for (const spec of EXPECTED) {
  const filePath = join(nativeDir, spec.file)

  if (!existsSync(filePath)) {
    missingFiles.push({ spec, filePath })
    continue
  }

  // 仓库只提交 Windows 版本的 .node（macOS/Linux 侧走 Web Audio 与内置降级实现）。
  // 因此在非 Windows 平台上，能读到文件即可；require 失败属于预期情况（PE 二进制），
  // 只作为提示，不计入失败。
  const canLoad = isWindows

  if (!canLoad) {
    ok.push({ spec, note: '文件存在（Windows 二进制，当前平台跳过加载校验）' })
    continue
  }

  let mod
  try {
    mod = require(filePath)
  } catch (error) {
    loadErrors.push({ spec, filePath, error })
    continue
  }

  const keys = Object.keys(mod ?? {})
  const absent = spec.exports.filter((key) => typeof mod?.[key] === 'undefined')
  const satisfied =
    spec.exportMode === 'any' ? absent.length < spec.exports.length : absent.length === 0

  if (!satisfied) {
    exportErrors.push({ spec, filePath, absent, keys })
    continue
  }

  ok.push({ spec, note: `导出正常 [${keys.join(', ')}]` })
}

const lines = []
lines.push('')
lines.push('=== 原生模块校验 ===')
lines.push(`平台: ${process.platform}${strict ? '（严格模式）' : '（诊断模式）'}`)
lines.push(`目录: ${nativeDir}`)
lines.push('')

for (const { spec, note } of ok) {
  lines.push(`  [OK]   ${spec.file.padEnd(30)} ${spec.label} — ${note}`)
}
for (const { spec, error } of loadErrors) {
  lines.push(`  [FAIL] ${spec.file.padEnd(30)} 加载失败：${error?.message ?? error}`)
}
for (const { spec, filePath, absent, keys } of exportErrors) {
  lines.push(
    `  [FAIL] ${spec.file.padEnd(30)} 缺少导出 [${absent.join(', ')}]（实际导出：${keys.join(', ') || '无'}）`
  )
  lines.push(`         路径：${filePath}`)
}
for (const { spec, filePath } of missingFiles) {
  lines.push(`  [MISS] ${spec.file.padEnd(30)} 文件不存在：${filePath}`)
}

const failed = loadErrors.length + exportErrors.length + (missingFiles.length > 0 && strict ? 1 : 0)

if (missingFiles.length > 0 || loadErrors.length > 0 || exportErrors.length > 0) {
  lines.push('')
  lines.push('  提示：执行 `npm run build:native` 可重新编译原生模块。')
  lines.push('  若 resources/native 下文件缺失，请确认它们已被提交进版本库')
  lines.push('  （.gitignore 中 `native` 必须写为锚定的 `/native`，否则会连带忽略 resources/native）。')
}

if (missingFiles.length > 0 && !strict) {
  lines.push('')
  lines.push('  （诊断模式下不因缺失而失败；CI/打包请使用 --strict）')
}

lines.push('')

if (failed > 0 && strict) {
  lines.push('原生模块校验未通过，已中止。')
  console.error(lines.join('\n'))
  process.exit(1)
}

lines.push('原生模块校验通过。')
console.log(lines.join('\n'))
