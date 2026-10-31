/**
 * 标签 → 曲目记录的字段映射（scanner 子进程内运行）。
 *
 * 这里集中处理「标签缺失时的兜底」，避免兜底逻辑散落在扫描、IPC、渲染三层：
 * - 标题：专辑标签 → 文件名（去常见音轨号前缀）
 * - 艺术家：标签 → 空数组（渲染层再统一成「未知歌手」）
 * - 专辑：标签 → 所在目录名（保持旧版本「目录名当专辑」的观感）
 * - 编码：标签 fileFormat → 扩展名推断
 */
import type { ScannedTrack } from '../../../../shared/library/types'
import { baseName } from '../../../../shared/library/normalize'
import type { NativeTags } from '../../../tagReaderCore'
import type { ResolvedAudioMeta } from '../../../audioMetaResolver'
import { guessCodec, type WalkedFile } from './walk'
import type { CoverRef } from './coverWriter'

/** 去掉文件名里的音轨号前缀：`01 - `、`01.`、`01 `、`01_` */
const TRACK_PREFIX = /^\s*\d{1,3}\s*[-._)\]]?\s+/

/** 常见「艺术家 - 标题」文件名形态，仅在标签完全缺失时使用 */
const ARTIST_TITLE = /^(.+?)\s+-\s+(.+)$/

export function titleFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const raw = dot > 0 ? fileName.slice(0, dot) : fileName
  return raw.replace(TRACK_PREFIX, '').trim() || raw
}

/** 标签完全没有艺术家时，从「A - B」文件名里猜一次（不需要精确，只为可读） */
function artistsFromFileName(fileName: string): string[] {
  const title = titleFromFileName(fileName)
  const match = ARTIST_TITLE.exec(title)
  if (!match) return []
  const artist = match[1].trim()
  return artist ? [artist] : []
}

function titleFromArtistTitleFile(fileName: string): string {
  const title = titleFromFileName(fileName)
  const match = ARTIST_TITLE.exec(title)
  return match ? match[2].trim() || title : title
}

function albumFallback(file: WalkedFile): string {
  return baseName(file.folderPath) || '未知专辑'
}

function normaliseNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 用批量读取到的原生标签构造曲目 */
export function buildTrackFromTags(
  file: WalkedFile,
  tags: NativeTags | null,
  cover: CoverRef | null,
  sidecarLyrics: string | undefined
): ScannedTrack {
  const hasTagArtist = !!tags?.artists && tags.artists.length > 0
  const artists = hasTagArtist ? tags!.artists! : artistsFromFileName(file.fileName)
  const hasTagTitle = !!tags?.title && tags.title.trim().length > 0

  return {
    filePath: file.filePath,
    fileName: file.fileName,
    folderPath: file.folderPath,
    rootPath: file.rootPath,
    relDir: file.relDir,
    size: file.size,
    mtimeMs: file.mtimeMs,
    title: hasTagTitle ? tags!.title!.trim() : titleFromArtistTitleFile(file.fileName),
    artists,
    album: tags?.album?.trim() || albumFallback(file),
    albumArtist: tags?.albumArtist,
    trackNo: normaliseNumber(tags?.track),
    discNo: normaliseNumber(tags?.disc),
    year: normaliseNumber(tags?.year),
    genre: tags?.genre,
    durationMs: normaliseNumber(tags?.durationMs),
    bitrate: normaliseNumber(tags?.bitrate),
    sampleRate: normaliseNumber(tags?.sampleRate),
    bitsPerSample: normaliseNumber(tags?.bitsPerSample),
    channels: normaliseNumber(tags?.channels),
    codec: tags?.codec || tags?.fileFormat || guessCodec(file.fileName),
    coverHash: cover?.hash,
    coverExt: cover?.ext,
    hasLyrics: !!(sidecarLyrics || tags?.lyrics)
  }
}

/** 用完整解析链（native → music-metadata → 手动嗅探）的结果构造曲目 */
export function buildTrackFromResolved(
  file: WalkedFile,
  meta: ResolvedAudioMeta,
  cover: CoverRef | null
): ScannedTrack {
  const artists = meta.artists.length > 0 ? meta.artists : artistsFromFileName(file.fileName)
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    folderPath: file.folderPath,
    rootPath: file.rootPath,
    relDir: file.relDir,
    size: file.size,
    mtimeMs: file.mtimeMs,
    title: meta.title?.trim() || titleFromArtistTitleFile(file.fileName),
    artists,
    album: meta.album?.trim() || albumFallback(file),
    trackNo: undefined,
    discNo: undefined,
    year: normaliseNumber(meta.year),
    genre: undefined,
    durationMs: normaliseNumber(meta.durationMs),
    bitrate: normaliseNumber(meta.bitrate),
    sampleRate: normaliseNumber(meta.sampleRate),
    bitsPerSample: normaliseNumber(meta.bitsPerSample),
    channels: normaliseNumber(meta.channels),
    codec: meta.codec || guessCodec(file.fileName),
    coverHash: cover?.hash,
    coverExt: cover?.ext,
    hasLyrics: !!meta.lyrics
  }
}
