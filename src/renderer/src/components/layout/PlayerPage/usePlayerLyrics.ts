import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { fetchGMALyric } from '../../../apis/gma'
import { fetchQQMusicLyric } from '../../../apis/vkeys'

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
   * 获取歌词（QQ音乐优先使用 VKeys API，失败时回退到 GMA API）
   * @param id 歌曲ID
   * @param source 歌曲来源（支持外部格式 'qq' 和内部格式 'tx'）
   * @returns { lyrics: 主歌词, translatedLyrics: 翻译歌词 }
   */
  const doFetchLyric = async (id: string, source: string): Promise<{ lyrics: string; translatedLyrics: string }> => {
    // 标准化 source：将外部格式 qq→tx 统一为内部格式
    const normalizedSource = source === 'qq' ? 'tx' : source

    // QQ音乐音源：优先使用 VKeys API 获取完整歌词（含YRC逐字歌词和翻译）
    if (normalizedSource === 'tx') {
      console.log(`[PlayerPage] 检测到 QQ 音乐音源(source=${source})，使用 VKeys API 获取歌词...`)
      try {
        const result = await fetchQQMusicLyric(String(id))
        if (result.yrc || result.lrc) {
          const mainLyric = result.yrc || result.lrc
          const lyricType = result.yrc ? 'YRC(逐字)' : 'LRC(标准)'
          const transStatus = result.trans ? '✓' : '✗'
          console.log(`[PlayerPage] VKeys 歌词获取成功 | 主歌词: ${lyricType} (${mainLyric.length} 字符) | 翻译: ${transStatus}`)
          if (result.yrc) {
            const yrcLines = result.yrc.split('\n')
            console.log(`[PlayerPage] YRC 行数: ${yrcLines.length}, 首行预览: ${yrcLines[0]?.substring(0, 120)}`)
          }
          return { lyrics: mainLyric, translatedLyrics: result.trans }
        }
        console.warn(`[PlayerPage] VKeys 返回空歌词，回退到 GMA API`)
      } catch (e) {
        console.warn('[PlayerPage] VKeys API 获取歌词失败，回退到 GMA API:', e)
      }
    }

    // 其他音源或 VKeys 失败：使用 GMA API
    console.log(`[PlayerPage] 使用 GMA API 获取歌词 (source=${source})...`)
    const lyricText = await fetchGMALyric(String(id), normalizedSource)
    return { lyrics: lyricText, translatedLyrics: '' }
  }

  /**
   * 歌词重试获取函数
   * @param id 歌曲ID
   * @param source 歌曲来源
   * @returns 歌词字符串（主歌词）
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
        const { lyrics, translatedLyrics } = await doFetchLyric(String(id), source)
        if (lyrics) {
          // 同时存储翻译歌词
          if (translatedLyrics) {
            player.setTranslatedLyrics(translatedLyrics)
          }
          return lyrics
        }
      } catch (e) {
        console.warn(`[PlayerPage] 获取歌词失败，第 ${attempt + 1} 次重试:`, e)
      }

      attempt++
      // 指数退避策略，最大延迟 5 秒
      const delay = Math.min(500 + attempt * 500, 5000)
      await new Promise((resolve) => setTimeout(resolve, delay))
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

  // 监听当前歌曲变化，如果无歌词则尝试重试获取
  // 如果是QQ音乐音源且只有LRC歌词，也尝试获取YRC逐字歌词
  watch(
    () => player.currentSong?.id,
    async (newId) => {
      if (!newId || !player.currentSong) return

      // 获取 source 并标准化
      const source = player.currentSong.source || 'wy'
      const normalizedSource = source === 'qq' ? 'tx' : source
      const neteaseId = player.currentSong.sourceSongId ?? player.currentSong.id
      if (!neteaseId) return

      const hasLyrics = player.currentSong.lyrics && player.currentSong.lyrics.length > 0

      // 如果是QQ音乐音源，且现有歌词是LRC格式（非YRC），尝试获取逐字歌词
      if (hasLyrics && normalizedSource === 'tx' && !isYrcFormat(player.currentSong.lyrics!)) {
        console.log('[PlayerPage] 检测到 QQ 音乐 LRC 歌词，尝试获取 YRC 逐字歌词...')
        try {
          const result = await fetchQQMusicLyric(String(neteaseId))
          if (result.yrc && player.currentSong?.id === newId) {
            console.log('[PlayerPage] 成功获取 YRC 逐字歌词，更新歌词')
            player.setLyrics(result.yrc)
            // 同时更新翻译歌词（如果之前没有）
            if (result.trans && !player.currentSong.translatedLyrics) {
              player.setTranslatedLyrics(result.trans)
            }
          } else {
            console.log('[PlayerPage] VKeys 未返回 YRC 歌词，保留现有 LRC 歌词')
          }
        } catch (e) {
          console.warn('[PlayerPage] 获取 YRC 逐字歌词失败，保留 LRC 歌词:', e)
        }
        return
      }

      // 如果已有歌词，则不需要重试
      if (hasLyrics) return

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
    translatedLyricsData,
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