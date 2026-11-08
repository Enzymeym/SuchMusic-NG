/**
 * 曲库的路径规则：支持的扩展名、目录排除表、路径键计算。
 *
 * 主进程与 scanner 子进程共用，**不依赖 electron**。
 */
import { basename, dirname } from 'path'
import { baseName, isCaseInsensitivePath, parentOf, pathKey, toPosixPath } from '../../../shared/library/normalize'

/** 支持的音频扩展名（与既有 `local-music:scan` 保持一致，避免同一文件两套判定） */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.ape',
  '.wv',
  '.aiff',
  '.aif',
  '.mp4',
  '.m4b'
])

/**
 * 一律跳过的目录名（大小写不敏感）。
 *
 * 这些目录里要么不可能有音乐，要么会拖慢遍历一个数量级：
 * - `.git` / `node_modules`：开发者常把音乐目录放在项目里
 * - `@eaDir`：群晖 NAS 生成的缩略图目录，每个音频文件都对应一个子目录
 * - `$RECYCLE.BIN` / `System Volume Information`：Windows 卷回收站
 * - `.Trashes` / `.Spotlight-V100`：macOS
 */
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '@eadir',
  '#recycle',
  '$recycle.bin',
  'system volume information',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  'lost+found'
])

/** 目录是否在排除表里（只看最后一段名字） */
export function isExcludedDirName(name: string): boolean {
  if (!name) return false
  // 隐藏目录：`.DS_Store` 之类不会进这里（那是文件），但 `.cache` 这种整目录要跳过
  if (name.startsWith('.')) return true
  return EXCLUDED_DIR_NAMES.has(name.toLowerCase())
}

/** 文件名是否是受支持的音频 */
export function isAudioFileName(fileName: string): boolean {
  const idx = fileName.lastIndexOf('.')
  if (idx <= 0) return false
  return AUDIO_EXTENSIONS.has(fileName.slice(idx).toLowerCase())
}

/** 取扩展名（含点，小写） */
export function extNameOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  return idx <= 0 ? '' : fileName.slice(idx).toLowerCase()
}

/**
 * 曲目主键：归一化路径键。
 * Windows / UNC 上折叠大小写，避免同一目录以不同大小写被重复收录。
 */
export function trackIdOf(filePath: string): string {
  return pathKey(filePath)
}

/** 目录主键（与曲目的 folderPath 使用同一套归一化） */
export function folderKeyOf(dirPath: string): string {
  return pathKey(dirPath)
}

/** 目录展示名（盘符根返回 `C:` 而不是空串） */
export function folderDisplayName(dirPath: string): string {
  const name = baseName(dirPath)
  if (name && name !== '/') return name
  return toPosixPath(dirPath)
}

export { dirname, basename, parentOf, toPosixPath, isCaseInsensitivePath }
