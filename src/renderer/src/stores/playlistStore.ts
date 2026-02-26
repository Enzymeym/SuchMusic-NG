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
}

interface PlaylistState {
  playlists: UserPlaylist[]
}

const STORAGE_KEY = 'user_playlists'

export const usePlaylistStore = defineStore('playlist', {
  state: (): PlaylistState => ({
    playlists: []
  }),
  actions: {
    loadFromStorage(): void {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.playlists = parsed
        }
      } catch (e) {
        console.error('Failed to load playlists from storage', e)
      }
    },
    saveToStorage(): void {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.playlists))
      } catch (e) {
        console.error('Failed to save playlists to storage', e)
      }
    },
    createPlaylistFromTracks(name: string, tracks: PlaylistTrack[], cover?: string): UserPlaylist {
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
      const index = this.playlists.findIndex((p) => p.id === playlist.id)
      if (index !== -1) {
        this.playlists.splice(index, 1, { ...playlist, updatedAt: Date.now() })
        this.saveToStorage()
      }
    },
    removePlaylist(id: string): void {
      const index = this.playlists.findIndex((p) => p.id === id)
      if (index !== -1) {
        this.playlists.splice(index, 1)
        this.saveToStorage()
      }
    }
  }
})

