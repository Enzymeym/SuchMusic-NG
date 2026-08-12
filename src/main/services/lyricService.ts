/**
 * 歌词获取服务
 * 为不同平台提供在线歌词获取能力，支持本地缓存
 */

import { ipcMain, app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import crypto from 'crypto'

/** 网易云歌词 API 基础地址 */
const WY_API_BASE = 'https://api.enzymeym.top'

/** QQ 音乐歌词 API 基础地址 */
const QQ_API_BASE = 'https://api.vkeys.cn/v2/music/tencent'

/** 网易云封面 URL 加密 key */
const NETEASE_PIC_KEY = '3go8&$8*3*3h0k(2)2'

/**
 * 网易云图片 ID 加密
 * 用于将 album.picId / song.picId 转换为封面直链路径
 */
export function neteaseEncryptPicId(picId: string): string {
  const keyChars = NETEASE_PIC_KEY.split('')
  const xored = picId
    .split('')
    .map((char, index) =>
      String.fromCharCode(char.charCodeAt(0) ^ keyChars[index % keyChars.length].charCodeAt(0))
    )
    .join('')
  return crypto
    .createHash('md5')
    .update(xored, 'binary')
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
}

/**
 * 根据 picId 构造网易云封面 URL
 * @param picId 图片 ID
 * @param size 图片尺寸，默认 300
 */
export function getNeteaseCoverUrl(picId: number | string, size = 300): string {
  const id = String(picId)
  const hash = neteaseEncryptPicId(id)
  return `https://p1.music.126.net/${hash}/${id}.jpg?param=${size}y${size}`
}

/** 网易云歌词 API 响应结构 */
interface WyLyricResponse {
  code: number
  lrc?: { version: number; lyric: string }
  tlyric?: { version: number; lyric: string }
  romalrc?: { version: number; lyric: string }
  yrc?: { version: number; lyric: string }
}

/** 网易云搜索 API 响应结构 */
interface WySearchResponse {
  result?: {
    songs?: WySearchSong[]
  }
}

interface WySearchSong {
  id: number
  name: string
  artists?: { name: string }[]
  ar?: { name: string }[]
  picId?: number
  album?: { name?: string; picId?: number; picUrl?: string }
  al?: { name?: string; picId?: number; picUrl?: string }
}

/** QQ 音乐搜索 API 响应结构 */
interface QQSearchResponse {
  code: number
  data?: QQSearchSong[]
}

interface QQSearchSong {
  id: number
  mid: string
  song: string
  singer: string
  album?: string
  cover?: string
}

/** QQ 音乐歌词 API 响应结构 */
interface QQLyricResponse {
  code: number
  data?: {
    lrc?: string
    trans?: string
    yrc?: string
    roma?: string
  }
}

/** 歌词来源 */
type LyricSource = 'netease' | 'qq'

/** 歌词获取结果 */
export interface LyricsResult {
  /** 主歌词（优先 YRC 逐字歌词，回退 LRC） */
  lyrics: string
  /** 翻译歌词 */
  translatedLyrics: string
  /** 音译歌词（罗马音） */
  romanLyrics: string
  /** 匹配到的网易云歌曲 ID */
  wySongId?: string
  /** 匹配到的歌曲封面 */
  coverUrl?: string
  /** 歌词来源 */
  source?: LyricSource
  /** QQ 音乐歌曲 mid（source 为 qq 时使用） */
  mid?: string
  /** 匹配到的歌曲名 */
  name?: string
  /** 匹配到的歌手名 */
  artists?: string
  /** 匹配到的专辑名 */
  album?: string
}

/** 歌词匹配请求参数 */
interface LyricsMatchRequest {
  title: string
  artist: string
}

/** 歌词搜索结果项 */
export interface LyricSearchResult {
  id: number
  name: string
  artists: string
  /** 专辑名 */
  album?: string
  /** 歌曲封面 */
  coverUrl?: string
  /** 歌词来源 */
  source: LyricSource
  /** QQ 音乐歌曲 mid（source 为 qq 时使用） */
  mid?: string
}

/** 本地缓存条目 */
interface CachedLyrics {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
  wySongId: string
  coverUrl: string
  source: LyricSource
  mid: string
  name: string
  artists: string
  album: string
  cachedAt: number
}

/** 歌词缓存映射：key = "artist - title" 归一化 */
type LyricsCache = Record<string, CachedLyrics>

/** 歌词缓存文件路径 */
let _cacheFilePath: string | null = null

function getCacheFilePath(): string {
  if (!_cacheFilePath) {
    _cacheFilePath = join(app.getPath('userData'), 'lyrics-cache.json')
  }
  return _cacheFilePath
}

/** 生成缓存键（归一化处理） */
function makeCacheKey(title: string, artist: string): string {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${normalize(artist)} - ${normalize(title)}`
}

/** 读取本地歌词缓存 */
async function loadLyricsCache(): Promise<LyricsCache> {
  const filePath = getCacheFilePath()
  try {
    if (existsSync(filePath)) {
      const raw = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(raw) as LyricsCache
    }
  } catch (e) {
    console.warn('[lyricService] Failed to read lyrics cache, starting fresh:', e)
  }
  return {}
}

/** 写入本地歌词缓存 */
async function saveLyricsCache(cache: LyricsCache): Promise<void> {
  const filePath = getCacheFilePath()
  try {
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8')
  } catch (e) {
    console.error('[lyricService] Failed to save lyrics cache:', e)
  }
}

/** 从缓存中查找歌词 */
async function getCachedLyrics(title: string, artist: string): Promise<LyricsResult | null> {
  const cache = await loadLyricsCache()
  const key = makeCacheKey(title, artist)
  const entry = cache[key]
  if (entry) {
    return {
      lyrics: entry.lyrics,
      translatedLyrics: entry.translatedLyrics,
      romanLyrics: entry.romanLyrics,
      wySongId: entry.wySongId,
      coverUrl: entry.coverUrl,
      source: entry.source,
      mid: entry.mid,
      name: entry.name,
      artists: entry.artists,
      album: entry.album
    }
  }
  return null
}

/** 将歌词存入缓存 */
async function setCachedLyrics(title: string, artist: string, result: LyricsResult): Promise<void> {
  const cache = await loadLyricsCache()
  const key = makeCacheKey(title, artist)
  cache[key] = {
    lyrics: result.lyrics,
    translatedLyrics: result.translatedLyrics,
    romanLyrics: result.romanLyrics,
    wySongId: result.wySongId || '',
    coverUrl: result.coverUrl || '',
    source: result.source || 'netease',
    mid: result.mid || '',
    name: result.name || '',
    artists: result.artists || '',
    album: result.album || '',
    cachedAt: Date.now()
  }
  await saveLyricsCache(cache)
}

/**
 * 从网易云搜索歌曲
 * @param keywords 搜索关键词
 * @returns 搜索结果列表
 */
async function searchWySong(keywords: string): Promise<WySearchSong[]> {
  const url = `${WY_API_BASE}/search?keywords=${encodeURIComponent(keywords)}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[lyricService] HTTP ${resp.status} searching for "${keywords}"`)
      return []
    }
    const data: WySearchResponse = await resp.json()
    return data.result?.songs || []
  } catch (e) {
    console.error(`[lyricService] Failed to search for "${keywords}":`, e)
    return []
  }
}

/**
 * 从网易云获取歌词
 * @param songId 网易云歌曲 ID（纯数字）
 * @returns 歌词数据，获取失败返回 null
 */
async function fetchWyLyrics(songId: string): Promise<LyricsResult | null> {
  const url = `${WY_API_BASE}/lyric/new?id=${songId}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[lyricService] HTTP ${resp.status} fetching lyrics for song ${songId}`)
      return null
    }
    const data: WyLyricResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[lyricService] API error code ${data.code} for song ${songId}`)
      return null
    }

    // 优先使用 YRC 逐字歌词，回退到 LRC 普通歌词
    const yrcLyric = data.yrc?.lyric || ''
    const lrcLyric = data.lrc?.lyric || ''
    const tLyric = data.tlyric?.lyric || ''
    const romaLyric = data.romalrc?.lyric || ''

    return {
      lyrics: yrcLyric || lrcLyric,
      translatedLyrics: tLyric,
      romanLyrics: romaLyric,
      wySongId: songId,
      source: 'netease'
    }
  } catch (e) {
    console.error(`[lyricService] Failed to fetch lyrics for song ${songId}:`, e)
    return null
  }
}

/**
 * 从 QQ 音乐搜索歌曲
 * @param keywords 搜索关键词
 * @returns 搜索结果列表
 */
async function searchQQSong(keywords: string): Promise<QQSearchSong[]> {
  const url = `${QQ_API_BASE}/search/song?word=${encodeURIComponent(keywords)}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[lyricService] HTTP ${resp.status} searching QQ for "${keywords}"`)
      return []
    }
    const data: QQSearchResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[lyricService] QQ API error code ${data.code} searching "${keywords}"`)
      return []
    }
    return data.data || []
  } catch (e) {
    console.error(`[lyricService] Failed to search QQ for "${keywords}":`, e)
    return []
  }
}

/**
 * 从 QQ 音乐获取歌词
 * @param mid QQ 音乐歌曲 mid
 * @returns 歌词数据，获取失败返回 null
 */
async function fetchQQLyrics(mid: string): Promise<LyricsResult | null> {
  const url = `${QQ_API_BASE}/lyric?mid=${encodeURIComponent(mid)}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[lyricService] HTTP ${resp.status} fetching QQ lyrics for ${mid}`)
      return null
    }
    const data: QQLyricResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[lyricService] QQ API error code ${data.code} for ${mid}`)
      return null
    }

    const lyricData = data.data || {}
    const yrcLyric = lyricData.yrc || ''
    const lrcLyric = lyricData.lrc || ''
    const tLyric = lyricData.trans || ''
    const romaLyric = lyricData.roma || ''

    return {
      lyrics: yrcLyric || lrcLyric,
      translatedLyrics: tLyric,
      romanLyrics: romaLyric,
      source: 'qq',
      mid
    }
  } catch (e) {
    console.error(`[lyricService] Failed to fetch QQ lyrics for ${mid}:`, e)
    return null
  }
}

/**
 * 根据歌曲名和歌手名，从网易云搜索匹配然后获取歌词
 * 匹配策略：优先找同名+同歌手的歌曲；没匹配到就用搜索结果第一项
 * @param title 歌曲名
 * @param artist 歌手名
 * @returns 歌词数据，获取失败返回 null
 */
async function matchAndFetchLyrics(title: string, artist: string): Promise<LyricsResult | null> {
  // 先查缓存
  const cached = await getCachedLyrics(title, artist)
  if (cached) {
    console.log(`[lyricService] Cache hit for "${artist} - ${title}"`)
    return cached
  }

  // 优先网易云
  const wyResult = await matchAndFetchWyLyrics(title, artist)
  if (wyResult) {
    await setCachedLyrics(title, artist, wyResult)
    return wyResult
  }

  // 网易云无结果时回退 QQ 音乐
  const qqResult = await matchAndFetchQQLyrics(title, artist)
  if (qqResult) {
    await setCachedLyrics(title, artist, qqResult)
    return qqResult
  }

  return null
}

/**
 * 网易云：搜索匹配并获取歌词
 */
async function matchAndFetchWyLyrics(
  title: string,
  artist: string
): Promise<LyricsResult | null> {
  const songs = await searchWySong(title)
  if (!songs.length) {
    console.warn(`[lyricService] No NetEase search results for "${title}"`)
    return null
  }

  const normalizedArtist = artist.trim().toLowerCase()
  let matchedSong: WySearchSong | null = null

  for (const song of songs) {
    const artists = song.artists || song.ar || []
    for (const a of artists) {
      if (a.name.trim().toLowerCase() === normalizedArtist) {
        matchedSong = song
        break
      }
    }
    if (matchedSong) break
  }

  if (!matchedSong) {
    matchedSong = songs[0]
    console.log(
      `[lyricService] No artist match for "${artist}", using first NetEase result: "${matchedSong.name}"`
    )
  } else {
    console.log(`[lyricService] Matched NetEase "${matchedSong.name}" by "${artist}"`)
  }

  const result = await fetchWyLyrics(String(matchedSong.id))
  if (result) {
    result.wySongId = String(matchedSong.id)
    const artists = matchedSong.artists || matchedSong.ar || []
    result.name = matchedSong.name
    result.artists = artists.map((a) => a.name).join(' / ')
    result.album = matchedSong.al?.name || matchedSong.album?.name || ''
    const picId = matchedSong.al?.picId ?? matchedSong.album?.picId ?? matchedSong.picId
    result.coverUrl =
      matchedSong.al?.picUrl ||
      matchedSong.album?.picUrl ||
      (picId ? getNeteaseCoverUrl(picId) : '')
  }
  return result
}

/**
 * QQ 音乐：搜索匹配并获取歌词
 */
async function matchAndFetchQQLyrics(
  title: string,
  artist: string
): Promise<LyricsResult | null> {
  const songs = await searchQQSong(title)
  if (!songs.length) {
    console.warn(`[lyricService] No QQ search results for "${title}"`)
    return null
  }

  const normalizedArtist = artist.trim().toLowerCase()
  let matchedSong: QQSearchSong | null = null

  for (const song of songs) {
    if (song.singer.trim().toLowerCase() === normalizedArtist) {
      matchedSong = song
      break
    }
  }

  if (!matchedSong) {
    matchedSong = songs[0]
    console.log(
      `[lyricService] No artist match for "${artist}", using first QQ result: "${matchedSong.song}"`
    )
  } else {
    console.log(`[lyricService] Matched QQ "${matchedSong.song}" by "${artist}"`)
  }

  const result = await fetchQQLyrics(matchedSong.mid)
  if (result) {
    result.name = matchedSong.song
    result.artists = matchedSong.singer
    result.album = matchedSong.album || ''
    result.coverUrl = matchedSong.cover || ''
  }
  return result
}

/**
 * 搜索歌词候选结果（不拉取歌词，仅返回歌曲列表）
 * @param title 歌曲名
 * @param artist 歌手名
 * @returns 搜索结果列表
 */
async function searchLyrics(title: string, artist: string): Promise<LyricSearchResult[]> {
  if (!title) return []
  const keyword = artist ? `${title} ${artist}` : title

  const [wyResult, qqResult] = await Promise.allSettled([
    searchWySong(keyword),
    searchQQSong(keyword)
  ])

  const results: LyricSearchResult[] = []

  if (wyResult.status === 'fulfilled') {
    results.push(
      ...wyResult.value.map((song) => {
        const artists = song.artists || song.ar || []
        const picId = song.al?.picId ?? song.album?.picId ?? song.picId
        const coverUrl =
          song.al?.picUrl ||
          song.album?.picUrl ||
          (picId ? getNeteaseCoverUrl(picId) : '')
        return {
          id: song.id,
          name: song.name,
          artists: artists.map((a) => a.name).join(' / '),
          album: song.al?.name || song.album?.name || '',
          coverUrl,
          source: 'netease' as LyricSource
        }
      })
    )
  } else {
    console.error('[lyricService] NetEase search failed:', wyResult.reason)
  }

  if (qqResult.status === 'fulfilled') {
    results.push(
      ...qqResult.value.map((song) => ({
        id: song.id,
        name: song.song,
        artists: song.singer || '未知歌手',
        album: song.album || '',
        coverUrl: song.cover || '',
        source: 'qq' as LyricSource,
        mid: song.mid
      }))
    )
  } else {
    console.error('[lyricService] QQ search failed:', qqResult.reason)
  }

  return results
}

/**
 * 将用户手动选择的歌词结果写入缓存
 * @param title 歌曲名
 * @param artist 歌手名
 * @param result 歌词结果
 */
async function cacheLyricsResult(
  title: string,
  artist: string,
  result: LyricsResult
): Promise<void> {
  await setCachedLyrics(title, artist, result)
}

/**
 * 注册歌词相关的 IPC handler
 */
export function registerLyricHandlers(): void {
  // 原有：根据网易云歌曲 ID 直接获取歌词
  ipcMain.handle('lyric:fetch-wy', async (_event, songId: string) => {
    return fetchWyLyrics(songId)
  })

  // 新增：根据 QQ 音乐歌曲 mid 直接获取歌词
  ipcMain.handle('lyric:fetch-qq', async (_event, mid: string) => {
    return fetchQQLyrics(mid)
  })

  // 新增：根据歌曲名 + 歌手名搜索匹配并获取歌词（本地优先）
  ipcMain.handle('lyric:fetch-local', async (_event, req: LyricsMatchRequest) => {
    if (!req.title) {
      console.warn('[lyricService] fetch-local: missing title')
      return null
    }
    return matchAndFetchLyrics(req.title, req.artist || '')
  })

  // 新增：仅搜索歌词候选结果，不拉取歌词
  ipcMain.handle('lyric:search', async (_event, title: string, artist?: string) => {
    return searchLyrics(title, artist || '')
  })

  // 新增：将用户手动选择的歌词结果写入缓存
  ipcMain.handle(
    'lyric:cache-result',
    async (_event, title: string, artist: string, result: LyricsResult) => {
      if (!title || !result) {
        console.warn('[lyricService] cache-result: missing title or result')
        return false
      }
      await cacheLyricsResult(title, artist || '', result)
      return true
    }
  )
}
