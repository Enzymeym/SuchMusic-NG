import { usePlayerStore } from '../stores/playerStore'
import { webAudioOutputEngine } from '../audio/web-audio-engine'
import { audioEngine } from '../audio/audio-engine'
import { isWebAudioMode } from './audioOutputModeManager'

interface PlayAudioOptions {
  url?: string
  filePath?: string
  volume?: number
}

/**
 * 音频播放器管理器
 * 协调 Rust 音频引擎进行音频播放（WASAPI / Web Audio）
 */
export class AudioPlayerManager {
  // 播放队列，防止并发播放
  private static playQueue: Promise<void> = Promise.resolve()

  // 上一首临时文件路径，用于切歌时清理
  private static lastTempPath: string | null = null

  private static getApi() {
    return (window as any).api?.audioEngine
  }

  /**
   * 统一播放入口
   * @param options 播放选项
   */
  static async play(options: PlayAudioOptions): Promise<void> {
    const prev = this.playQueue.catch(() => {})
    return this.playQueue = prev.then(() => this.handleAudio(options, true))
  }

  /**
   * 加载音频但不播放
   */
  static async load(options: PlayAudioOptions): Promise<void> {
    const prev = this.playQueue.catch(() => {})
    return this.playQueue = prev.then(() => this.handleAudio(options, false))
  }

  private static async handleAudio(options: PlayAudioOptions, autoPlay: boolean): Promise<void> {
    const { url, filePath, volume } = options
    const playerStore = usePlayerStore()
    const api = this.getApi()

    if (!api) {
      throw new Error('[AudioPlayerManager] 音频引擎 API 不可用')
    }

    const vol = volume ?? playerStore.volume

    // WASAPI 顺序淡入淡出降级：过渡启用且实际播放时，先淡出当前曲再加载新曲
    // （Web Audio 模式的过渡由 TransitionController 调度，此处仍走即时停止）
    const fadeOnWASAPI = !isWebAudioMode() && autoPlay && playerStore.transitionEnabled

    // 停止当前播放并清理上一首临时文件（淡入淡出场景延迟到 WASAPI 分支处理）
    if (!fadeOnWASAPI) {
      await audioEngine.stop()
    }
    await audioEngine.setVolume(vol)

    // 清理上一首通过 URL 下载的临时文件
    if (this.lastTempPath && window.electron?.ipcRenderer) {
      const pathToClean = this.lastTempPath
      this.lastTempPath = null
      window.electron.ipcRenderer.invoke('audio:cleanup-temp', pathToClean).catch(() => {})
    }

    // 解析文件路径
    let targetPath = filePath
    if (url && !targetPath) {
      if (window.electron && window.electron.ipcRenderer) {
        try {
          // 主进程缓存优先：命中缓存时直接返回本地路径，跳过网络下载，加快二次播放
          const result = (await window.electron.ipcRenderer.invoke(
            'audio:get-online-audio',
            url
          )) as string | { path: string; cached: boolean }
          targetPath = typeof result === 'string' ? result : result.path
          // 仅缓存未命中时产生的临时文件参与切歌清理；缓存文件由主进程淘汰策略管理
          if (result && typeof result === 'object' && !result.cached) {
            this.lastTempPath = targetPath
          }
        } catch (e) {
          console.error('[AudioPlayerManager] Failed to download URL:', e)
        }
      }
      if (!targetPath) {
        throw new Error('[AudioPlayerManager] Failed to download audio from URL')
      }
    }

    if (!targetPath) {
      throw new Error('[AudioPlayerManager] No valid source (filePath or url) provided')
    }

    // 验证本地文件存在
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', targetPath)
        if (!exists) {
          console.warn('[AudioPlayerManager] Local file not found:', targetPath)
          throw new Error(`文件不存在: ${targetPath}`)
        }
      } catch (e: any) {
        if (e.message?.includes('文件不存在')) throw e
      }
    }

    // ====== Web Audio 模式 ======
    if (isWebAudioMode()) {
      await this.handleWebAudio(targetPath, vol, autoPlay, playerStore)
      return
    }

    // ====== WASAPI 模式（现有 Rust 引擎路径）======
    if (fadeOnWASAPI) {
      // 顺序淡入淡出：显示过渡提示，先淡出当前曲再加载新曲
      playerStore.setTransitioning(true)
    }
    try {
      if (fadeOnWASAPI) {
        // 顺序淡入淡出：仅当旧曲仍在播放时淡出（自然结束时引擎已停止，直接跳过）
        const playing = await audioEngine.isCurrentlyPlaying()
        if (playing) {
          await audioEngine.fadeOutAndStop(playerStore.transitionDuration)
        } else {
          await audioEngine.stop()
        }
      }

      console.log(`[AudioPlayerManager] ${autoPlay ? 'Playing' : 'Loading'} from:`, targetPath)
      const loadResult = await api.load(targetPath)

      // 使用解码器返回的真实时长更新 store，确保 seek 位置准确（元数据时长可能与实际不符）
      if (loadResult?.trackInfo?.durationMs && playerStore.currentSong) {
        playerStore.setDuration(loadResult.trackInfo.durationMs)
      }

      if (autoPlay) {
        if (fadeOnWASAPI) {
          // 从静音开始播放，再顺序淡入到目标音量
          await audioEngine.setVolume(0)
          await api.play()
          playerStore.setPlaying(true)
          await this.fadeInVolume(vol, playerStore.transitionDuration)
        } else {
          await api.play()
          playerStore.setPlaying(true)
        }
      }
    } finally {
      // 无论成功与否都复位过渡提示，避免指示器卡在"过渡中"
      if (fadeOnWASAPI) playerStore.setTransitioning(false)
    }
  }

  /**
   * WASAPI 顺序淡入：音量从 0 渐变到目标值（配合 fadeOutAndStop 组成顺序淡入淡出）
   * @param targetVolume 目标音量（0.0 - 1.0）
   * @param durationMs 淡入时长（毫秒）
   */
  private static async fadeInVolume(targetVolume: number, durationMs: number): Promise<void> {
    const steps = 10
    const stepDelay = Math.max(20, durationMs / steps)
    for (let i = 1; i <= steps; i++) {
      await audioEngine.setVolume(targetVolume * (i / steps))
      await new Promise((resolve) => setTimeout(resolve, stepDelay))
    }
    await audioEngine.setVolume(targetVolume)
  }

  /**
   * Web Audio 模式播放（直接发送原始文件，浏览器原生解码）
   */
  private static async handleWebAudio(
    filePath: string,
    volume: number,
    autoPlay: boolean,
    playerStore: ReturnType<typeof usePlayerStore>
  ): Promise<void> {
    const api = this.getApi()
    if (!api) return

    // 1. 读取原始音频文件（主进程只做文件 I/O，不解码）
    console.log(`[AudioPlayerManager] Web Audio: reading file`, filePath)
    const readResult = await api.readAudioFile(filePath)
    if (!readResult || !readResult.success) {
      console.error('[AudioPlayerManager] Web Audio: read failed', readResult?.error)
      return
    }
    console.log(`[AudioPlayerManager] Web Audio: file read ${(readResult.data?.byteLength ?? 0) / 1024 / 1024} MB`)

    // 2. 浏览器原生解码（异步，硬件加速，极快）
    // 直接传递原始 ArrayBuffer 给解码器，无需 .slice() 创建副本
    // decodeAudioData 内部会复制数据，额外的拷贝纯属浪费
    console.log(`[AudioPlayerManager] Web Audio: decoding via browser...`)
    const buf = readResult.data!.buffer
    const ok = await webAudioOutputEngine.loadFromArrayBuffer(buf)
    // 立即释放 IPC 返回的大数据引用，帮助 GC 及时回收
    ;(readResult as any).data = null
    if (!ok) {
      console.error('[AudioPlayerManager] Web Audio: decode failed')
      return
    }
    console.log(`[AudioPlayerManager] Web Audio: decoded ${webAudioOutputEngine.sampleRate}Hz ${webAudioOutputEngine.channels}ch ${webAudioOutputEngine.getDurationMs()}ms`)

    // 用解码结果补齐真实时长（元数据缺失时进度与智能过渡依赖该值）
    if (playerStore.currentSong) {
      playerStore.setDuration(webAudioOutputEngine.getDurationMs())
    }

    // 3. 播放（通过 audioEngine 设置音量以应用音量增强）
    await audioEngine.setVolume(volume)
    if (autoPlay) {
      webAudioOutputEngine.play()
      playerStore.setPlaying(true)
    }
  }

  /**
   * 暂停播放
   */
  static async pause(): Promise<void> {
    await audioEngine.pause()
  }

  /**
   * 恢复播放
   */
  static async resume(): Promise<void> {
    await audioEngine.play()
  }

  /**
   * 停止播放
   */
  static async stop(): Promise<void> {
    await audioEngine.stop()
  }

  /**
   * 跳转到指定位置
   * @param positionMs 位置（毫秒）
   */
  static async seek(positionMs: number): Promise<void> {
    await audioEngine.seek(positionMs)
  }

  /**
   * 设置音量
   * @param volume 音量（0.0 - 1.0）
   */
  static async setVolume(volume: number): Promise<void> {
    await audioEngine.setVolume(volume)
  }

  /**
   * 获取当前音量
   */
  static async getVolume(): Promise<number> {
    return await audioEngine.getVolume()
  }

  /**
   * 淡出并停止
   * @param durationMs 淡出时长（毫秒）
   */
  static async fadeOutAndStop(durationMs: number): Promise<void> {
    await audioEngine.fadeOutAndStop(durationMs)
  }

  /**
   * 检查是否正在播放
   */
  static async isPlaying(): Promise<boolean> {
    return await audioEngine.isCurrentlyPlaying()
  }

  /**
   * 获取当前播放位置
   * @returns 当前播放位置（毫秒）
   */
  static async getCurrentPosition(): Promise<number> {
    return await audioEngine.getCurrentPosition()
  }

  /**
   * 设置播放结束回调
   * @param callback 回调函数
   */
  static setOnEndedCallback(callback: () => void): void {
    audioEngine.setOnEndedCallback(callback)
  }

  /**
   * 移除播放结束回调
   */
  static removeOnEndedCallback(): void {
    audioEngine.removeOnEndedCallback()
  }
}
