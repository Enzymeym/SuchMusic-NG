import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import { useOsTheme } from 'naive-ui'
import { audioEngine } from '../audio/audio-engine'
import { webAudioOutputEngine } from '../audio/web-audio-engine'
import { setPrimaryColor, setGlobalFontFamily } from '../themes'
import { usePlayerStore } from './playerStore'
import { extractImageColors } from '../utils/imageColors'
import { mixWithBlack, mixWithWhite, getBrightness } from '../utils/color'
import { getDefaultOutputMode, type AudioOutputMode } from '../utils/audioOutputModeManager'

export interface GeneralSettings {
  closeAction: 'minimize' | 'quit'
  remindOnClose: boolean
  taskbarProgress: boolean
  taskbarSongInfo: boolean
  orpheusProtocol: boolean
  autoCheckUpdate: boolean
  updateChannel: 'stable' | 'beta'
}

export interface AppearanceSettings {
  globalFont: string
  lyricsFont: string
  desktopLyricsFont: string
  themeMode: 'system' | 'light' | 'dark'
  themeColorPreset: string
  customThemeColor: string
  playlistLayoutStyle: 'classic' | 'modern'
  songListStyle: 'card' | 'plain'
  themeColorFollowsCover: boolean
  /** 首页是否显示信息展示卡片（关闭后显示随时间变化的问候标语） */
  homeShowInfoCards: boolean
}

export interface PlaybackSettings {
  autoHideCursorWhenControlsHidden: boolean
  autoHidePlayerPageFooter: boolean
  /** 音频输出模式: 'webaudio' | 'wasapi-shared' | 'wasapi-exclusive' */
  audioOutputMode: AudioOutputMode
  /** WASAPI 输出设备 ID（空字符串表示默认设备） */
  audioOutputDeviceId: string
  /** WASAPI 输出设备名称（用于 UI 显示） */
  audioOutputDeviceName: string
  lyricsAutoSize: boolean
  lyricsFontSize: number
  lyricsAreaRatio: number
  lyricsAppleStyle: boolean
  /** 当前歌词行垂直位置（百分比，0-100，50 为居中，仅 Apple 风格歌词生效） */
  lyricsAlignPosition: number
  lyricsBlurEnabled: boolean
  lyricsSpringEnabled: boolean
  playerBackgroundStyle: 'classic' | 'amll'
  /** 是否显示翻译歌词 */
  lyricsShowTranslation: boolean
  /** 是否显示音译歌词（罗马音等） */
  lyricsShowTransliteration: boolean
  /** 翻译/音译歌词字号（仅在自适应大小开启时生效） */
  lyricsTranslationSize: number
  /** 是否排除 TTML 格式歌词 */
  lyricsExcludeTTML: boolean
  /** 是否排除本地音乐歌词 */
  lyricsExcludeLocal: boolean
  /** 元数据关键词过滤（逗号分隔，匹配冒号前内容） */
  lyricsExcludeKeywords: string
  /** 隐藏已播放歌词行（AMLL） */
  amllHidePassedLines: boolean
  /** 逐字歌词渐变宽度（AMLL） */
  amllWordFadeWidth: number
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
  lyricsOffset: number // 歌词偏移（秒，正数=歌词延后，负数=歌词提前）
  playbackRate: number // 播放速度倍率（0.25-4.0）
  // 音频可视化设置
  visualizerEnabled: boolean // 是否启用可视化
  visualizerStyle: string // 可视化风格（bars/circular/wave/particles/flame）
  visualizerSize: number // 显示大小（0.5-2.0）
  visualizerColorTheme: string // 颜色主题（default/warm/cool/neon/grayscale/follow-cover）
  visualizerIntensity: number // 显示强度（0.3-1.5）
  volumeBoost: number // 音量增强倍数（1.0-3.0，默认 1.0）
  // 任务栏播控设置
  taskbarControlEnabled: boolean // 是否启用任务栏播控
  taskbarControlWidthMode: 'auto' | 'custom' // 宽度模式：自适应 / 自定义
  taskbarControlCustomWidth: number // 自定义宽度（px）
  taskbarControlWidgetOffset: boolean // 居中对齐时预留 Windows 小组件入口
  taskbarControlOffsetX: number // 手动位置偏移（px，正数右移）
  taskbarControlShowCover: boolean
  taskbarControlShowTitle: boolean
  taskbarControlShowArtist: boolean
}

export interface LocalSettings {
  scanDirs: string[]
  cacheDir?: string
  downloadDir?: string
}

export const useSettingsStore = defineStore('settings', () => {
  // --- State ---
  const general = ref<GeneralSettings>({
    closeAction: 'minimize',
    remindOnClose: true,
    taskbarProgress: true,
    taskbarSongInfo: true,
    orpheusProtocol: true,
    autoCheckUpdate: true,
    updateChannel: 'stable'
  })

  const appearance = ref<AppearanceSettings>({
    globalFont: 'Microsoft YaHei UI',
    lyricsFont: 'Microsoft YaHei UI',
    desktopLyricsFont: 'Microsoft YaHei UI',
    themeMode: 'system',
    themeColorPreset: 'default',
    customThemeColor: '#2C8EFD',
    playlistLayoutStyle: 'classic',
    songListStyle: 'card',
    themeColorFollowsCover: false,
    homeShowInfoCards: true
  })

  const playback = ref<PlaybackSettings>({
    autoHideCursorWhenControlsHidden: true,
    autoHidePlayerPageFooter: true,
    audioOutputMode: getDefaultOutputMode(),
    audioOutputDeviceId: '',
    audioOutputDeviceName: '',
    // 歌词自适应大小开关
    lyricsAutoSize: true,
    // 歌词基础字号（px）
    lyricsFontSize: 28,
    // 播放页歌词区域占比（百分比，表示右侧歌词区域宽度）
    lyricsAreaRatio: 60,
    // 是否启用 Apple 风格歌词
    lyricsAppleStyle: true,
    // 当前歌词垂直位置（百分比，50 为居中）
    lyricsAlignPosition: 50,
    // Apple 风格歌词模糊效果开关
    lyricsBlurEnabled: true,
    // Apple 风格歌词弹簧效果开关
    lyricsSpringEnabled: true,
    playerBackgroundStyle: 'classic',
    // 翻译与音译
    lyricsShowTranslation: true,
    lyricsShowTransliteration: true,
    lyricsTranslationSize: 16,
    // 歌词排除过滤
    lyricsExcludeTTML: false,
    lyricsExcludeLocal: false,
    lyricsExcludeKeywords: '',
    // AMLL 专属设置
    amllHidePassedLines: false,
    amllWordFadeWidth: 0.5,
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
    ttmlMirrorUrl: 'https://amlldb.bikonoo.com/ncm-lyrics',
    // 歌词偏移（秒）
    lyricsOffset: 0,
    // 播放速度倍率
    playbackRate: 1.0,
    // 音频可视化
    visualizerEnabled: true,
    visualizerStyle: 'bars',
    visualizerSize: 1.0,
    visualizerColorTheme: 'follow-cover',
    visualizerIntensity: 0.8,
    volumeBoost: 1.0,
    // 任务栏播控
    taskbarControlEnabled: false,
    taskbarControlWidthMode: 'auto',
    taskbarControlCustomWidth: 480,
    taskbarControlWidgetOffset: false,
    taskbarControlOffsetX: 0,
    taskbarControlShowCover: true,
    taskbarControlShowTitle: true,
    taskbarControlShowArtist: true
  })

  const local = ref<LocalSettings>({
    scanDirs: [],
    cacheDir: '',
    downloadDir: ''
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

  // 同步音频输出模式和设备到主进程（影响实际播放引擎的选择）
  watch(
    [() => playback.value.audioOutputMode, () => playback.value.audioOutputDeviceId],
    ([mode, deviceId]) => {
      // 离开 Web Audio 模式时释放渲染进程的 AudioContext（其单例在 WASAPI 模式下
      // 无任何播放请求但仍占用一条 Web Audio 音频线程，属资源泄漏）。
      // 切回 Web Audio 模式播放时 loadFromArrayBuffer 会按需重建，故 dispose 安全。
      if (mode !== 'webaudio') {
        webAudioOutputEngine.dispose()
      }
      if (window.electron && window.electron.ipcRenderer) {
        window.electron.ipcRenderer.invoke('audio-engine:set-output-config', { mode, deviceId })
      }
    },
    { immediate: true }
  )

  // 同步音量增强设置到音频引擎
  watch(
    () => playback.value.volumeBoost,
    async (val) => {
      await audioEngine.setVolumeBoost(val)
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
              // 浅色模式下压暗颜色，深色模式下提亮暗色
              if (isLightMode) {
                setPrimaryColor(mixWithBlack(colors.main, 0.3))
              } else {
                // 深色模式：较亮的颜色保持不变，较暗的颜色提亮80%
                const brightness = getBrightness(colors.main) ?? 0.5
                if (brightness < 0.5) {
                  setPrimaryColor(mixWithWhite(colors.main, 0.8))
                } else {
                  setPrimaryColor(colors.main)
                }
              }
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
      } catch (e) {
        console.error('Failed to load settings', e)
      }
    }
  }

  const saveSettings = () => {
    localStorage.setItem(
      'app-settings',
      JSON.stringify({
        general: general.value,
        appearance: appearance.value,
        playback: playback.value,
        local: local.value
      })
    )
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

  // Initialize - 必须在 watch 之前加载，避免加载过程触发不必要的保存
  loadSettings()

  // 监听每个设置分组的属性变化，使用深度监听确保嵌套属性变更也能触发保存
  watch(
    [general, appearance, playback, local],
    () => {
      debouncedSave()
    },
    { deep: true }
  )

  // 窗口关闭前立即刷新待保存的设置，避免防抖窗口期内修改丢失
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      saveSettings()
    })
  }

  const updateAppearance = (settings: Partial<AppearanceSettings>) => {
    appearance.value = { ...appearance.value, ...settings }
  }

  return {
    general,
    appearance,
    playback,
    local,
    updateAppearance,
    saveSettings
  }
})
