/**
 * 网易云音乐服务
 * 基于 https://api.enzymeym.top/docs/#/ （网易云音乐 API Enhanced）提供歌曲搜索、播放地址、热搜等基础能力
 */

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { getNeteaseCoverUrl } from './lyricService'
import { parseVipInfo, rebindAccountIdentity } from './neteaseAccount'

/** 网易云 API 基础地址 */
const API_BASE = 'https://api.enzymeym.top'

/** 已登录账号列表（内存态），支持多账号 */
let neteaseAccounts: NeteaseAccount[] = []

/** 当前活跃账号 userId（空表示未登录） */
let activeUserId = ''

/** 账号持久化文件路径 */
const accountsFilePath = (): string => join(app.getPath('userData'), 'netease-accounts.json')

/** 旧版单账号 Cookie 文件路径（用于迁移） */
const legacyCookieFilePath = (): string => join(app.getPath('userData'), 'netease-cookie.json')

/** 搜索结果中的歌曲结构（原始 API 返回） */
interface WyRawSong {
  id: number
  name: string
  // 搜索接口字段：artists / album / duration / mvid
  artists?: { id: number; name: string }[]
  album?: { id: number; name: string; picId?: number; picUrl?: string }
  duration?: number
  mvid?: number
  // 歌单/详情接口字段：ar / al / dt / mv
  ar?: { id: number; name: string }[]
  al?: { id: number; name: string; picId?: number; picUrl?: string }
  dt?: number
  mv?: number
  picId?: number
  fee?: number
}

/** 归一化后的网易云歌曲（可直接喂给渲染层 SongList） */
export interface NeteaseSong {
  id: number
  name: string
  ar: { id: number; name: string }[]
  al: { id: number; name: string; picUrl: string }
  dt: number
  mv: number
  fee: number
  source: 'netease'
}

/** 搜索接口响应 */
interface WySearchResponse {
  code: number
  result?: {
    songs?: WyRawSong[]
    songCount?: number
  }
}

/** 播放地址接口响应 */
interface WySongUrlResponse {
  code: number
  data?: {
    id: number
    url: string | null
    fee?: number
  }[]
}

/** 热搜接口响应（/search/hot/detail 的 data 为直接数组） */
interface WyHotSearchResponse {
  code: number
  data?: {
    searchWord: string
    score?: number
    iconUrl?: string
    content?: string
  }[]
}

/** 搜索建议接口响应（/search/suggest 的 allMatch 关键字联想） */
interface WySuggestResponse {
  code: number
  result?: {
    allMatch?: { keyword?: string; type?: number; alg?: string }[]
  }
}

/** 歌单详情的原始结构（仅取用到的字段） */
interface WyRawPlaylist {
  id?: number
  name?: string
  coverImgUrl?: string
  description?: string
  trackCount?: number
  trackIds?: { id: number }[]
}

/** 歌单详情接口响应（/playlist/detail） */
interface WyPlaylistDetailResponse {
  code: number
  playlist?: WyRawPlaylist
}

/** 歌单所有歌曲接口响应（/playlist/track/all） */
interface WyPlaylistTracksResponse {
  code: number
  songs?: WyRawSong[]
}

/** 用户歌单接口响应（/user/playlist） */
interface WyUserPlaylistResponse {
  code: number
  playlist?: WyRawPlaylist[]
}

/** 归一化后的歌单摘要（供渲染层列表/导入使用） */
export interface NeteasePlaylistSummary {
  id: number
  name: string
  cover: string
  trackCount: number
  description?: string
}

/**
 * 归一化原始歌曲结构（兼容搜索接口 artists/album/duration 与歌单接口 ar/al/dt 两套字段）
 */
function normalizeSong(song: WyRawSong): NeteaseSong {
  const artists = song.ar?.length ? song.ar : song.artists || []
  const albumName = song.al?.name || song.album?.name || ''
  const picId = song.al?.picId ?? song.album?.picId ?? song.picId
  const picUrl = song.al?.picUrl || song.album?.picUrl || (picId ? getNeteaseCoverUrl(picId) : '')
  return {
    id: song.id,
    name: song.name || '未知歌曲',
    ar: artists.map((a) => ({ id: a.id ?? 0, name: a.name })),
    al: {
      id: song.al?.id ?? song.album?.id ?? 0,
      name: albumName,
      picUrl
    },
    dt: song.dt || song.duration || 0,
    mv: song.mv || song.mvid || 0,
    fee: song.fee ?? 0,
    source: 'netease'
  }
}

/**
 * 批量获取歌曲详情（用于修正搜索接口不准确的封面）
 * 实测 `/search` 返回的 album.picId 与真实封面存在偏差（尾号差 1~6），
 * 而 `/song/detail` 返回的 al.picUrl 为真实封面地址
 * @param ids 网易云歌曲 ID 列表
 */
async function fetchSongDetailMap(
  ids: number[]
): Promise<Map<number, { al?: { name?: string; picUrl?: string } }>> {
  const map = new Map<number, { al?: { name?: string; picUrl?: string } }>()
  if (ids.length === 0) return map
  try {
    const resp = await fetch(`${API_BASE}/song/detail?ids=${ids.join(',')}`)
    if (!resp.ok) return map
    const data = await resp.json()
    for (const s of (data.songs ?? []) as {
      id: number
      al?: { name?: string; picUrl?: string }
    }[]) {
      map.set(s.id, s)
    }
  } catch (e) {
    console.warn('[neteaseService] 批量获取歌曲详情失败，封面可能不准确:', e)
  }
  return map
}

/**
 * 搜索网易云歌曲
 * @param keywords 关键词
 * @param offset 偏移量（分页）
 * @param limit 每页数量
 */
async function searchSongs(
  keywords: string,
  offset = 0,
  limit = 30
): Promise<{ songs: NeteaseSong[]; hasMore: boolean; total: number }> {
  const url =
    `${API_BASE}/search?keywords=${encodeURIComponent(keywords)}` +
    `&type=1&offset=${offset}&limit=${limit}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} searching for "${keywords}"`)
      return { songs: [], hasMore: false, total: 0 }
    }
    const data: WySearchResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} searching for "${keywords}"`)
      return { songs: [], hasMore: false, total: 0 }
    }
    const rawSongs = data.result?.songs || []
    const total = data.result?.songCount ?? rawSongs.length

    // 搜索接口的 album.picId 不准确，批量拉取详情用真实封面覆盖
    const detailMap = await fetchSongDetailMap(rawSongs.map((s) => s.id))

    const songs = rawSongs.map((raw) => {
      const song = normalizeSong(raw)
      const realPicUrl = detailMap.get(raw.id)?.al?.picUrl
      if (realPicUrl) {
        // 追加缩略参数减小图片体积（详情返回的是原图地址）
        song.al.picUrl = realPicUrl.includes('?') ? realPicUrl : `${realPicUrl}?param=300y300`
      }
      return song
    })
    return {
      songs,
      hasMore: offset + songs.length < total,
      total
    }
  } catch (e) {
    console.error(`[neteaseService] Failed to search for "${keywords}":`, e)
    return { songs: [], hasMore: false, total: 0 }
  }
}

/**
 * 音质等级映射：内部质量标识 -> 网易云 API level
 * standard=标准(128k) higher=较高(192k) exhigh=极高/高品(320k) lossless=无损(FLAC) hires=高解析
 */
const QUALITY_LEVEL_MAP: Record<string, string> = {
  '128k': 'standard',
  '192k': 'higher',
  '320k': 'exhigh',
  flac: 'lossless',
  lossless: 'lossless',
  hires: 'hires'
}

/**
 * 批量获取歌曲播放地址
 * @param ids 网易云歌曲 ID 列表
 * @param quality 音质标识（128k / 192k / 320k / flac 等），默认标准音质
 * @returns id -> 播放地址 映射（无播放地址的条目会被剔除）
 */
async function getSongUrlMap(
  ids: number[],
  quality = '128k',
  refresh = false
): Promise<Record<number, string>> {
  if (ids.length === 0) return {}
  const level = QUALITY_LEVEL_MAP[quality] || 'standard'
  const url =
    `${API_BASE}/song/url/v1?id=${ids.join(',')}` +
    `&level=${level}&randomCNIP=true` +
    // refresh=true 时附加时间戳穿透服务端 URL 缓存，用于播放失败后强制取新地址
    // （普通重查可能返回同一已过期的 CDN 地址，导致重试无效）
    (refresh ? `&t=${Date.now()}` : '')
  try {
    const resp = await netFetch(url, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching song urls`)
      return {}
    }
    const data: WySongUrlResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching song urls`)
      return {}
    }
    const map: Record<number, string> = {}
    for (const item of data.data || []) {
      if (item && item.url) {
        map[item.id] = item.url
      }
    }
    return map
  } catch (e) {
    console.error('[neteaseService] Failed to fetch song urls:', e)
    return {}
  }
}

/**
 * 获取网易云热搜列表
 */
async function getHotSearch(): Promise<{ searchWord: string; iconUrl?: string }[]> {
  const url = `${API_BASE}/search/hot/detail`
  try {
    const resp = await netFetch(url)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching hot search`)
      return []
    }
    const data: WyHotSearchResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching hot search`)
      return []
    }
    return (data.data || []).map((item) => ({
      searchWord: item.searchWord,
      iconUrl: item.iconUrl
    }))
  } catch (e) {
    console.error('[neteaseService] Failed to fetch hot search:', e)
    return []
  }
}

/**
 * 获取网易云搜索建议（关键字联想）
 * 基于 /search/suggest 返回的 allMatch 关键字列表，去重后截断
 */
async function getSearchSuggest(keywords: string): Promise<string[]> {
  const url = `${API_BASE}/search/suggest?keywords=${encodeURIComponent(keywords)}&type=mobile`
  try {
    const resp = await netFetch(url)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching suggest for "${keywords}"`)
      return []
    }
    const data: WySuggestResponse = await resp.json()
    if (data.code !== 200) {
      console.error(
        `[neteaseService] API error code ${data.code} fetching suggest for "${keywords}"`
      )
      return []
    }
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of data.result?.allMatch || []) {
      const keyword = item.keyword?.trim()
      if (!keyword || seen.has(keyword)) continue
      seen.add(keyword)
      list.push(keyword)
      if (list.length >= 8) break
    }
    return list
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch suggest for "${keywords}":`, e)
    return []
  }
}

// ==================== 歌单拉取 ====================

/** 将原始歌单映射为摘要 */
function toPlaylistSummary(raw: WyRawPlaylist): NeteasePlaylistSummary {
  return {
    id: Number(raw.id) || 0,
    name: raw.name || '未命名歌单',
    cover: raw.coverImgUrl || '',
    trackCount: raw.trackCount ?? raw.trackIds?.length ?? 0,
    description: raw.description || ''
  }
}

/**
 * 获取歌单详情
 * @param id 网易云歌单 ID
 */
async function getPlaylistDetail(id: number): Promise<NeteasePlaylistSummary | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  try {
    const resp = await netFetch(`${API_BASE}/playlist/detail?id=${id}`, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching playlist detail ${id}`)
      return null
    }
    const data: WyPlaylistDetailResponse = await resp.json()
    if (data.code !== 200 || !data.playlist) {
      console.error(`[neteaseService] API error code ${data.code} fetching playlist detail ${id}`)
      return null
    }
    return toPlaylistSummary(data.playlist)
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch playlist detail ${id}:`, e)
    return null
  }
}

/** 单页拉取数量（与接口 limit 上限配合） */
const PLAYLIST_TRACK_PAGE_SIZE = 500
/** 安全阈值：避免异常响应导致无限翻页 */
const PLAYLIST_TRACK_MAX = 20000

/**
 * 获取歌单全部歌曲（分页拉取并归一化）
 * @param id 网易云歌单 ID
 */
async function getPlaylistTracks(id: number): Promise<NeteaseSong[]> {
  if (!Number.isFinite(id) || id <= 0) return []
  const detail = await getPlaylistDetail(id)
  const total = detail?.trackCount ?? 0
  const out: NeteaseSong[] = []
  let offset = 0
  try {
    while (offset < PLAYLIST_TRACK_MAX) {
      const url =
        `${API_BASE}/playlist/track/all?id=${id}` +
        `&limit=${PLAYLIST_TRACK_PAGE_SIZE}&offset=${offset}`
      const resp = await netFetch(url, activeAccount()?.cookie)
      if (!resp.ok) {
        console.error(`[neteaseService] HTTP ${resp.status} fetching playlist tracks ${id}`)
        break
      }
      const data: WyPlaylistTracksResponse = await resp.json()
      if (data.code !== 200) {
        console.error(`[neteaseService] API error code ${data.code} fetching playlist tracks ${id}`)
        break
      }
      const songs = data.songs || []
      out.push(...songs.map(normalizeSong))
      // 返回不足一页说明已到末尾
      if (songs.length < PLAYLIST_TRACK_PAGE_SIZE) break
      offset += PLAYLIST_TRACK_PAGE_SIZE
      // 已满足详情声明的总数
      if (total && offset >= total) break
    }
    return out
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch playlist tracks ${id}:`, e)
    return out
  }
}

/**
 * 获取当前活跃账号的用户歌单列表
 * 未登录时返回空数组
 */
async function getUserPlaylists(): Promise<NeteasePlaylistSummary[]> {
  await ensureAccountsLoaded()
  const account = activeAccount()
  if (!account?.userId) return []
  try {
    const url = `${API_BASE}/user/playlist?uid=${encodeURIComponent(account.userId)}&limit=1000`
    const resp = await netFetch(url, account.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching user playlists`)
      return []
    }
    const data: WyUserPlaylistResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching user playlists`)
      return []
    }
    return (data.playlist || []).map(toPlaylistSummary).filter((p) => p.id > 0)
  } catch (e) {
    console.error('[neteaseService] Failed to fetch user playlists:', e)
    return []
  }
}

// ==================== 歌手 / 专辑（搜索页点击歌手名进入详情） ====================

/** 歌手详情（归一化，可直接喂给歌手详情页） */
export interface NeteaseArtistDetail {
  id: number
  name: string
  /** 方图封面（优先 artist/album 接口的 picUrl，其次 detail 的 cover） */
  cover: string
  /** 简介（网易云多数歌手为空字符串） */
  briefDesc: string
  /** 作品总数（歌曲 + 纯音乐等） */
  musicSize: number
  albumSize: number
  followed: boolean
}

/** 歌手专辑（归一化） */
export interface NeteaseArtistAlbum {
  id: number
  name: string
  cover: string
  /** 专辑曲目数 */
  size: number
  /** 发行时间（毫秒时间戳） */
  publishTime: number
}

interface WyArtistDetailResponse {
  code: number
  data?: {
    artist?: {
      id?: number
      name?: string
      cover?: string
      avatar?: string
      briefDesc?: string
      musicSize?: number
      albumSize?: number
      followed?: boolean
    }
  }
}

interface WyArtistSongsResponse {
  code: number
  more?: boolean
  songs?: WyRawSong[]
}

interface WyArtistAlbumsResponse {
  code: number
  more?: boolean
  // 部分版本的接口在该字段里额外返回 artist，这里按需读取
  artist?: { name?: string; picUrl?: string; img1v1Url?: string }
  hotAlbums?: {
    id?: number
    name?: string
    picUrl?: string
    blurPicUrl?: string
    size?: number
    publishTime?: number
  }[]
}

interface WyAlbumResponse {
  code: number
  album?: { name?: string; picUrl?: string }
  songs?: WyRawSong[]
}

/**
 * 网易云图片地址统一升级为 https
 * 接口偶发返回 http（如 /artist/detail 的 cover），Electron 下会被当作不安全内容
 */
function toSecureUrl(url?: string): string {
  if (!url) return ''
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

/** 歌手详情页单次拉取的歌曲数量（接口上限 200） */
const ARTIST_SONG_PAGE_SIZE = 200
/** 歌手详情页单次拉取的专辑数量 */
const ARTIST_ALBUM_PAGE_SIZE = 100

/**
 * 获取歌手详情
 * @param id 网易云歌手 ID
 */
async function getArtistDetail(id: number): Promise<NeteaseArtistDetail | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  try {
    const resp = await netFetch(`${API_BASE}/artist/detail?id=${id}`, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching artist detail ${id}`)
      return null
    }
    const data: WyArtistDetailResponse = await resp.json()
    if (data.code !== 200 || !data.data?.artist) {
      console.error(`[neteaseService] API error code ${data.code} fetching artist detail ${id}`)
      return null
    }
    const a = data.data.artist
    return {
      id: Number(a.id) || id,
      name: a.name || '',
      cover: toSecureUrl(a.cover || a.avatar),
      briefDesc: (a.briefDesc || '').trim(),
      musicSize: a.musicSize ?? 0,
      albumSize: a.albumSize ?? 0,
      followed: !!a.followed
    }
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch artist detail ${id}:`, e)
    return null
  }
}

/**
 * 获取歌手歌曲（分页，接口单页上限约 200）
 * @param id 网易云歌手 ID
 * @param offset 偏移量
 * @param limit 每页数量
 */
async function getArtistSongs(
  id: number,
  offset = 0,
  limit = ARTIST_SONG_PAGE_SIZE
): Promise<{ songs: NeteaseSong[]; hasMore: boolean }> {
  if (!Number.isFinite(id) || id <= 0) return { songs: [], hasMore: false }
  try {
    const url =
      `${API_BASE}/artist/songs?id=${id}` +
      `&limit=${Math.min(limit, ARTIST_SONG_PAGE_SIZE)}&offset=${offset}`
    const resp = await netFetch(url, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching artist songs ${id}`)
      return { songs: [], hasMore: false }
    }
    const data: WyArtistSongsResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching artist songs ${id}`)
      return { songs: [], hasMore: false }
    }
    const songs = (data.songs || []).map(normalizeSong)
    return { songs, hasMore: !!data.more }
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch artist songs ${id}:`, e)
    return { songs: [], hasMore: false }
  }
}

/**
 * 获取歌手专辑（分页）
 * @param id 网易云歌手 ID
 * @param offset 偏移量
 * @param limit 每页数量
 */
async function getArtistAlbums(
  id: number,
  offset = 0,
  limit = ARTIST_ALBUM_PAGE_SIZE
): Promise<{ albums: NeteaseArtistAlbum[]; hasMore: boolean }> {
  if (!Number.isFinite(id) || id <= 0) return { albums: [], hasMore: false }
  try {
    const url =
      `${API_BASE}/artist/album?id=${id}` +
      `&limit=${Math.min(limit, ARTIST_ALBUM_PAGE_SIZE)}&offset=${offset}`
    const resp = await netFetch(url, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching artist albums ${id}`)
      return { albums: [], hasMore: false }
    }
    const data: WyArtistAlbumsResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching artist albums ${id}`)
      return { albums: [], hasMore: false }
    }
    const albums = (data.hotAlbums || [])
      .map((a) => ({
        id: Number(a.id) || 0,
        name: a.name || '未知专辑',
        cover: toSecureUrl(a.picUrl || a.blurPicUrl),
        size: a.size ?? 0,
        publishTime: a.publishTime ?? 0
      }))
      .filter((a) => a.id > 0)
    return { albums, hasMore: !!data.more }
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch artist albums ${id}:`, e)
    return { albums: [], hasMore: false }
  }
}

/**
 * 获取专辑全部曲目（歌手详情页点击专辑时按需拉取）
 * @param id 网易云专辑 ID
 */
async function getAlbumTracks(id: number): Promise<NeteaseSong[]> {
  if (!Number.isFinite(id) || id <= 0) return []
  try {
    const resp = await netFetch(`${API_BASE}/album?id=${id}`, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching album ${id}`)
      return []
    }
    const data: WyAlbumResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching album ${id}`)
      return []
    }
    const picUrl = toSecureUrl(data.album?.picUrl)
    return (data.songs || []).map((raw) => {
      const song = normalizeSong(raw)
      // 专辑内的歌曲统一用专辑封面，避免个别曲目缺封面
      if (!song.al.picUrl && picUrl) song.al.picUrl = picUrl
      return song
    })
  } catch (e) {
    console.error(`[neteaseService] Failed to fetch album ${id}:`, e)
    return []
  }
}

// ==================== 首页推荐（每日推荐 / 推荐歌单） ====================

/** 每日推荐接口响应（/recommend/songs，歌曲字段与歌单接口一致：ar / al / dt） */
interface WyDailySongsResponse {
  code: number
  data?: {
    dailySongs?: WyRawSong[]
  }
}

/** 推荐歌单原始结构（/recommend/resource 与 /personalized 共用） */
interface WyRawRecommendPlaylist {
  id?: number
  name?: string
  picUrl?: string
  coverImgUrl?: string
  trackCount?: number
  copywriter?: string
}

/** 每日推荐歌单接口响应（/recommend/resource，需登录） */
interface WyRecommendResourceResponse {
  code: number
  recommend?: WyRawRecommendPlaylist[]
}

/** 推荐歌单接口响应（/personalized，无需登录） */
interface WyPersonalizedResponse {
  code: number
  result?: WyRawRecommendPlaylist[]
}

/**
 * 拉取网易云「每日推荐」歌曲
 *
 * 该接口未登录时也会按公共口味返回一批（服务端匿名推荐），
 * 登录后则按账号口味生成，因此不做登录校验，仅在请求时附带 Cookie。
 * @returns 归一化后的歌曲列表，失败时返回空数组
 */
async function getDailySongs(): Promise<NeteaseSong[]> {
  try {
    const resp = await netFetch(`${API_BASE}/recommend/songs`, activeAccount()?.cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching daily songs`)
      return []
    }
    const data: WyDailySongsResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching daily songs`)
      return []
    }
    return (data.data?.dailySongs || []).map(normalizeSong)
  } catch (e) {
    console.error('[neteaseService] Failed to fetch daily songs:', e)
    return []
  }
}

/** 将推荐歌单原始结构映射为摘要（兼容 picUrl / coverImgUrl 两种封面字段） */
function toRecommendSummary(raw: WyRawRecommendPlaylist): NeteasePlaylistSummary {
  return {
    id: Number(raw.id) || 0,
    name: raw.name || '未命名歌单',
    cover: raw.picUrl || raw.coverImgUrl || '',
    trackCount: raw.trackCount ?? 0,
    description: raw.copywriter || ''
  }
}

/**
 * 拉取首页「专属歌单」（推荐歌单）
 *
 * 已登录优先用 /recommend/resource（按账号口味生成的每日推荐歌单），
 * 未登录 / 失败时退回 /personalized（公共个性化推荐），保证首页不空。
 * @param limit 期望返回数量上限
 */
async function getRecommendPlaylists(limit = 12): Promise<NeteasePlaylistSummary[]> {
  await ensureAccountsLoaded()
  const account = activeAccount()

  const collect = async (
    url: string,
    cookie?: string,
    key?: 'recommend' | 'result'
  ): Promise<NeteasePlaylistSummary[]> => {
    const resp = await netFetch(url, cookie)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching recommend playlists`)
      return []
    }
    const data: WyRecommendResourceResponse & WyPersonalizedResponse = await resp.json()
    if (data.code !== 200) return []
    const list = (key === 'recommend' ? data.recommend : data.result) || []
    return list.map(toRecommendSummary).filter((p) => p.id > 0)
  }

  try {
    if (account?.cookie) {
      const mine = await collect(`${API_BASE}/recommend/resource`, account.cookie, 'recommend')
      if (mine.length > 0) return mine.slice(0, limit)
    }
    return await collect(`${API_BASE}/personalized?limit=${limit}`, undefined, 'result')
  } catch (e) {
    console.error('[neteaseService] Failed to fetch recommend playlists:', e)
    return []
  }
}

// ==================== 登录状态与多账号管理 ====================

/** 网易云登录用户信息（渲染层展示用，含 VIP 与等级） */
export interface NeteaseLoginProfile {
  nickname: string
  userId: string
  avatarUrl?: string
  /** VIP 类型（位标志）：0=无，1=仅音乐包，10/100/110=黑胶（11=黑胶+音乐包） */
  vipType?: number
  /** 黑胶 VIP 等级（来自 /vip/info 的 associator.vipLevel） */
  vipLevel?: number
  /** 账号等级（来自 /user/detail 的 level） */
  level?: number
  /** 个性签名 */
  signature?: string
}

/** 本地持久化的账号（含 Cookie 与缓存的详情） */
interface NeteaseAccount {
  userId: string
  nickname: string
  avatarUrl?: string
  cookie: string
  savedAt: number
  vipType?: number
  vipLevel?: number
  level?: number
  signature?: string
  /** 上次拉取 /user/detail + /vip/info 的时间戳（用于定期刷新等级与会员状态） */
  detailRefreshedAt?: number
}

/** 账号详情（等级 / 会员）的缓存有效期：超过后重新拉取，避免会员过期仍显示 VIP */
const DETAIL_TTL_MS = 10 * 60 * 1000

/** 当前活跃账号：优先按 activeUserId 匹配，无匹配时回退到最近保存的账号 */
function activeAccount(): NeteaseAccount | undefined {
  return neteaseAccounts.find((a) => a.userId === activeUserId) || neteaseAccounts[0]
}

/**
 * 获取当前活跃网易云账号的 Cookie（供音频下载 / 下载歌曲等请求附加登录态，
 * 否则登录后返回的 VIP/高音质 CDN 地址会在下载环节 403）
 */
export function getActiveNeteaseCookie(): string {
  return activeAccount()?.cookie || ''
}

/** 浏览器请求头：部分网易云 API 对缺少 UA/Referer 的请求返回异常或误判为失效 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com'
}

/** 网络层错误的最大请求次数（含首次） */
const NET_FETCH_ATTEMPTS = 3

/** 判断是否为可重试的网络层错误（连接超时/中断等，非 HTTP 错误状态） */
function isRetriableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const causeCode = (error as { cause?: { code?: string } }).cause?.code
  if (causeCode && String(causeCode).startsWith('UND_ERR')) return true
  return error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'TimeoutError'
}

/** 判断是否为可重试的 HTTP 状态：网关抖动（502/503/504）与限流（429） */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/** 简易延时（重试退避用） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 给 URL 追加一次性参数，绕开网关按 URL 的缓存
 *
 * api.enzymeym.top 前置 EdgeOne，响应带 `Cache-Control: max-age=120`，
 * 且**错误响应同样会进缓存**（实测同一 URL 第二次起 `EO-Cache-Status: HIT`）。
 * 因此「重试同一个 URL」等于原地打转：拿到的还是那份被缓存的 502。
 */
function withCacheBust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_r=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 带浏览器头（及可选 Cookie）的网易云 API 请求
 * 通过代理/TUN 访问时连接可能较慢，undici 默认 10s 连接超时偶发触发；
 * 网关（openresty / EdgeOne）在回源超时或上游网易云抖动时也会直接回 502。
 * 这两类都属于瞬时失败，因此做有限次重试（全部调用点均为 GET，幂等，重试安全）。
 * 每次重试都换一个全新 URL，避免撞上网关缓存下来的错误响应。
 */
async function netFetch(url: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS }
  if (cookie) headers['Cookie'] = cookie

  let lastError: unknown
  for (let attempt = 0; attempt < NET_FETCH_ATTEMPTS; attempt++) {
    const isLast = attempt === NET_FETCH_ATTEMPTS - 1
    const target = attempt === 0 ? url : withCacheBust(url)
    try {
      const resp = await fetch(target, { headers })
      if (!isRetriableStatus(resp.status) || isLast) return resp
      // 响应体不读，交给 GC/undici 回收；下一次重试会换新 URL 重新发起请求
      console.warn(
        `[neteaseService] 网关返回 HTTP ${resp.status}，正在重试 (${attempt + 1}/${NET_FETCH_ATTEMPTS - 1})`
      )
      // 502 多半是回源超时，退避要比连接错误更宽裕，否则只是再撞一次繁忙的上游
      await delay(1200 * (attempt + 1))
    } catch (error) {
      lastError = error
      if (!isRetriableNetworkError(error) || isLast) break
      console.warn(
        `[neteaseService] 请求失败，正在重试 (${attempt + 1}/${NET_FETCH_ATTEMPTS - 1}): ${url}`
      )
      await delay(400 * (attempt + 1))
    }
  }
  if (lastError) throw lastError
  // 理论上不可达：循环要么 return，要么在 catch 分支 break 时已记录 lastError
  throw new Error('请求失败: 未知错误')
}

/** 将账号转为渲染层可见的 profile */
function toProfile(a: NeteaseAccount): NeteaseLoginProfile {
  return {
    nickname: a.nickname,
    userId: a.userId,
    avatarUrl: a.avatarUrl || '',
    vipType: a.vipType,
    vipLevel: a.vipLevel,
    level: a.level,
    signature: a.signature
  }
}

/** 清洗 Cookie：按 ; 分割，剔除属性段，只保留 key=value */
function cleanCookie(rawCookie: string): string {
  if (!rawCookie) return ''
  const attrKeywords = [
    'max-age',
    'path',
    'domain',
    'expires',
    'secure',
    'httponly',
    'samesite',
    'priority',
    'partitioned'
  ]
  const parts = rawCookie.split(';')
  // 同一 key 重复出现（网关把多条 Set-Cookie 拼在一起时很常见）只保留最后一个，
  // 否则请求会带上多个同名 Cookie，服务端取到哪个不确定 —— 表现为「串号 / 登录态时好时坏」
  const byKey = new Map<string, string>()
  for (const part of parts) {
    const p = part.trim()
    if (!p) continue
    const eqIdx = p.indexOf('=')
    if (eqIdx > 0) {
      const rawKey = p.substring(0, eqIdx).trim()
      if (!attrKeywords.includes(rawKey.toLowerCase())) {
        byKey.set(rawKey, p)
      }
    }
  }
  return [...byKey.values()].join('; ')
}

/** 持久化账号列表 */
async function persistAccounts(): Promise<void> {
  try {
    await fs.writeFile(
      accountsFilePath(),
      JSON.stringify({ accounts: neteaseAccounts, activeUserId }, null, 2),
      'utf-8'
    )
  } catch (e) {
    console.error('[neteaseService] 保存账号列表失败:', e)
  }
}

/** 从 /login/status 响应解析用户信息 */
function parseLoginStatus(data: unknown): NeteaseLoginProfile | null {
  const profile = (
    data as {
      profile?: {
        nickname?: string
        userId?: number | string
        id?: number | string
        avatarUrl?: string
        vipType?: number
        signature?: string
      }
    }
  )?.profile
  if (!profile) return null
  return {
    nickname: profile.nickname || '网易云用户',
    userId: String(profile.userId ?? profile.id ?? ''),
    avatarUrl: profile.avatarUrl || '',
    vipType: profile.vipType,
    signature: profile.signature
  }
}

/**
 * 用指定 Cookie 向 /login/status 校验并解析用户
 * @param cookie 登录 Cookie
 * @returns invalid=true 表示 Cookie 明确失效（301 或无 profile），网络异常等临时失败时 invalid 为 false
 */
async function fetchStatusWithCookie(
  cookie: string
): Promise<{ loggedIn: boolean; profile?: NeteaseLoginProfile; invalid?: boolean }> {
  if (!cookie) return { loggedIn: false, invalid: true }
  try {
    const resp = await netFetch(`${API_BASE}/login/status`, cookie)
    if (!resp.ok) {
      console.warn(`[neteaseService] /login/status HTTP ${resp.status}`)
      return { loggedIn: false }
    }
    const data = (await resp.json()) as {
      code?: number
      data?: { code?: number; profile?: unknown }
    }
    // 实测该 API 的 /login/status 顶层无 code 字段，code 位于 data.code（如 { data: { code: 200, profile } }）
    const code = data.data?.code ?? data.code
    // code 301 表示 Cookie 失效（未登录）
    if (code === 301) return { loggedIn: false, invalid: true }
    if (code !== 200) {
      console.warn(`[neteaseService] /login/status code ${code}`)
      return { loggedIn: false }
    }
    const profile = parseLoginStatus(data.data)
    return profile ? { loggedIn: true, profile } : { loggedIn: false, invalid: true }
  } catch (e) {
    console.warn('[neteaseService] 获取登录状态失败:', e)
    return { loggedIn: false }
  }
}

/**
 * 补充账号详情：等级（/user/detail）与黑胶 VIP 等级（/vip/info）
 * 两者都需要登录态，失败时静默降级
 */
async function enrichAccountDetail(account: NeteaseAccount): Promise<void> {
  try {
    // 1. 账号等级 / 签名 / vipType
    const detailResp = await netFetch(
      `${API_BASE}/user/detail?uid=${encodeURIComponent(account.userId)}`,
      account.cookie
    )
    if (detailResp.ok) {
      const detail = (await detailResp.json()) as {
        code?: number
        level?: number
        profile?: { userId?: number | string; vipType?: number; signature?: string }
      }
      // /user/detail 按 uid 查询，只要 uid 与本地账号不一致就会把别人的资料写进来
      const detailUserId = detail.profile?.userId != null ? String(detail.profile.userId) : ''
      if (detailUserId && detailUserId !== account.userId) {
        console.warn(
          `[neteaseService] /user/detail 返回的账号(${detailUserId})与本地账号(${account.userId})不一致，已忽略`
        )
      } else if (!detail.code || detail.code === 200) {
        if (typeof detail.level === 'number') account.level = detail.level
        if (typeof detail.profile?.vipType === 'number') account.vipType = detail.profile.vipType
        if (detail.profile?.signature) account.signature = detail.profile.signature
      }
    }
  } catch (e) {
    console.warn('[neteaseService] 获取账号等级失败:', e)
  }
  try {
    // 2. 黑胶 / 音乐包会员状态
    const vipResp = await netFetch(`${API_BASE}/vip/info`, account.cookie)
    if (vipResp.ok) {
      const summary = parseVipInfo(await vipResp.json())
      // summary 为 null 表示响应不可用，此时保留原值，不要误清成「非会员」
      if (summary) {
        account.vipType = summary.vipType
        account.vipLevel = summary.vipLevel
      }
    }
  } catch (e) {
    console.warn('[neteaseService] 获取 VIP 信息失败:', e)
  }
  account.detailRefreshedAt = Date.now()
}

/** 账号详情是否需要刷新（等级/会员缺失或缓存过期） */
function needsDetailRefresh(account: NeteaseAccount): boolean {
  if (account.level === undefined || account.vipLevel === undefined) return true
  if (!account.detailRefreshedAt) return true
  return Date.now() - account.detailRefreshedAt > DETAIL_TTL_MS
}

/** 从本地加载账号列表；兼容迁移旧版单账号 Cookie 文件 */
async function loadAccounts(): Promise<void> {
  try {
    const filePath = accountsFilePath()
    if (existsSync(filePath)) {
      const raw = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as { accounts?: NeteaseAccount[]; activeUserId?: string }
      // 顺带清洗历史 Cookie（去属性段、同名键去重），避免重复键让服务端取到旧值
      neteaseAccounts = (data.accounts || [])
        .map((a) => ({ ...a, cookie: cleanCookie(a.cookie || '') }))
        .filter((a) => a.cookie && a.userId)
      activeUserId = data.activeUserId || neteaseAccounts[0]?.userId || ''
      if (neteaseAccounts.length) {
        console.log(`[neteaseService] 已从本地恢复 ${neteaseAccounts.length} 个网易云账号`)
      }
      return
    }

    // 迁移旧版单账号 Cookie
    if (existsSync(legacyCookieFilePath())) {
      const raw = await fs.readFile(legacyCookieFilePath(), 'utf-8')
      const legacy = JSON.parse(raw) as { cookie?: string; savedAt?: number }
      if (legacy.cookie) {
        const legacyCookie = cleanCookie(legacy.cookie)
        const status = await fetchStatusWithCookie(legacyCookie)
        if (status.loggedIn && status.profile) {
          const account: NeteaseAccount = {
            userId: status.profile.userId,
            nickname: status.profile.nickname,
            avatarUrl: status.profile.avatarUrl,
            cookie: legacyCookie,
            savedAt: legacy.savedAt || Date.now(),
            vipType: status.profile.vipType,
            signature: status.profile.signature
          }
          neteaseAccounts = [account]
          activeUserId = account.userId
          await persistAccounts()
          console.log('[neteaseService] 已将旧版登录 Cookie 迁移为账号')
          await fs.unlink(legacyCookieFilePath()).catch(() => {})
        } else if (status.invalid) {
          // Cookie 已明确失效，清理旧文件
          await fs.unlink(legacyCookieFilePath()).catch(() => {})
        }
        // 网络异常等临时失败：保留旧文件，下次启动再尝试迁移
      }
    }
  } catch (e) {
    console.warn('[neteaseService] 读取本地账号失败:', e)
  }
}

/**
 * 账号列表的加载任务（只启动一次）
 *
 * 启动时 loadAccounts 是异步的，渲染层一挂载就会请求登录状态；若不等待，
 * 会读到空列表而显示成「未登录 + 扫码」，随后才变成已登录 —— 表现为登录信息前后矛盾。
 * 所有依赖账号列表的 IPC 入口都先 await 这个任务。
 */
let accountsLoadTask: Promise<void> | null = null

function ensureAccountsLoaded(): Promise<void> {
  accountsLoadTask ??= loadAccounts()
  return accountsLoadTask
}

/**
 * 以 Cookie 为准纠正账号身份，并清空属于旧身份的缓存
 * @returns 是否发生了纠正
 */
function rebindAccountToCookieProfile(
  account: NeteaseAccount,
  realUserId: string
): { account: NeteaseAccount; rebind: boolean } {
  const result = rebindAccountIdentity(neteaseAccounts, account, realUserId, activeUserId)
  if (!result.rebind) return { account, rebind: false }

  neteaseAccounts = result.accounts
  activeUserId = result.activeUserId
  // 等级 / 会员 / 签名都是按旧 userId 查到的，不属于新身份，必须丢弃后重取
  result.account.level = undefined
  result.account.vipLevel = undefined
  result.account.signature = undefined
  result.account.vipType = undefined
  result.account.detailRefreshedAt = undefined
  console.warn(
    `[neteaseService] 本地账号标识与 Cookie 不一致（${account.userId} → ${realUserId}），已按 Cookie 归属纠正`
  )
  return { account: result.account, rebind: true }
}

/**
 * 获取当前登录状态（含账号列表与活跃账号）
 */
async function getLoginStatus(): Promise<{
  loggedIn: boolean
  profile?: NeteaseLoginProfile
  accounts: NeteaseLoginProfile[]
  activeUserId: string
}> {
  await ensureAccountsLoaded()
  const active = activeAccount()
  if (!active) return { loggedIn: false, accounts: [], activeUserId: '' }

  const status = await fetchStatusWithCookie(active.cookie)
  if (!status.loggedIn) {
    // 仅当 Cookie 明确失效时移除该账号；网络异常等临时失败不删除
    if (status.invalid) {
      neteaseAccounts = neteaseAccounts.filter((a) => a.userId !== active.userId)
      if (activeUserId === active.userId) {
        activeUserId = neteaseAccounts[0]?.userId || ''
      }
      await persistAccounts()
      return getLoginStatus()
    }
    // 临时失败：仍把已知账号回传给渲染层，避免「明明已登录却跳回扫码登录」
    return {
      loggedIn: false,
      profile: toProfile(active),
      accounts: neteaseAccounts.map(toProfile),
      activeUserId
    }
  }

  const profile = status.profile!
  // profile 里的 userId 才是 Cookie 真正所属的账号，与本地记录不一致时必须纠正
  const rebound = rebindAccountToCookieProfile(active, profile.userId)
  const account = rebound.account

  // 更新昵称 / 头像 / VIP 类型（可能已变更）
  account.nickname = profile.nickname
  account.avatarUrl = profile.avatarUrl
  if (profile.vipType !== undefined) account.vipType = profile.vipType
  account.signature = profile.signature

  // 等级 / 会员信息缺失或过期时补充（身份纠正后这些缓存已被清空，必然重新拉取）
  if (rebound.rebind || needsDetailRefresh(account)) {
    await enrichAccountDetail(account)
    await persistAccounts()
  }

  return {
    loggedIn: true,
    profile: toProfile(account),
    accounts: neteaseAccounts.map(toProfile),
    activeUserId
  }
}

/**
 * 启动时逐个校正已存账号的身份
 *
 * 历史版本会把「Cookie 归属于 A」的记录挂在「B 的 userId」下，之后所有按 userId
 * 查询的接口（等级、歌单）都会取到 B 的数据，而昵称头像来自 A。这里在启动阶段
 * 以 Cookie 为准统一纠正一次；只在身份不一致时改写，不做删除，网络失败静默跳过。
 */
async function verifyAccountsIdentity(): Promise<void> {
  const targets = neteaseAccounts.slice(0, 5)
  let changed = false
  for (const account of targets) {
    // 列表可能已被上一次纠正过程改写，重新定位当前对象
    const current = neteaseAccounts.find((a) => a === account || a.cookie === account.cookie)
    if (!current) continue
    try {
      const status = await fetchStatusWithCookie(current.cookie)
      if (!status.loggedIn || !status.profile) continue
      if (status.profile.userId === current.userId) continue
      const result = rebindAccountIdentity(
        neteaseAccounts,
        current,
        status.profile.userId,
        activeUserId
      )
      if (!result.rebind) continue
      neteaseAccounts = result.accounts
      activeUserId = result.activeUserId
      result.account.nickname = status.profile.nickname
      result.account.avatarUrl = status.profile.avatarUrl
      result.account.vipType = status.profile.vipType
      result.account.signature = status.profile.signature
      result.account.level = undefined
      result.account.vipLevel = undefined
      result.account.detailRefreshedAt = undefined
      changed = true
      console.warn(`[neteaseService] 已纠正账号身份：${current.userId} → ${status.profile.userId}`)
    } catch (e) {
      console.warn('[neteaseService] 校正账号身份失败:', e)
    }
  }
  if (changed) {
    await persistAccounts()
    console.log('[neteaseService] 账号身份校正完成')
  }
}

/**
 * 生成登录二维码
 * @returns unikey（轮询用）+ qrimg（base64 data URI）
 */
async function getLoginQr(): Promise<{ unikey: string; qrimg: string }> {
  // 1. 获取二维码 key
  const keyResp = await netFetch(`${API_BASE}/login/qr/key?timestamp=${Date.now()}`)
  if (!keyResp.ok) throw new Error(`获取二维码 key 失败: HTTP ${keyResp.status}`)
  const keyData = await keyResp.json()
  const unikey: string = keyData.data?.unikey
  if (!unikey) throw new Error('获取二维码 key 失败: 响应缺少 unikey')

  // 2. 生成二维码图片
  const qrResp = await netFetch(
    `${API_BASE}/login/qr/create?key=${encodeURIComponent(unikey)}&qrimg=true&timestamp=${Date.now()}`
  )
  if (!qrResp.ok) throw new Error(`生成二维码失败: HTTP ${qrResp.status}`)
  const qrData = await qrResp.json()
  let qrimg: string = qrData.data?.qrimg || ''
  if (!qrimg) throw new Error('生成二维码失败: 响应缺少 qrimg')
  if (!qrimg.startsWith('data:')) {
    qrimg = `data:image/png;base64,${qrimg}`
  }
  return { unikey, qrimg }
}

/** 检测接口的软失败码：上游瞬时不可用，调用方应继续轮询而非中断登录 */
const QR_CHECK_SOFT_FAIL = -1

/**
 * 检测接口的额外重试轮数（netFetch 内部已对 5xx/429 换了新 URL 重试 3 次）
 *
 * 只留 1 轮：单次 IPC 的总耗时必须压在 10s 内。扫码轮询是串行调度的，
 * 一次 tick 拖到 30s 会让「扫码成功」迟迟读不到、二维码先过期，比偶发失败更糟。
 */
const QR_CHECK_RETRY = 1

/**
 * 读取 JSON 响应体，空响应体或非 JSON（网关错误页）都返回 null 而非抛错
 */
async function readJsonBody(resp: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await resp.text()
    if (!text || !text.trim()) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 检测接口响应（code 已归一化到顶层，兼容嵌在 data 里的实现） */
interface QrCheckPayload {
  code: number
  cookie?: string
  message?: string
  data?: unknown
  [key: string]: unknown
}

/**
 * 单次请求二维码检测接口
 * @returns null 表示本次为可重试的瞬时失败（HTTP 5xx / 429 / 空响应体 / 非 JSON）
 *
 * **每次请求都带 `noCookie=true`**——这不是容错开关，而是官方约定：
 * 1. 文档明确「如扫码后返回 502，则需加上 noCookie 参数」，而 502 恰恰多发于扫码之后，
 *    正是需要读 803 的时刻；不加就永远拿不到登录凭证。
 * 2. 带 Cookie 轮询会让上游尝试改写会话 Cookie，多标签/多账号场景下会互相串；
 *    noCookie 只抑制响应头里的 Set-Cookie，**803 响应体里的 cookie 字段照常返回**，
 *    官方参考实现 public/qrlogin-nocookie.html 也是全程带它、再从 body 取 cookie。
 */
async function fetchQrCheckOnce(unikey: string, seq: string): Promise<QrCheckPayload | null> {
  // 网关对同一 URL 有 120s 缓存（Cache-Control: max-age=120），会把上游瞬时错误一起缓存；
  // 追加序号保证每轮轮询都是全新 URL，避免整段扫码期被一个坏响应污染
  const params = new URLSearchParams({
    key: unikey,
    timestamp: String(Date.now()),
    noCookie: 'true',
    seq
  })

  const resp = await netFetch(`${API_BASE}/login/qr/check?${params.toString()}`)
  if (!resp.ok) {
    console.warn(`[neteaseService] 检测扫码状态仍失败 (HTTP ${resp.status})，本轮跳过`)
    return null
  }
  const raw = await readJsonBody(resp)
  if (!raw) {
    console.warn('[neteaseService] 检测扫码状态返回内容无法解析，按瞬时失败处理')
    return null
  }
  const nested = (raw.data as { code?: unknown })?.code
  const code = typeof raw.code === 'number' ? raw.code : nested
  if (typeof code !== 'number') {
    console.warn('[neteaseService] 检测扫码状态响应缺少 code，按瞬时失败处理')
    return null
  }
  return { ...raw, code }
}

/**
 * 轮询检测二维码扫码状态
 * @param unikey 二维码 key
 * @returns code 与登录成功时的用户信息
 *
 * 上游抖动（网关 502 / 空响应体）不抛错，而是回 QR_CHECK_SOFT_FAIL 让渲染层继续轮询：
 * 扫码是持续数分钟的轮询过程，一次瞬时失败不应打断并刷出 IPC handler 错误。
 * 只有「拿到 Cookie 却校验不过」这类确定性错误才抛出。
 */
async function checkLoginQr(
  unikey: string
): Promise<{ code: number; profile?: NeteaseLoginProfile }> {
  let data: QrCheckPayload | null = null
  for (let attempt = 0; attempt <= QR_CHECK_RETRY; attempt++) {
    if (attempt > 0) await delay(600 * attempt)
    data = await fetchQrCheckOnce(unikey, `${attempt}`)
    // 非 502 的有效业务码即成功；502 说明上游这一轮确实取不到状态，退避后重试
    if (data && data.code !== 502) break
    data = null
  }

  if (!data) {
    return { code: QR_CHECK_SOFT_FAIL }
  }

  const code = data.code

  // 803：扫码授权成功，提取 Cookie 并写入账号列表
  if (code === 803) {
    const rawCookie = data.cookie || (typeof data.data === 'string' ? data.data : '')
    const cookie = cleanCookie(rawCookie)
    if (!cookie) {
      throw new Error('未获取到登录凭证')
    }
    // 必须等本地账号列表加载完，否则随后的写回会被 loadAccounts 覆盖掉
    await ensureAccountsLoaded()
    const status = await fetchStatusWithCookie(cookie)
    if (!status.loggedIn || !status.profile) {
      throw new Error('登录凭证校验失败')
    }
    const profile = status.profile
    // 同 userId 覆盖旧账号，并置为活跃
    const existing = neteaseAccounts.find((a) => a.userId === profile.userId)
    const account: NeteaseAccount = {
      userId: profile.userId,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      cookie,
      savedAt: Date.now(),
      vipType: profile.vipType,
      signature: profile.signature
    }
    if (existing) {
      neteaseAccounts[neteaseAccounts.indexOf(existing)] = account
    } else {
      neteaseAccounts.push(account)
    }
    activeUserId = profile.userId
    await enrichAccountDetail(account)
    await persistAccounts()
    return { code: 803, profile: toProfile(account) }
  }

  return { code }
}

/**
 * 退出登录：移除指定账号（缺省移除当前活跃账号）
 * @param userId 可选，目标账号 userId
 */
async function logout(userId?: string): Promise<void> {
  await ensureAccountsLoaded()
  const targetId = userId || activeUserId
  if (!targetId) return
  neteaseAccounts = neteaseAccounts.filter((a) => a.userId !== targetId)
  if (activeUserId === targetId) {
    activeUserId = neteaseAccounts[0]?.userId || ''
  }
  await persistAccounts()
  console.log(`[neteaseService] 已退出网易云账号 ${targetId}`)
}

/**
 * 切换当前活跃账号
 * @param userId 目标账号 userId
 */
async function switchAccount(userId: string): Promise<{
  loggedIn: boolean
  profile?: NeteaseLoginProfile
  accounts: NeteaseLoginProfile[]
  activeUserId: string
}> {
  await ensureAccountsLoaded()
  if (!neteaseAccounts.some((a) => a.userId === userId)) {
    return { loggedIn: false, accounts: neteaseAccounts.map(toProfile), activeUserId }
  }
  activeUserId = userId
  await persistAccounts()
  return getLoginStatus()
}

/**
 * 注册网易云相关 IPC handler
 */
export function registerNeteaseHandlers(): void {
  // 启动时恢复登录账号，随后校正可能存在的身份错位（历史脏数据）
  void ensureAccountsLoaded()
    .then(() => verifyAccountsIdentity())
    .catch((e) => console.warn('[neteaseService] 启动账号校正失败:', e))

  ipcMain.handle('netease:search', async (_event, keywords: string, offset = 0, limit = 30) => {
    if (!keywords || !keywords.trim()) {
      return { songs: [], hasMore: false, total: 0 }
    }
    return searchSongs(keywords.trim(), Number(offset) || 0, Number(limit) || 30)
  })

  ipcMain.handle(
    'netease:song-url',
    async (_event, ids: number[], quality?: string, refresh?: boolean) => {
      if (!Array.isArray(ids)) return {}
      return getSongUrlMap(
        ids.map(Number).filter((id) => Number.isFinite(id) && id > 0),
        quality,
        refresh
      )
    }
  )

  ipcMain.handle('netease:hot-search', async () => {
    return getHotSearch()
  })

  ipcMain.handle('netease:suggest', async (_event, keywords: string) => {
    if (!keywords || !keywords.trim()) return []
    return getSearchSuggest(keywords.trim())
  })

  ipcMain.handle('netease:login-qr', async () => {
    return getLoginQr()
  })

  ipcMain.handle('netease:login-qr-check', async (_event, unikey: string) => {
    if (!unikey) return { code: -1 }
    return checkLoginQr(unikey)
  })

  ipcMain.handle('netease:login-status', async () => {
    return getLoginStatus()
  })

  ipcMain.handle('netease:switch-account', async (_event, userId: string) => {
    if (!userId) return { loggedIn: false, accounts: [], activeUserId: '' }
    return switchAccount(userId)
  })

  ipcMain.handle('netease:logout', async (_event, userId?: string) => {
    await logout(userId)
  })

  ipcMain.handle('netease:playlist-detail', async (_event, id: number) => {
    return getPlaylistDetail(Number(id))
  })

  ipcMain.handle('netease:playlist-tracks', async (_event, id: number) => {
    return getPlaylistTracks(Number(id))
  })

  ipcMain.handle('netease:user-playlists', async () => {
    return getUserPlaylists()
  })

  ipcMain.handle('netease:daily-songs', async () => {
    return getDailySongs()
  })

  ipcMain.handle('netease:recommend-playlists', async (_event, limit = 12) => {
    return getRecommendPlaylists(Number(limit) || 12)
  })

  ipcMain.handle('netease:artist-detail', async (_event, id: number) => {
    return getArtistDetail(Number(id))
  })

  ipcMain.handle(
    'netease:artist-songs',
    async (_event, id: number, offset = 0, limit = ARTIST_SONG_PAGE_SIZE) => {
      return getArtistSongs(Number(id), Number(offset) || 0, Number(limit) || ARTIST_SONG_PAGE_SIZE)
    }
  )

  ipcMain.handle(
    'netease:artist-albums',
    async (_event, id: number, offset = 0, limit = ARTIST_ALBUM_PAGE_SIZE) => {
      return getArtistAlbums(
        Number(id),
        Number(offset) || 0,
        Number(limit) || ARTIST_ALBUM_PAGE_SIZE
      )
    }
  )

  ipcMain.handle('netease:album-tracks', async (_event, id: number) => {
    return getAlbumTracks(Number(id))
  })
}
