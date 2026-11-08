/**
 * Such 插件系统（v2）主进程侧类型
 *
 * 与 `src/shared/plugin/types.ts`（纯类型、渲染层可见）分开：
 * 本文件描述沙箱内的插件脚本能看到什么，只应在主进程使用。
 */

// ==================== 版本门禁 ====================

/** 宿主支持的插件 API 级别。插件头 `@apiLevel` 高于此值将被拒绝加载。 */
export const SUCH_API_LEVEL = 1

/** 合法的授权项 */
export const SUCH_GRANTS = ['network', 'ui', 'playlist', 'system'] as const

// ==================== 插件头 ====================

/** 插件头元信息（DTO 定义在 shared，渲染层也要用） */
export type { SuchPluginHeader } from '../shared/plugin/types'

// ==================== 注册声明 ====================

/** 音源动作 */
export type SuchMusicAction = 'musicUrl' | 'musicSearch' | 'musicLyric' | 'musicPic'

/** 插件向宿主声明的单个音源 */
export interface SuchSourceDeclaration {
  /** 显示名称 */
  name: string
  /** 支持的动作 */
  actions: SuchMusicAction[]
  /** 支持的音质 */
  qualities?: string[]
}

/** `such.register({ sources, settings })` 的入参 */
export interface SuchRegisterDeclaration {
  /** 以插件内 source key 为索引的音源表 */
  sources?: Record<string, SuchSourceDeclaration>
  /** 用户可编辑的设置项 */
  settings?: unknown[]
}

// ==================== 音源数据结构 ====================

/**
 * 搜索候选。
 *
 * 会随播放队列 / 歌单持久化，**单条序列化上限 8 KiB**；只放重新拉取所需的标识与
 * 轻量字段，歌词与图片内容应在对应 handler 里按需获取。
 */
export interface SuchCandidate {
  id: string
  name: string
  singer?: string
  album?: string
  durationMs?: number
  cover?: string
  /** 其他字段原样透传给后续 handler */
  [k: string]: unknown
}

/** `musicSearch` 请求 */
export interface SuchSearchRequest {
  source: string
  keyword: string
  page?: number
  limit?: number
}

/** `musicSearch` 返回 */
export interface SuchSearchResult {
  list: SuchCandidate[]
  total?: number
  hasMore?: boolean
}

/** `musicUrl` 请求 */
export interface SuchUrlRequest {
  source: string
  musicInfo: SuchCandidate
  quality: string
}

/** `musicUrl` 返回 */
export interface SuchUrlResult {
  url: string
  quality?: string
  /** 过期时间戳（毫秒） */
  expire?: number
}

/** `musicLyric` / `musicPic` 请求 */
export interface SuchMetaRequest {
  source: string
  musicInfo: SuchCandidate
}

/** `musicLyric` 返回 */
export interface SuchLyricResult {
  lyric: string
  tlyric?: string
  rlyric?: string
  awlyric?: string
}

/** `musicPic` 返回 */
export interface SuchPicResult {
  url: string
}

// ==================== 宿主内部归一化结果 ====================

/**
 * 归一化后的曲目（结构与 pluginSource 的 `SourceTrack` 一致）。
 * 主进程的路由层负责把它转成 `SourceTrack` 交给音源注册表。
 */
export interface V2Track {
  pluginId: string
  providerId?: string
  sourceKey: string
  id: string
  ref?: unknown
  title: string
  artist: string
  album?: string
  coverUrl?: string
  durationMs?: number
  qualities?: string[]
  playable: boolean
}

/** 归一化分页结果 */
export interface V2PageResult<T> {
  items: T[]
  nextCursor?: string
  hasMore?: boolean
  totalEstimate?: number
}

/** 播放地址解析结果 */
export interface V2ResolveResult {
  url: string
  expiresAt?: number
  requestHeaders?: Record<string, string>
}

/** 歌词结果（纯文本，供现有 LRC/YRC 解析链消费） */
export interface V2LyricResult {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
  /** 逐字歌词原文（YRC/TTML/QRC），有则优先 */
  wordLyrics?: string
}

// ==================== 敏感操作确认 ====================

/** 敏感操作类型 */
export type SensitiveOperation = 'exec' | 'fileRead' | 'fileWrite' | 'fileDelete' | 'writeMeta'

/** 单个待确认操作 */
export interface PendingConfirmItem {
  opId: string
  operation: SensitiveOperation
  detail: string
}

/** 批量确认请求（main → renderer） */
export interface BatchConfirmRequest {
  requestId: string
  pluginId: string
  pluginName: string
  operations: PendingConfirmItem[]
}

/** 批量确认响应（renderer → main） */
export interface BatchConfirmResponse {
  requestId: string
  confirmed: boolean
  /** 被单独拒绝的操作（confirmed=false 时生效） */
  rejectedOpIds?: string[]
  /** 本次会话不再询问 */
  skipSession: boolean
}

// ==================== 歌单操作 ====================

/** 歌单操作请求（main → renderer） */
export interface PlaylistOpRequest {
  requestId: string
  pluginId: string
  pluginName: string
  action: 'createPlaylist' | 'addToPlaylist' | 'updatePlaylistSettings' | 'listPlaylists'
  params: Record<string, unknown>
}

/** 歌单操作响应（renderer → main） */
export interface PlaylistOpResponse {
  requestId: string
  success: boolean
  error?: string
  result?: unknown
}
