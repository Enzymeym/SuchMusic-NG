/**
 * 本地音频元数据解析编排器。
 *
 * 三个解析器按「能力」而非「顺序」协作：
 * - native（lofty，`music_tag_reader.node`）：最快，字段最全，作为首选
 * - music-metadata：容器格式支持面最广，作为第二意见
 * - 手动嗅探（`musicMetaReader`）：连容器都读不动时的最后兜底
 *
 * 关键设计：**逐字段合并 + 封面独立多源回退**。
 * 旧实现只要 native 返回了对象就直接 `return`，即使 `cover` 为空也不再询问
 * 其它解析器，导致「lofty 能打开文件但读不到 picture」的歌永远没有封面。
 */
import { promises as fs } from 'fs'
import { readTagsWith, type NativeTagReader, type NativeTags } from './tagReaderCore'
import { readMetaManually, type ManualMeta } from '../utils/musicMetaReader'
import { finalizeCoverRaw, isUsableCoverData } from '../utils/imageSniff'

/** 封面来源，用于日志与诊断 */
export type CoverSource = 'native' | 'music-metadata' | 'manual'

export interface ResolvedCover {
  mimeType: string
  /** 仅 coverFormat='base64' 时有值 */
  base64: string
  source: CoverSource
  bytes: number
}

/** 裸字节封面：曲库扫描走这条路径，直接按内容哈希落盘 */
export interface ResolvedCoverRaw {
  mimeType: string
  data: Uint8Array
  source: CoverSource
  bytes: number
}

export interface ResolvedAudioMeta {
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  /** 采样精度（位深） */
  bitsPerSample?: number
  channels?: number
  /** 容器/编码格式，如 FLAC / MP3 */
  codec?: string
  cover?: ResolvedCover
  /** coverFormat='raw' 时的封面（与 cover 互斥） */
  coverData?: ResolvedCoverRaw
  title?: string
  artists: string[]
  album?: string
  lyrics?: string
  year?: number
  /** 主要字段来源（保持 IPC 旧字段语义：native 或 js 解析链） */
  source: 'native' | 'js'
}

/** 超过这个体积就不再为「补时长」去整轨读一遍文件（封面解析仍然照常，它只读头部） */
const MM_MAX_FILE_BYTES = 300 * 1024 * 1024

/**
 * 明确不是封面的 ID3 APIC 类型码：图标(1/2)、封底(4)、宣传册(5)、
 * 媒体图(6)、主要艺人照(7)、艺人照(8)。
 *
 * 只有命中这些类型才会考虑再向 music-metadata 求证是否有更好的前封面 ——
 * 很多抓轨工具把封面写成 0(Other) 而不是 3(CoverFront)，那种情况必须当成
 * 正常封面接受，否则会给整个曲库平白多跑一遍 mm。
 */
const NON_COVER_PICTURE_TYPES = new Set([1, 2, 4, 5, 6, 7, 8])

/** 封面候选：还没做 MIME 裁决与 base64，只描述来源与原始字节 */
interface CoverCandidate {
  source: CoverSource
  mimeType?: string
  data: Uint8Array
  /** true=前封面，false=其它类型，undefined=未知（老版 native 模块不返回类型） */
  isFront?: boolean
}

/** 推理过程中的可变字段容器；只补缺失，绝不覆盖 */
interface TagFields {
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  bitsPerSample?: number
  channels?: number
  codec?: string
  title?: string
  artists: string[]
  album?: string
  year?: number
  lyrics?: string
}

// 懒加载 music-metadata，避免主进程启动时就解析这个 ESM 包
let _mmParseFile:
  | ((filePath: string, options?: Record<string, unknown>) => Promise<unknown>)
  | null = null

async function getMusicMetadataParser(): Promise<
  (filePath: string, options?: Record<string, unknown>) => Promise<unknown>
> {
  if (_mmParseFile) return _mmParseFile
  const mm = await import('music-metadata')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mmParseFile = (mm as any).parseFile as (
    filePath: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>
  return _mmParseFile
}

/** native 返回的 APIC 类型码 → 是否前封面：3=是，命中 NON_COVER=否，其余未知 */
function nativeFrontFlag(pictureType: number | undefined): boolean | undefined {
  if (pictureType === 3) return true
  if (pictureType !== undefined && NON_COVER_PICTURE_TYPES.has(pictureType)) return false
  return undefined
}

/** 前封面优先，其次未知类型，最后才是封底/艺人照 */
function coverRank(c: CoverCandidate): number {
  if (c.isFront === true) return 0
  if (c.isFront === undefined) return 1
  return 2
}

/** 通过裁决的封面候选（裸字节） */
interface PickedCover {
  mimeType: string
  source: CoverSource
  bytes: number
  data: Uint8Array
}

/** 按优先级挑第一个能通过 MIME 裁决与大小校验的候选 */
function pickCover(candidates: CoverCandidate[]): PickedCover | undefined {
  const ordered = candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => coverRank(a.c) - coverRank(b.c) || a.index - b.index)
    .map((entry) => entry.c)

  for (const candidate of ordered) {
    const normalized = finalizeCoverRaw(candidate.mimeType, candidate.data)
    if (normalized) {
      return {
        mimeType: normalized.mimeType,
        source: candidate.source,
        bytes: normalized.bytes,
        data: normalized.data
      }
    }
  }
  return undefined
}

/** 同名 `.lrc` 覆盖标签内歌词（路径不含扩展名时原样拼 .lrc，避免 substring(0,-1) 的旧缺陷） */
async function readSidecarLyrics(filePath: string): Promise<string | undefined> {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dot = filePath.lastIndexOf('.')
  const base = dot > slash ? filePath.slice(0, dot) : filePath
  try {
    const content = await fs.readFile(base + '.lrc', 'utf-8')
    return content || undefined
  } catch {
    return undefined
  }
}

function mergeNativeFields(fields: TagFields, native: NativeTags): void {
  fields.durationMs ??= native.durationMs
  fields.bitrate ??= native.bitrate
  fields.sampleRate ??= native.sampleRate
  fields.bitsPerSample ??= native.bitsPerSample
  fields.channels ??= native.channels
  fields.codec ??= native.codec ?? native.fileFormat
  fields.title ??= native.title
  fields.album ??= native.album
  fields.year ??= native.year
  fields.lyrics ??= native.lyrics
  if (fields.artists.length === 0 && native.artists && native.artists.length > 0) {
    fields.artists = [...native.artists]
  }
}

function mergeManualFields(fields: TagFields, manual: ManualMeta): void {
  fields.durationMs ??= manual.durationMs
  fields.bitrate ??= manual.bitrate
  fields.sampleRate ??= manual.sampleRate
  fields.title ??= manual.title
  fields.album ??= manual.album
  fields.year ??= manual.year
  if (fields.artists.length === 0 && manual.artists && manual.artists.length > 0) {
    fields.artists = [...manual.artists]
  }
}

interface MusicMetadataResult {
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  bitsPerSample?: number
  channels?: number
  codec?: string
  title?: string
  artists: string[]
  album?: string
  year?: number
  lyrics?: string
  pictures: CoverCandidate[]
}

/**
 * `{ duration: true }` 会在必要时把整个文件读一遍。
 *
 * 超大文件（现场录音、DSD 转录）跳过这一步：时长交给播放时的音频引擎按解码
 * 结果回填，宁可少一个时长也不要让整库扫描卡在单个文件上。
 */
async function canAffordFullScan(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.size <= MM_MAX_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * 跑一遍 music-metadata。
 *
 * 注意：只有 `{ duration: true }` 才会触发「必要时读完整文件」，因此默认不带它；
 * 时长缺失时由调用方单独重试一次。
 */
async function parseWithMusicMetadata(
  filePath: string,
  withDuration = false
): Promise<MusicMetadataResult | null> {
  const parseFile = await getMusicMetadataParser()
  let metadata: unknown
  try {
    metadata = await parseFile(filePath, withDuration ? { duration: true } : undefined)
  } catch (error) {
    console.warn('[audioMeta] music-metadata 解析失败:', filePath, error)
    return null
  }

  // 所有字段一律可选链访问：两次解析都失败时 metadata 可能是空对象，
  // 旧实现在这里直接 `m.common.picture` 会抛 TypeError 并被外层吞掉。
  const m = (metadata ?? {}) as {
    format?: {
      duration?: number
      numberOfSamples?: number
      sampleRate?: number
      bitrate?: number
      bitsPerSample?: number
      bitsPerPixel?: number
      numberOfChannels?: number
      codec?: string
      container?: string
    }
    common?: {
      title?: string
      artist?: string
      artists?: string[]
      album?: string
      year?: number
      lyrics?: string[]
      picture?: Array<{ format?: string; data?: Uint8Array; type?: string }>
    }
  }

  const format = m.format
  const common = m.common
  const seconds = format?.duration
  let durationMs: number | undefined
  if (seconds && Number.isFinite(seconds)) {
    durationMs = Math.round(seconds * 1000)
  } else if (
    typeof format?.numberOfSamples === 'number' &&
    typeof format?.sampleRate === 'number' &&
    format.numberOfSamples > 0 &&
    format.sampleRate > 0
  ) {
    durationMs = Math.round((format.numberOfSamples / format.sampleRate) * 1000)
  }

  const artists: string[] = []
  if (Array.isArray(common?.artists)) {
    for (const a of common.artists) {
      const s = String(a || '').trim()
      if (s) artists.push(s)
    }
  }
  if (artists.length === 0 && typeof common?.artist === 'string') {
    const s = common.artist.trim()
    if (s) artists.push(s)
  }

  const pictures: CoverCandidate[] = []
  for (const p of common?.picture ?? []) {
    const data = p?.data
    // 只收真正像图片的字节：畸形小图收进来会让「缺封面」的判定失效
    if (!data || !isUsableCoverData(data)) continue
    pictures.push({
      source: 'music-metadata',
      mimeType: p?.format,
      data,
      isFront: typeof p?.type === 'string' ? /front/i.test(p.type) : undefined
    })
  }
  // 前封面优先，同类型取最大（分辨率通常更高）
  pictures.sort((a, b) => coverRank(a) - coverRank(b) || b.data.length - a.data.length)

  return {
    durationMs,
    bitrate: format?.bitrate,
    sampleRate: format?.sampleRate,
    bitsPerSample: format?.bitsPerSample ?? format?.bitsPerPixel,
    channels: format?.numberOfChannels,
    codec: format?.codec ?? format?.container,
    title: common?.title?.trim() || undefined,
    artists,
    album: common?.album?.trim() || undefined,
    year: common?.year,
    lyrics: common?.lyrics?.[0],
    pictures
  }
}

/**
 * 解析单个本地音频文件的元数据与封面。
 *
 * @param opts.includeCover=false 时只取歌词/时长等轻量字段：既不解析封面，
 *   也不会因为封面缺失去跑 music-metadata 或手动嗅探（播放条取歌词的快路径）。
 * @param opts.coverFormat='base64'（默认）时封面编码成 base64 走 IPC；
 *   'raw' 时只返回裸字节，供曲库扫描直接按内容哈希落盘。
 * @param opts.reader 原生标签读取器。由调用方注入（主进程用 nativeModuleLoader
 *   加载，scanner 子进程用主进程传入的绝对路径加载），本模块不依赖 electron。
 */
export async function resolveAudioMeta(
  filePath: string,
  opts?: {
    includeCover?: boolean
    coverFormat?: 'base64' | 'raw'
    reader?: NativeTagReader | null
  }
): Promise<ResolvedAudioMeta> {
  const includeCover = opts?.includeCover !== false
  const coverFormat = opts?.coverFormat ?? 'base64'
  const fields: TagFields = { artists: [] }
  const candidates: CoverCandidate[] = []

  // ---- 1. native（lofty）----
  let nativeOk = false
  let nativePictureType: number | undefined
  try {
    const native = await readTagsWith(opts?.reader ?? null, filePath, { includeCover })
    if (native !== null) {
      nativeOk = true
      mergeNativeFields(fields, native)
      nativePictureType = native.pictureType
      if (includeCover && native.cover && isUsableCoverData(native.cover.data)) {
        candidates.push({
          source: 'native',
          mimeType: native.cover.mimeType,
          data: native.cover.data,
          isFront: nativeFrontFlag(nativePictureType)
        })
      }
    }
  } catch (error) {
    console.warn('[audioMeta] native 标签读取抛错:', filePath, error)
  }

  // ---- 2. music-metadata（第二意见：补字段 + 补封面）----
  // 需要向第二源求证的条件：
  // - native 完全没返回（null / UNAVAILABLE）→ 字段与封面都得靠别人
  // - 需要封面但一个候选都没有 → 这是本次修复的核心分支
  // - native 明确给了「非前封面」→ 可能存在更好的前封面
  const needCover = includeCover && candidates.length === 0
  const nativeCoverNotFront =
    includeCover &&
    candidates.length > 0 &&
    nativePictureType !== undefined &&
    NON_COVER_PICTURE_TYPES.has(nativePictureType)
  const needsSecondOpinion = !nativeOk || needCover || nativeCoverNotFront

  let mmRan = false
  if (needsSecondOpinion) {
    // 不带 duration 的解析只读头部/随机 seek，不需要按文件体积设闸门；
    // 真正昂贵的是下面的 duration:true 重试，那里才按体积跳过。
    const mm = await parseWithMusicMetadata(filePath)
    if (mm) {
      mmRan = true
      fields.durationMs ??= mm.durationMs
      fields.bitrate ??= mm.bitrate
      fields.sampleRate ??= mm.sampleRate
      fields.bitsPerSample ??= mm.bitsPerSample
      fields.channels ??= mm.channels
      fields.codec ??= mm.codec
      fields.title ??= mm.title
      fields.album ??= mm.album
      fields.year ??= mm.year
      fields.lyrics ??= mm.lyrics
      if (fields.artists.length === 0 && mm.artists.length > 0) fields.artists = mm.artists
      if (includeCover) candidates.push(...mm.pictures)
    }
  }

  // ---- 3. 手动嗅探兜底（只有确实缺封面时才跑）----
  if (includeCover && candidates.length === 0) {
    try {
      const manual = await readMetaManually(filePath)
      if (manual) {
        mergeManualFields(fields, manual)
        if (manual.cover && isUsableCoverData(manual.cover.data)) {
          candidates.push({
            source: 'manual',
            mimeType: manual.cover.mimeType,
            data: manual.cover.data
          })
        }
      }
    } catch (error) {
      console.warn('[audioMeta] 手动嗅探失败:', filePath, error)
    }
  }

  // ---- 4. 时长兜底：只有解析过 mm 且仍缺时长时，才付一次整轨扫描的代价 ----
  if (fields.durationMs === undefined && mmRan && (await canAffordFullScan(filePath))) {
    const mm = await parseWithMusicMetadata(filePath, true)
    if (mm?.durationMs !== undefined) {
      fields.durationMs = mm.durationMs
      fields.bitrate ??= mm.bitrate
      fields.sampleRate ??= mm.sampleRate
      fields.bitsPerSample ??= mm.bitsPerSample
      fields.channels ??= mm.channels
      fields.codec ??= mm.codec
    }
  }

  // ---- 5. 同名 .lrc 覆盖标签歌词（唯一一处实现）----
  const sidecar = await readSidecarLyrics(filePath)
  const lyrics = sidecar ?? fields.lyrics

  const pick = includeCover ? pickCover(candidates) : undefined

  if (includeCover && !pick && process.env.SUCH_DEBUG_COVER === '1') {
    // 整库扫描时这类日志可能上千条，默认关闭，用 SUCH_DEBUG_COVER=1 或
    // scripts/diagnose-cover.mjs 做排查
    console.warn('[audioMeta] 三个解析器都没取到可用封面:', filePath)
  }

  const rawCover: ResolvedCoverRaw | undefined =
    pick && coverFormat === 'raw'
      ? { mimeType: pick.mimeType, data: pick.data, source: pick.source, bytes: pick.bytes }
      : undefined
  const base64Cover: ResolvedCover | undefined =
    pick && coverFormat === 'base64'
      ? {
          mimeType: pick.mimeType,
          base64: Buffer.from(pick.data).toString('base64'),
          source: pick.source,
          bytes: pick.bytes
        }
      : undefined

  return {
    durationMs: fields.durationMs,
    bitrate: fields.bitrate,
    sampleRate: fields.sampleRate,
    bitsPerSample: fields.bitsPerSample,
    channels: fields.channels,
    codec: fields.codec,
    cover: base64Cover,
    coverData: rawCover,
    title: fields.title,
    artists: fields.artists,
    album: fields.album,
    lyrics,
    year: fields.year,
    source: nativeOk ? 'native' : 'js'
  }
}
