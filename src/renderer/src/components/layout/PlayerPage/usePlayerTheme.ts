import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useAutoNaiveTheme } from '../../../themes/autoNaiveTheme'
import { extractImageColors } from '../../../utils/imageColors'
import { getBrightness, mixWithWhite, hexToRgba } from '../../../utils/color'

/**
 * 主题色相关的组合式函数
 * 处理主题色计算、封面颜色提取等功能
 */
export function usePlayerTheme() {
  const player = usePlayerStore()
  const { isDark } = useAutoNaiveTheme()

  // 播放页内的主题色（只作用于本页）
  const playerThemeColor = ref('#2C8EFD')
  const lastCoverForTheme = ref<string | null>(null)

  /**
   * 归一化主题色
   * @param hex 十六进制颜色字符串
   * @returns 归一化后的颜色
   */
  const normalizeThemeColor = (hex: string) => {
    let color = hex
    let brightness = getBrightness(color) ?? 0
    const target = 0.9
    if (brightness >= target) return color
    for (let i = 0; i < 3 && brightness < target; i++) {
      const delta = target - brightness
      const weight = Math.min(0.6, Math.max(0.2, delta * 1.2))
      color = mixWithWhite(color, weight)
      brightness = getBrightness(color) ?? 0
    }
    return color
  }

  /**
   * 播放页根元素样式（注入局部 CSS 变量）
   */
  const playerPageStyle = computed(() => {
    const main = playerThemeColor.value
    return {
      '--player-accent-color': main,
      '--player-accent-soft-bg': hexToRgba(main, 0.18),
      '--player-accent-border': hexToRgba(main, 0.6)
    } as Record<string, string>
  })

  // 根据封面自动更新播放页主题色
  let extractSeq = 0
  watch(
    () => player.currentSong?.cover,
    async (cover) => {
      if (!cover) return
      if (cover === lastCoverForTheme.value) return
      lastCoverForTheme.value = cover
      const seq = ++extractSeq
      try {
        // 根据当前主题模式传入 isLightMode 参数
        const palette = await extractImageColors(cover, { isLightMode: !isDark.value })
        if (seq !== extractSeq) return // 竞态：已切换到新封面
        const candidates = [palette.main, palette.secondary, palette.third].filter(Boolean)
        if (!candidates.length) return
        let best = candidates[0]
        let bestBrightness = getBrightness(best) ?? 0
        for (let i = 1; i < candidates.length; i++) {
          const b = getBrightness(candidates[i]) ?? 0
          if (b > bestBrightness) {
            bestBrightness = b
            best = candidates[i]
          }
        }
        playerThemeColor.value = normalizeThemeColor(best)
      } catch (e) {
        console.error('auto theme from cover failed', e)
      }
    }
  )

  return {
    playerThemeColor,
    playerPageStyle
  }
}
