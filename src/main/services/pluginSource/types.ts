/**
 * 音源插件（洛雪 LX v2 / 澜音 Ceru v2）统一类型定义
 *
 * 说明：本模块运行在主进程，负责把两类第三方插件的音乐能力归一化成
 *       一套宿主内部接口，供 IPC 层与渲染层消费。
 */

/** 插件生态种类 */
export type SourcePluginKind = 'lx' | 'ceru'

/** 平台标识：洛雪固定 kw/kg/tx/wy/mg/local；澜音为自定义 providerId */
export type SourceKey = string

/**
 * 平台标识别名组。
 *
 * 同一个上游在不同插件里写法不同：洛雪固定 `tx`，而澜音插件的 providerId 常写
 * `qq` / `tencent`。若只按字面比较，就会出现「插件已加载但按 tx 找不到」的假失败，
 * 因此宿主在匹配 sourceKey 时统一走 `expandSourceKeys()` 的等价组。
 */
const SOURCE_KEY_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['tx', 'qq', 'tencent', 'qqmusic'],
  ['wy', 'netease', 'wangyi', 'cloudmusic'],
  ['kg', 'kugou'],
  ['kw', 'kuwo'],
  ['mg', 'migu'],
  ['local', 'localmusic']
]

/**
 * 把单个平台标识展开为等价的候选标识（小写、首项为原值本身）。
 * 未登记的自定义 providerId 原样返回（小写化）。
 */
export function expandSourceKeys(sourceKey?: string): string[] {
  const raw = (sourceKey ?? '').trim()
  if (!raw) return []
  const key = raw.toLowerCase()
  const group = SOURCE_KEY_ALIAS_GROUPS.find((g) => g.includes(key))
  if (!group) return [key]
  return [key, ...group.filter((item) => item !== key)]
}

/** 两个平台标识是否等价（大小写与别名不敏感） */
export function isSameSourceKey(a?: string, b?: string): boolean {
  const left = expandSourceKeys(a)
  if (left.length === 0) return false
  const right = new Set(expandSourceKeys(b))
  return left.some((key) => right.has(key))
}

/** 归一化音质标识（低 → 高） */
export type QualityId =
  '128k' | '320k' | 'flac' | 'flac24bit' | 'hires' | 'atmos' | 'atmos_plus' | 'master'

/** 音质从低到高的排序（用于 pickQuality 回退） */
export const QUALITY_ORDER: QualityId[] = [
  '128k',
  '320k',
  'flac',
  'flac24bit',
  'hires',
  'atmos',
  'atmos_plus',
  'master'
]

/**
 * 归一化后的曲目（可映射为渲染层 SongList 的 Song / playerStore 的 PlayerSong）
 * `ref` 为不透明引用：解析播放地址/歌词时必须原样回传，宿主据此定位上游资源。
 */
export interface SourceTrack {
  /** 来源插件 id（QQ 内置搜索来源为空字符串） */
  pluginId: string
  /** 澜音 provider id（洛雪为空） */
  providerId?: string
  /** 平台标识（洛雪 kw/kg/tx/wy/mg/local；澜音为 providerId） */
  sourceKey: SourceKey
  /** 插件内曲目 id */
  id: string
  /** 不透明引用（Ceru ContentEntity.ref / vkeys 原始字段），解析时回传 */
  ref?: unknown
  title: string
  /** 已 join 的歌手名 */
  artist: string
  album?: string
  coverUrl?: string
  durationMs?: number
  qualities?: QualityId[]
  /** 是否具备可解析的播放地址 */
  playable: boolean
}

/** 插件声明的单条来源能力 */
export interface SourceCapability {
  key: SourceKey
  name: string
  /** 支持的动作：musicUrl / lyric / pic / search ... */
  actions: string[]
  qualities: QualityId[]
}

/** 插件声明的 provider（澜音） */
export interface ProviderCapability {
  id: string
  name: string
  protocols: string[]
  qualities: QualityId[]
}

/**
 * 单个音源插件的用户偏好（每个插件独立保存）
 *
 * - `sources`：启用哪些音乐源（洛雪平台 key / 澜音 providerId）。
 *   `null` / `undefined` 表示「全部启用」；空数组表示用户手动全部关闭。
 * - `quality`：该插件的首选音质，`null` 表示跟随应用全局音质。
 */
export interface SourcePreferences {
  sources?: string[] | null
  quality?: QualityId | null
}

/** 暴露给渲染层的音源插件摘要 */
export interface PluginSourceInfo {
  id: string
  kind: SourcePluginKind
  name: string
  version: string
  author?: string
  description?: string
  homepage?: string
  filePath: string
  enabled: boolean
  state: 'loaded' | 'running' | 'error' | 'disabled'
  capabilities: {
    /** 洛雪：每个平台源一条；澜音：每个 provider 一条（key 取 providerId） */
    sources: SourceCapability[]
    /** 澜音 provider 明细 */
    providers?: ProviderCapability[]
    canSearch: boolean
    canBrowsePlaylist: boolean
  }
  /** 插件通过 updateAlert 上报的更新提示 */
  updateAlert?: { log?: string; updateUrl?: string }
  /** 用户为该插件单独设置的偏好（音乐源开关 / 音质） */
  settings?: SourcePreferences
  /** 最近一次错误信息 */
  error?: string
}

/** 播放地址解析结果 */
export interface ResolveResult {
  url: string
  /** 过期时间戳（毫秒），无则视为长效 */
  expiresAt?: number
  /** 下载/请求该地址所需的请求头（防盗链、token 等） */
  requestHeaders?: Record<string, string>
}

/** 歌词结果（统一为文本，供现有 LRC 解析器消费） */
export interface LyricResult {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
}

/** 封面结果 */
export interface PicResult {
  url: string
}

/** 泛化分页结果 */
export interface PageResult<T> {
  items: T[]
  nextCursor?: string
  totalEstimate?: number
}

/** 搜索请求 */
export interface SearchRequest {
  pluginId?: string
  providerId?: string
  query: string
  limit: number
  cursor?: string
}

/** 播放地址解析请求 */
export interface ResolveRequest {
  pluginId?: string
  providerId?: string
  sourceKey?: SourceKey
  id: string
  ref?: unknown
  quality: QualityId
  /**
   * 调用方显式指定的音质（如下载面板里的选择）。
   * 优先于插件自身的音质偏好 —— 播放走插件偏好，下载尊重用户当场的选择。
   */
  qualityOverride?: QualityId
}

/** 歌词/封面请求 */
export interface LyricRequest {
  pluginId: string
  providerId?: string
  sourceKey?: SourceKey
  id: string
  ref?: unknown
}

/** 歌单请求 */
export interface PlaylistListRequest {
  pluginId: string
  providerId?: string
  ref?: unknown
  cursor?: string
  query?: string
}

/** 歌单曲目页 */
export interface PlaylistTrackPage {
  items: SourceTrack[]
  nextCursor?: string
  meta?: { name?: string; coverUrl?: string; description?: string }
}

/**
 * 单插件宿主运行时统一接口
 * 洛雪 / 澜音各自实现，注册表按能力分派调用。
 */
export interface SourceHost {
  readonly id: string
  readonly kind: SourcePluginKind
  readonly name: string
  readonly version: string
  readonly filePath: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string

  /** 初始化：执行脚本 / activate，捕获能力。失败抛错。 */
  init(): Promise<void>
  /** 释放资源（含澜音 effects 清理），幂等 */
  dispose(): Promise<void>

  /** 能力摘要（init 后可读） */
  getCapabilities?(): PluginSourceInfo['capabilities']
  /** 更新提示（洛雪 updateAlert） */
  getUpdateAlert?(): { log?: string; updateUrl?: string } | undefined
  /** 是否声明了指定 sourceKey 的 action */
  supports?(sourceKey: string | undefined, action: string): boolean
  /**
   * 把外部传入的平台标识（可能是别名，如 qq）映射为插件真正声明的 key（如 tx）。
   * 未命中返回 undefined。解析播放地址时必须使用返回的 key，否则插件会不认识。
   */
  matchSourceKey?(sourceKey: string | undefined): string | undefined

  /** 搜索（仅澜音 provider 支持） */
  search?(req: SearchRequest): Promise<PageResult<SourceTrack>>
  /** 解析播放地址 */
  resolveUrl?(req: ResolveRequest): Promise<ResolveResult>
  /** 获取歌词 */
  lyric?(req: LyricRequest): Promise<LyricResult | null>
  /** 获取封面 */
  pic?(req: LyricRequest): Promise<PicResult | null>

  /** 歌单：类目 */
  playlistCategories?(): Promise<SourceTrack[]>
  /** 歌单：搜索 */
  playlistSearch?(req: PlaylistListRequest): Promise<PageResult<SourceTrack>>
  /** 歌单：列表 */
  playlistList?(req: PlaylistListRequest): Promise<PageResult<SourceTrack>>
  /** 歌单：曲目明细 */
  playlistGet?(req: PlaylistListRequest): Promise<PlaylistTrackPage>
}

/** 加载后的插件（宿主实例 + 摘要信息） */
export interface LoadedSourcePlugin {
  info: PluginSourceInfo
  host: SourceHost
}
