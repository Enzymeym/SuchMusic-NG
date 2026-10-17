import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSettingsStore } from './settingsStore'
import { usePlayerStore } from './playerStore'
import { usePlaylistStore } from './playlistStore'
import { formatQuality } from '../utils/quality'
import { base64ToBlobUrl, createThumbnailBlobUrl } from '../utils/cover'

/** 分批并发执行：控制同时进行的异步任务数量，避免瞬间大量请求 */
async function batchPromiseAll<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 10
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

/**
 * 元数据批量更新队列：fillMeta 期间每条 IPC 返回都会修改多个响应式字段，
 * 逐条立即应用会让 SongList 行与 artistList/albumList 等 getter 反复重算。
 * 将变更聚合并定时批量应用（同一微任务内合并为一次渲染/重算）。
 */
let metaUpdateQueue: Array<() => void> = []
let metaFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushMetaUpdates(): void {
  if (metaFlushTimer) {
    clearTimeout(metaFlushTimer)
    metaFlushTimer = null
  }
  const queue = metaUpdateQueue
  metaUpdateQueue = []
  for (const fn of queue) fn()
  // 元数据批量应用后节流推进分组版本号（分组 getter 依赖它决定是否重算）
  if (queue.length > 0) scheduleMetaVersionBump()
}

function queueMetaUpdate(fn: () => void): void {
  metaUpdateQueue.push(fn)
  if (!metaFlushTimer) {
    metaFlushTimer = setTimeout(flushMetaUpdates, 40)
  }
}

/**
 * 按需加载的“高清封面”缓存：列表/历史等场景统一使用缩略图常驻，
 * 仅当前播放歌曲按需读取原始封面并缓存在此，最多保留 FULL_COVER_CACHE_MAX 张，
 * 超出后释放最旧一张的 Blob URL，避免高清封面在整库规模上常驻内存。
 */
const fullCoverCache = new Map<string | number, string>()
const FULL_COVER_CACHE_MAX = 4
/** 本次 fillMeta 中缩略图两次都失败的数量（用于结束时一次性告警，便于定位异常封面） */
let thumbFailCount = 0

/**
 * 歌词缓存（模块级、非响应式）。
 *
 * 旧实现把每首歌的歌词全文写入 `song.lyrics`（Pinia 响应式数组），
 * 5000 首 × 2-10KB ≈ 40MB 常驻，而列表/分组根本不用这个字段。
 * 现在只有「最近用到的歌词」保留在这一小份 LRU 里。
 */
const LYRICS_CACHE_MAX = 120
const lyricsCache = new Map<string, string>()

function lyricsKeyOf(song: { id?: string | number; filePath?: string }): string {
  return song.filePath || `id:${String(song.id)}`
}

function setLyricsCache(key: string, text: string): void {
  if (!text) return
  lyricsCache.delete(key)
  lyricsCache.set(key, text)
  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    const oldest = lyricsCache.keys().next().value
    if (oldest === undefined) break
    lyricsCache.delete(oldest)
  }
}

function getLyricsCache(key: string): string | undefined {
  const value = lyricsCache.get(key)
  if (value !== undefined) {
    // 命中时刷新为最近使用，维持 LRU 顺序
    lyricsCache.delete(key)
    lyricsCache.set(key, value)
  }
  return value
}

/** 清空歌词缓存（曲库被整体替换时调用） */
export function clearLocalLyricsCache(): void {
  lyricsCache.clear()
}

/**
 * 分组 getter 的版本号。
 *
 * `artistList` / `albumList` 会遍历整库并 buildTrack 出新对象，而 fillMeta 期间
 * 每 40ms 就有一批字段更新，导致这两个 getter 在几十秒内被反复全量重建。
 * 引入显式版本号后，getter 只依赖「数组引用 / 长度 / 版本号」这几个结构级信号，
 * 字段级改动不再弄脏它，重算频率从 40ms 级降到 1.2s 级。
 */
const metaVersion = ref(0)
let metaVersionTimer: ReturnType<typeof setTimeout> | null = null

function bumpMetaVersion(): void {
  metaVersion.value++
}

/** fillMeta 期间节流推进版本号，避免每批 meta 更新都触发全量分组重算 */
function scheduleMetaVersionBump(): void {
  if (metaVersionTimer) return
  metaVersionTimer = setTimeout(() => {
    metaVersionTimer = null
    bumpMetaVersion()
  }, 1200)
}

interface GroupFingerprint {
  version: number
  songsRef: unknown
  songCount: number
  historyRef: unknown
  historyLen: number
  historyHeadTs: number | undefined
}

interface GroupCacheEntry<T> extends GroupFingerprint {
  value: T[]
}

let artistCache: GroupCacheEntry<any> | null = null
let albumCache: GroupCacheEntry<any> | null = null

function buildFingerprint(songs: unknown[], history: Array<{ timestamp?: number }>): GroupFingerprint {
  return {
    version: metaVersion.value,
    songsRef: songs,
    songCount: songs.length,
    historyRef: history,
    historyLen: history.length,
    historyHeadTs: history[0]?.timestamp
  }
}

function isCacheHit(cache: GroupCacheEntry<any> | null, fp: GroupFingerprint): boolean {
  return (
    !!cache &&
    cache.version === fp.version &&
    cache.songsRef === fp.songsRef &&
    cache.songCount === fp.songCount &&
    cache.historyRef === fp.historyRef &&
    cache.historyLen === fp.historyLen &&
    cache.historyHeadTs === fp.historyHeadTs
  )
}
/** 列表缩略图边长（px）：兼顾列表/卡片清晰度与常驻内存，播放页大图另走高清按需加载 */
const THUMB_SIZE = 256

export interface LocalSong {
  id: number | string
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  filePath?: string
  dt?: number
  picUrl?: string
  /** 列表小图缩略图（128px WebP），避免大封面按原尺寸解码占用内存 */
  thumbUrl?: string
  lyrics?: string
  quality?: string
  bitrate?: number
  sampleRate?: number
  [key: string]: any
}

interface LocalMusicState {
  songs: LocalSong[]
  loading: boolean
  fillingMeta: boolean
}

/** 聚合列表中的单曲结构（歌手/专辑分组共用） */
interface GroupedTrack {
  id: string | number
  title: string
  artist: string
  cover: string
  album?: string
  filePath?: string
  durationMs?: number
  year?: number
}

/**
 * 从本地歌曲或播放记录构建统一的曲目结构
 * @param song 本地歌曲（LocalSong）或播放记录（字段结构兼容）
 * @param artistName 歌手名（已做“未知歌手”兜底）
 */
function buildTrack(
  song: {
    id: string | number
    name?: string
    title?: string
    picUrl?: string
    cover?: string
    al?: { name?: string; picUrl?: string }
    album?: string
    filePath?: string
    dt?: number
  },
  artistName: string
): GroupedTrack {
  return {
    id: song.id,
    title: song.title ?? song.name ?? '',
    artist: artistName,
    cover: song.cover ?? song.picUrl ?? song.al?.picUrl ?? '',
    album: song.album ?? song.al?.name,
    filePath: song.filePath,
    durationMs: song.dt
  }
}

/**
 * 将曲目写入分组歌曲数组（去重插入）
 * @param groups 分组名 -> 分组对象（含 songs 数组）
 * @param seen 去重索引：`${分组名}\u0000${歌曲id}` -> songs 数组下标，替代 findIndex 的 O(n) 线性扫描
 * @param groupName 分组名（歌手/专辑）
 * @param track 待写入的曲目
 */
function upsertTrack<T extends { songs: GroupedTrack[] }>(
  groups: Map<string, T>,
  seen: Map<string, number>,
  groupName: string,
  track: GroupedTrack
): void {
  const key = `${groupName}\u0000${track.id}`
  if (seen.has(key)) return
  const songs = groups.get(groupName)!.songs
  seen.set(key, songs.length)
  songs.push(track)
}

export const useLocalMusicStore = defineStore('localMusic', {
  state: (): LocalMusicState => ({
    songs: [],
    loading: false,
    fillingMeta: false
  }),
  getters: {
    /** 按歌手聚合的音乐列表，利用 Pinia getter 缓存避免 SingerView 每次 computed 重建 Map */
    artistList(state) {
      const playerStore = usePlayerStore()
      // 只读「结构级」依赖做指纹：命中时 O(1) 返回同一数组引用，
      // 不触碰任何 song.* 字段，因此 fillMeta 的字段级更新不会触发全量重建
      const fingerprint = buildFingerprint(state.songs, playerStore.playHistory)
      if (isCacheHit(artistCache, fingerprint)) return artistCache!.value

      const groups = new Map<string, {
        name: string
        cover: string
        playCount: number
        songCount: number
        songs: GroupedTrack[]
      }>()
      // 去重索引：`${分组名}\u0000${歌曲id}` -> songs 数组下标，替代 findIndex 的 O(n) 线性扫描
      const seen = new Map<string, number>()

      const ensureGroup = (name: string) => {
        let group = groups.get(name)
        if (!group) {
          group = { name, cover: '', playCount: 0, songCount: 0, songs: [] }
          groups.set(name, group)
        }
        return group
      }

      state.songs.forEach((song) => {
        const artistName = song.ar?.[0]?.name || '未知歌手'
        const group = ensureGroup(artistName)
        if (!group.cover && song.picUrl) group.cover = song.picUrl
        if (!group.cover && song.al?.picUrl) group.cover = song.al.picUrl

        upsertTrack(groups, seen, artistName, buildTrack(song, artistName))
      })

      playerStore.playHistory.forEach((record) => {
        const artistName = record.artist || '未知歌手'
        const group = ensureGroup(artistName)
        group.playCount++
        if (!group.cover && record.cover) group.cover = record.cover

        upsertTrack(groups, seen, artistName, buildTrack({
          id: record.songId,
          title: record.title,
          cover: record.cover,
          album: record.album,
          filePath: record.filePath
        }, artistName))
      })

      for (const group of groups.values()) {
        group.songCount = group.songs.length
        if (group.songs.length > 0) {
          group.cover = group.songs.find(s => s.cover)?.cover || group.cover
        }
      }
      const value = Array.from(groups.values())
      artistCache = { ...fingerprint, value }
      return value
    },

    /** 按专辑聚合的音乐列表，利用 Pinia getter 缓存避免 AlbumView 每次 computed 重建 Map */
    albumList(state) {
      const playerStore = usePlayerStore()
      const fingerprint = buildFingerprint(state.songs, playerStore.playHistory)
      if (isCacheHit(albumCache, fingerprint)) return albumCache!.value

      const groups = new Map<string, {
        name: string
        artist: string
        cover: string
        playCount: number
        songs: GroupedTrack[]
      }>()
      const seen = new Map<string, number>()

      const ensureGroup = (name: string, artist: string) => {
        let group = groups.get(name)
        if (!group) {
          group = { name, artist, cover: '', playCount: 0, songs: [] }
          groups.set(name, group)
        }
        return group
      }

      state.songs.forEach((song) => {
        const albumName = song.al?.name || '未知专辑'
        const artist = song.ar?.[0]?.name || '未知歌手'
        const group = ensureGroup(albumName, artist)
        if (!group.cover && song.picUrl) group.cover = song.picUrl
        if (!group.cover && song.al?.picUrl) group.cover = song.al.picUrl

        const track = buildTrack(song, artist)
        const year = (song as any).year
          ?? ((song as any).publishTime ? new Date((song as any).publishTime).getFullYear() : undefined)
        if (year !== undefined) track.year = year
        upsertTrack(groups, seen, albumName, track)
      })

      playerStore.playHistory.forEach((record) => {
        const albumName = record.album || '未知专辑'
        const artist = record.artist || '未知歌手'
        const group = ensureGroup(albumName, artist)
        group.playCount++
        if (!group.cover && record.cover) group.cover = record.cover

        upsertTrack(groups, seen, albumName, buildTrack({
          id: record.songId,
          title: record.title,
          cover: record.cover,
          album: record.album,
          filePath: record.filePath
        }, artist))
      })

      const value = Array.from(groups.values())
      albumCache = { ...fingerprint, value }
      return value
    }
  },

  actions: {
    async scanMusic() {
      if (this.loading) return
      this.loading = true
      const settingsStore = useSettingsStore()

      try {
        // 释放旧数据的 Blob URL，避免内存泄漏
        this.revokeCovers()
        // 曲库将被整体替换，旧路径的歌词可能属于已删除文件
        clearLocalLyricsCache()

        const rawDirs = settingsStore.local.scanDirs
        const plainDirs = Array.isArray(rawDirs) ? [...rawDirs] : []
        
        // @ts-ignore
        const result = (await window.electron.ipcRenderer.invoke(
          'local-music:scan',
          plainDirs.length ? plainDirs : undefined
        )) as {
          rootDir: string
          rootDirs?: string[]
          tracks: Array<{
            id: string
            name: string
            filePath: string
            ar: { name: string }[]
            al: { name: string }
            dt?: number
            quality?: string
          }>
        }

        const list: LocalSong[] = result.tracks.map((t) => ({
          id: t.id,
          name: t.name,
          ar: t.ar,
          al: t.al,
          filePath: t.filePath,
          dt: t.dt,
          quality: t.quality ?? 'Standard'
        }))

        this.songs = list
        // 新数组引用已能触发分组重建，这里再显式推进版本号做双保险
        bumpMetaVersion()
        void this.fillMeta()
      } catch (error) {
        console.error('扫描本地音乐失败', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async fillMeta() {
      if (this.fillingMeta) return
      this.fillingMeta = true
      thumbFailCount = 0
      const playerStore = usePlayerStore()
      const playlistStore = usePlaylistStore()

      try {
        const targets = this.songs.filter((song) => {
          if (!song.filePath) return false
          const missingBasic =
            !song.dt || !song.picUrl || !song.name || !song.ar || song.ar.length === 0
          const isPlaceholderArtist =
            song.ar && song.ar.length > 0 && song.ar[0].name === '本地音乐'
          return missingBasic || isPlaceholderArtist
        })
        
        if (targets.length) {
          // 限制并发为 3，避免同时读取多个大文件导致主进程/渲染进程内存峰值过高
          await batchPromiseAll(
            targets,
            async (song) => {
              if (!song.filePath) return
              try {
                // @ts-ignore
                const result = (await window.electron.ipcRenderer.invoke(
                  'local-music:get-meta',
                  song.filePath
                )) as {
                  durationMs?: number
                  bitrate?: number
                  sampleRate?: number
                  cover?: { mimeType: string; base64: string }
                  title?: string
                  artists?: string[]
                  album?: string
                  lyrics?: string
                }

                if (result.lyrics) {
                  const lyrics = result.lyrics
                  // 歌词不再写入响应式 state：只放模块级 LRU，播放时按需取用
                  setLyricsCache(lyricsKeyOf(song), lyrics)
                  if (
                    playerStore.currentSong?.id === song.id &&
                    !playerStore.currentSong.lyrics
                  ) {
                    queueMetaUpdate(() => {
                      playerStore.setLyrics(lyrics)
                    })
                  }
                }

                if (
                  typeof result.durationMs === 'number' &&
                  result.durationMs > 0 &&
                  !song.dt
                ) {
                  queueMetaUpdate(() => {
                    song.dt = result.durationMs
                  })
                }

                if (result.cover && result.cover.base64 && !song.picUrl) {
                  // 先以原图占位，随后异步生成缩略图并切换为缩略图，再释放原图 Blob URL。
                  // 列表/历史等场景只需缩略图，避免整库高清封面常驻（单张可达数百 KB 编码数据
                  // + 大尺寸解码位图）；播放页大图另经 loadFullCover 按需加载。
                  const coverUrl = base64ToBlobUrl(result.cover.base64, result.cover.mimeType)
                  if (coverUrl) {
                    queueMetaUpdate(() => {
                      song.picUrl = coverUrl
                    })
                    void (async () => {
                      // 256px 首要目标；失败时降级到 128px / 较低质量再试一次。
                      // 两次都失败才保留原图 blob（由 revokeCovers 统一释放）。
                      let thumbUrl = await createThumbnailBlobUrl(coverUrl, THUMB_SIZE)
                      if (!thumbUrl) {
                        thumbUrl = await createThumbnailBlobUrl(coverUrl, 128, 0.7)
                      }
                      if (!thumbUrl) {
                        thumbFailCount++
                        return
                      }
                      queueMetaUpdate(() => {
                        song.thumbUrl = thumbUrl
                        song.picUrl = thumbUrl
                      })
                      // 待列表渲染切换到缩略图后再释放原图，避免封面闪烁
                      setTimeout(() => URL.revokeObjectURL(coverUrl), 500)
                    })()
                  }
                }

                if (result.title) {
                  const title = result.title
                  queueMetaUpdate(() => {
                    song.name = title
                  })
                }

                if (result.artists && result.artists.length > 0) {
                  const artists = result.artists.map((n) => ({ name: n }))
                  queueMetaUpdate(() => {
                    song.ar = artists
                  })
                }

                if (result.album) {
                  const album = result.album
                  queueMetaUpdate(() => {
                    if (!song.al) {
                      song.al = { name: album }
                    } else {
                      song.al.name = album
                    }
                  })
                }

                if (typeof result.bitrate === 'number' && result.bitrate > 0) {
                  queueMetaUpdate(() => {
                    song.bitrate = result.bitrate
                  })
                }

                if (typeof result.sampleRate === 'number' && result.sampleRate > 0) {
                  queueMetaUpdate(() => {
                    song.sampleRate = result.sampleRate
                  })
                }

                if (
                  (typeof result.bitrate === 'number' && result.bitrate > 0) ||
                  (typeof result.sampleRate === 'number' && result.sampleRate > 0)
                ) {
                  const quality = formatQuality(result.bitrate, result.sampleRate)
                  queueMetaUpdate(() => {
                    song.quality = quality
                  })
                }
              } catch (error) {
                console.error('读取歌曲 meta 失败', song.filePath, error)
              }
            }
          , 3)
        }

        // 批量应用所有待处理的元数据更新，确保后续封面恢复读到最新状态
        flushMetaUpdates()

        // 本地音乐元数据补全后，把封面同步回播放器状态和用户歌单
        playerStore.restoreCoversFromLocalSongs(this.songs)
        playlistStore.restoreCoversFromLocalSongs(this.songs)
      } finally {
        this.fillingMeta = false
        // 最后一次批量应用 + 推进版本号，保证视图拿到补全后的最终分组
        flushMetaUpdates()
        bumpMetaVersion()
        if (thumbFailCount > 0) {
          console.warn(`[localMusic] ${thumbFailCount} 首歌曲的封面缩略图生成失败，已回退为原图`)
          thumbFailCount = 0
        }
      }
    },

    /**
     * 释放所有通过 URL.createObjectURL 创建的 Blob URL
     * 避免 Blob URL 引用的数据无法被 GC 回收
     */
    revokeCovers(): void {
      this.songs.forEach((song) => {
        if (song.picUrl && song.picUrl.startsWith('blob:')) {
          URL.revokeObjectURL(song.picUrl)
        }
        if (song.thumbUrl && song.thumbUrl.startsWith('blob:')) {
          URL.revokeObjectURL(song.thumbUrl)
        }
      })
    },

    /**
     * 按需加载某首本地歌曲的高清封面（用于播放页大图与背景）。
     * 结果缓存在模块级 fullCoverCache 中并受容量限制，超出时释放最旧一张。
     * @param songId 歌曲 ID
     * @param filePath 音频文件路径
     * @returns 高清封面 Blob URL；无封面或失败返回 null
     */
    async loadFullCover(songId: string | number, filePath?: string): Promise<string | null> {
      if (!filePath) return null
      const cached = fullCoverCache.get(songId)
      if (cached) {
        // 命中时刷新为最近使用，维持 LRU 顺序（原实现是 FIFO，来回切两首歌会互相淘汰）
        fullCoverCache.delete(songId)
        fullCoverCache.set(songId, cached)
        return cached
      }
      try {
        // @ts-ignore
        const result = (await window.electron.ipcRenderer.invoke(
          'local-music:get-meta',
          filePath
        )) as { cover?: { mimeType: string; base64: string } }
        if (!result?.cover?.base64) return null
        const url = base64ToBlobUrl(result.cover.base64, result.cover.mimeType)
        if (!url) return null
        fullCoverCache.set(songId, url)
        while (fullCoverCache.size > FULL_COVER_CACHE_MAX) {
          const oldestKey = fullCoverCache.keys().next().value
          if (oldestKey === undefined) break
          const oldUrl = fullCoverCache.get(oldestKey)
          fullCoverCache.delete(oldestKey)
          if (oldUrl) URL.revokeObjectURL(oldUrl)
        }
        return url
      } catch (error) {
        console.error('加载高清封面失败', filePath, error)
        return null
      }
    },

    /**
     * 取某首歌缓存的歌词（模块级 LRU，非响应式）。
     * 未命中返回空串，调用方应保持「空则走兜底异步拉取」的语义。
     */
    getLyrics(song: { id?: string | number; filePath?: string }): string {
      return getLyricsCache(lyricsKeyOf(song)) ?? ''
    },

    /**
     * 返回某首歌曲已缓存的高清封面 URL（未加载则为 null）
     * @param songId 歌曲 ID
     */
    getFullCoverUrl(songId: string | number): string | null {
      return fullCoverCache.get(songId) ?? null
    },

    /**
     * 清空本地音乐数据并释放所有 Blob URL
     */
    clear(): void {
      this.revokeCovers()
      fullCoverCache.forEach((url) => URL.revokeObjectURL(url))
      fullCoverCache.clear()
      clearLocalLyricsCache()
      this.songs = []
      this.loading = false
      this.fillingMeta = false
      bumpMetaVersion()
    }
  }
})
