import type { DecodedAudio } from '../apis/audio-decoder.types'
import { rustAudioAdapter } from './rust-audio-adapter'

/**
 * Web Audio 引擎
 * 保持原有接口不变，内部使用 Rust 音频引擎适配器
 * 
 * 注意：音效处理（EQ、压缩器、限制器）现在通过 useAudioEngine composable 
 * 使用 Rust 音频引擎处理，此类主要负责音频播放功能
 */
class WebAudioEngine {
  // 委托给 Rust 音频适配器
  
  // 确保 AudioContext 初始化
  public ensureContext(): void {
    rustAudioAdapter.ensureContext()
  }

  // 停止当前播放
  public stop(): void {
    rustAudioAdapter.stop()
  }

  // 淡出并停止
  public async fadeOutAndStop(durationMs: number): Promise<void> {
    await rustAudioAdapter.fadeOutAndStop(durationMs)
  }

  // 暂停播放
  public async pause(): Promise<void> {
    await rustAudioAdapter.pause()
  }

  // 恢复播放
  public async play(): Promise<boolean> {
    return await rustAudioAdapter.play()
  }

  // 仅恢复 AudioContext
  public async resume(): Promise<void> {
    await rustAudioAdapter.resume()
  }

  /**
   * 跳转到指定位置
   * @param positionMs 目标位置（毫秒）
   * @param startPlaying 是否启动播放，默认为 true
   */
  public seek(positionMs: number, startPlaying: boolean = true): void {
    rustAudioAdapter.seek(positionMs, startPlaying)
  }

  // 设置播放结束回调
  public setOnEndedCallback(callback: () => void): void {
    rustAudioAdapter.setOnEndedCallback(callback)
  }

  // 移除播放结束回调
  public removeOnEndedCallback(): void {
    rustAudioAdapter.removeOnEndedCallback()
  }

  // 设置全局音量（0.0 - 1.0）
  public setVolume(volume: number): void {
    rustAudioAdapter.setVolume(volume)
  }

  /**
   * 设置播放速度倍率
   * @param rate 播放速度倍率（0.25 - 4.0）
   */
  public setPlaybackRate(rate: number): void {
    rustAudioAdapter.setPlaybackRate(rate)
  }

  /**
   * 交叉渐入渐出过渡到新的音频缓冲区
   * @param audioBuffer 新的音频缓冲区
   * @param durationMs 过渡时长（毫秒）
   */
  public async crossfadeToBuffer(audioBuffer: AudioBuffer, durationMs: number): Promise<void> {
    await rustAudioAdapter.crossfadeToBuffer(audioBuffer, durationMs)
  }

  /**
   * 仅解码音频数据，不播放
   * @param data 音频文件 ArrayBuffer
   * @returns 解码后的 AudioBuffer
   */
  public async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return await rustAudioAdapter.decodeAudioData(data)
  }

  /**
   * 检查当前是否正在播放
   * @returns 是否正在播放
   */
  public isCurrentlyPlaying(): boolean {
    return rustAudioAdapter.isCurrentlyPlaying()
  }

  /**
   * 获取当前正在播放的 AudioBuffer，用于音频分析
   * @returns 当前音频缓冲区，无缓冲区时返回 null
   */
  public getCurrentAudioBuffer(): AudioBuffer | null {
    return rustAudioAdapter.getCurrentAudioBuffer()
  }

  /**
   * 调度主动交叉过渡
   * @param nextBuffer 下一首 AudioBuffer
   * @param transitionDurationMs 过渡时长（毫秒）
   * @param startPositionMs 起始位置（毫秒）
   */
  public schedulePendingTransition(
    nextBuffer: AudioBuffer,
    transitionDurationMs: number,
    startPositionMs: number
  ): void {
    rustAudioAdapter.schedulePendingTransition(nextBuffer, transitionDurationMs, startPositionMs)
  }

  /**
   * 清除待定交叉过渡
   */
  public clearPendingTransition(): void {
    rustAudioAdapter.clearPendingTransition()
  }

  // 配置压限器强度
  public async setLimiterStrength(strength: number): Promise<void> {
    const api = (window as any).api?.audioEngine
    if (!api) return

    // 检查引擎是否已初始化
    const state = await api.getState().catch(() => null)
    if (!state) return

    // 根据强度设置限制器参数
    if (strength > 0) {
      await api.setLimiterEnabled(true)
      const ceiling = -0.3 - (strength * 2.7)
      await api.setLimiter({
        ceilingDb: Math.max(ceiling, -3),
        releaseMs: 50
      })
    } else {
      await api.setLimiterEnabled(false)
    }
  }

  // 设置均衡器启用状态
  public async setEqEnabled(enabled: boolean): Promise<void> {
    const api = (window as any).api?.audioEngine
    if (!api) return

    // 检查引擎是否已初始化
    const state = await api.getState().catch(() => null)
    if (!state) return

    await api.setEqEnabled(enabled)
  }

  // 设置均衡器各频段增益
  public async setEqGains(gains: number[]): Promise<void> {
    const api = (window as any).api?.audioEngine
    if (!api) return

    // 检查引擎是否已初始化
    const state = await api.getState().catch(() => null)
    if (!state) return

    // 将数组转换为普通数组以避免克隆错误
    await api.setEqGains([...gains])
  }

  // 使用解码好的 PCM 数据播放（已废弃，请使用 AudioPlayerManager）
  public async playDecodedAudio(decoded: DecodedAudio): Promise<void> {
    console.warn('[WebAudioEngine] playDecodedAudio is deprecated, use AudioPlayerManager instead')
    // 降级处理：使用原始数据播放
    this.ensureContext()
    const audioContext = (rustAudioAdapter as any).audioContext
    const gainNode = (rustAudioAdapter as any).gainNode
    
    if (!audioContext || !gainNode) return

    await this.fadeOutAndStop(200)

    const sampleRate = (decoded as any).sample_rate ?? (decoded as any).sampleRate
    const channels = decoded.channels
    const totalSamples = decoded.data.length
    const totalFrames = totalSamples / channels
    const maxFrames = Math.min(totalFrames, Math.floor((sampleRate || audioContext.sampleRate) * 1))

    const buffer = audioContext.createBuffer(channels, maxFrames, sampleRate || audioContext.sampleRate)

    for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
      const channelData = buffer.getChannelData(channelIndex)
      for (let frameIndex = 0; frameIndex < maxFrames; frameIndex++) {
        const sourceIndex = frameIndex * channels + channelIndex
        channelData[frameIndex] = decoded.data[sourceIndex] ?? 0
      }
    }

    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(gainNode)
    source.start()

    gainNode.gain.value = 0
    // 淡入
    const now = audioContext.currentTime
    gainNode.gain.setValueAtTime(0, now)
    gainNode.gain.linearRampToValueAtTime((rustAudioAdapter as any).volume || 1, now + 0.2)
  }

  // 使用原始文件二进制数据播放（已废弃，请使用 AudioPlayerManager）
  public async playFromFileData(data: ArrayBuffer): Promise<void> {
    console.warn('[WebAudioEngine] playFromFileData is deprecated, use AudioPlayerManager instead')
    await rustAudioAdapter.playFromFileData(data)
  }

  // 加载文件数据但不播放（已废弃，请使用 AudioPlayerManager）
  public async loadFromFileData(data: ArrayBuffer, startPlaying: boolean = true): Promise<void> {
    console.warn('[WebAudioEngine] loadFromFileData is deprecated, use AudioPlayerManager instead')
    await rustAudioAdapter.loadFromFileData(data, startPlaying)
  }

  // 通过 URL 播放音频（已废弃，请使用 AudioPlayerManager）
  public async playFromUrl(url: string): Promise<void> {
    console.warn('[WebAudioEngine] playFromUrl is deprecated, use AudioPlayerManager instead')
    await rustAudioAdapter.playFromUrl(url)
  }

  // 加载 URL 但不播放（已废弃，请使用 AudioPlayerManager）
  public async loadFromUrl(url: string, startPlaying: boolean = true): Promise<void> {
    console.warn('[WebAudioEngine] loadFromUrl is deprecated, use AudioPlayerManager instead')
    await rustAudioAdapter.loadFromUrl(url, startPlaying)
  }

  // 开始流式播放会话（已废弃）
  public startStream(_sampleRate: number, _channels: number): void {
    console.warn('[WebAudioEngine] startStream is deprecated')
  }

  // 追加一块流式解码得到的 PCM 数据（已废弃）
  public appendStreamChunk(_chunk: {
    sampleRate: number
    channels: number
    data: number[]
    finished?: boolean
  }): void {
    console.warn('[WebAudioEngine] appendStreamChunk is deprecated')
  }

  // 预加载下一首歌曲（已废弃，请使用 AudioPlayerManager）
  public async preloadNextSong(_song: any): Promise<void> {
    console.warn('[WebAudioEngine] preloadNextSong is deprecated, use AudioPlayerManager instead')
    // 简单实现：只记录预加载状态
  }

  // 清除预加载资源（已废弃）
  public clearPreload(): void {
    console.warn('[WebAudioEngine] clearPreload is deprecated')
  }

  // 检查是否有预加载的歌曲（已废弃）
  public hasPreloadedSong(): boolean {
    console.warn('[WebAudioEngine] hasPreloadedSong is deprecated')
    return false
  }

  // 获取预加载的歌曲（已废弃）
  public getPreloadedSong(): any {
    console.warn('[WebAudioEngine] getPreloadedSong is deprecated')
    return null
  }

  // 播放预加载的歌曲（已废弃）
  public async playPreloadedSong(): Promise<void> {
    console.warn('[WebAudioEngine] playPreloadedSong is deprecated')
  }

  // 添加预加载状态回调（已废弃）
  public addPreloadCallback(_callback: (status: 'loading' | 'loaded' | 'error', error?: string) => void): void {
    console.warn('[WebAudioEngine] addPreloadCallback is deprecated')
  }

  // 移除预加载状态回调（已废弃）
  public removePreloadCallback(_callback: (status: 'loading' | 'loaded' | 'error', error?: string) => void): void {
    console.warn('[WebAudioEngine] removePreloadCallback is deprecated')
  }

  // 设置过渡功能启用状态（已废弃）
  public setTransitionEnabled(_enabled: boolean): void {
    console.warn('[WebAudioEngine] setTransitionEnabled is deprecated')
  }

  // 设置过渡时长（已废弃）
  public setTransitionDuration(_duration: number): void {
    console.warn('[WebAudioEngine] setTransitionDuration is deprecated')
  }

  // 设置过渡效果类型（已废弃）
  public setTransitionType(_type: 'crossfade' | 'fade' | 'smart'): void {
    console.warn('[WebAudioEngine] setTransitionType is deprecated')
  }

  // 获取当前过渡状态（已废弃）
  public getTransitionStatus(): {
    enabled: boolean
    isTransitioning: boolean
    duration: number
    type: 'crossfade' | 'fade' | 'smart'
  } {
    console.warn('[WebAudioEngine] getTransitionStatus is deprecated')
    return {
      enabled: false,
      isTransitioning: false,
      duration: 0,
      type: 'fade'
    }
  }

  // 执行智能过渡（已废弃）
  public async performTransition(nextSong: () => Promise<void>, callback?: () => void): Promise<void> {
    console.warn('[WebAudioEngine] performTransition is deprecated')
    await nextSong()
    callback?.()
  }

  // 分析音频特征（已废弃）
  public analyzeAudioFeatures(_buffer: AudioBuffer): {
    energy: number
    tempo: number
    key: number
    loudness: number
  } {
    console.warn('[WebAudioEngine] analyzeAudioFeatures is deprecated')
    return {
      energy: 0,
      tempo: 120,
      key: 0,
      loudness: -20
    }
  }

  // 基于音频特征计算最佳过渡点（已废弃）
  public calculateTransitionPoint(
    _currentFeatures: { energy: number; tempo: number; key: number; loudness: number },
    _nextFeatures: { energy: number; tempo: number; key: number; loudness: number }
  ): {
    fadeInDuration: number
    fadeOutDuration: number
    crossfadeDuration: number
  } {
    console.warn('[WebAudioEngine] calculateTransitionPoint is deprecated')
    return {
      fadeInDuration: 1,
      fadeOutDuration: 1,
      crossfadeDuration: 2
    }
  }
}

// 导出全局单例
export const webAudioEngine = new WebAudioEngine()
export { rustAudioAdapter }

// 默认导出
export default webAudioEngine
