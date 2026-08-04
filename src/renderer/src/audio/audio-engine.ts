/**
 * 音频引擎
 * 统一封装音频播放控制接口。根据当前输出模式自动选择后端：
 * - Web Audio 模式 → 委托给 WebAudioOutputEngine（本地 AudioContext）
 * - WASAPI 模式 → 委托给 Rust 引擎（IPC）
 *
 * 注意：音效处理（EQ、压缩器、限制器）已支持 Web Audio 模式。
 */

import { webAudioOutputEngine } from './web-audio-engine'
import { useSettingsStore } from '../stores/settingsStore'
import type {
  EqBandSettings,
  CompressorParams,
  LimiterParams,
  LoudnessParams,
  VirtualBassParams,
  SoftClipperParams
} from './web-audio-dsp'
import { WebAudioDspChain } from './web-audio-dsp'

/** 检测当前是否为 Web Audio 输出模式 */
function isWebAudioMode(): boolean {
  try {
    return useSettingsStore().playback.audioOutputMode === 'webaudio'
  } catch {
    return false
  }
}

class AudioEngine {
  private onEndedRef: (() => void) | null = null
  private currentVolume = 1.0
  private volumeBoost = 1.0
  /** 按曲补偿增益（dB，音量平衡功能），默认 0 */
  private trackGainDb = 0

  private getApi() {
    return (window as any).api?.audioEngine
  }

  /** 确保 Web Audio DSP 链已初始化（懒加载） */
  private ensureDspChain(): WebAudioDspChain | null {
    if (!webAudioOutputEngine.dspChain) {
      webAudioOutputEngine.dspChain = new WebAudioDspChain()
    }
    return webAudioOutputEngine.dspChain
  }

  /** 检查 Web Audio API 是否可用 */
  public isWebAudioAvailable(): boolean {
    try {
      return (
        typeof AudioContext !== 'undefined' ||
        typeof (window as any).webkitAudioContext !== 'undefined'
      )
    } catch {
      return false
    }
  }

  // 确保引擎初始化
  public async ensureContext(): Promise<void> {
    if (isWebAudioMode()) return // Web Audio 无需初始化 Rust 引擎
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) {
        await api.create?.()
      }
    } catch (err) {
      console.warn('[AudioEngine] ensureContext failed:', err)
    }
  }

  // 停止当前播放
  public async stop(): Promise<void> {
    if (isWebAudioMode()) {
      webAudioOutputEngine.stop()
      return
    }
    const api = this.getApi()
    if (!api) return
    await api.stop().catch((err) => {
      console.error('[AudioEngine] stop failed:', err)
    })
  }

  // 淡出并停止
  public async fadeOutAndStop(durationMs: number): Promise<void> {
    if (isWebAudioMode()) {
      const steps = 10
      const stepDelay = durationMs / steps
      const effectiveVol = this.currentVolume * this.volumeBoost
      for (let i = steps; i >= 0; i--) {
        webAudioOutputEngine.setVolume(effectiveVol * (i / steps))
        await new Promise((resolve) => setTimeout(resolve, stepDelay))
      }
      webAudioOutputEngine.stop()
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const currentVol = await api.getVolume().catch(() => 1)
      const steps = 10
      const stepDelay = durationMs / steps
      const volStep = currentVol / steps
      for (let i = steps; i >= 0; i--) {
        await api.setVolume(volStep * i)
        await new Promise((resolve) => setTimeout(resolve, stepDelay))
      }
      await api.stop()
      await api.setVolume(currentVol)
    } catch {
      await api.stop().catch((err) => {
        console.error('[AudioEngine] fadeOutAndStop cleanup failed:', err)
      })
    }
  }

  // 暂停播放
  public async pause(): Promise<void> {
    if (isWebAudioMode()) {
      webAudioOutputEngine.pause()
      return
    }
    const api = this.getApi()
    if (!api) return
    await api.pause().catch((err) => {
      console.error('[AudioEngine] pause failed:', err)
    })
  }

  // 恢复播放
  public async play(): Promise<boolean> {
    if (isWebAudioMode()) {
      // Web Audio: 暂停状态 → 恢复；否则视为全新播放（由 audioPlayerManager 触发）
      if (webAudioOutputEngine.isPaused) {
        webAudioOutputEngine.resume()
      } else if (!webAudioOutputEngine.isPlaying && webAudioOutputEngine.isReady) {
        // 引擎已加载但处于"非暂停、未播放"状态（歌曲自然结束 / stop 后）：
        // 从当前位置重新播放，避免 UI 显示播放中而引擎静默的卡死状态
        webAudioOutputEngine.play(webAudioOutputEngine.getPositionMs() / 1000)
      }
      return true
    }
    const api = this.getApi()
    if (!api) return false
    try {
      await api.play()
      return true
    } catch {
      return false
    }
  }

  // 恢复引擎
  public async resume(): Promise<void> {
    await this.play()
  }

  /**
   * 跳转到指定位置
   * @param positionMs 目标位置（毫秒）
   * @param startPlaying 是否启动播放，默认为 true
   */
  public async seek(positionMs: number, startPlaying: boolean = true): Promise<void> {
    if (isWebAudioMode()) {
      webAudioOutputEngine.seek(positionMs)
      if (startPlaying) {
        webAudioOutputEngine.play()
      }
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      if (startPlaying) {
        await api.seekAndPlay(positionMs)
      } else {
        await api.seek(positionMs)
      }
    } catch (err) {
      console.error('[AudioEngine] seek failed:', err)
    }
  }

  // 设置播放结束回调
  public setOnEndedCallback(callback: () => void): void {
    if (isWebAudioMode()) {
      webAudioOutputEngine.setOnEnded(callback)
      return
    }
    const api = this.getApi()
    if (!api) return
    this.onEndedRef = callback
    api.on('audio-engine:ended', callback)
  }

  // 移除播放结束回调
  public removeOnEndedCallback(): void {
    if (isWebAudioMode()) {
      webAudioOutputEngine.setOnEnded(null)
      return
    }
    const api = this.getApi()
    if (!api) return
    if (this.onEndedRef) {
      api.off('audio-engine:ended', this.onEndedRef)
      this.onEndedRef = null
    }
  }

  // 设置全局音量（0.0 - 1.0）
  public async setVolume(volume: number): Promise<void> {
    this.currentVolume = Math.max(0, Math.min(1, volume))
    await this.applyEffectiveVolume()
  }

  // 设置音量增强倍数（1.0 - 3.0）
  public async setVolumeBoost(boost: number): Promise<void> {
    this.volumeBoost = Math.max(1, Math.min(3, boost))
    await this.applyEffectiveVolume()
  }

  // 设置按曲补偿增益（dB，音量平衡功能），安全钳制到 ±24 dB
  public async setTrackGainDb(db: number): Promise<void> {
    this.trackGainDb = Math.max(-24, Math.min(24, db))
    await this.applyEffectiveVolume()
  }

  // 应用 effective gain = volume * boost * trackGain 到底层引擎
  private async applyEffectiveVolume(): Promise<void> {
    const trackGain = Math.pow(10, this.trackGainDb / 20)
    // 有效增益钳制在 [0.125, 4]，防止极端补偿导致爆音或无声
    const effectiveGain = Math.min(4, Math.max(0.125, this.currentVolume * this.volumeBoost * trackGain))
    if (isWebAudioMode()) {
      webAudioOutputEngine.setVolume(effectiveGain)
      return
    }
    const api = this.getApi()
    if (!api) return
    // WASAPI 引擎尚未创建（如应用启动早期 / 模式切换前）时静默跳过：
    // 音量值已记录在 currentVolume，引擎创建后、播放前会再次应用
    if (!api.getEngineId?.()) return
    await api.setVolume(effectiveGain).catch((err) => {
      console.error('[AudioEngine] setVolume failed:', err)
    })
  }

  /**
   * 设置播放速度倍率
   * @param rate 播放速度倍率（0.25 - 4.0）
   */
  public async setPlaybackRate(rate: number): Promise<void> {
    if (isWebAudioMode()) {
      // Web Audio 暂不支持变速
      return
    }
    const api = this.getApi()
    if (!api) return
    await api.setPlaybackRate?.(rate).catch((err) => {
      console.error('[AudioEngine] setPlaybackRate failed:', err)
    })
  }

  /**
   * 检查当前是否正在播放
   * @returns 是否正在播放
   */
  public async isCurrentlyPlaying(): Promise<boolean> {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.isPlaying
    }
    const api = this.getApi()
    if (!api) return false
    try {
      return await api.isPlaying()
    } catch {
      return false
    }
  }

  /**
   * 获取当前播放位置
   * @returns 当前播放位置（毫秒）
   */
  public async getCurrentPosition(): Promise<number> {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.getPositionMs()
    }
    const api = this.getApi()
    if (!api) return 0
    try {
      return await api.getPosition()
    } catch {
      return 0
    }
  }

  /**
   * 获取当前音量
   * @returns 当前音量（0.0 - 1.0）
   */
  public async getVolume(): Promise<number> {
    // Web Audio 模式不追踪单独音量值，由 GainNode 管理
    if (isWebAudioMode()) return 1
    const api = this.getApi()
    if (!api) return 1
    try {
      return await api.getVolume()
    } catch {
      return 1
    }
  }

  // 配置压限器强度
  public async setLimiterStrength(strength: number): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (!dsp) return
      if (strength > 0) {
        dsp.setLimiterEnabled(true)
        const ceiling = -0.3 - strength * 2.7
        dsp.setLimiterParams({
          ceiling: Math.max(ceiling, -3),
          release: 50
        })
      } else {
        dsp.setLimiterEnabled(false)
      }
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      if (strength > 0) {
        await api.setLimiterEnabled(true)
        const ceiling = -0.3 - strength * 2.7
        await api.setLimiter({
          ceilingDb: Math.max(ceiling, -3),
          releaseMs: 50
        })
      } else {
        await api.setLimiterEnabled(false)
      }
    } catch (err) {
      console.error('[AudioEngine] setLimiterStrength failed:', err)
    }
  }

  // ====== EQ 控制 ======

  public async setEqEnabled(enabled: boolean): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setEqEnabled(enabled)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setEqEnabled(enabled)
    } catch {
      // 忽略错误
    }
  }

  public async setEqBand(index: number, settings: Partial<EqBandSettings>): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setEqBand(index, settings)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      const bandTypeMap: Record<string, string> = {
        lowShelf: 'lowShelf',
        highShelf: 'highShelf',
        peaking: 'peaking',
        notch: 'notch'
      }
      await api.setEqBand(index, {
        frequency: settings.frequency ?? 1000,
        preGain: settings.preGain ?? 0,
        postGain: settings.postGain ?? 0,
        preQ: settings.preQ ?? 1,
        postQ: settings.postQ ?? 1,
        bandType: bandTypeMap[settings.bandType || 'peaking'] || 'peaking'
      })
    } catch {
      // 忽略错误
    }
  }

  public async setEqGains(gains: number[]): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setEqGains(gains)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setEqGains([...gains])
    } catch {
      // 忽略错误
    }
  }

  // ====== 压缩器控制 ======

  public async setCompressorEnabled(enabled: boolean): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setCompressorEnabled(enabled)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setCompressorEnabled(enabled)
    } catch {
      /* ignore */
    }
  }

  public async setCompressorParams(params: CompressorParams): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setCompressorParams(params)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setCompressor({
        thresholdDb: params.threshold,
        ratio: params.ratio,
        attackMs: params.attack,
        releaseMs: params.release,
        kneeDb: params.knee
      })
    } catch {
      /* ignore */
    }
  }

  public getCompressorGainReduction(): number {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.dspChain?.getCompressorGainReduction() ?? 0
    }
    return 0
  }

  // ====== 限制器控制 ======

  public async setLimiterEnabled(enabled: boolean): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setLimiterEnabled(enabled)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setLimiterEnabled(enabled)
    } catch {
      /* ignore */
    }
  }

  public async setLimiterParams(params: LimiterParams): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setLimiterParams(params)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      await api.setLimiter({
        ceilingDb: params.ceiling,
        releaseMs: params.release
      })
    } catch {
      /* ignore */
    }
  }

  public getLimiterGainReduction(): number {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.dspChain?.getLimiterGainReduction() ?? 0
    }
    return 0
  }

  // ====== 等响度控制 ======

  public setLoudnessEnabled(enabled: boolean): void {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setLoudnessEnabled(enabled)
      return
    }
    // Rust 引擎通过 IPC 设置，若不可用则忽略
    const api = this.getApi()
    if (api && typeof api.setLoudnessEnabled === 'function') {
      api.setLoudnessEnabled(enabled).catch(() => {
        /* ignore */
      })
    }
  }

  public async setLoudnessParams(params: LoudnessParams): Promise<void> {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setLoudnessParams(params)
      return
    }
    const api = this.getApi()
    if (!api) return
    try {
      const state = await api.getState().catch(() => null)
      if (!state) return
      if (typeof api.setLoudness === 'function') {
        await api.setLoudness({
          enabled: params.enabled,
          compensation: params.compensation,
          referenceLoudness: params.referenceLoudness,
          direction: params.direction
        })
      }
    } catch {
      /* ignore */
    }
  }

  // ====== 虚拟低频控制 ======

  public setVirtualBassEnabled(enabled: boolean): void {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setVirtualBassEnabled(enabled)
      return
    }
  }

  public setVirtualBassParams(params: VirtualBassParams): void {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setVirtualBassParams(params)
      return
    }
  }

  // ====== 软限幅器控制 ======

  public setSoftClipperEnabled(enabled: boolean): void {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setSoftClipperEnabled(enabled)
      return
    }
  }

  public setSoftClipperParams(params: SoftClipperParams): void {
    if (isWebAudioMode()) {
      const dsp = this.ensureDspChain()
      if (dsp) dsp.setSoftClipperParams(params)
      return
    }
  }

  // ====== 音频可视化 ======

  /**
   * 注册 FFT 频谱数据回调
   * - WASAPI 模式：从 Rust 引擎推送，通过 IPC 接收
   * - Web Audio 模式：从 AnalyserNode 读取
   *
   * @param callback 接收归一化频谱数据 [0, 1]，128 bins
   * @returns 取消注册函数
   */
  public onFftData(callback: (spectrum: number[]) => void): () => void {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.onFftData(callback)
    }
    // WASAPI 模式：通过 IPC 回调
    const api = this.getApi()
    if (api?.setFftCallback) {
      return api.setFftCallback(callback)
    }
    return () => {}
  }

  // ====== Automix 智能过渡（Web Audio 模式） ======

  /**
   * 解码下一曲（Automix 预加载），不打断当前播放
   * 仅 Web Audio 模式支持；其他模式返回 false
   */
  public async loadNextFromArrayBuffer(buffer: ArrayBuffer): Promise<boolean> {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.loadNextFromArrayBuffer(buffer)
    }
    return false
  }

  /**
   * 加载并解码为当前曲（Automix fade 过渡切歌用）
   * 会停止当前播放；仅 Web Audio 模式支持
   */
  public async loadFromArrayBuffer(buffer: ArrayBuffer): Promise<boolean> {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.loadFromArrayBuffer(buffer)
    }
    return false
  }

  /**
   * 已解码的下一曲 AudioBuffer（供 head 特征分析）；无预加载时返回 null
   */
  public get nextAudioBuffer(): AudioBuffer | null {
    if (!isWebAudioMode()) return null
    return webAudioOutputEngine.nextAudioBuffer
  }

  /**
   * 当前播放/加载曲目的 AudioBuffer（供智能过渡人声结尾分析）；
   * 仅 Web Audio 模式可用，未加载曲目时返回 null
   */
  public get currentAudioBuffer(): AudioBuffer | null {
    if (!isWebAudioMode()) return null
    return webAudioOutputEngine.currentAudioBuffer
  }

  /**
   * 用变速处理后的缓冲替换预解码的下一曲（Automix BPM 对齐变速用）
   */
  public setNextAudioBuffer(buf: AudioBuffer): void {
    if (!isWebAudioMode()) return
    webAudioOutputEngine.setNextAudioBuffer(buf)
  }

  /** 当前曲目时长（毫秒）；无已加载曲目返回 0（供过渡调度在元数据缺失时兜底） */
  public getDurationMs(): number {
    if (isWebAudioMode()) return webAudioOutputEngine.getDurationMs()
    return 0
  }

  /**
   * 开始交叉淡化过渡到下一曲（Automix）
   * 前置条件：正在播放且已通过 loadNextFromArrayBuffer 预解码
   * @param durationMs 交叉淡化时长（毫秒）
   * @param nextStartOffsetMs 下一曲起始偏移（毫秒，跳过前奏），默认 0
   */
  public beginCrossfade(durationMs: number, nextStartOffsetMs: number = 0): boolean {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.beginCrossfade(durationMs, nextStartOffsetMs)
    }
    return false
  }

  /** 设置交叉淡化完成回调 */
  public setOnCrossfadeComplete(callback: (() => void) | null): void {
    if (isWebAudioMode()) {
      webAudioOutputEngine.setOnCrossfadeComplete(callback)
    }
  }

  /** 是否正在交叉淡化过渡中 */
  public get isCrossfading(): boolean {
    if (isWebAudioMode()) return webAudioOutputEngine.isCrossfading
    return false
  }

  /** 是否已有解码好的下一曲 */
  public get hasNextBuffer(): boolean {
    if (isWebAudioMode()) return webAudioOutputEngine.hasNextBuffer
    return false
  }

  /**
   * 注册实时时域帧数据回调（Automix 实时过渡点分析）
   * 仅 Web Audio 模式支持；其他模式返回空函数
   */
  public onTimeDomainData(callback: (data: Float32Array) => void): () => void {
    if (isWebAudioMode()) {
      return webAudioOutputEngine.onTimeDomainData(callback)
    }
    return () => {}
  }
}

// 导出全局单例
export const audioEngine = new AudioEngine()

// 便于外部使用的独立函数
export const onFftData = (callback: (spectrum: number[]) => void): (() => void) =>
  audioEngine.onFftData(callback)

// 默认导出
export default audioEngine
