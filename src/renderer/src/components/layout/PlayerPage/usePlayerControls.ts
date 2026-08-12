import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlaylistStore } from '../../../stores/playlistStore'
import { useAutoNaiveTheme } from '../../../themes/autoNaiveTheme'
import { audioEngine } from '../../../audio/audio-engine'
import { getTransitionController } from '../../../audio/transition-controller'
import { useDownloadMusic } from '../../../composables/useDownloadMusic'
import { useMessage } from 'naive-ui'

/**
 * 播放控制相关的组合式函数
 * 处理播放/暂停、上一曲/下一曲、播放模式切换等功能
 */
export function usePlayerControls() {
  const player = usePlayerStore()
  const settingsStore = useSettingsStore()
  const playlistStore = usePlaylistStore()
  const message = useMessage()
  const { isDark: _isDark } = useAutoNaiveTheme()

  const { downloadMusic } = useDownloadMusic()

  // 控制条显示状态
  const isControlsVisible = ref(true)
  let hideControlsTimer: ReturnType<typeof setTimeout> | null = null

  // 鼠标指针隐藏状态
  const isCursorHidden = ref(false)

  // 全屏状态与容器引用
  const isFullscreen = ref(false)
  const playerPageRef = ref<HTMLElement | null>(null)

  // 是否启用“隐藏底栏时自动隐藏鼠标指针”设置
  const autoHideCursorEnabled = computed(
    () => settingsStore.playback.autoHideCursorWhenControlsHidden
  )

  // 是否启用播放页底栏自动隐藏
  const autoHideFooterEnabled = computed(
    () => settingsStore.playback.autoHidePlayerPageFooter
  )

  /**
   * 根据当前状态应用鼠标指针显示/隐藏
   */
  const applyCursorVisibility = () => {
    // 播放页关闭或未启用设置时，确保恢复指针
    if (!player.isPlayerPageShown || !autoHideCursorEnabled.value) {
      if (isCursorHidden.value) {
        document.body.style.cursor = ''
        isCursorHidden.value = false
      }
      return
    }

    if (isControlsVisible.value) {
      if (isCursorHidden.value) {
        document.body.style.cursor = ''
        isCursorHidden.value = false
      }
    } else {
      if (!isCursorHidden.value) {
        document.body.style.cursor = 'none'
        isCursorHidden.value = true
      }
    }
  }

  /**
   * 显示控制条，并重置隐藏计时器
   */
  const showControls = () => {
    isControlsVisible.value = true
    if (hideControlsTimer) {
      clearTimeout(hideControlsTimer)
    }
    // 只有在启用自动隐藏时才设置隐藏计时器
    if (autoHideFooterEnabled.value) {
      hideControlsTimer = setTimeout(() => {
        // 仅在未拖动进度条时才隐藏
        isControlsVisible.value = false
      }, 3000)
    }
  }

  /**
   * 处理用户活动，显示控制条
   */
  const handleActivity = () => {
    // 只有在启用自动隐藏时才响应用户操作
    if (autoHideFooterEnabled.value) {
      // 用户有操作时，显示控制条并恢复鼠标指针
      showControls()
    }
  }

  /**
   * 同步全屏状态（处理 Esc 等外部退出）
   */
  const handleFullscreenChange = () => {
    isFullscreen.value = !!document.fullscreenElement
  }

  /**
   * 进入全屏
   */
  const enterFullscreen = async (): Promise<void> => {
    const el = playerPageRef.value
    if (!el || !el.requestFullscreen) return
    try {
      await el.requestFullscreen()
    } catch (e) {
      console.error('enter fullscreen failed', e)
    }
  }

  /**
   * 退出全屏
   */
  const exitFullscreen = async (): Promise<void> => {
    if (!document.fullscreenElement) {
      isFullscreen.value = false
      return
    }
    try {
      await document.exitFullscreen()
    } catch (e) {
      console.error('exit fullscreen failed', e)
    } finally {
      isFullscreen.value = false
    }
  }

  /**
   * 切换全屏
   */
  const toggleFullscreen = (): void => {
    if (isFullscreen.value) {
      void exitFullscreen()
    } else {
      void enterFullscreen()
    }
  }

  /**
   * 播放/暂停切换
   */
  const togglePlay = async (): Promise<void> => {
    if (player.isPlaying) {
      await audioEngine.pause()
      player.setPlaying(false)
    } else {
      if (player.currentSong) {
        await audioEngine.resume()
        player.setPlaying(true)
      }
    }
  }

  /**
   * 播放上一曲
   */
  const handlePrev = (): void => {
    // 中断智能过渡流程，走现有快速切换路径（与 PlayerBar.handlePrev 对齐）
    getTransitionController().abort()
    player.setTransitioning(false)
    player.playPrev()
  }

  /**
   * 播放下一曲
   */
  const handleNext = (): void => {
    // 中断智能过渡流程，走现有快速切换路径（与 PlayerBar.handleNext 对齐）
    getTransitionController().abort()
    player.setTransitioning(false)
    player.playNext()
  }

  /**
   * 当前歌曲是否已收藏
   */
  const isFavorite = computed(() => {
    if (!player.currentSong) return false
    const track = {
      id: player.currentSong.id,
      title: player.currentSong.title,
      artist: player.currentSong.artist,
      album: player.currentSong.album,
      cover: player.currentSong.cover,
      filePath: player.currentSong.filePath,
      durationMs: player.currentSong.durationMs,
      source: player.currentSong.source,
      sourceSongId: player.currentSong.sourceSongId
    }
    return playlistStore.isFavorite(track)
  })

  /**
   * 切换收藏状态
   */
  const toggleFavorite = () => {
    if (!player.currentSong) return
    const track = {
      id: player.currentSong.id,
      title: player.currentSong.title,
      artist: player.currentSong.artist,
      album: player.currentSong.album,
      cover: player.currentSong.cover,
      filePath: player.currentSong.filePath,
      durationMs: player.currentSong.durationMs,
      source: player.currentSong.source,
      sourceSongId: player.currentSong.sourceSongId
    }
    const added = playlistStore.toggleFavorite(track)
    if (added) {
      message.success('已添加到我喜爱的音乐')
    } else {
      message.success('已取消收藏')
    }
  }

  /**
   * 播放模式图标
   */
  const modeIcon = computed(() => {
    switch (player.playMode) {
      case 'loop':
        return 'mgc_repeat_one_line'
      case 'shuffle':
        return 'mgc_shuffle_line'
      case 'list':
      default:
        return 'mgc_repeat_line'
    }
  })

  /**
   * 歌单下拉选项
   */
  const addToPlaylistDropdownOptions = computed(() =>
    playlistStore.playlists.map((pl) => ({
      label: pl.name,
      key: pl.id
    }))
  )

  /**
   * 处理添加到歌单
   * @param key 歌单ID
   */
  const handleAddToPlaylistSelect = (key: string | number) => {
    if (!player.currentSong) return
    const target = playlistStore.playlists.find((p) => p.id === key)
    if (!target) return
    const exists = target.tracks.some((t) => t.id === player.currentSong?.id)
    if (exists) {
      message.info('歌单中已存在该歌曲')
      return
    }
    const track = {
      id: player.currentSong.id,
      title: player.currentSong.title,
      artist: player.currentSong.artist,
      album: player.currentSong.album,
      cover: player.currentSong.cover,
      filePath: player.currentSong.filePath,
      durationMs: player.currentSong.durationMs,
      source: player.currentSong.source,
      sourceSongId: player.currentSong.sourceSongId
    }
    const updated = {
      ...target,
      tracks: [...target.tracks, track]
    }
    playlistStore.updatePlaylist(updated)
    message.success('已添加到歌单')
  }

  // Touch handling for swipe down
  const touchStartY = ref(0)
  const touchCurrentY = ref(0)
  const isDragging = ref(false)

  /**
   * 处理触摸开始
   * @param e 触摸事件
   */
  const handleTouchStart = (e: TouchEvent): void => {
    touchStartY.value = e.touches[0].clientY
    isDragging.value = true
  }

  /**
   * 处理触摸移动
   * @param e 触摸事件
   */
  const handleTouchMove = (e: TouchEvent): void => {
    if (!isDragging.value) return
    touchCurrentY.value = e.touches[0].clientY
  }

  /**
   * 处理触摸结束
   */
  const handleTouchEnd = (): void => {
    if (!isDragging.value) return
    isDragging.value = false

    const deltaY = touchCurrentY.value - touchStartY.value
    if (deltaY > 60 && !isFullscreen.value) {
      closePage()
    }

    touchStartY.value = 0
    touchCurrentY.value = 0
  }

  /**
   * 关闭播放页
   */
  const closePage = (): void => {
    // 关闭播放页前确保退出全屏
    if (isFullscreen.value) {
      void exitFullscreen()
    }
    player.setPlayerPageShown(false)
  }

  // 生命周期钩子
  onMounted(() => {
    // 初始化控制条状态
    if (autoHideFooterEnabled.value) {
      showControls()
    } else {
      isControlsVisible.value = true
    }
    window.addEventListener('mousemove', handleActivity)
    window.addEventListener('click', handleActivity)
    window.addEventListener('keydown', handleActivity)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    
    // 预加载状态由 Rust 引擎内部管理
  })

  onUnmounted(() => {
    if (hideControlsTimer) {
      clearTimeout(hideControlsTimer)
    }
    window.removeEventListener('mousemove', handleActivity)
    window.removeEventListener('click', handleActivity)
    window.removeEventListener('keydown', handleActivity)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)

    // 播放页卸载时恢复鼠标指针与全屏
    if (isCursorHidden.value) {
      document.body.style.cursor = ''
      isCursorHidden.value = false
    }
    if (isFullscreen.value) {
      void exitFullscreen()
    }
  })

  // 监听控制条显示状态和设置开关，实时更新鼠标指针状态
  watch([isControlsVisible, autoHideCursorEnabled], () => {
    applyCursorVisibility()
  })

  return {
    isControlsVisible,
    isFullscreen,
    playerPageRef,
    showControls,
    handleActivity,
    toggleFullscreen,
    togglePlay,
    handlePrev,
    handleNext,
    isFavorite,
    toggleFavorite,
    modeIcon,
    addToPlaylistDropdownOptions,
    handleAddToPlaylistSelect,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    closePage,
    downloadMusic
  }
}