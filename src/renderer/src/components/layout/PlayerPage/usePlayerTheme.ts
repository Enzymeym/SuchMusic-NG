import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useAutoNaiveTheme } from '../../../themes/autoNaiveTheme'
import { extractImageColors } from '../../../utils/imageColors'

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
   * 解析十六进制颜色
   * @param hex 十六进制颜色字符串
   * @returns RGB颜色对象，解析失败返回null
   */
  const hexToRgb = (hex: string) => {
    let s = hex.trim()
    if (s.startsWith('#')) s = s.slice(1)
    if (s.length === 3) {
      s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    }
    if (s.length !== 6) return null
    const r = parseInt(s.slice(0, 2), 16)
    const g = parseInt(s.slice(2, 4), 16)
    const b = parseInt(s.slice(4, 6), 16)
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
    return { r, g, b }
  }

  /**
   * 计算颜色亮度（0-1）
   * @param hex 十六进制颜色字符串
   * @returns 亮度值（0-1）
   */
  const getBrightness = (hex: string) => {
    const rgb = hexToRgb(hex)
    if (!rgb) return 0
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
  }

  /**
   * 将颜色与白色混合
   * @param hex 十六进制颜色字符串
   * @param weight 混合权重（0-1）
   * @returns 混合后的颜色
   */
  const mixWithWhite = (hex: string, weight: number) => {
    const rgb = hexToRgb(hex)
    if (!rgb) return hex
    const w = Math.min(Math.max(weight, 0), 1)
    const r = Math.round(rgb.r * (1 - w) + 255 * w)
    const g = Math.round(rgb.g * (1 - w) + 255 * w)
    const b = Math.round(rgb.b * (1 - w) + 255 * w)
    const toHex = (v: number) => v.toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  /**
   * 归一化主题色
   * @param hex 十六进制颜色字符串
   * @returns 归一化后的颜色
   */
  const normalizeThemeColor = (hex: string) => {
    let color = hex
    let brightness = getBrightness(color)
    const target = 0.9
    if (brightness >= target) return color
    for (let i = 0; i < 3 && brightness < target; i++) {
      const delta = target - brightness
      const weight = Math.min(0.6, Math.max(0.2, delta * 1.2))
      color = mixWithWhite(color, weight)
      brightness = getBrightness(color)
    }
    return color
  }

  /**
   * 转为 rgba 字符串
   * @param hex 十六进制颜色字符串
   * @param alpha 透明度
   * @returns rgba颜色字符串
   */
  const hexToRgba = (hex: string, alpha: number) => {
    const rgb = hexToRgb(hex)
    if (!rgb) return `rgba(255, 255, 255, ${alpha})`
    const a = Math.min(Math.max(alpha, 0), 1)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
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
        let bestBrightness = getBrightness(best)
        for (let i = 1; i < candidates.length; i++) {
          const b = getBrightness(candidates[i])
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
