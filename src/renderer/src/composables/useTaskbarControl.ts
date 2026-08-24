import { ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlayerStore } from '../stores/playerStore'
import { parseLyricsToCore } from '../utils/lyric/lyricParser'

export function useTaskbarControl() {
  const settingsStore = useSettingsStore()
  const playerStore = usePlayerStore()

  const isOpen = ref(false)

  // 开关驱动：由设置中的「任务栏播控」开关控制窗口开/关
  watch(
    () => settingsStore.playback.taskbarControlEnabled,
    (enabled) => {
      if (enabled) {
        window.electron.ipcRenderer.invoke('taskbar-control:open')
        isOpen.value = true
      } else {
        window.electron.ipcRenderer.invoke('taskbar-control:close')
        isOpen.value = false
      }
    },
    { immediate: true }
  )

  // 同步歌曲信息（标题 / 歌手 / 封面）
  watch(
    () => [
      playerStore.currentSong?.id,
      playerStore.currentSong?.title,
      playerStore.currentSong?.artist,
      playerStore.currentSong?.cover
    ],
    () => {
      const song = playerStore.currentSong
      window.electron.ipcRenderer.send('taskbar-control:set-info', {
        title: song?.title ?? '',
        artist: song?.artist ?? '',
        cover: song?.cover ?? ''
      })
    },
    { immediate: true }
  )

  // 同步播放状态
  watch(
    () => playerStore.isPlaying,
    (isPlaying) => {
      window.electron.ipcRenderer.send('taskbar-control:set-playing', isPlaying)
    },
    { immediate: true }
  )

  // 同步歌词（含逐字时间戳）到播控窗口，用于歌名区域逐字卡拉OK展示
  watch(
    () => [
      playerStore.currentSong?.id,
      playerStore.currentSong?.lyrics,
      playerStore.currentSong?.translatedLyrics
    ],
    () => {
      const song = playerStore.currentSong
      if (!song) return
      const parsed = parseLyricsToCore(song.lyrics || '', song.translatedLyrics || '')
      window.electron.ipcRenderer.send('taskbar-control:set-lyrics', parsed)
      // 歌曲切换时与歌词瞬间可能滞后于进度，立即补发当前进度，保证歌词/信息同步
      window.electron.ipcRenderer.send('taskbar-control:set-progress', {
        positionMs: playerStore.positionMs,
        durationMs: song.durationMs ?? 0
      })
    },
    { immediate: true }
  )

  // 同步播放进度（位置 + 总时长），用于播控窗口的进度条与时间显示
  // 节流：常规播放进度最多每 500ms 同步一次（2Hz，足够进度条平滑）；
  // 位置回退/大幅跳变（seek、切歌重置）时立即同步，保证拖拽跳转即时反馈
  let lastSentProgressMs = -1
  let lastProgressSendTime = 0
  watch(
    () => playerStore.positionMs,
    (pos) => {
      const now = Date.now()
      const timeSinceLast = now - lastProgressSendTime
      const isSeekBackward = pos < lastSentProgressMs
      const largeJump = Math.abs(pos - lastSentProgressMs) > 2000
      if (timeSinceLast < 500 && !isSeekBackward && !largeJump) return
      lastSentProgressMs = pos
      lastProgressSendTime = now
      const dur = playerStore.currentSong?.durationMs ?? 0
      window.electron.ipcRenderer.send('taskbar-control:set-progress', {
        positionMs: pos,
        durationMs: dur
      })
    },
    { immediate: true }
  )

  // 同步设置（宽度模式 / 自定义宽度 / 小组件偏移 / 位置偏移 / 显示项）
  watch(
    () => [
      settingsStore.playback.taskbarControlWidthMode,
      settingsStore.playback.taskbarControlCustomWidth,
      settingsStore.playback.taskbarControlWidgetOffset,
      settingsStore.playback.taskbarControlOffsetX,
      settingsStore.playback.taskbarControlShowCover,
      settingsStore.playback.taskbarControlShowTitle,
      settingsStore.playback.taskbarControlShowArtist
    ],
    () => {
      const p = settingsStore.playback
      window.electron.ipcRenderer.send('taskbar-control:set-settings', {
        widthMode: p.taskbarControlWidthMode,
        customWidth: p.taskbarControlCustomWidth,
        widgetOffset: p.taskbarControlWidgetOffset,
        offsetX: p.taskbarControlOffsetX,
        showCover: p.taskbarControlShowCover,
        showTitle: p.taskbarControlShowTitle,
        showArtist: p.taskbarControlShowArtist
      })
    },
    { immediate: true }
  )

  const init = async () => {
    isOpen.value = await window.electron.ipcRenderer.invoke('taskbar-control:is-open')
  }

  const open = async () => {
    await window.electron.ipcRenderer.invoke('taskbar-control:open')
    isOpen.value = true
  }

  const close = async () => {
    await window.electron.ipcRenderer.invoke('taskbar-control:close')
    isOpen.value = false
  }

  const toggle = async () => {
    await window.electron.ipcRenderer.invoke('taskbar-control:toggle')
    isOpen.value = await window.electron.ipcRenderer.invoke('taskbar-control:is-open')
  }

  return {
    isOpen,
    init,
    open,
    close,
    toggle
  }
}