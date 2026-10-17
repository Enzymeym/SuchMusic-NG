/**
 * 澜音 Ceru v2 插件相关类型
 *
 * 与 @shiqianjiang/ceru-plugin-sdk 的公开类型保持一致（仅保留宿主需要消费的部分）。
 * 参考：https://ceru.docs.shiqianjiang.cn/guide/plugins/v2/reference.html
 */

/** 插件清单（manifest） */
export interface CeruManifest {
  manifestVersion?: number
  id: string
  name: string
  version: string
  description?: string
  author?: string | { name?: string; email?: string; homepage?: string }
  homepage?: string
  engines?: { hostApi?: string; logicRuntime?: string }
  modules?: Record<string, { entry?: string; [k: string]: any }>
  contributes?: CeruContributes
  permissions?: Array<{ key: string; name?: string; description?: string } | string>
  config?: Record<string, any>
  [k: string]: any
}

export interface CeruContributes {
  commands?: Array<{ id: string; title?: string; action?: string; [k: string]: any }>
  providers?: CeruProviderDecl[]
  /** 旧版声明字段，与 providers 同义 */
  sources?: CeruProviderDecl[]
  lyricConverters?: Array<{ id: string; title?: string; formats?: string[] }>
  playlistImporters?: Array<{ id: string; title?: string; [k: string]: any }>
  surfaces?: any[]
  resources?: any[]
  [k: string]: any
}

/** Provider 声明 */
export interface CeruProviderDecl {
  id: string
  name?: string
  protocols?: string[]
  qualities?: string[]
  connectionMode?: 'none' | 'single' | 'multiple'
  icon?: { kind: 'host'; name: string } | string
  [k: string]: any
}

/** 资源引用 */
export interface ResourceRef {
  pluginId?: string
  providerId: string
  connectionId?: string
  kind: string
  id: string
  scope?: 'provider'
  data?: Record<string, any>
}

/** 曲目元数据 */
export interface TrackMetadata {
  hash?: string
  qualitySizeLabels?: Record<string, string>
  artists: string[]
  album?: { id?: string; title: string }
  qualities?: string[]
  qualitySizes?: Record<string, number>
  artworkUrl?: string
  durationMs?: number
}

/** 内容实体 */
export interface ContentEntity {
  ref: ResourceRef
  title: string
  subtitle?: string
  artwork?: { kind: 'asset'; id: string }
  playable?: boolean
  durationMs?: number
  capabilities?: string[]
  extensions?: Record<string, any>
  metadata?: TrackMetadata
  playlist?: { trackCount?: number; description?: string; author?: string; artworkUrl?: string }
  chart?: { updateFrequency?: string; artworkUrl?: string }
  [k: string]: any
}

/** 分页容器 */
export interface CeruPage<T> {
  items: T[]
  nextCursor?: string
  snapshotId?: string
  totalEstimate?: number
}

/** 播放解析结果 */
export type CeruResolveResult =
  | { ok: true; url: string; expiresAt?: number; requestHeaders?: Record<string, string> }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } }

/** 歌词行 */
export interface CeruLyricLine {
  isBackground?: boolean
  isDuet?: boolean
  startTimeMs: number
  endTimeMs?: number
  text: string
  translation?: string
  romanization?: string
  words?: Array<{ startTimeMs: number; endTimeMs: number; text: string }>
}

/** CrLyric 歌词文档 */
export interface CrLyric {
  format: 'crlyric'
  version: 1
  track: ResourceRef
  offsetMs: number
  lines: CeruLyricLine[]
  plainText?: string
}

/** 歌词文档别名（旧 SDK 名称） */
export type LyricsDocument = CrLyric

/** 搜索请求 */
export interface CeruSearchRequest {
  query: string
  kinds: string[]
  filters: Record<string, any>
  cursor?: string
  limit: number
}

/** 曲目 Provider */
export interface CeruTrackProvider {
  search?(request: CeruSearchRequest, operation: any): Promise<CeruPage<ContentEntity>>
  resolve?(
    resource: ResourceRef,
    quality: string | undefined,
    operation: any
  ): Promise<CeruResolveResult>
  lyrics?(resource: ResourceRef, operation: any): Promise<CrLyric>
}

/** 歌单 Provider */
export interface CeruPlaylistProvider {
  search?(request: CeruSearchRequest, operation: any): Promise<CeruPage<ContentEntity>>
  categories?(operation: any): Promise<CeruPage<ContentEntity>>
  list?(
    resource: ResourceRef,
    cursor: string | undefined,
    operation: any
  ): Promise<CeruPage<ContentEntity>>
  get?(
    resource: ResourceRef,
    cursor: string | undefined,
    operation: any
  ): Promise<CeruPlaylistTrackPage>
}

/** 歌单曲目页 */
export interface CeruPlaylistTrackPage {
  items: ContentEntity[]
  nextCursor?: string
  playlist?: { trackCount?: number; description?: string; author?: string; artworkUrl?: string }
  meta?: { name?: string; coverUrl?: string; description?: string }
}

/** Provider 实现（新旧字段并存） */
export interface CeruProviderImplementation {
  tracks?: CeruTrackProvider
  playlists?: CeruPlaylistProvider
  charts?: any
  sharing?: any
}
