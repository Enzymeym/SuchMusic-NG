/**
 * 原生标签读取的 **electron 侧入口**。
 *
 * 只做一件事：用 `nativeModuleLoader` 在「开发 / 打包」两种形态下把
 * `music_tag_reader.node` 找出来并加载；真正的读取与规范化逻辑在
 * `tagReaderCore.ts`（纯 Node，可被 scanner 子进程复用）。
 */
import { tryLoadNativeModule as tryLoadNative } from './nativeModuleLoader'
import {
  describeReader,
  readManyTagsWith,
  readTagsWith,
  resolveReader,
  type NativeTagReader,
  type NativeTags
} from './tagReaderCore'

export type {
  NativePicture,
  NativeTagInfo,
  NativeTagReader,
  NativeTags
} from './tagReaderCore'

let nativeReader: NativeTagReader | null = null
let nativeReaderPath = ''
let nativeAvailable = false
let loadAttempted = false

/**
 * 懒加载原生模块；失败时静默降级（非 Windows 平台本来就没有这份二进制）。
 */
function ensureLoaded(): void {
  if (loadAttempted) return
  loadAttempted = true

  const result = tryLoadNative<NativeTagReader>({
    label: 'music_tag_reader',
    filenames: ['music_tag_reader.node'],
    requiredExports: ['readTags']
  })

  if (!result) {
    console.warn('[music_tag_reader] 原生模块不可用，标签读取降级为内置实现')
    nativeAvailable = false
    return
  }

  nativeReader = result.module
  nativeReaderPath = result.path
  const { readTags } = resolveReader(result.module)
  nativeAvailable = typeof readTags === 'function'
  if (!nativeAvailable) {
    console.error('[music_tag_reader] 模块未导出 readTags：', result.module)
  } else {
    console.log(`[music_tag_reader] 能力探测：${describeReader(result.module)}`)
  }
}

export function isTagReaderAvailable(): boolean {
  ensureLoaded()
  return nativeAvailable
}

/**
 * 原生模块的绝对路径，供 scanner 子进程加载。
 * 子进程不能自己调 `nativeModuleLoader`（它依赖 `app`），必须由主进程传入。
 */
export function getNativeTagReaderPath(): string {
  ensureLoaded()
  return nativeReaderPath
}

/** 已加载的读取器；不可用时返回 null */
export function getNativeTagReader(): NativeTagReader | null {
  ensureLoaded()
  return nativeAvailable ? nativeReader : null
}

// 读取单个文件的 native 标签；native 不可用时返回 'UNAVAILABLE'
export async function readNativeTags(
  filePath: string,
  opts?: { includeCover?: boolean }
): Promise<NativeTags | null | 'UNAVAILABLE'> {
  ensureLoaded()
  if (!nativeAvailable) return 'UNAVAILABLE'
  const tags = await readTagsWith(nativeReader, filePath, opts)
  return tags
}

// 批量读取多个文件的 native 标签；native 不可用时返回空数组
export async function readNativeTagsMany(
  filePaths: string[],
  opts?: { includeCover?: boolean }
): Promise<Array<NativeTags | null>> {
  ensureLoaded()
  if (!nativeAvailable) return []
  return readManyTagsWith(nativeReader, filePaths, opts)
}
