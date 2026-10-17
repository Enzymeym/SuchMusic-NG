/**
 * 音源插件（洛雪 / 澜音）渲染层辅助函数
 *
 * 统一「把 PlayerSong 交给主进程的音源插件注册表解析」的调用方式，
 * 供下载、播放重解析、歌词获取、搜索页多处复用。
 */
import type { PlayerSong } from '../stores/playerStore'
import type { PlaylistTrack } from '../stores/playlistStore'

/** 归一化音质标识（与主进程 QualityId 对齐） */
export type SourceQuality = '128k' | '320k' | 'flac' | 'flac24bit' | 'hires'

/** 播放地址解析结果（与主进程 ResolveResult 对齐） */
export interface PluginResolveResult {
  url: string
  expiresAt?: number
  requestHeaders?: Record<string, string>
}

/** 歌词结果（与主进程 LyricResult 对齐） */
export interface PluginLyricResult {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
}

/** 平台来源别名归一化：netease→wy / qq|tencent→tx / kugou→kg / kuwo→kw / migu→mg */
export function normalizeSourceKey(source?: string): string {
  switch ((source || '').toLowerCase()) {
    case 'netease':
    case 'wangyi':
    case 'cloudmusic':
      return 'wy'
    case 'qq':
    case 'tencent':
    case 'qqmusic':
      return 'tx'
    case 'kugou':
      return 'kg'
    case 'kuwo':
      return 'kw'
    case 'migu':
      return 'mg'
    default:
      return source || ''
  }
}

/** 应用内音质等级 → 音源插件音质标识 */
export function toSourceQuality(level?: string): SourceQuality {
  switch (level) {
    case 'flac':
    case 'lossless':
      return 'flac'
    case 'flac24bit':
    case 'hires':
      return (level as SourceQuality) ?? 'flac'
    case '192k':
    case '320k':
      return '320k'
    default:
      return '128k'
  }
}

/**
 * 是否为「需要走音源插件解析」的歌曲。
 *
 * - 携带 `pluginId` / `providerId` / `trackRef` 任一 → 明确属于插件曲目
 * - 内置 QQ 搜索（vkeys）曲目会记录 `sourceKey: 'tx'` → 同样走插件
 *
 * 注意：不能仅凭 `source === 'qq' | 'tx'` 判定，否则会把历史遗留的
 * snowdrop QQ 曲目误路由到插件，导致原本可播的曲目解析失败。
 */
export function isPluginSong(song: PlayerSong): boolean {
  const s = song as any
  if (s.pluginId || s.providerId || s.trackRef) return true
  return s.sourceKey === 'tx'
}

/**
 * 深拷贝成「可结构化克隆」的纯数据。
 *
 * 搜索结果放在 `ref([])` 里，读出来的 `song.trackRef` 是 Vue 的响应式 Proxy；
 * Proxy 无法跨进程传输，直接 `invoke` 会抛 `An object could not be cloned.`。
 * （preload 里还有一层同样的兜底，这里做是为了让请求体本身就是纯数据。）
 */
export function toCloneable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => toCloneable(item, seen)) as unknown as T
  if (seen.has(value as object)) return undefined as unknown as T
  seen.add(value as object)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'function' || typeof v === 'symbol') continue
    out[key] = toCloneable(v, seen)
  }
  return out as T
}

/** 组装主进程 resolve-url / lyric 请求体（纯数据，可安全跨 IPC） */
function buildRequest(song: PlayerSong, sourceKey: string) {
  const s = song as any
  return toCloneable({
    pluginId: s.pluginId || undefined,
    providerId: s.providerId || undefined,
    sourceKey: sourceKey || undefined,
    id: String(s.sourceSongId ?? s.id ?? ''),
    ref: s.trackRef
  })
}

/**
 * 通过音源插件解析播放地址，**保留失败原因**。
 *
 * 旧实现把所有失败都吞成 `null`，调用方只能显示「未找到音源插件」，
 * 于是「插件已加载但解析失败（网络/版权/音质）」也被误导成「没有插件」。
 */
export interface PluginResolveDetail extends Partial<PluginResolveResult> {
  /** 解析成功时的播放地址 */
  url?: string
  /** 失败原因（主进程返回的可读说明） */
  error?: string
  /** 主进程错误码，见 SourcePluginErrorCode */
  code?: string
}

export async function resolvePluginUrlDetailed(
  song: PlayerSong,
  quality: SourceQuality = '320k',
  /**
   * 是否为「调用方显式指定音质」（下载面板里的选择）。
   * 为 false 时主进程会让插件自身的音质偏好优先，保证每个插件设置相互独立。
   */
  explicitQuality = false
): Promise<PluginResolveDetail> {
  const sourceKey = normalizeSourceKey((song as any).sourceKey || song.source)
  try {
    const res = await window.api.sources.resolveUrl({
      ...buildRequest(song, sourceKey),
      quality,
      qualityOverride: explicitQuality ? quality : undefined
    })
    if (res?.success && res.result?.url) {
      return res.result as PluginResolveDetail
    }
    return {
      error: res?.error || '音源插件未返回播放地址',
      code: res?.code || 'RESOLVE_FAILED'
    }
  } catch (e: any) {
    console.warn('[pluginSource] 解析播放地址失败:', e)
    return {
      error: `无法调用音源插件：${e?.message || String(e)}`,
      code: 'IPC_ERROR'
    }
  }
}

/**
 * 通过音源插件解析播放地址。
 * 优先使用歌曲自身携带的 pluginId；否则按 sourceKey（如 tx）在已启用插件中查找。
 * @returns 解析结果，失败或未命中返回 null（调用方可回退到内置音源）
 */
export async function resolvePluginUrl(
  song: PlayerSong,
  quality: SourceQuality = '320k',
  explicitQuality = false
): Promise<PluginResolveResult | null> {
  const detail = await resolvePluginUrlDetailed(song, quality, explicitQuality)
  if (!detail.url) return null
  return detail as PluginResolveResult
}

/** 通过音源插件获取歌词（需歌曲携带 pluginId） */
export async function fetchPluginLyric(song: PlayerSong): Promise<PluginLyricResult | null> {
  const s = song as any
  if (!s.pluginId) return null
  const sourceKey = normalizeSourceKey(s.sourceKey || s.source)
  try {
    const res = await window.api.sources.lyric({
      ...buildRequest(song, sourceKey)
    })
    if (res?.success && res.result) {
      return res.result as PluginLyricResult
    }
    return null
  } catch (e) {
    console.warn('[pluginSource] 获取歌词失败:', e)
    return null
  }
}

/** 通过音源插件获取封面（需歌曲携带 pluginId） */
export async function fetchPluginPic(song: PlayerSong): Promise<string | null> {
  const s = song as any
  if (!s.pluginId) return null
  const sourceKey = normalizeSourceKey(s.sourceKey || s.source)
  try {
    const res = await window.api.sources.pic({
      ...buildRequest(song, sourceKey)
    })
    if (res?.success && res.result?.url) {
      return res.result.url as string
    }
    return null
  } catch (e) {
    console.warn('[pluginSource] 获取封面失败:', e)
    return null
  }
}

/**
 * 主进程 SourceTrack（或搜索页曲目对象）→ 歌单曲目。
 * 保留插件解析所需的全部元数据，避免导入歌单后无法重新解析播放地址。
 */
export function sourceTrackToPlaylistTrack(track: any, fallbackPluginId?: string): PlaylistTrack {
  const sourceKey = normalizeSourceKey(track?.sourceKey || track?.source)
  return {
    id: track?.id ?? track?.sourceSongId ?? null,
    title: track?.title || track?.name || '未知歌曲',
    artist: track?.artist || '未知歌手',
    album: track?.album,
    cover: track?.coverUrl || track?.picUrl || undefined,
    durationMs: track?.durationMs ?? track?.dt ?? undefined,
    source: sourceKey || 'tx',
    sourceKey: sourceKey || undefined,
    sourceSongId: track?.sourceSongId ?? track?.id,
    pluginId: track?.pluginId || fallbackPluginId,
    providerId: track?.providerId,
    trackRef: track?.ref ?? track?.trackRef,
    requestHeaders: track?.requestHeaders
  }
}
