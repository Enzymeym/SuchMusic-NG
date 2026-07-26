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

  // 是否含有有效歌词（去除空白后判断）
  const hasLyrics = computed(() => lyricsData.value.trim().length > 0)

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

  // 判断是否为网易云歌曲
  function isWySong(source?: string): boolean {
    return source === 'wy' || source === 'netease'
  }

  // 标记是否正在获取歌词，防止重复请求
  const fetchingLyrics = ref(false)

  // 记录用户手动选择过歌词的歌曲 ID，防止自动匹配覆盖用户选择
  const manualLyricsSongId = ref<string | number | null>(null)

  /**
   * 标记当前歌曲已手动选择歌词
   * 后续自动匹配会跳过该歌曲，避免覆盖用户选择
   */
  function markManualLyricsSelected(): void {
    manualLyricsSongId.value = player.currentSong?.id ?? null
  }

  // 从网易云在线获取歌词（已有已知 songId）
  async function fetchWyLyricsOnline(sourceSongId: string | number) {
    try {
      const result = await window.electron.ipcRenderer.invoke('lyric:fetch-wy', String(sourceSongId))
      if (!result) return
      // 校验歌曲是否已切换，且未手动选择过歌词
      if (!player.currentSong) return
      if (manualLyricsSongId.value === player.currentSong.id) return
      const currentWy = isWySong(player.currentSong.source)
      const currentSid = player.currentSong.sourceSongId
      if (!currentWy || String(currentSid) !== String(sourceSongId)) return

      if (result.lyrics) {
        player.setLyrics(result.lyrics)
      }
      if (result.translatedLyrics) {
        player.setTranslatedLyrics(result.translatedLyrics)
      }
    } catch (e) {
      console.warn('[usePlayerLyrics] Failed to fetch Wy lyrics:', e)
    }
  }

  // 通过歌曲名 + 歌手名模糊匹配获取网易云歌词（支持本地缓存）
  async function fetchLyricsByMatch(title: string, artist: string) {
    if (fetchingLyrics.value) return
    fetchingLyrics.value = true
    try {
      const result = await window.electron.ipcRenderer.invoke('lyric:fetch-local', {
        title,
        artist
      })
      if (!result) return
      // 校验歌曲是否已切换，且未手动选择过歌词
      if (!player.currentSong) return
      if (manualLyricsSongId.value === player.currentSong.id) return
      if (
        player.currentSong.title !== title ||
        player.currentSong.artist !== artist
      ) {
        return
      }

      if (result.lyrics) {
        player.setLyrics(result.lyrics)
      }
      if (result.translatedLyrics) {
        player.setTranslatedLyrics(result.translatedLyrics)
      }
    } catch (e) {
      console.warn('[usePlayerLyrics] Failed to fetch lyrics by match:', e)
    } finally {
      fetchingLyrics.value = false
    }
  }

  // 监听当前歌曲变化，尝试在线获取歌词
  watch(
    () => player.currentSong?.id,
    (newId) => {
      if (!newId || !player.currentSong) return
      // 歌曲切换时清除手动选择标记
      if (manualLyricsSongId.value !== newId) {
        manualLyricsSongId.value = null
      }

      const song = player.currentSong

      // 如果已有歌词或已手动选择，跳过
      if (song.lyrics) return
      if (manualLyricsSongId.value === newId) return

      // 网易云歌曲已有 sourceSongId 的，直接通过 ID 获取
      if (isWySong(song.source) && song.sourceSongId) {
        fetchWyLyricsOnline(song.sourceSongId)
        return
      }

      // 其他歌曲（本地歌曲等），通过歌名 + 歌手匹配获取
      fetchLyricsByMatch(song.title, song.artist)
    },
    { immediate: true }
  )

  return {
    currentTime,
    lyricsData,
    hasLyrics,
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
    scrollToPage,
    fetchingLyrics,
    markManualLyricsSelected
  }
}
