import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { fetchGMALyric } from '../../../apis/gma'

/**
 * 歌词相关的组合式函数
 * 处理歌词获取、重试逻辑等功能
 */
export function usePlayerLyrics() {
  const player = usePlayerStore()
  const settingsStore = useSettingsStore()

  // 当前播放时间（秒）
  const currentTime = computed(() => {
    return player.positionMs / 1000
  })

  // 歌词数据
  const lyricsData = computed(() => {
    return player.currentSong?.lyrics || ''
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
   * 歌词重试获取函数
   * @param id 歌曲ID
   * @param source 歌曲来源
   * @returns 歌词字符串
   */
  const fetchLyricWithRetry = async (id: string, source: string): Promise<string> => {
    let attempt = 0
    while (true) {
      // 检查当前播放歌曲是否改变，如果改变则停止重试
      const currentId = player.currentSong?.sourceSongId ?? player.currentSong?.id
      if (String(currentId) !== String(id)) {
        return ''
      }

      try {
        const lyricText = await fetchGMALyric(String(id), source)
        if (lyricText) return lyricText
      } catch (e) {
        console.warn(`[PlayerPage] 获取歌词失败，第 ${attempt + 1} 次重试:`, e)
      }

      attempt++
      // 指数退避策略，最大延迟 5 秒
      const delay = Math.min(500 + attempt * 500, 5000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  // 监听当前歌曲变化，如果无歌词则尝试重试获取
  watch(
    () => player.currentSong?.id,
    async (newId) => {
      if (!newId || !player.currentSong) return

      // 如果已有歌词，则不需要重试
      if (player.currentSong.lyrics && player.currentSong.lyrics.length > 0) return

      // 获取 source
      const source = player.currentSong.source || 'wy'
      const neteaseId = player.currentSong.sourceSongId ?? player.currentSong.id
      if (!neteaseId) return

      console.log('[PlayerPage] 当前歌曲无歌词，尝试后台重试获取...', neteaseId)
      const lyrics = await fetchLyricWithRetry(String(neteaseId), source)

      // 如果获取到了歌词，且当前播放的歌曲未变，则更新 store
      if (lyrics && player.currentSong?.id === newId) {
        console.log('[PlayerPage] 重试获取歌词成功，更新 store')
        player.setLyrics(lyrics)
      }
    },
    { immediate: true }
  )

  return {
    currentTime,
    lyricsData,
    lyricsMode,
    lyricsBaseFontSize,
    lyricsAreaRatio,
    leftPanelFlex,
    rightPanelFlex,
    lyricsMainFontSize,
    lyricsSubFontSize,
    activePageIndex,
    handleMainScroll,
    scrollToPage
  }
}