import { defineStore } from 'pinia'
import { useSettingsStore } from './settingsStore'
import { usePlayerStore } from './playerStore'
import { formatQuality } from '../utils/quality'

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
  actions: {
    async scanMusic() {
      if (this.loading) return
      this.loading = true
      const settingsStore = useSettingsStore()
      
      try {
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

      try {
        const targets = this.songs.filter((song) => {
          if (!song.filePath) return false
          const missingBasic =
            !song.dt || !song.picUrl || !song.name || !song.ar || song.ar.length === 0
          const isPlaceholderArtist =
            song.ar && song.ar.length > 0 && song.ar[0].name === '本地音乐'
          return missingBasic || isPlaceholderArtist
        })
        
        if (!targets.length) return

        await Promise.all(
          targets.map(async (song) => {
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
                const coverUrl = `data:${result.cover.mimeType};base64,${result.cover.base64}`
                song.picUrl = coverUrl

                if (playerStore.currentSong?.id === song.id) {
                    // Update cover if needed, but playerStore doesn't expose a direct setCover method for currentSong easily 
                    // except by replacing the object or relying on reactivity if we mutated the object passed to it.
                    // But playerStore.currentSong is a separate object usually.
                    // We can try to update it manually if needed, but let's leave it for now or implement a helper in playerStore.
                }
              }

              if (result.title) song.name = result.title

              if (result.artists && result.artists.length > 0) {
                if (!song.ar || song.ar.length === 0 || song.ar[0].name === '本地音乐') {
                  song.ar = result.artists.map((n) => ({ name: n }))
                }
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
          })
        )
      } finally {
        this.fillingMeta = false
      }
    }
  }
})
