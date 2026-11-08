import { ref, computed } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { audioEngine } from '../../../audio/audio-engine'
import { createTrailingThrottle } from '../../../utils/trailingThrottle'

/**
 * 音量控制相关的组合式函数
 * 处理音量调节、静音等功能
 */
export function usePlayerVolume() {
  const player = usePlayerStore()

  // 音量控制弹窗显示状态
  const showVolumePopover = ref(false)

  /**
   * 下发到音频引擎的音量（30ms 节流 + 尾调用）。
   *
   * 只节流引擎调用，不动 store：store 是滑块的受控数据源，
   * 一旦连 store 一起节流，被丢弃的那次输入会让滑块回弹到旧值（「调不动」）。
   */
  const applyVolumeToEngine = createTrailingThrottle((v: number) => {
    audioEngine.setVolume(v)
  }, 30)

  /**
   * 更新音量（0-100）
   * @param volume 音量值（0-100）
   */
  const updateVolume = (volume: number): void => {
    const v = Math.min(1, Math.max(0, volume / 100))
    player.setVolume(v)
    applyVolumeToEngine(v)
  }

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
   *
   * 记住静音前的音量：取消静音时恢复到该值，而不是固定 80%
   * （原先固定 0.8，用户在 30% 静音后取消会突然变响）。
   */
  const lastNonZeroVolume = ref(0.8)

  const toggleMute = () => {
    if (player.volume > 0) {
      lastNonZeroVolume.value = player.volume
      player.setVolume(0)
      audioEngine.setVolume(0)
    } else {
      const restore = lastNonZeroVolume.value > 0 ? lastNonZeroVolume.value : 0.8
      player.setVolume(restore)
      audioEngine.setVolume(restore)
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
