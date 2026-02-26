import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { webAudioEngine } from '../audio/audio-engine'
import { setPrimaryColor, setGlobalFontFamily } from '../themes'

export interface GeneralSettings {
  onlineServices: boolean
  closeAction: 'minimize' | 'quit'
  remindOnClose: boolean
  taskbarProgress: boolean
  orpheusProtocol: boolean
  autoCheckUpdate: boolean
  updateChannel: 'stable' | 'beta'
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
}

export interface PlaybackSettings {
  autoHideCursorWhenControlsHidden: boolean
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
}

export interface LocalSettings {
  scanDirs: string[]
  cacheDir?: string
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
    updateChannel: 'stable'
  })

  const appearance = ref<AppearanceSettings>({
    globalFont: 'Microsoft YaHei UI',
    lyricsFont: 'Microsoft YaHei UI',
    taskbarLyricsFont: 'Microsoft YaHei UI',
    desktopLyricsFont: 'Microsoft YaHei UI',
    themeMode: 'system',
    themeColorPreset: 'default',
    customThemeColor: '#2C8EFD',
    playlistLayoutStyle: 'classic'
  })

  const playback = ref<PlaybackSettings>({
    autoHideCursorWhenControlsHidden: true,
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
    desktopLyricsForceDuet: false
  })

  const local = ref<LocalSettings>({
    scanDirs: [],
    cacheDir: ''
  })

  const source = ref<SourceSettings>({
    preferredPlatform: 'all',
    preferredQuality: '128k'
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

  // 同步主题主色到 Naive UI 主题
  watch(
    () => appearance.value.customThemeColor,
    (color) => {
      if (color) {
        setPrimaryColor(color)
      }
    },
    { immediate: true }
  )

  // 同步压限器设置到音频引擎
  watch(
    () => playback.value.limiterStrength,
    (val) => {
      webAudioEngine.setLimiterStrength(val)
    },
    { immediate: true }
  )

  // 同步均衡器启用状态
  watch(
    () => playback.value.eqEnabled,
    (val) => {
      webAudioEngine.setEqEnabled(val)
    },
    { immediate: true }
  )

  // 同步均衡器各频段增益
  watch(
    () => playback.value.eqGains,
    (val) => {
      webAudioEngine.setEqGains(val)
    },
    { immediate: true, deep: true }
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

  // Watch for changes to save
  watch([general, appearance, playback, local, source], () => {
    saveSettings()
  }, { deep: true })

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
