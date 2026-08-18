import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 音频引擎配置接口
interface AudioEngineConfig {
  sampleRate?: number
  bufferSize?: number
  channels?: number
  enableEq?: boolean
  enableCompressor?: boolean
  enableLimiter?: boolean
  enableLoudness?: boolean
}

// 轨道信息接口
interface TrackInfo {
  durationMs: number
  sampleRate: number
  channels: number
  format: string
}

// 系统媒体控制状态接口
interface MediaControlStatus {
  title?: string
  artist?: string
  album?: string
  cover?: string // data: | http(s): | 本地文件路径 | blob:(渲染层先转 data:)
  durationMs?: number
  playing: boolean
  positionMs?: number
}

// 系统媒体控制命令类型
type MediaControlCommand =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'stop'
  | 'seek'
  | 'seekRelative'
  | 'setVolume'

// EQ 频段设置接口
interface EqBandSettings {
  frequency: number
  preGain: number
  postGain: number
  preQ: number
  postQ: number
  bandType: 'lowShelf' | 'highShelf' | 'peaking' | 'notch'
}

// 压缩器参数接口
interface CompressorParams {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
}

// 限制器参数接口
interface LimiterParams {
  ceilingDb: number
  releaseMs: number
}

// 等响度参数接口
interface LoudnessParams {
  enabled: boolean
  compensation: number
  referenceLoudness: number
  direction: 'low' | 'high' | 'both'
}

// 循环模式类型
type LoopMode = 'none' | 'one' | 'all'

// 引擎状态类型
type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped'

// 版本信息接口
interface VersionInfo {
  major: number
  minor: number
  patch: number
}

// 引擎管理器 - 管理引擎实例 ID
class AudioEngineManager {
  private currentEngineId: string | null = null

  async create(
    config?: AudioEngineConfig
  ): Promise<{ success: boolean; engineId?: string; error?: string }> {
    const result = await ipcRenderer.invoke('audio-engine:create', config)
    if (result.success) {
      this.currentEngineId = result.engineId
      return { success: true, engineId: result.engineId }
    }
    return { success: false, error: result.error }
  }

  getEngineId(): string | null {
    return this.currentEngineId
  }

  async destroy(): Promise<boolean> {
    if (!this.currentEngineId) return false
    const result = await ipcRenderer.invoke('audio-engine:destroy', this.currentEngineId)
    if (result.success) {
      this.currentEngineId = null
    }
    return result.success
  }

  private ensureEngineId(): string {
    if (!this.currentEngineId) {
      throw new Error('音频引擎未初始化，请先调用 create()')
    }
    return this.currentEngineId
  }

  // === 播放控制 ===

  async load(
    filePath: string
  ): Promise<{ success: boolean; trackInfo?: TrackInfo; error?: string }> {
    return ipcRenderer.invoke('audio-engine:load', this.ensureEngineId(), filePath)
  }

  async play(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:play', this.ensureEngineId())
  }

  async pause(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:pause', this.ensureEngineId())
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:stop', this.ensureEngineId())
  }

  async seek(positionMs: number): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:seek', this.ensureEngineId(), positionMs)
  }

  async seekAndPlay(positionMs: number): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:seek-and-play', this.ensureEngineId(), positionMs)
  }

  async setVolume(volume: number): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-volume', this.ensureEngineId(), volume)
  }

  async getVolume(): Promise<number> {
    const result = await ipcRenderer.invoke('audio-engine:get-volume', this.ensureEngineId())
    return result.volume ?? 1.0
  }

  async setLoopMode(mode: LoopMode): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-loop-mode', this.ensureEngineId(), mode)
  }

  async getLoopMode(): Promise<LoopMode> {
    const result = await ipcRenderer.invoke('audio-engine:get-loop-mode', this.ensureEngineId())
    return result.mode ?? 'none'
  }

  async getPosition(): Promise<number> {
    const result = await ipcRenderer.invoke('audio-engine:get-position', this.ensureEngineId())
    return result.position ?? 0
  }

  /**
   * 获取当前播放位置（毫秒）
   * @returns 当前播放位置（毫秒）
   */
  async getPositionMs(): Promise<number> {
    return this.getPosition()
  }

  async isPlaying(): Promise<boolean> {
    const result = await ipcRenderer.invoke('audio-engine:is-playing', this.ensureEngineId())
    return result.isPlaying ?? false
  }

  async getState(): Promise<EngineState> {
    const result = await ipcRenderer.invoke('audio-engine:get-state', this.ensureEngineId())
    return result.state ?? 'idle'
  }

  // === EQ 控制 ===

  async setEqEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-eq-enabled', this.ensureEngineId(), enabled)
  }

  async isEqEnabled(): Promise<boolean> {
    const result = await ipcRenderer.invoke('audio-engine:is-eq-enabled', this.ensureEngineId())
    return result.enabled ?? true
  }

  async setEqBand(
    bandIndex: number,
    settings: Partial<EqBandSettings>
  ): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke(
      'audio-engine:set-eq-band',
      this.ensureEngineId(),
      bandIndex,
      settings
    )
  }

  async getEqBand(bandIndex: number): Promise<EqBandSettings | null> {
    const result = await ipcRenderer.invoke(
      'audio-engine:get-eq-band',
      this.ensureEngineId(),
      bandIndex
    )
    return result.band ?? null
  }

  async getEqBands(): Promise<EqBandSettings[]> {
    const result = await ipcRenderer.invoke('audio-engine:get-eq-bands', this.ensureEngineId())
    return result.bands ?? []
  }

  async setEqGains(gains: number[]): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-eq-gains', this.ensureEngineId(), gains)
  }

  // === 压缩器控制 ===

  async setCompressorEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-compressor-enabled', this.ensureEngineId(), enabled)
  }

  async isCompressorEnabled(): Promise<boolean> {
    const result = await ipcRenderer.invoke(
      'audio-engine:is-compressor-enabled',
      this.ensureEngineId()
    )
    return result.enabled ?? true
  }

  async setCompressor(params: CompressorParams): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-compressor', this.ensureEngineId(), params)
  }

  async getCompressor(): Promise<CompressorParams> {
    const result = await ipcRenderer.invoke('audio-engine:get-compressor', this.ensureEngineId())
    return result.params ?? { thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 100, kneeDb: 6 }
  }

  async getCompressorGainReduction(): Promise<number> {
    const result = await ipcRenderer.invoke(
      'audio-engine:get-compressor-gain-reduction',
      this.ensureEngineId()
    )
    return result.gainReduction ?? 0
  }

  // === 限制器控制 ===

  async setLimiterEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-limiter-enabled', this.ensureEngineId(), enabled)
  }

  async isLimiterEnabled(): Promise<boolean> {
    const result = await ipcRenderer.invoke(
      'audio-engine:is-limiter-enabled',
      this.ensureEngineId()
    )
    return result.enabled ?? true
  }

  async setLimiter(params: LimiterParams): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-limiter', this.ensureEngineId(), params)
  }

  async getLimiter(): Promise<LimiterParams> {
    const result = await ipcRenderer.invoke('audio-engine:get-limiter', this.ensureEngineId())
    return result.params ?? { ceilingDb: -0.3, releaseMs: 50 }
  }

  async getLimiterGainReduction(): Promise<number> {
    const result = await ipcRenderer.invoke(
      'audio-engine:get-limiter-gain-reduction',
      this.ensureEngineId()
    )
    return result.gainReduction ?? 0
  }

  // === 等响度控制 ===

  async setLoudness(params: LoudnessParams): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-loudness', this.ensureEngineId(), params)
  }

  async getLoudness(): Promise<LoudnessParams> {
    const result = await ipcRenderer.invoke('audio-engine:get-loudness', this.ensureEngineId())
    return (
      result.params ?? {
        enabled: false,
        compensation: 1.0,
        referenceLoudness: -20,
        direction: 'both'
      }
    )
  }

  async setLoudnessEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:set-loudness-enabled', this.ensureEngineId(), enabled)
  }

  async isLoudnessEnabled(): Promise<boolean> {
    const result = await ipcRenderer.invoke(
      'audio-engine:is-loudness-enabled',
      this.ensureEngineId()
    )
    return result.enabled ?? false
  }

  // === 生命周期 ===

  /**
   * 读取原始音频文件 Buffer（用于 Web Audio 浏览器原生解码）
   * @param filePath 文件路径
   * @returns 文件原始 Buffer
   */
  async readAudioFile(filePath: string): Promise<{
    success: boolean
    data?: Uint8Array
    error?: string
  }> {
    return ipcRenderer.invoke('audio-engine:read-audio-file', filePath)
  }

  /**
   * 一次性解码全部音频并返回处理后的 PCM Buffer
   * 用于 Web Audio API 播放模式
   * @returns PCM 数据（Uint8Array 形式的 f32 PCM）、采样率、声道数
   */
  async decodeAllProcessed(): Promise<{
    success: boolean
    data?: Uint8Array
    sampleRate?: number
    channels?: number
    isPartial?: boolean
    error?: string
  }> {
    return ipcRenderer.invoke('audio-engine:decode-processed', this.ensureEngineId())
  }

  /**
   * 快速解码前 N 个采样（渐进式播放）
   * @param targetSamples 目标采样数（每声道）
   * @returns PCM 数据
   */
  async decodePartial(targetSamples: number): Promise<{
    success: boolean
    data?: Uint8Array
    sampleRate?: number
    channels?: number
    isPartial?: boolean
    error?: string
  }> {
    return ipcRenderer.invoke('audio-engine:decode-partial', this.ensureEngineId(), targetSamples)
  }

  async reset(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('audio-engine:reset', this.ensureEngineId())
  }

  static async getVersion(): Promise<VersionInfo> {
    const result = await ipcRenderer.invoke('audio-engine:get-version')
    return result.version ?? { major: 0, minor: 0, patch: 0 }
  }
}

const audioEngineManager = new AudioEngineManager()

const api = {
  rustAudio: audioEngineManager,

  /** 起始点分析模型：获取 onnxruntime WASM 二进制 */
  analyzer: {
    getWasmBinary: () => ipcRenderer.invoke('analyzer:get-wasm-binary')
  },

  /** 内存监控：获取主进程内存统计报告 */
  memory: {
    getReport: () => ipcRenderer.invoke('memory:get-report')
  },

  audioEngine: {
    create: (config?: AudioEngineConfig) => audioEngineManager.create(config),
    destroy: () => audioEngineManager.destroy(),
    getEngineId: () => audioEngineManager.getEngineId(),
    load: (filePath: string) => audioEngineManager.load(filePath),
    play: () => audioEngineManager.play(),
    pause: () => audioEngineManager.pause(),
    stop: () => audioEngineManager.stop(),
    seek: (positionMs: number) => audioEngineManager.seek(positionMs),
    seekAndPlay: (positionMs: number) => audioEngineManager.seekAndPlay(positionMs),
    setVolume: (volume: number) => audioEngineManager.setVolume(volume),
    getVolume: () => audioEngineManager.getVolume(),
    setLoopMode: (mode: LoopMode) => audioEngineManager.setLoopMode(mode),
    getLoopMode: () => audioEngineManager.getLoopMode(),
    getPosition: () => audioEngineManager.getPosition(),
    isPlaying: () => audioEngineManager.isPlaying(),
    getState: () => audioEngineManager.getState(),

    setEqEnabled: (enabled: boolean) => audioEngineManager.setEqEnabled(enabled),
    isEqEnabled: () => audioEngineManager.isEqEnabled(),
    setEqBand: (bandIndex: number, settings: Partial<EqBandSettings>) =>
      audioEngineManager.setEqBand(bandIndex, settings),
    getEqBand: (bandIndex: number) => audioEngineManager.getEqBand(bandIndex),
    getEqBands: () => audioEngineManager.getEqBands(),
    setEqGains: (gains: number[]) => audioEngineManager.setEqGains(gains),

    setCompressorEnabled: (enabled: boolean) => audioEngineManager.setCompressorEnabled(enabled),
    isCompressorEnabled: () => audioEngineManager.isCompressorEnabled(),
    setCompressor: (params: CompressorParams) => audioEngineManager.setCompressor(params),
    getCompressor: () => audioEngineManager.getCompressor(),
    getCompressorGainReduction: () => audioEngineManager.getCompressorGainReduction(),

    setLimiterEnabled: (enabled: boolean) => audioEngineManager.setLimiterEnabled(enabled),
    isLimiterEnabled: () => audioEngineManager.isLimiterEnabled(),
    setLimiter: (params: LimiterParams) => audioEngineManager.setLimiter(params),
    getLimiter: () => audioEngineManager.getLimiter(),
    getLimiterGainReduction: () => audioEngineManager.getLimiterGainReduction(),

    setLoudness: (params: LoudnessParams) => audioEngineManager.setLoudness(params),
    getLoudness: () => audioEngineManager.getLoudness(),
    setLoudnessEnabled: (enabled: boolean) => audioEngineManager.setLoudnessEnabled(enabled),
    isLoudnessEnabled: () => audioEngineManager.isLoudnessEnabled(),

    reset: () => audioEngineManager.reset(),

    decodeAllProcessed: () => audioEngineManager.decodeAllProcessed(),

    decodePartial: (targetSamples: number) => audioEngineManager.decodePartial(targetSamples),

    readAudioFile: (filePath: string) => audioEngineManager.readAudioFile(filePath),

    on: (channel: string, callback: (...args: any[]) => void) => {
      const validChannels = [
        'audio-engine:ended',
        'audio-engine:error',
        'audio-engine:progress',
        'audio-engine:stateChange'
      ]
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args))
      }
    },
    off: (channel: string, callback: (...args: any[]) => void) => {
      ipcRenderer.removeListener(channel, callback)
    },

    getGainReductions: () =>
      Promise.resolve({
        compressorGR: 0,
        limiterGR: 0
      }),

    getVersion: () => AudioEngineManager.getVersion(),

    setFftCallback: (callback: (spectrum: number[]) => void) => {
      const engineId = audioEngineManager.getEngineId()
      if (!engineId) return () => {}

      let lastFftTime = 0
      const FFT_THROTTLE_MS = 60 // 约 16fps，平衡流畅度与性能

      const handler = (_event: any, spectrum: number[]) => {
        const now = Date.now()
        if (now - lastFftTime < FFT_THROTTLE_MS) return
        lastFftTime = now
        callback(spectrum)
      }
      ipcRenderer.on('audio-engine:fft-data', handler)
      ipcRenderer.send('audio-engine:set-fft-callback', engineId)

      return () => {
        ipcRenderer.removeListener('audio-engine:fft-data', handler)
        // 通知主进程停止从 Rust 引擎推送 FFT 数据
        ipcRenderer.send('audio-engine:remove-fft-callback', engineId)
      }
    }
  },

  // WASAPI 音频输出 (独占/共享模式)
  wasapi: {
    enumerateDevices: () => ipcRenderer.invoke('wasapi:enumerate-devices'),
    create: (
      sampleRate: number,
      channels: number,
      mode: 'Shared' | 'Exclusive',
      deviceId?: string
    ) => ipcRenderer.invoke('wasapi:create', sampleRate, channels, mode, deviceId),
    destroy: (engineId: string) => ipcRenderer.invoke('wasapi:destroy', engineId),
    start: (engineId: string) => ipcRenderer.invoke('wasapi:start', engineId),
    stop: (engineId: string) => ipcRenderer.invoke('wasapi:stop', engineId),
    outputAudio: (engineId: string, data: number[], channels: number, sampleRate: number) =>
      ipcRenderer.invoke('wasapi:output-audio', engineId, data, channels, sampleRate),
    flush: (engineId: string) => ipcRenderer.invoke('wasapi:flush', engineId),
    getState: (engineId: string) => ipcRenderer.invoke('wasapi:get-state', engineId),
    getVersion: () => ipcRenderer.invoke('wasapi:get-version')
  },

  // 网易云音乐（搜索 / 播放地址 / 热搜 / 账号登录）
  netease: {
    search: (keywords: string, offset = 0, limit = 30) =>
      ipcRenderer.invoke('netease:search', keywords, offset, limit),
    songUrl: (ids: number[], quality?: string, refresh?: boolean) =>
      ipcRenderer.invoke('netease:song-url', ids, quality, refresh),
    hotSearch: () => ipcRenderer.invoke('netease:hot-search'),
    loginQr: () => ipcRenderer.invoke('netease:login-qr'),
    loginQrCheck: (unikey: string) => ipcRenderer.invoke('netease:login-qr-check', unikey),
    loginStatus: () => ipcRenderer.invoke('netease:login-status'),
    switchAccount: (userId: string) => ipcRenderer.invoke('netease:switch-account', userId),
    logout: (userId?: string) => ipcRenderer.invoke('netease:logout', userId)
  },

  // 在线音频缓存（缓存目录管理 / 统计 / 清理）
  cache: {
    getInfo: () => ipcRenderer.invoke('audio:get-cache-info'),
    setDir: (dir: string) => ipcRenderer.invoke('audio:set-cache-dir', dir),
    clear: () => ipcRenderer.invoke('audio:clear-cache')
  },

  // 系统媒体控制（三端通用：Windows SMTC / macOS Now Playing / Linux MPRIS）
  mediaControl: {
    update: (status: MediaControlStatus) => ipcRenderer.send('media-control:update', status),
    getStatus: () => ipcRenderer.invoke('media-control:get-status'),
    onCommand: (cb) => {
      const handler = (_event: any, payload: { command: MediaControlCommand; value?: number }) => cb(payload)
      // 保存包装后的 handler 引用，供 offCommand 精确移除对应监听器
      ;(cb as any)._mediaControlHandler = handler
      ipcRenderer.on('media-control:command', handler)
    },
    offCommand: (cb) => {
      ipcRenderer.removeListener('media-control:command', (cb as any)._mediaControlHandler || cb)
    }
  },

  updater: {
    /**
     * 检查更新
     * @param channel 更新通道，'stable' 或 'beta'
     * @returns 更新检查结果
     */
    check: (channel: 'stable' | 'beta') => ipcRenderer.invoke('update:check', channel),
    /**
     * 下载更新包
     * @param url 更新包下载链接
     * @returns 下载结果
     */
    download: (url: string) => ipcRenderer.invoke('update:download', url),
    /**
     * 安装更新
     * @param filePath 更新包本地路径（可选）
     * @returns 安装结果
     */
    install: (filePath?: string) => ipcRenderer.invoke('update:install', filePath),
    /**
     * 获取当前应用版本号
     * @returns 当前版本号
     */
    getCurrentVersion: () => ipcRenderer.invoke('update:getCurrentVersion'),
    /**
     * 清理下载的更新包
     * @returns 清理结果
     */
    cleanup: () => ipcRenderer.invoke('update:cleanup'),
    /**
     * 监听下载进度
     * @param callback 进度回调函数
     */
    onProgress: (
      callback: (progress: {
        downloaded: number
        total: number
        percent: number
        speed: number
      }) => void
    ) => {
      const wrapper = (
        _event: any,
        progress: { downloaded: number; total: number; percent: number; speed: number }
      ) => callback(progress)
      ;(callback as any).__updateProgressWrapper = wrapper
      ipcRenderer.on('update:progress', wrapper)
    },
    /**
     * 移除下载进度监听
     * @param callback 进度回调函数
     */
    offProgress: (
      callback: (progress: {
        downloaded: number
        total: number
        percent: number
        speed: number
      }) => void
    ) => {
      const wrapper = (callback as any).__updateProgressWrapper
      if (wrapper) {
        ipcRenderer.removeListener('update:progress', wrapper)
      }
    },
    /**
     * 监听自动检查结果
     * @param callback 结果回调函数
     */
    onAutoCheckResult: (callback: (result: any) => void) => {
      const wrapper = (_event: any, result: any) => callback(result)
      ;(callback as any).__updateAutoCheckWrapper = wrapper
      ipcRenderer.on('update:autoCheckResult', wrapper)
    },
    /**
     * 移除自动检查结果监听
     * @param callback 结果回调函数
     */
    offAutoCheckResult: (callback: (result: any) => void) => {
      const wrapper = (callback as any).__updateAutoCheckWrapper
      if (wrapper) {
        ipcRenderer.removeListener('update:autoCheckResult', wrapper)
      }
    }
  },

  // ========== 插件系统 ==========
  plugins: {
    /** 加载插件 */
    load: (filePath: string) => ipcRenderer.invoke('plugin:load', filePath),
    /** 移除插件 */
    remove: (pluginId: string) => ipcRenderer.invoke('plugin:remove', pluginId),
    /** 设置活跃插件 */
    setActive: (pluginId: string | null) => ipcRenderer.invoke('plugin:set-active', pluginId),
    /** 调用插件方法 */
    call: (pluginId: string, methodName: string, ...args: any[]) =>
      ipcRenderer.invoke('plugin:call', pluginId, methodName, ...args),
    /** 检查插件更新 */
    checkUpdate: (pluginId: string) => ipcRenderer.invoke('plugin:check-update', pluginId),
    /** 获取已加载插件列表 */
    list: () => ipcRenderer.invoke('plugin:list'),
    /** 选择插件文件 */
    selectFile: () => ipcRenderer.invoke('plugin:select-file'),
    /** 选择目录 */
    selectDirectory: () => ipcRenderer.invoke('plugin:select-directory'),

    // ========== 事件监听 ==========
    /** 监听插件通知 */
    onNotice: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('plugin:notice', handler)
      return () => {
        ipcRenderer.removeListener('plugin:notice', handler)
      }
    },
    /** 监听插件日志 */
    onLog: (callback: (level: string, ...args: any[]) => void) => {
      const handler = (_event: any, level: string, ...args: any[]) => callback(level, ...args)
      ipcRenderer.on('plugin:log', handler)
      return () => {
        ipcRenderer.removeListener('plugin:log', handler)
      }
    },
    /** 监听敏感操作确认请求 */
    onConfirmRequest: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on('plugin:request-confirm', handler)
      return () => {
        ipcRenderer.removeListener('plugin:request-confirm', handler)
      }
    },
    /** 监听批量敏感操作确认请求 */
    onBatchConfirmRequest: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on('plugin:request-batch-confirm', handler)
      return () => {
        ipcRenderer.removeListener('plugin:request-batch-confirm', handler)
      }
    },
    /** 响应敏感操作确认 */
    respondConfirm: (response: { requestId: string; confirmed: boolean; skipSession: boolean }) =>
      ipcRenderer.invoke('plugin:confirm-response', response),
    /** 响应批量敏感操作确认 */
    respondBatchConfirm: (response: {
      requestId: string
      confirmed: boolean
      rejectedOpIds?: string[]
      skipSession: boolean
    }) => ipcRenderer.invoke('plugin:batch-confirm-response', response),
    /** 监听插件 emit 事件 */
    onEmit: (callback: (data: { pluginId: string; eventName: string; args: any[] }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('plugin:emit', handler)
      return () => {
        ipcRenderer.removeListener('plugin:emit', handler)
      }
    },
    /** 监听插件 props 变更（setProps 触发） */
    onPropsChanged: (
      callback: (data: { pluginId: string; props: Record<string, any> }) => void
    ) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('plugin:props-changed', handler)
      return () => {
        ipcRenderer.removeListener('plugin:props-changed', handler)
      }
    },

    // ========== 歌单操作 ==========
    /** 监听歌单操作请求 */
    onPlaylistOp: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on('plugin:playlist-op', handler)
      return () => {
        ipcRenderer.removeListener('plugin:playlist-op', handler)
      }
    },
    /** 响应歌单操作 */
    respondPlaylistOp: (response: any) =>
      ipcRenderer.invoke('plugin:playlist-op-response', response)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as any).electron = electronAPI
  ;(window as any).api = api
}
