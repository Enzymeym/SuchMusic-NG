import { ref, computed } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { audioEngine } from '../../../audio/audio-engine'

/**
 * 音量控制相关的组合式函数
 * 处理音量调节、静音等功能
 */
export function usePlayerVolume() {
  const player = usePlayerStore()

  // 音量控制弹窗显示状态
  const showVolumePopover = ref(false)

  /**
   * 节流函数
   * @param func 要执行的函数
   * @param delay 节流延迟时间（毫秒）
   * @returns 节流后的函数
   */
  const throttle = (func: Function, delay: number) => {
    let lastCall = 0
    return (...args: any[]) => {
      const now = Date.now()
      if (now - lastCall >= delay) {
        lastCall = now
        return func(...args)
      }
    }
  }

  /**
   * 节流处理的音量更新函数
   * @param volume 音量值（0-100）
   */
  const updateVolume = throttle((volume: number) => {
    const v = volume / 100
    // 先更新本地状态，避免UI卡顿
    player.setVolume(v)
    // 使用requestAnimationFrame优化Web Audio API调用
    requestAnimationFrame(() => {
      audioEngine.setVolume(v)
    })
  }, 30) // 减少节流间隔到30ms，提高响应速度

  /**
   * 音量百分比
   */
  const volumePercent = computed({
    get: () => Math.round(player.volume * 100),
    set: (val: number) => {
      updateVolume(val)
    }
  })

  /**
   * 音量图标
   */
  const volumeIcon = computed(() => {
    if (player.volume === 0) return 'mgc_volume_mute_line'
    return 'mgc_volume_line'
  })

  /**
   * 切换静音状态
   */
  const toggleMute = () => {
    if (player.volume > 0) {
      player.setVolume(0)
      audioEngine.setVolume(0)
    } else {
      player.setVolume(0.8) // 默认恢复到 80%
      audioEngine.setVolume(0.8)
    }
  }

  /**
   * 切换音量控制弹窗
   */
  const toggleVolumePopover = () => {
    showVolumePopover.value = !showVolumePopover.value
  }

  return {
    showVolumePopover,
    volumePercent,
    volumeIcon,
    toggleMute,
    toggleVolumePopover
  }
}