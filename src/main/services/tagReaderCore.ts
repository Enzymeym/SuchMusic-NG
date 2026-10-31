/**
 * 原生标签读取的**纯核心**：不依赖 electron，主进程与 scanner 子进程共用。
 *
 * 拆出来的原因：`utilityProcess` 里拿不到 `app`，而原来的
 * `tagReaderService` 顶部就 `import { app } from 'electron'`（用于路径探测）。
 * 现在路径探测留在 electron 侧（`tagReaderService.ts`），本文件只负责
 * 「给定一个已加载的模块，怎么把标签读出来并规范化」。
 *
 * 需要 `require()` 原生模块的只有 `loadTagReaderFromPath()`，它只接收
 * 主进程解析好的绝对路径，不做任何目录猜测。
 */

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
  /** 文件内图片总数（仅 includeCover=true 时有值），用于诊断 */
  pictureCount?: number
  /** 选中图片的 ID3 APIC 类型码：3=前封面 4=封底 0=其他 */
  pictureType?: number
  durationMs?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  bitrate?: number
  fileFormat?: string
}

/**
 * 原生模块的导出面。
 *
 * `readMany` 在 Rust 侧几乎必然是异步任务（否则会在 N-API 线程上阻塞），
 * 但不同版本的实现可能是同步返回数组。两种都接受 —— 调用方一律 `await`，
 * 并对返回长度做对齐校验。
 */
export interface NativeTagReader {
  readTags?: (path: string, options?: { includeCover?: boolean }) => NativeTagInfo | null
  readMany?: (
    paths: string[],
    options?: { includeCover?: boolean }
  ) => Array<NativeTagInfo | null> | Promise<Array<NativeTagInfo | null>>
  default?: NativeTagReader
}

/** 规范化后的标签结构（跨 IPC / 跨进程使用） */
export interface NativeTags {
  source: 'native'
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  /** 采样精度（位深）：无损格式才有意义 */
  bitsPerSample?: number
  channels?: number
  /** 容器/编码格式，如 FLAC / MP3 */
  codec?: string
  /**
   * 封面原始字节。MIME 可能是空串或脏值，编码与裁决统一交给
   * imageSniff.finalizeCover 在解析出口完成，这里不做猜测与 base64。
   */
  cover?: { mimeType?: string; data: Uint8Array }
  /** 选中图片的 APIC 类型码（3=前封面），供上层判断是否需要再向其它解析器求证 */
  pictureType?: number
  pictureCount?: number
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

/** 从模块导出里解析出真正可用的 readTags / readMany（兼容 default 包装） */
export function resolveReader(module: NativeTagReader): {
  readTags: ((path: string, options?: { includeCover?: boolean }) => NativeTagInfo | null) | null
  readMany: NativeTagReader['readMany'] | null
} {
  const readTags = module.readTags || module.default?.readTags || null
  const readMany = module.readMany || module.default?.readMany || null
  return { readTags, readMany }
}

/**
 * 按主进程给出的绝对路径加载原生模块。
 *
 * 失败时返回 null 而不是抛错 —— 非 Windows 平台本来就没有这份二进制，
 * 整个扫描链路会自动退回 music-metadata。
 */
export function loadTagReaderFromPath(nativePath: string | undefined): NativeTagReader | null {
  if (!nativePath) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(nativePath) as NativeTagReader
    if (!mod) return null
    const { readTags } = resolveReader(mod)
    return typeof readTags === 'function' ? mod : null
  } catch (error) {
    console.warn('[music_tag_reader] 子进程加载失败:', nativePath, error)
    return null
  }
}

/** 将 napi 返回的 TagInfo 规范化为高层结构 */
export function normalizeTags(info: NativeTagInfo | null): NativeTags | null {
  if (!info) return null

  const trimStr = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.trim() || undefined : undefined

  let artists: string[] | undefined
  if (Array.isArray(info.artists) && info.artists.some((a) => typeof a === 'string' && a.trim())) {
    artists = info.artists.map((a) => String(a || '').trim()).filter((a) => a.length > 0)
  } else if (typeof info.artist === 'string' && info.artist.trim()) {
    // 单一 artist 字符串按 '/' 或 ',' 拆分（music-metadata 风格）
    artists = info.artist
      .split(/[/,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  let cover: { mimeType?: string; data: Uint8Array } | undefined
  if (info.picture && info.picture.data && info.picture.data.byteLength > 0) {
    cover = {
      mimeType: info.picture.mimeType || undefined,
      data: info.picture.data
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
    bitsPerSample: info.bitDepth,
    channels: info.channels,
    codec: trimStr(info.fileFormat),
    cover,
    pictureType: info.pictureType,
    pictureCount: info.pictureCount,
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

/** 读取单个文件的标签；模块级异常一律吞掉并返回 null（callers 会降级） */
export async function readTagsWith(
  reader: NativeTagReader | null,
  filePath: string,
  opts?: { includeCover?: boolean }
): Promise<NativeTags | null> {
  if (!reader) return null
  const { readTags } = resolveReader(reader)
  if (typeof readTags !== 'function') return null
  try {
    const info = readTags(filePath, opts)
    return normalizeTags(info)
  } catch (error) {
    console.error('读取 native 标签失败:', filePath, error)
    return null
  }
}

/**
 * 批量读取标签。
 *
 * 三个必须做的防御（旧实现缺失，导致 readMany 静默退化成空数组）：
 * 1. `await` —— 异步实现直接返回 Promise，`Array.isArray(Promise)` 为 false；
 * 2. 长度对齐 —— 长度不符时不能按索引 map，否则整批数据错位；
 * 3. 结果按索引回填后与入参一一对应，任一项为 null 表示该文件不可读。
 */
export async function readManyTagsWith(
  reader: NativeTagReader | null,
  filePaths: string[],
  opts?: { includeCover?: boolean }
): Promise<Array<NativeTags | null>> {
  if (!reader || filePaths.length === 0) return filePaths.map(() => null)
  const { readMany } = resolveReader(reader)

  if (typeof readMany === 'function') {
    try {
      const raw = await readMany(filePaths, opts)
      if (Array.isArray(raw) && raw.length === filePaths.length) {
        return raw.map((info) => normalizeTags(info))
      }
      if (Array.isArray(raw)) {
        console.warn(
          `[music_tag_reader] readMany 返回长度不匹配（${raw.length} != ${filePaths.length}），回退逐文件读取`
        )
      }
    } catch (error) {
      console.warn('[music_tag_reader] readMany 调用失败，回退逐文件读取:', error)
    }
  }

  const results: Array<NativeTags | null> = []
  for (const fp of filePaths) {
    results.push(await readTagsWith(reader, fp, opts))
  }
  return results
}

/** 探测 readMany 是否可用（不依赖文件内容，仅用于日志与降级决策） */
export function describeReader(reader: NativeTagReader | null): string {
  if (!reader) return 'unavailable'
  const { readTags, readMany } = resolveReader(reader)
  return `readTags=${typeof readTags === 'function'} readMany=${typeof readMany === 'function'}`
}
