import { ref, computed } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { webAudioEngine } from '../../../audio/audio-engine'

/**
 * 进度条相关的组合式函数
 * 处理进度条拖动、时间格式化等功能
 */
export function usePlayerProgress() {
  const player = usePlayerStore()

  // 进度条拖动状态
  const isDraggingProgress = ref(false)
  const dragValue = ref(0)

  /**
   * 格式化时间为 mm:ss 格式
   * @param seconds 秒数
   * @returns 格式化后的时间字符串
   */
  const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return '00:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  /**
   * 进度百分比
   */
  const progressPercent = computed(() => {
    if (isDraggingProgress.value) return dragValue.value
    if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
    return (player.positionMs / player.currentSong.durationMs) * 100
  })

  /**
   * 显示时间
   */
  const displayTime = computed(() => {
    if (isDraggingProgress.value) {
      if (!player.currentSong || player.currentSong.durationMs <= 0) return '00:00'
      const ms = (dragValue.value / 100) * player.currentSong.durationMs
      return formatTime(ms / 1000)
    }
    return formatTime(player.positionMs / 1000)
  })

  /**
   * 处理进度更新
   * @param val 进度值
   */
  const handleProgressUpdate = (val: number): void => {
    // 始终更新拖拽值，保证 UI 与滑块一致
    dragValue.value = val

    // 非拖拽场景（例如点击或键盘调节），直接跳转进度
    if (!isDraggingProgress.value) {
      if (!player.currentSong || player.currentSong.durationMs <= 0) return
      const ratio = Math.min(Math.max(val, 0), 100) / 100
      const targetMs = player.currentSong.durationMs * ratio
      webAudioEngine.seek(targetMs)
    }
  }

  /**
   * 开始拖拽进度条
   */
  const startDrag = (): void => {
    // 初始化拖拽起点为当前播放进度，避免进度条跳变
    if (player.currentSong && player.currentSong.durationMs > 0) {
      dragValue.value = (player.positionMs / player.currentSong.durationMs) * 100
    } else {
      dragValue.value = 0
    }

    isDraggingProgress.value = true
    window.addEventListener('mouseup', endDrag)
    window.addEventListener('touchend', endDrag)
  }

  /**
   * 结束拖拽进度条
   */
  const endDrag = (): void => {
    if (!isDraggingProgress.value) return

    isDraggingProgress.value = false
    window.removeEventListener('mouseup', endDrag)
    window.removeEventListener('touchend', endDrag)

    if (!player.currentSong || player.currentSong.durationMs <= 0) return

    // 根据拖拽结果计算目标位置并跳转
    const ratio = Math.min(Math.max(dragValue.value, 0), 100) / 100
    const targetMs = player.currentSong.durationMs * ratio
    webAudioEngine.seek(targetMs)
  }

  return {
    isDraggingProgress,
    progressPercent,
    displayTime,
    formatTime,
    handleProgressUpdate,
    startDrag,
    endDrag
  }
}