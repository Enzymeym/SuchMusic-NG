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

export interface LocalSong {
  id: number | string
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  filePath?: string
  dt?: number
  picUrl?: string
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
      const artistMap = new Map<string, {
        name: string
        cover: string
        playCount: number
        songCount: number
        songs: { id: string | number; title: string; artist: string; cover: string; album?: string; filePath?: string; durationMs?: number }[]
      }>()

      const ensureArtist = (name: string) => {
        if (!artistMap.has(name)) {
          artistMap.set(name, { name, cover: '', playCount: 0, songCount: 0, songs: [] })
        }
        return artistMap.get(name)!
      }

      state.songs.forEach((song) => {
        const artistName = song.ar?.[0]?.name || '未知歌手'
        const info = ensureArtist(artistName)
        if (!info.cover && song.picUrl) info.cover = song.picUrl
        if (!info.cover && song.al?.picUrl) info.cover = song.al.picUrl

        const existingIdx = info.songs.findIndex(s => s.id === song.id)
        const track = {
          id: song.id,
          title: song.name,
          artist: artistName,
          cover: song.picUrl || song.al?.picUrl || '',
          album: song.al?.name,
          filePath: song.filePath,
          durationMs: song.dt
        }
        if (existingIdx >= 0) {
          info.songs[existingIdx] = track
        } else {
          info.songs.push(track)
        }
      })

      playerStore.playHistory.forEach((record) => {
        const artistName = record.artist || '未知歌手'
        const info = ensureArtist(artistName)
        info.playCount++
        if (!info.cover && record.cover) info.cover = record.cover
        if (!info.songs.find(s => s.id === record.songId)) {
          info.songs.push({
            id: record.songId,
            title: record.title,
            artist: record.artist,
            cover: record.cover,
            album: record.album,
            filePath: record.filePath
          })
        }
      })

      for (const info of artistMap.values()) {
        info.songCount = info.songs.length
        if (info.songs.length > 0) {
          info.cover = info.songs.find(s => s.cover)?.cover || info.cover
        }
      }
      return Array.from(artistMap.values())
    },

    /** 按专辑聚合的音乐列表，利用 Pinia getter 缓存避免 AlbumView 每次 computed 重建 Map */
    albumList(state) {
      const playerStore = usePlayerStore()
      const albumMap = new Map<string, {
        name: string
        artist: string
        cover: string
        playCount: number
        songs: { id: string | number; title: string; artist: string; cover: string; album?: string; filePath?: string; durationMs?: number; year?: number }[]
      }>()

      const ensureAlbum = (name: string, artist: string) => {
        if (!albumMap.has(name)) {
          albumMap.set(name, { name, artist, cover: '', playCount: 0, songs: [] })
        }
        return albumMap.get(name)!
      }

      state.songs.forEach((song) => {
        const albumName = song.al?.name || '未知专辑'
        const artist = song.ar?.[0]?.name || '未知歌手'
        const info = ensureAlbum(albumName, artist)
        if (!info.cover && song.picUrl) info.cover = song.picUrl
        if (!info.cover && song.al?.picUrl) info.cover = song.al.picUrl

        const existingIdx = info.songs.findIndex(s => s.id === song.id)
        let year: number | undefined
        if ((song as any).year) year = (song as any).year
        else if ((song as any).publishTime) year = new Date((song as any).publishTime).getFullYear()

        const track = {
          id: song.id,
          title: song.name,
          artist,
          cover: song.picUrl || song.al?.picUrl || '',
          album: albumName,
          filePath: song.filePath,
          durationMs: song.dt,
          year
        }
        if (existingIdx >= 0) {
          info.songs[existingIdx] = track
        } else {
          info.songs.push(track)
        }
      })

      playerStore.playHistory.forEach((record) => {
        const albumName = record.album || '未知专辑'
        const artist = record.artist || '未知歌手'
        const info = ensureAlbum(albumName, artist)
        info.playCount++
        if (!info.cover && record.cover) info.cover = record.cover
        if (!info.songs.find(s => s.id === record.songId)) {
          info.songs.push({
            id: record.songId,
            title: record.title,
            artist: record.artist,
            cover: record.cover,
            album: record.album,
            filePath: record.filePath
          })
        }
      })

      return Array.from(albumMap.values())
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
                  song.lyrics = result.lyrics
                  if (playerStore.currentSong?.id === song.id && !playerStore.currentSong.lyrics) {
                    playerStore.setLyrics(result.lyrics)
                  }
                }

                if (typeof result.durationMs === 'number' && result.durationMs > 0 && !song.dt) {
                  song.dt = result.durationMs
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
                  song.picUrl = URL.createObjectURL(blob)
                }

                if (result.title) song.name = result.title

                if (result.artists && result.artists.length > 0) {
                  song.ar = result.artists.map((n) => ({ name: n }))
                }

                if (result.album) {
                  if (!song.al) {
                    song.al = { name: result.album }
                  } else {
                    song.al.name = result.album
                  }
                }

                if (typeof result.bitrate === 'number' && result.bitrate > 0) {
                  song.bitrate = result.bitrate
                }

                if (typeof result.sampleRate === 'number' && result.sampleRate > 0) {
                  song.sampleRate = result.sampleRate
                }

                if (
                  (typeof result.bitrate === 'number' && result.bitrate > 0) ||
                  (typeof result.sampleRate === 'number' && result.sampleRate > 0)
                ) {
                  song.quality = formatQuality(result.bitrate, result.sampleRate)
                }
              } catch (error) {
                console.error('读取歌曲 meta 失败', song.filePath, error)
              }
            }
          , 3)
        }

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
