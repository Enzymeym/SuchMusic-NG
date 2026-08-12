import { defineStore } from 'pinia'

export interface PlaylistTrack {
  id: string | number | null
  title: string
  artist: string
  album?: string
  cover?: string
  filePath?: string
  durationMs?: number
  source?: string
  sourceSongId?: string | number
}

export interface UserPlaylist {
  id: string
  name: string
  cover?: string
  tracks: PlaylistTrack[]
  createdAt: number
  updatedAt: number
  description?: string
  // 新增外观设置
  coverStyle?: 'square' | 'landscape' | 'wide' | 'adaptive' | 'full'
  titleFontWeight?: 'light' | 'regular' | 'bold' | 'heavy'
  titleFontFamily?: 'default' | 'serif'
  /** 封面是否跟随第一首歌曲封面，为 true 时忽略 cover 字段自动使用第一首歌曲封面 */
  coverFollowsFirstTrack?: boolean
}

interface PlaylistState {
  playlists: UserPlaylist[]
}

const STORAGE_KEY = 'user_playlists'
/** localStorage 安全存储上限（保守估计，实际限制因浏览器/环境而异） */
const STORAGE_SAFE_LIMIT_BYTES = 3 * 1024 * 1024 // 3MB

export const usePlaylistStore = defineStore('playlist', {
  state: (): PlaylistState => {
    // 在 state 初始化时同步从 localStorage 加载歌单数据
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return { playlists: parsed }
        }
      } catch (e) {
        console.error('Failed to load playlists from storage', e)
      }
    }
    return { playlists: [] }
  },
  actions: {
    loadFromStorage(): void {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            this.playlists = parsed
          }
        } catch (e) {
          console.error('Failed to load playlists from storage', e)
        }
      }

      // 确保“我喜爱的音乐”歌单存在
      let favoriteIndex = this.playlists.findIndex((p) => p.id === 'favorite')
      if (favoriteIndex === -1) {
        const now = Date.now()
        const favorite: UserPlaylist = {
          id: 'favorite',
          name: '我喜爱的音乐',
          cover: undefined,
          tracks: [],
          createdAt: now,
          updatedAt: now,
          coverStyle: 'full',
          titleFontWeight: 'bold',
          titleFontFamily: 'serif'
        }
        // 插入到最前面
        this.playlists.unshift(favorite)
        this.saveToStorage()
      } else {
        // 确保它在第一个
        if (favoriteIndex !== 0) {
          const fav = this.playlists.splice(favoriteIndex, 1)[0]
          this.playlists.unshift(fav)
          this.saveToStorage()
        }
      }
    },
    saveToStorage(): void {
      try {
        // 本地音乐封面使用 blob URL，进程重启后即失效，持久化时剥离，
        // 避免 localStorage 中残留指向已失效 URL 的封面（与 playerStore 持久化策略一致）。
        // 相关封面会在本地音乐扫描补全后由 restoreCoversFromLocalSongs 重新恢复。
        const persisted = this.playlists.map((pl) => ({
          ...pl,
          cover: pl.cover?.startsWith('blob:') ? undefined : pl.cover,
          tracks: pl.tracks.map((t) => ({
            ...t,
            cover: t.cover?.startsWith('blob:') ? undefined : t.cover
          }))
        }))
        const json = JSON.stringify(persisted)
        const sizeBytes = new Blob([json]).size

        if (sizeBytes > STORAGE_SAFE_LIMIT_BYTES) {
          console.warn(
            `[playlistStore] 歌单数据过大 (${(sizeBytes / 1024).toFixed(2)} KB)，` +
            `接近 localStorage 限制。建议清理不常用的歌单。`
          )
        }

        localStorage.setItem(STORAGE_KEY, json)
      } catch (e) {
        console.error('Failed to save playlists to storage', e)
        try {
          const size = JSON.stringify(this.playlists).length
          console.error(`Playlists data size: ${(size / 1024).toFixed(2)} KB`)
        } catch {
          /* ignore secondary error */
        }
      }
    },
    /**
     * 根据本地歌曲已加载的封面恢复用户歌单中缺失的封面
     * 仅补充空封面或指向已失效 blob URL 的曲目，并持久化到 storage
     *
     * 本地封面使用 blob URL，重新扫描时会 revoke 旧 URL 并生成新 URL，
     * 若歌单仍持有旧 blob URL 且封面非空，则不会被补全，导致封面消失。
     */
    restoreCoversFromLocalSongs(localSongs: { id: string | number; picUrl?: string }[]): void {
      const coverMap = new Map<string | number, string>()
      localSongs.forEach((song) => {
        if (song.picUrl) {
          coverMap.set(song.id, song.picUrl)
        }
      })

      let updated = false
      this.playlists.forEach((pl) => {
        pl.tracks.forEach((t) => {
          if (t.id != null && coverMap.has(t.id) && (!t.cover || t.cover.startsWith('blob:'))) {
            t.cover = coverMap.get(t.id)!
            updated = true
          }
        })
      })

      if (updated) {
        this.saveToStorage()
      }
    },
    createPlaylistFromTracks(name: string, tracks: PlaylistTrack[], cover?: string): UserPlaylist {
      if (name === '我喜爱的音乐') {
        throw new Error('无法创建名为“我喜爱的音乐”的歌单，因为它是系统保留名称')
      }
      const now = Date.now()
      const playlist: UserPlaylist = {
        id: `pl-${now.toString(16)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
        name,
        cover,
        tracks: [...tracks],
        createdAt: now,
        updatedAt: now
      }
      this.playlists.unshift(playlist)
      this.saveToStorage()
      return playlist
    },
    updatePlaylist(playlist: UserPlaylist): void {
      // 保护“我喜爱的音乐”不被重命名或修改ID
      if (playlist.id === 'favorite' && playlist.name !== '我喜爱的音乐') {
        // 如果尝试修改名称，静默恢复或抛出错误。这里选择仅恢复名称，允许修改其他属性
        playlist.name = '我喜爱的音乐'
      }
      // 防止其他歌单重命名为“我喜爱的音乐”
      if (playlist.id !== 'favorite' && playlist.name === '我喜爱的音乐') {
        throw new Error('无法将歌单重命名为“我喜爱的音乐”，因为它是系统保留名称')
      }

      const index = this.playlists.findIndex((p) => p.id === playlist.id)
      if (index !== -1) {
        this.playlists.splice(index, 1, { ...playlist, updatedAt: Date.now() })
        this.saveToStorage()
      }
    },
    removePlaylist(id: string): void {
      if (id === 'favorite') return // 保护我喜爱的音乐歌单
      const index = this.playlists.findIndex((p) => p.id === id)
      if (index !== -1) {
        this.playlists.splice(index, 1)
        this.saveToStorage()
      }
    },
    removeTracksFromPlaylist(playlistId: string, trackIds: Array<string | number | null>): number {
      const index = this.playlists.findIndex((p) => p.id === playlistId)
      if (index === -1) return 0

      const pl = this.playlists[index]
      const idSet = new Set(trackIds.map(String))
      const before = pl.tracks.length
      const newTracks = pl.tracks.filter((t) => !(t.id && idSet.has(String(t.id))))

      if (newTracks.length !== before) {
        this.playlists.splice(index, 1, {
          ...pl,
          tracks: newTracks,
          updatedAt: Date.now()
        })
        this.saveToStorage()
      }
      return before - newTracks.length
    },
    toggleFavorite(track: PlaylistTrack): boolean {
      const fav = this.playlists.find((p) => p.id === 'favorite')
      if (!fav) return false

      const isMatch = (t: PlaylistTrack) => {
        // 1. 尝试通过 ID 匹配（转为字符串比较）
        if (t.id && track.id && String(t.id) === String(track.id)) {
          return true
        }
        // 2. 尝试通过 source + sourceSongId 匹配
        if (
          track.source &&
          t.source === track.source &&
          track.sourceSongId &&
          t.sourceSongId &&
          String(t.sourceSongId) === String(track.sourceSongId)
        ) {
          return true
        }
        return false
      }

      const hasMatch = fav.tracks.some(isMatch)

      if (hasMatch) {
        // 移除所有匹配的歌曲（防止出现重复造成的“一直取消收藏”问题）
        fav.tracks = fav.tracks.filter((t) => !isMatch(t))
        this.saveToStorage()
        return false
      } else {
        fav.tracks.unshift(track)
        // 更新封面：如果没有自定义封面，或开启了跟随第一首歌曲封面，则自动更新
        if (fav.coverFollowsFirstTrack || !fav.cover) {
          if (track.cover) {
            fav.cover = track.cover
          }
        }
        this.saveToStorage()
        return true
      }
    },
    isFavorite(track: PlaylistTrack): boolean {
      const fav = this.playlists.find((p) => p.id === 'favorite')
      if (!fav) return false

      return fav.tracks.some((t) => {
        if (t.id && track.id && String(t.id) === String(track.id)) {
          return true
        }
        if (
          track.source &&
          t.source === track.source &&
          track.sourceSongId &&
          t.sourceSongId &&
          String(t.sourceSongId) === String(track.sourceSongId)
        ) {
          return true
        }
        return false
      })
    }
  }
})
