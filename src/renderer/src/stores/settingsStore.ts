import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import { useOsTheme } from 'naive-ui'
import { webAudioEngine } from '../audio/audio-engine'
import { setPrimaryColor, setGlobalFontFamily } from '../themes'
import { usePlayerStore } from './playerStore'
import { extractImageColors } from '../utils/imageColors'

export interface GeneralSettings {
  onlineServices: boolean
  closeAction: 'minimize' | 'quit'
  remindOnClose: boolean
  taskbarProgress: boolean
  orpheusProtocol: boolean
  autoCheckUpdate: boolean
  updateChannel: 'stable' | 'beta'
  searchResultOrder: string[]
}

export interface AppearanceSettings {
  globalFont: string
  lyricsFont: string
  taskbarLyricsFont: string
  desktopLyricsFont: string
  themeMode: 'system' | 'light' | 'dark'
  themeColorPreset: string
  customThemeColor: string
  playlistLayoutStyle: 'classic' | 'modern'
  songListStyle: 'card' | 'plain'
  themeColorFollowsCover: boolean
}

export interface PlaybackSettings {
  autoHideCursorWhenControlsHidden: boolean
  autoHidePlayerPageFooter: boolean
  limiterStrength: number
  eqEnabled: boolean
  eqGains: number[]
  eqPreset: string
  lyricsAutoSize: boolean
  lyricsFontSize: number
  lyricsAreaRatio: number
  lyricsAppleStyle: boolean
  lyricsBlurEnabled: boolean
  lyricsSpringEnabled: boolean
  playerBackgroundStyle: 'classic' | 'amll'
  desktopLyricsFontSize: number
  desktopLyricsColor: string
  desktopLyricsActiveColor: string
  desktopLyricsOpacity: number
  desktopLyricsShowNextLine: boolean
  desktopLyricsAlign: 'left' | 'center' | 'right'
  desktopLyricsLocked: boolean
  desktopLyricsForceDuet: boolean
  preloadTriggerThreshold: number // 预加载触发阈值（0-1，默认0.85）
  preloadQualityLevel: string // 预加载质量级别
  lyricsPriority: string[] // 歌词格式优先级
  ttmlMirrorUrl: string // TTML 歌词镜像站地址
}

export interface LocalSettings {
  scanDirs: string[]
  cacheDir?: string
  downloadDir?: string
}

export interface SourceSettings {
  preferredPlatform: string
  preferredQuality: string
}

export const useSettingsStore = defineStore('settings', () => {
  // --- State ---
  const general = ref<GeneralSettings>({
    onlineServices: true,
    closeAction: 'minimize',
    remindOnClose: true,
    taskbarProgress: true,
    orpheusProtocol: true,
    autoCheckUpdate: true,
    updateChannel: 'stable',
    searchResultOrder: ['tx', 'kg', 'wy', 'kw', 'mg']
  })

  const appearance = ref<AppearanceSettings>({
    globalFont: 'Microsoft YaHei UI',
    lyricsFont: 'Microsoft YaHei UI',
    taskbarLyricsFont: 'Microsoft YaHei UI',
    desktopLyricsFont: 'Microsoft YaHei UI',
    themeMode: 'system',
    themeColorPreset: 'default',
    customThemeColor: '#2C8EFD',
    playlistLayoutStyle: 'classic',
    songListStyle: 'card',
    themeColorFollowsCover: false
  })

  const playback = ref<PlaybackSettings>({
    autoHideCursorWhenControlsHidden: true,
    autoHidePlayerPageFooter: true,
    limiterStrength: 0.6,
    eqEnabled: false,
    eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqPreset: 'flat',
    // 歌词自适应大小开关
    lyricsAutoSize: true,
    // 歌词基础字号（px）
    lyricsFontSize: 28,
    // 播放页歌词区域占比（百分比，表示右侧歌词区域宽度）
    lyricsAreaRatio: 60,
    // 是否启用 Apple 风格歌词
    lyricsAppleStyle: true,
    // Apple 风格歌词模糊效果开关
    lyricsBlurEnabled: true,
    // Apple 风格歌词弹簧效果开关
    lyricsSpringEnabled: true,
    playerBackgroundStyle: 'classic',
    // 桌面歌词设置
    desktopLyricsFontSize: 24,
    desktopLyricsColor: '#ffffff',
    desktopLyricsActiveColor: '#18a058',
    desktopLyricsOpacity: 1.0,
    desktopLyricsShowNextLine: true,
    desktopLyricsAlign: 'center',
    desktopLyricsLocked: false,
    desktopLyricsForceDuet: false,
    // 预加载设置
    preloadTriggerThreshold: 0.85, // 预加载触发阈值（0-1）
    preloadQualityLevel: '128k', // 预加载质量级别
    // 歌词格式优先级
    lyricsPriority: ['ttml', 'crlyric', 'lyric'],
    // TTML 歌词镜像站地址
    ttmlMirrorUrl: 'https://amlldb.bikonoo.com/ncm-lyrics'
  })

  const local = ref<LocalSettings>({
    scanDirs: [],
    cacheDir: '',
    downloadDir: ''
  })

  const source = ref<SourceSettings>({
    preferredPlatform: 'all',
    preferredQuality: '128k'
  })

  // 获取系统主题
  const osThemeRef = useOsTheme()

  // 计算当前是否为深色模式
  const isDark = computed(() => {
    const mode = appearance.value.themeMode
    if (mode === 'dark') return true
    if (mode === 'light') return false
    return osThemeRef.value === 'dark'
  })

  // --- Actions ---

  // 构造统一的字体栈字符串
  const buildFontStack = (font: string): string => {
    // 组合用户选择字体与系统通用字体栈
    return `"${font}", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  }

  // 应用全局字体到 body 与 Naive UI 主题
  watch(
    () => appearance.value.globalFont,
    (newFont) => {
      if (newFont) {
        const stack = buildFontStack(newFont)
        document.body.style.fontFamily = stack
        setGlobalFontFamily(stack)
      }
    },
    { immediate: true }
  )

  // 同步压限器设置到音频引擎
  watch(
    () => playback.value.limiterStrength,
    async (val) => {
      await webAudioEngine.setLimiterStrength(val)
    },
    { immediate: true }
  )

  // 同步均衡器启用状态
  watch(
    () => playback.value.eqEnabled,
    async (val) => {
      await webAudioEngine.setEqEnabled(val)
    },
    { immediate: true }
  )

  // 同步均衡器各频段增益
  watch(
    () => playback.value.eqGains,
    async (val) => {
      await webAudioEngine.setEqGains(val)
    },
    { immediate: true, deep: true }
  )

  // 同步关闭行为设置到主进程
  watch(
    () => general.value.closeAction,
    (val) => {
      if (window.electron && window.electron.ipcRenderer) {
        window.electron.ipcRenderer.send('settings:closeAction', val)
      }
    },
    { immediate: true }
  )

  // 主题色跟随封面逻辑
  // 延迟获取 playerStore 以避免循环依赖
  let playerStore: ReturnType<typeof usePlayerStore> | null = null
  const getPlayerStore = () => {
    if (!playerStore) playerStore = usePlayerStore()
    return playerStore
  }

  // 记录最后一次提取的主色，防止切歌太快导致的异步覆盖
  let lastCoverUrl = ''

  watch(
    () => {
      const ps = getPlayerStore()
      return {
        followsCover: appearance.value.themeColorFollowsCover,
        cover: ps.currentSong?.cover,
        customThemeColor: appearance.value.customThemeColor,
        isLightMode: !isDark.value
      }
    },
    async ({ followsCover, cover, customThemeColor, isLightMode }) => {
      if (followsCover) {
        if (cover) {
          lastCoverUrl = cover
          try {
            const colors = await extractImageColors(cover, { isLightMode })
            // 确保当前封面没有发生变化，再应用颜色
            if (lastCoverUrl === cover) {
              setPrimaryColor(colors.main)
            }
          } catch (e) {
            console.error('Failed to extract theme color from cover', e)
            if (lastCoverUrl === cover) {
              setPrimaryColor(customThemeColor)
            }
          }
        } else {
          // 如果开启了跟随封面，但当前没有封面，则回退到自定义颜色
          setPrimaryColor(customThemeColor)
        }
      } else {
        // 如果没有开启跟随封面，则使用自定义颜色
        setPrimaryColor(customThemeColor)
      }
    },
    { immediate: true }
  )

  // Persistence (Optional for now, can be expanded later)
  const loadSettings = () => {
    const stored = localStorage.getItem('app-settings')
    if (stored) {
      try {
        const data = JSON.parse(stored)
        if (data.general) general.value = { ...general.value, ...data.general }
        if (data.appearance) appearance.value = { ...appearance.value, ...data.appearance }
        if (data.playback) playback.value = { ...playback.value, ...data.playback }
        if (data.local) local.value = { ...local.value, ...data.local }
        if (data.source) source.value = { ...source.value, ...data.source }
      } catch (e) {
        console.error('Failed to load settings', e)
      }
    }
  }

  const saveSettings = () => {
    localStorage.setItem('app-settings', JSON.stringify({
      general: general.value,
      appearance: appearance.value,
      playback: playback.value,
      local: local.value,
      source: source.value
    }))
  }

  /**
   * 防抖保存函数，减少频繁 JSON 序列化带来的性能开销
   * @param delay - 防抖延迟时间（毫秒）
   */
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveSettings()
    }, 500)
  }

  // 监听每个设置分组的顶层属性变化，使用浅监听替代 deep watch
  watch([general, appearance, playback, local, source], () => {
    debouncedSave()
  }, { deep: false })

  // Initialize
  loadSettings()

  const updateAppearance = (settings: Partial<AppearanceSettings>) => {
    appearance.value = { ...appearance.value, ...settings }
  }

  return {
    general,
    appearance,
    playback,
    local,
    source,
    updateAppearance
  }
})
