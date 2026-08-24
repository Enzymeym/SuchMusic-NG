import { defineStore } from 'pinia'
import { useSettingsStore } from './settingsStore'
import { usePlayerStore } from './playerStore'
import { usePlaylistStore } from './playlistStore'
import { formatQuality } from '../utils/quality'

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
}

function queueMetaUpdate(fn: () => void): void {
  metaUpdateQueue.push(fn)
  if (!metaFlushTimer) {
    metaFlushTimer = setTimeout(flushMetaUpdates, 40)
  }
}

/**
 * 将图片 Blob URL 缩小为正方形缩略图 Blob URL（128px WebP）。
 * 列表封面显示仅几十像素，若直接用原图（可能 1000×1000+）按原尺寸解码，
 * 每张位图可达数 MB；缩略图后仅 ~128×128，滚动数百首也仅占用几十 MB。
 * 失败时返回空字符串（调用方回退到原图）。
 */
async function createThumbnailBlobUrl(src: string, size = 128, quality = 0.82): Promise<string> {
  try {
    const res = await fetch(src)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return ''
      const side = Math.min(bmp.width, bmp.height)
      ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size)
      return await new Promise<string>((resolve) => {
        canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : ''), 'image/webp', quality)
      })
    } finally {
      bmp.close()
    }
  } catch {
    return ''
  }
}

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
      return Array.from(groups.values())
    },

    /** 按专辑聚合的音乐列表，利用 Pinia getter 缓存避免 AlbumView 每次 computed 重建 Map */
    albumList(state) {
      const playerStore = usePlayerStore()
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

      return Array.from(groups.values())
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
                  queueMetaUpdate(() => {
                    song.lyrics = lyrics
                    if (
                      playerStore.currentSong?.id === song.id &&
                      !playerStore.currentSong.lyrics
                    ) {
                      playerStore.setLyrics(lyrics)
                    }
                  })
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
                  // 将 base64 封面转换为 Blob URL，避免大字符串占用 Pinia 响应式内存
                  // Blob URL 是一个短引用字符串（~50字节），而非 100-300KB 的 base64 数据
                  const binaryStr = atob(result.cover.base64)
                  const bytes = new Uint8Array(binaryStr.length)
                  for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i)
                  }
                  const blob = new Blob([bytes], { type: result.cover.mimeType })
                  const coverUrl = URL.createObjectURL(blob)
                  queueMetaUpdate(() => {
                    song.picUrl = coverUrl
                  })
                  // 原图较大时异步生成 128px 缩略图供列表小图使用（后台执行，不阻塞 fillMeta）
                  if (result.cover.base64.length > 16000) {
                    void createThumbnailBlobUrl(coverUrl, 128).then((thumbUrl) => {
                      if (thumbUrl) {
                        queueMetaUpdate(() => {
                          song.thumbUrl = thumbUrl
                        })
                      }
                    })
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
     * 清空本地音乐数据并释放所有 Blob URL
     */
    clear(): void {
      this.revokeCovers()
      this.songs = []
      this.loading = false
      this.fillingMeta = false
    }
  }
})
