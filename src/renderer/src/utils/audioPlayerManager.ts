import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { webAudioOutputEngine } from '../audio/web-audio-engine'
import { audioEngine } from '../audio/audio-engine'

interface PlayAudioOptions {
  url?: string
  filePath?: string
  volume?: number
}

/** 检测当前是否为 Web Audio 输出模式 */
function isWebAudioMode(): boolean {
  try {
    const settingsStore = useSettingsStore()
    return settingsStore.playback.audioOutputMode === 'webaudio'
  } catch {
    return false
  }
}

/**
 * 音频播放器管理器
 * 协调 Rust 音频引擎进行音频播放（WASAPI / Web Audio）
 */
export class AudioPlayerManager {
  // 播放队列，防止并发播放
  private static playQueue: Promise<void> = Promise.resolve()

  private static getApi() {
    return (window as any).api?.audioEngine
  }

  /**
   * 统一播放入口
   * @param options 播放选项
   */
  static async play(options: PlayAudioOptions): Promise<void> {
    return this.playQueue = this.playQueue.then(() => this.handleAudio(options, true))
  }

  /**
   * 加载音频但不播放
   */
  static async load(options: PlayAudioOptions): Promise<void> {
    return this.playQueue = this.playQueue.then(() => this.handleAudio(options, false))
  }

  private static async handleAudio(options: PlayAudioOptions, autoPlay: boolean): Promise<void> {
    const { url, filePath, volume } = options
    const playerStore = usePlayerStore()
    const api = this.getApi()

    if (!api) {
      throw new Error('[AudioPlayerManager] 音频引擎 API 不可用')
    }

    const vol = volume ?? playerStore.volume

    // 停止当前播放
    await audioEngine.stop()
    await audioEngine.setVolume(vol)

    // 解析文件路径
    let targetPath = filePath
    if (url && !targetPath) {
      if (window.electron && window.electron.ipcRenderer) {
        try {
          targetPath = await window.electron.ipcRenderer.invoke('audio:download-to-temp', url)
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
    console.log(`[AudioPlayerManager] ${autoPlay ? 'Playing' : 'Loading'} from:`, targetPath)
    const loadResult = await api.load(targetPath)

    // 使用解码器返回的真实时长更新 store，确保 seek 位置准确（元数据时长可能与实际不符）
    if (loadResult?.trackInfo?.durationMs && playerStore.currentSong) {
      playerStore.setDuration(loadResult.trackInfo.durationMs)
    }

    if (autoPlay) {
      await api.play()
      playerStore.setPlaying(true)
    }
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
    console.log(`[AudioPlayerManager] Web Audio: decoding via browser...`)
    const buf = readResult.data!.buffer.slice(
      readResult.data!.byteOffset,
      readResult.data!.byteOffset + readResult.data!.byteLength
    )
    const ok = await webAudioOutputEngine.loadFromArrayBuffer(buf)
    if (!ok) {
      console.error('[AudioPlayerManager] Web Audio: decode failed')
      return
    }
    console.log(`[AudioPlayerManager] Web Audio: decoded ${webAudioOutputEngine.sampleRate}Hz ${webAudioOutputEngine.channels}ch ${webAudioOutputEngine.getDurationMs()}ms`)

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
