import { ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlayerStore } from '../stores/playerStore'
import { parseLyricsToCore } from '../utils/lyric/lyricParser'

export function useTaskbarLyric() {
  const settingsStore = useSettingsStore()
  const playerStore = usePlayerStore()

  // Sync settings to taskbar lyric window
  watch(
    () => [
      settingsStore.appearance.desktopLyricsFont,
      // Taskbar lyric specific settings could be added here
      // For now, we reuse some desktop lyric settings or use defaults
      // Maybe we need taskbar specific settings in the future
      settingsStore.appearance.customThemeColor
    ],
    () => {
      updateSettings()
    }
  )

  // Sync lyrics to taskbar lyric window
  watch(
    () => [playerStore.currentSong?.id, playerStore.currentSong?.lyrics],
    () => {
      const lyricsContent = playerStore.currentSong?.lyrics || ''
      const parsedLyrics = parseLyricsToCore(lyricsContent)
      window.electron.ipcRenderer.send('taskbar-lyric:set-lyrics', parsedLyrics)
    },
    { deep: true }
  )

  // Sync playing state
  watch(
    () => playerStore.isPlaying,
    (isPlaying) => {
      window.electron.ipcRenderer.send('taskbar-lyric:set-playing', isPlaying)
    }
  )

  // Sync track info
  watch(
    () => playerStore.currentSong,
    (song) => {
      if (song) {
        window.electron.ipcRenderer.send('taskbar-lyric:set-info', {
          title: song.title,
          artist: song.artist
        })
      }
    },
    { deep: true, immediate: true }
  )

  // Sync time
  watch(
    () => playerStore.positionMs,
    (time) => {
      if (isOpen.value) {
        window.electron.ipcRenderer.send('taskbar-lyric:time-update', time / 1000)
      }
    }
  )

  const updateSettings = () => {
    const config = {
      // Mapping settings to taskbar lyric
      font: settingsStore.appearance.desktopLyricsFont,
      fontSize: 16, // Default or from settings
      fontColor: '#ffffff', // Default
      highlightColor: settingsStore.appearance.customThemeColor || '#18a058',
      // Add more as needed
    }
    window.electron.ipcRenderer.send('taskbar-lyric:set-settings', config)
  }

  const isOpen = ref(false)

  // Initial sync
  const init = async () => {
    isOpen.value = await window.electron.ipcRenderer.invoke('taskbar-lyric:is-open')
    
    updateSettings()
    if (playerStore.currentSong?.lyrics) {
      const parsedLyrics = parseLyricsToCore(playerStore.currentSong.lyrics)
      window.electron.ipcRenderer.send('taskbar-lyric:set-lyrics', parsedLyrics)
    }
    window.electron.ipcRenderer.send('taskbar-lyric:set-playing', playerStore.isPlaying)
    if (playerStore.currentSong) {
      window.electron.ipcRenderer.send('taskbar-lyric:set-info', {
        title: playerStore.currentSong.title,
        artist: playerStore.currentSong.artist
      })
    }
  }

  const toggle = async () => {
    await window.electron.ipcRenderer.invoke('taskbar-lyric:toggle')
    isOpen.value = await window.electron.ipcRenderer.invoke('taskbar-lyric:is-open')
  }

  // Listen for time updates from main process (which might come from other sources)
  // But actually, we are the source of time updates usually (from audio engine)
  // In this app, App.vue or PlayerBar.vue updates the time.
  // We need to ensure that time is sent to taskbar lyric window.
  // This is typically done where the audio time update happens.
  
  return {
    isOpen,
    init,
    open: async () => {
      await window.electron.ipcRenderer.invoke('taskbar-lyric:open')
      isOpen.value = true
    },
    close: async () => {
      await window.electron.ipcRenderer.invoke('taskbar-lyric:close')
      isOpen.value = false
    },
    toggle
  }
}
