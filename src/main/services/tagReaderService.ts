import { app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// napi-rs 自动将 Rust snake_case 字段转成 camelCase，可选字段在缺省时会被省略
export interface NativePicture {
  mimeType?: string
  description?: string
  data: Uint8Array
}

export interface NativeTagInfo {
  title?: string
  artist?: string
  artists?: string[]
  album?: string
  albumArtist?: string
  genre?: string
  year?: number
  track?: number
  totalTracks?: number
  disc?: number
  totalDiscs?: number
  lyrics?: string
  comment?: string
  composer?: string
  picture?: NativePicture
  durationMs?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  bitrate?: number
  fileFormat?: string
}

// 描述 music_tag_reader.node 导出的 camelCase 模块
export interface NativeTagReader {
  readTags?: (path: string, options?: { includeCover?: boolean }) => NativeTagInfo | null
  readMany?: (
    paths: string[],
    options?: { includeCover?: boolean }
  ) => Array<NativeTagInfo | null>
  default?: NativeTagReader
}

// 规范化后的标签结构，经由 IPC 返回给渲染进程
export interface NativeTags {
  source: 'native'
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  cover?: { mimeType: string; base64: string }
  title?: string
  artists?: string[]
  artist?: string
  album?: string
  albumArtist?: string
  year?: number
  lyrics?: string
  genre?: string
  track?: number
  totalTracks?: number
  disc?: number
  totalDiscs?: number
  comment?: string
  composer?: string
  fileFormat?: string
}

let nativeAvailable = false
let nativeReader: NativeTagReader | null = null

// 获取 native 插件在当前环境下的实际路径（开发 / 生产）
function getNativeTagReaderPath(): string {
  if (is.dev) {
    return join(app.getAppPath(), 'resources', 'native', 'music_tag_reader.node')
  }
  return join(process.resourcesPath, 'native', 'music_tag_reader.node')
}

// 从 native 模块中解析出真正可用的 readTags / readMany
function resolveReader(module: NativeTagReader): {
  readTags: ((path: string, options?: { includeCover?: boolean }) => NativeTagInfo | null) | null
  readMany: ((
    paths: string[],
    options?: { includeCover?: boolean }
  ) => Array<NativeTagInfo | null>) | null
} {
  const readTags =
    module.readTags ||
    module.default?.readTags ||
    null
  const readMany =
    module.readMany ||
    module.default?.readMany ||
    null
  return { readTags, readMany }
}

// 懒加载 native 标签读取模块；加载失败或缺少 readTags 时降级为不可用，绝不崩溃
function ensureLoaded(): void {
  if (nativeReader !== null) return
  const nativePath = getNativeTagReaderPath()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const module = require(nativePath) as NativeTagReader
    const { readTags } = resolveReader(module)
    // 只有拿到了 readTags 才认为 native 可用
    nativeAvailable = typeof readTags === 'function'
    if (!nativeAvailable) {
      console.error('[music_tag_reader] 模块未导出 readTags：', module)
    }
    nativeReader = module
  } catch (error) {
    console.error('加载 local tag reader（music_tag_reader.node）失败:', error)
    nativeAvailable = false
    nativeReader = {}
  }
}

export function isTagReaderAvailable(): boolean {
  ensureLoaded()
  return nativeAvailable
}

// 将 napi 返回的 TagInfo 规范化为 IPC 使用的高层结构
function normalizeTags(info: NativeTagInfo | null): NativeTags | null {
  if (!info) return null

  const trimStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.trim() || undefined : undefined

  let artists: string[] | undefined
  if (Array.isArray(info.artists) && info.artists.some((a) => typeof a === 'string' && a.trim())) {
    artists = info.artists
      .map((a) => String(a || '').trim())
      .filter((a) => a.length > 0)
  } else if (typeof info.artist === 'string' && info.artist.trim()) {
    // 单一 artist 字符串按 '/' 或 ',' 拆分（music-metadata 风格）
    artists = info.artist
      .split(/[/,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  let cover: { mimeType: string; base64: string } | undefined
  if (info.picture && info.picture.data && info.picture.data.byteLength > 0) {
    cover = {
      mimeType: info.picture.mimeType || 'image/jpeg',
      base64: Buffer.from(info.picture.data).toString('base64')
    }
  }

  const tags: NativeTags = {
    source: 'native',
    durationMs:
      typeof info.durationMs === 'number' && Number.isFinite(info.durationMs)
        ? Math.round(info.durationMs)
        : undefined,
    bitrate: info.bitrate,
    sampleRate: info.sampleRate,
    cover,
    title: trimStr(info.title),
    artists,
    artist: trimStr(info.artist),
    album: trimStr(info.album),
    albumArtist: trimStr(info.albumArtist),
    year: info.year,
    lyrics: trimStr(info.lyrics),
    genre: trimStr(info.genre),
    track: info.track,
    totalTracks: info.totalTracks,
    disc: info.disc,
    totalDiscs: info.totalDiscs,
    comment: trimStr(info.comment),
    composer: trimStr(info.composer),
    fileFormat: trimStr(info.fileFormat)
  }
  return tags
}

// 读取单个文件的 native 标签；native 不可用时返回 'UNAVAILABLE'
export async function readNativeTags(
  filePath: string,
  opts?: { includeCover?: boolean }
): Promise<NativeTags | null | 'UNAVAILABLE'> {
  ensureLoaded()
  if (!nativeAvailable) return 'UNAVAILABLE'
  const reader = nativeReader
  const { readTags } = resolveReader(reader ?? {})
  try {
    if (typeof readTags !== 'function') {
      nativeAvailable = false
      return 'UNAVAILABLE'
    }
    const info = readTags(filePath, opts)
    return normalizeTags(info)
  } catch (error) {
    console.error('读取 native 标签失败:', filePath, error)
    return null
  }
}

// 批量读取多个文件的 native 标签；native 不可用时返回空数组
export async function readNativeTagsMany(
  filePaths: string[],
  opts?: { includeCover?: boolean }
): Promise<Array<NativeTags | null>> {
  ensureLoaded()
  if (!nativeAvailable) return []
  const reader = nativeReader
  const { readMany } = resolveReader(reader ?? {})
  try {
    if (typeof readMany !== 'function') {
      // 若只有 readTags，则逐个降级读取
      const results: Array<NativeTags | null> = []
      for (const fp of filePaths) {
        const r = await readNativeTags(fp, opts)
        results.push(r === 'UNAVAILABLE' ? null : r)
      }
      return results
    }
    const infos = readMany(filePaths, opts)
    if (!Array.isArray(infos)) return []
    return infos.map((info) => normalizeTags(info))
  } catch (error) {
    console.error('批量读取 native 标签失败:', error)
    return []
  }
}