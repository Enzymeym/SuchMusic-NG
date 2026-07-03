import { ref, watch } from 'vue'
import { extractImageColors } from '../utils/imageColors'
import { useAutoNaiveTheme } from '../themes/autoNaiveTheme'
import defaultCover from '@renderer/assets/icon.png'

/**
 * 歌单主题色组合式函数
 * 根据歌单封面图片自动提取主题色，用于按钮等 UI 元素着色
 *
 * @param coverUrl - 封面图片 URL 的计算属性（getter 函数）
 * @returns 返回包含 accentColor（主色）的对象
 */
export function usePlaylistTheme(coverUrl: () => string) {
  const { isDark } = useAutoNaiveTheme()

  /** 封面提取的主色，用于主要按钮颜色 */
  const accentColor = ref('#2080f0')

  /** 上一次提取的封面 URL，避免重复提取 */
  let lastCoverUrl = ''

  /**
   * 从封面图片中提取主题色
   * @param url - 封面图片 URL
   */
  const extractThemeColor = async (url: string) => {
    // 跳过默认封面和空 URL
    if (!url || url === defaultCover) {
      accentColor.value = '#2080f0'
      return
    }

    if (url === lastCoverUrl) return
    lastCoverUrl = url

    try {
      const palette = await extractImageColors(url, {
        isLightMode: !isDark.value
      })
      // 优先使用主色，并适当调整确保作为按钮颜色时对比度足够
      accentColor.value = palette.main
    } catch (e) {
      console.error('提取封面颜色失败:', e)
      accentColor.value = '#2080f0'
    }
  }

  // 监听封面 URL 变化
  watch(
    () => coverUrl(),
    (url) => {
      extractThemeColor(url)
    },
    { immediate: true }
  )

  // 监听主题变化，重新提取颜色
  watch(
    () => isDark.value,
    () => {
      // 主题切换时重置缓存，重新提取
      lastCoverUrl = ''
      extractThemeColor(coverUrl())
    }
  )

  return {
    accentColor
  }
}
