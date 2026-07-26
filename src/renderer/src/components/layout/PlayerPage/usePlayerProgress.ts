import { ref, computed } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { audioEngine } from '../../../audio/audio-engine'

/**
 * 进度条相关的组合式函数
 * 使用 NaiveUI n-slider 的 @dragstart / @dragend 事件区分拖拽和点击
 */
export function usePlayerProgress() {
  const player = usePlayerStore()

  // 进度条拖拽状态
  const isDraggingProgress = ref(false)
  const dragValue = ref(0)

  // 防止 endDrag 后立即触发 handleProgressUpdate 造成 double-seek
  let _lastSeekTime = 0

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
   * 执行 seek 跳转
   */
  const doSeek = (percent: number) => {
    if (!player.currentSong || player.currentSong.durationMs <= 0) return

    const ratio = Math.min(Math.max(percent, 0), 100) / 100
    const targetMs = player.currentSong.durationMs * ratio

    // 防止短时间重复 seek
    const now = Date.now()
    if (now - _lastSeekTime < 200) return
    _lastSeekTime = now

    player.setPosition(targetMs)
    audioEngine.seek(targetMs)
  }

  /**
   * 处理进度更新（点击和拖拽都会触发）
   * 点击时 isDraggingProgress = false → 立即 seek
   * 拖拽时 isDraggingProgress = true → 仅更新 dragValue，seek 由 endDrag 处理
   */
  const handleProgressUpdate = (val: number): void => {
    dragValue.value = val

    // 拖拽中：仅更新 dragValue，seek 由 endDrag 统一处理
    if (isDraggingProgress.value) return

    // 非拖拽场景（点击进度条）→ 立即跳转
    if (!player.currentSong || player.currentSong.durationMs <= 0) return

    // 防止轮询更新 player.positionMs 触发滑块 @update:value 造成反馈循环
    const currentPercent = (player.positionMs / player.currentSong.durationMs) * 100
    if (Math.abs(val - currentPercent) < 0.5) return

    doSeek(val)
  }

  /**
   * 拖拽开始（由 n-slider @dragstart 触发）
   */
  const startDrag = (): void => {
    // 初始化拖拽起点为当前播放进度，避免进度条跳变
    if (player.currentSong && player.currentSong.durationMs > 0) {
      dragValue.value = (player.positionMs / player.currentSong.durationMs) * 100
    } else {
      dragValue.value = 0
    }

    isDraggingProgress.value = true
  }

  /**
   * 拖拽结束（由 n-slider @dragend 触发）
   */
  const endDrag = (): void => {
    isDraggingProgress.value = false

    if (!player.currentSong || player.currentSong.durationMs <= 0) return

    doSeek(dragValue.value)
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