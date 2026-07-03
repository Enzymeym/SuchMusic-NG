import { rustAudioAdapter } from '../audio/rust-audio-adapter'
import { usePlayerStore } from '../stores/playerStore'
import { computeSmartTransition, getStrategyLabel } from '../audio/audio-analyzer'

interface PlayAudioOptions {
  url?: string
  filePath?: string
  volume?: number
}

/**
 * 音频播放器管理器
 * 协调 Rust 音频引擎和 Web Audio API 进行音频播放
 */
export class AudioPlayerManager {
  // 播放锁，防止并发播放
  private static isPlayingAudio = false

  /**
   * 统一播放入口
   * 优先尝试播放本地文件/缓存文件，如果失败或无文件则尝试播放 URL
   * @param options 播放选项
   * @param useTransition 是否使用智能过渡
   */
  static async play(options: PlayAudioOptions): Promise<void> {
    // 防止并发播放
    if (this.isPlayingAudio) {
      console.log('[AudioPlayerManager] 正在播放音频，跳过重复请求')
      return
    }
    this.isPlayingAudio = true

    try {
      await this.handleAudio(options, true)
    } finally {
      this.isPlayingAudio = false
    }
  }

  /**
   * 加载音频但不播放
   */
  static async load(options: PlayAudioOptions): Promise<void> {
    // 防止并发播放
    if (this.isPlayingAudio) {
      console.log('[AudioPlayerManager] 正在播放音频，跳过重复请求')
      return
    }
    this.isPlayingAudio = true

    try {
      await this.handleAudio(options, false)
    } finally {
      this.isPlayingAudio = false
    }
  }

  private static async handleAudio(options: PlayAudioOptions, autoPlay: boolean): Promise<void> {
    const { url, filePath, volume } = options
    const playerStore = usePlayerStore()

    // 设置音量（如果未提供，使用 store 中的音量）
    const vol = volume ?? playerStore.volume

    // 检查是否应该使用交叉渐入渐出过渡
    const shouldCrossfade = autoPlay
      && playerStore.transitionEnabled
      && rustAudioAdapter.isCurrentlyPlaying()

    if (shouldCrossfade) {
      // 加载新音频数据为 AudioBuffer（不停止当前播放）
      const audioBuffer = await this.loadAudioAsBuffer(filePath, url)
      if (audioBuffer) {
        rustAudioAdapter.setVolume(vol)

        // 判断是否使用智能模式：分析音频内容确定最优过渡参数
        const isSmartMode = playerStore.transitionType === 'smart'

        if (isSmartMode) {
          const currentBuffer = rustAudioAdapter.getCurrentAudioBuffer()
          if (currentBuffer) {
            const result = computeSmartTransition(currentBuffer, audioBuffer)
            const currentPositionMs = playerStore.positionMs

            console.log(
              `[AudioPlayerManager] 智能过渡: 策略=${getStrategyLabel(result.strategy)}, ` +
              `起始位置=${result.startPositionMs.toFixed(0)}ms, ` +
              `过渡=${result.transitionDurationMs}ms, ` +
              `质量=${(result.quality * 100).toFixed(0)}%`
            )

            if (currentPositionMs >= result.startPositionMs) {
              // 起始位置已过，立即执行交叉过渡
              await rustAudioAdapter.crossfadeToBuffer(audioBuffer, result.transitionDurationMs)
            } else {
              // 调度主动交叉过渡，适配器的位置定时器会在到达 startPositionMs 时触发
              rustAudioAdapter.schedulePendingTransition(
                audioBuffer,
                result.transitionDurationMs,
                result.startPositionMs
              )
            }
            return
          }
        }

        // 非智能模式 或 无当前缓冲区时：基于剩余时间计算等待
        const currentSong = playerStore.currentSong
        const remainingMs = Math.max(0, (currentSong?.durationMs ?? 0) - playerStore.positionMs)
        const configuredTransition = playerStore.transitionDuration
        const effectiveTransition = Math.min(configuredTransition, Math.max(remainingMs - 200, 100))
        const waitMs = Math.max(0, remainingMs - effectiveTransition)

        if (waitMs > 0) {
          playerStore.setTransitioning(true)
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }

        await rustAudioAdapter.crossfadeToBuffer(audioBuffer, effectiveTransition)
        return
      }
      // 如果预加载失败，回退到正常播放流程
    }

    // 正常播放流程：先停止旧音频，再加载新音频
    rustAudioAdapter.clearPendingTransition()
    rustAudioAdapter.stop()
    rustAudioAdapter.setVolume(vol)

    // 1. 尝试本地文件（filePath）
    if (filePath && window.electron && window.electron.ipcRenderer) {
      try {
        // 先检查文件是否存在
        const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', filePath)
        if (exists) {
          console.log(`[AudioPlayerManager] ${autoPlay ? 'Playing' : 'Loading'} from local file:`, filePath)
          const data = (await window.electron.ipcRenderer.invoke(
            'audio:load-file',
            filePath
          )) as ArrayBuffer
          
          if (autoPlay) {
            await rustAudioAdapter.playFromFileData(data)
          } else {
            // 仅加载但不播放，避免在恢复状态等场景下自动开始播放
            await rustAudioAdapter.loadFromFileData(data, false)
          }
          return
        } else {
          console.warn('[AudioPlayerManager] Local file not found:', filePath)
        }
      } catch (e) {
        console.error('[AudioPlayerManager] Failed to handle local file, fallback to URL:', e)
        // 失败后继续尝试 URL
      }
    }

    // 2. 尝试在线 URL
    if (url) {
      console.log(`[AudioPlayerManager] ${autoPlay ? 'Playing' : 'Loading'} from URL:`, url)
      
      try {
        if (autoPlay) {
          await rustAudioAdapter.playFromUrl(url)
        } else {
          // 仅加载但不播放，避免在恢复状态等场景下自动开始播放
          await rustAudioAdapter.loadFromUrl(url, false)
        }
      } catch (e) {
        console.error('[AudioPlayerManager] Failed to handle URL:', e)
        throw e
      }
    } else {
      throw new Error('[AudioPlayerManager] No valid source (filePath or url) provided')
    }
  }

  /**
   * 仅加载音频数据并解码为 AudioBuffer，不播放
   * 用于交叉渐入渐出过渡时预加载新音频
   * @param filePath 本地文件路径
   * @param url 在线音频 URL
   * @returns 解码后的 AudioBuffer，加载失败返回 null
   */
  private static async loadAudioAsBuffer(
    filePath?: string,
    url?: string
  ): Promise<AudioBuffer | null> {
    // 优先尝试本地文件
    if (filePath && window.electron && window.electron.ipcRenderer) {
      try {
        const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', filePath)
        if (exists) {
          console.log('[AudioPlayerManager] 预加载本地文件用于交叉过渡:', filePath)
          const data = (await window.electron.ipcRenderer.invoke(
            'audio:load-file',
            filePath
          )) as ArrayBuffer
          return await rustAudioAdapter.decodeAudioData(data)
        }
      } catch (e) {
        console.error('[AudioPlayerManager] 预加载本地文件失败:', e)
      }
    }

    // 尝试在线 URL
    if (url) {
      try {
        console.log('[AudioPlayerManager] 预加载在线音频用于交叉过渡:', url.substring(0, 100))
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
        const data = await response.arrayBuffer()
        return await rustAudioAdapter.decodeAudioData(data)
      } catch (e) {
        console.error('[AudioPlayerManager] 预加载在线音频失败:', e)
      }
    }

    return null
  }

  /**
   * 暂停播放
   */
  static async pause(): Promise<void> {
    await rustAudioAdapter.pause()
  }

  /**
   * 恢复播放
   */
  static async resume(): Promise<void> {
    await rustAudioAdapter.play()
  }

  /**
   * 停止播放
   */
  static stop(): void {
    rustAudioAdapter.stop()
  }

  /**
   * 跳转到指定位置
   * @param positionMs 位置（毫秒）
   */
  static seek(positionMs: number): void {
    rustAudioAdapter.seek(positionMs)
  }

  /**
   * 设置音量
   * @param volume 音量（0.0 - 1.0）
   */
  static setVolume(volume: number): void {
    rustAudioAdapter.setVolume(volume)
  }

  /**
   * 获取当前音量
   */
  static getVolume(): number {
    return rustAudioAdapter.getVolume()
  }

  /**
   * 淡出并停止
   * @param durationMs 淡出时长（毫秒）
   */
  static async fadeOutAndStop(durationMs: number): Promise<void> {
    await rustAudioAdapter.fadeOutAndStop(durationMs)
  }

  /**
   * 检查是否正在播放
   */
  static isPlaying(): boolean {
    return rustAudioAdapter.isPlaying()
  }

  /**
   * 获取当前播放位置
   * @returns 当前播放位置（毫秒）
   */
  static async getCurrentPosition(): Promise<number> {
    return await rustAudioAdapter.getCurrentPosition()
  }

  /**
   * 设置播放结束回调
   * @param callback 回调函数
   */
  static setOnEndedCallback(callback: () => void): void {
    rustAudioAdapter.setOnEndedCallback(callback)
  }

  /**
   * 移除播放结束回调
   */
  static removeOnEndedCallback(): void {
    rustAudioAdapter.removeOnEndedCallback()
  }
}
