import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useSettingsStore } from '../../../stores/settingsStore'

/**
 * 歌词相关的组合式函数
 * 处理歌词获取、重试逻辑等功能
 */
export function usePlayerLyrics() {
  const player = usePlayerStore()
  const settingsStore = useSettingsStore()

  // 当前播放时间（秒），应用歌词偏移
  const currentTime = computed(() => {
    const rawTime = player.positionMs / 1000
    const offset = settingsStore.playback.lyricsOffset || 0
    return rawTime + offset
  })

  // 歌词数据
  const lyricsData = computed(() => {
    return player.currentSong?.lyrics || ''
  })

  // 翻译歌词数据
  const translatedLyricsData = computed(() => {
    return player.currentSong?.translatedLyrics || ''
  })

  // 歌词显示模式（Apple 风格或简洁列表）
  const lyricsMode = computed<'apple' | 'suth'>(() =>
    settingsStore.playback.lyricsAppleStyle ? 'apple' : 'suth'
  )

  // 歌词基础字号（px）
  const lyricsBaseFontSize = computed(() => settingsStore.playback.lyricsFontSize || 28)

  // 歌词布局占比（右侧歌词区域百分比）
  const lyricsAreaRatio = computed(() => {
    const raw = settingsStore.playback.lyricsAreaRatio ?? 60
    return Math.min(Math.max(raw, 30), 70)
  })

  // 左右区域 flex 比例
  const leftPanelFlex = computed(() => 100 - lyricsAreaRatio.value)
  const rightPanelFlex = computed(() => lyricsAreaRatio.value)

  // 歌词字号样式字符串
  const lyricsMainFontSize = computed(() => `${lyricsBaseFontSize.value}px`)
  const lyricsSubFontSize = computed(() => `${Math.round(lyricsBaseFontSize.value * 0.7)}px`)

  /**
   * 歌词字体 CSS 值
   * 从外观设置中读取歌词字体，构建带系统回退的 font-family 字符串
   * @returns font-family CSS 值，如 `"Microsoft YaHei UI", system-ui, sans-serif`
   */
  const lyricsFontFamily = computed(() => {
    const font = settingsStore.appearance.lyricsFont || 'Microsoft YaHei UI'
    return `"${font}", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  })

  // Mobile Swipe State
  const activePageIndex = ref(0)

  /**
   * 处理主区域滚动
   * @param e 滚动事件
   */
  const handleMainScroll = (e: Event) => {
    const target = e.target as HTMLElement
    if (target.clientWidth === 0) return
    const index = Math.round(target.scrollLeft / target.clientWidth)
    if (activePageIndex.value !== index) {
      activePageIndex.value = index
    }
  }

  /**
   * 滚动到指定页面
   * @param index 页面索引
   */
  const scrollToPage = (index: number) => {
    const container = document.querySelector('.main-area') as HTMLElement
    if (container) {
      container.scrollTo({ left: index * container.clientWidth, behavior: 'smooth' })
      activePageIndex.value = index
    }
  }

  /**
   * 判断歌词是否为 YRC 逐字格式
   * YRC 格式特征：每行包含形如 (词,开始时间,持续时长) 的词级时间戳
   * @param lyrics 歌词字符串
   * @returns 是否为 YRC 逐字格式
   */
  const isYrcFormat = (lyrics: string): boolean => {
    return lyrics.includes('(') && /\d+,\d+,\d+/.test(lyrics)
  }

  // 监听当前歌曲变化，仅使用本地已有的歌词数据
  watch(
    () => player.currentSong?.id,
    (newId) => {
      if (!newId || !player.currentSong) return
      // 歌词来源于本地文件元数据，无需在线获取
    },
    { immediate: true }
  )

  return {
    currentTime,
    lyricsData,
    translatedLyricsData,
    lyricsMode,
    lyricsBaseFontSize,
    lyricsAreaRatio,
    leftPanelFlex,
    rightPanelFlex,
    lyricsMainFontSize,
    lyricsSubFontSize,
    lyricsFontFamily,
    activePageIndex,
    handleMainScroll,
    scrollToPage
  }
}