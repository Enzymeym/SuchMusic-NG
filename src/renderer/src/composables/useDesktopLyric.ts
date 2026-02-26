import { ref, watch, onMounted } from 'vue'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { parseLyricsToCore } from '../utils/lyric/lyricParser'

export function useDesktopLyric() {
  const player = usePlayerStore()
  const settings = useSettingsStore()
  
  const isDesktopLyricOpen = ref(false)
  const hasInitialized = ref(false)

  const toggleDesktopLyric = async () => {
    const newState = !isDesktopLyricOpen.value
    if (newState) {
      await window.electron.ipcRenderer.invoke('desktop-lyric:open')
      isDesktopLyricOpen.value = true
      updateLyrics()
      updateTime()
      updateSettings()
      updatePlaying()
    } else {
      await window.electron.ipcRenderer.invoke('desktop-lyric:close')
      isDesktopLyricOpen.value = false
    }
  }

  const updatePlaying = () => {
    if (!isDesktopLyricOpen.value) return
    window.electron.ipcRenderer.send('desktop-lyric:set-playing', player.isPlaying)
  }

  const updateLyrics = () => {
    if (!isDesktopLyricOpen.value) return
    const lyricsContent = player.currentSong?.lyrics || ''
    const parsed = parseLyricsToCore(lyricsContent)
    window.electron.ipcRenderer.send('desktop-lyric:set-lyrics', parsed)
    
    // Also update info
    window.electron.ipcRenderer.send('desktop-lyric:set-info', {
      title: player.currentSong?.title || '',
      artist: player.currentSong?.artist || ''
    })
  }

  const updateTime = () => {
    if (!isDesktopLyricOpen.value) return
    window.electron.ipcRenderer.send('desktop-lyric:time-update', player.positionMs / 1000)
  }

  const updateSettings = () => {
    if (!isDesktopLyricOpen.value) return
    const config = {
      fontSize: settings.playback.desktopLyricsFontSize,
      fontColor: settings.playback.desktopLyricsColor,
      highlightColor: settings.playback.desktopLyricsActiveColor || settings.appearance.customThemeColor || '#18a058',
      opacity: settings.playback.desktopLyricsOpacity,
      showNextLine: settings.playback.desktopLyricsShowNextLine,
      align: settings.playback.desktopLyricsAlign,
      font: settings.appearance.desktopLyricsFont,
      locked: settings.playback.desktopLyricsLocked,
      forceDuet: settings.playback.desktopLyricsForceDuet
    }
    window.electron.ipcRenderer.send('desktop-lyric:set-settings', config)
  }

  watch(() => [player.currentSong?.id, player.currentSong?.lyrics], () => {
    updateLyrics()
  })

  watch(() => player.positionMs, () => {
    updateTime()
  })
  
  watch(() => player.isPlaying, () => {
    updatePlaying()
  })
  
  // Watch settings changes
  watch(
    () => [
      settings.playback.desktopLyricsFontSize,
      settings.playback.desktopLyricsColor,
      settings.playback.desktopLyricsActiveColor,
      settings.playback.desktopLyricsOpacity,
      settings.playback.desktopLyricsShowNextLine,
      settings.playback.desktopLyricsAlign,
      settings.appearance.desktopLyricsFont,
      settings.playback.desktopLyricsLocked,
      settings.appearance.customThemeColor,
      settings.playback.desktopLyricsForceDuet
    ],
    () => {
      updateSettings()
    }
  )
  
  onMounted(async () => {
    if (hasInitialized.value) return
    try {
      const isOpen = await window.electron.ipcRenderer.invoke('desktop-lyric:is-open')
      isDesktopLyricOpen.value = isOpen
      if (isOpen) {
        updateLyrics()
        updateSettings()
        updatePlaying()
      }
      hasInitialized.value = true
    } catch (e) {
      console.error('Failed to check desktop lyric status', e)
    }
  })

  return {
    isDesktopLyricOpen,
    toggleDesktopLyric
  }
}
