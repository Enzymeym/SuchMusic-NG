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
      return typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined';
    } catch {
      return false;
    }
  }

  // 确保引擎初始化
  public async ensureContext(): Promise<void> {
    if (isWebAudioMode()) return  // Web Audio 无需初始化 Rust 引擎
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
    await api.stop().catch((err) => { console.error('[AudioEngine] stop failed:', err) })
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
      await api.stop().catch((err) => { console.error('[AudioEngine] fadeOutAndStop cleanup failed:', err) })
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
    await api.pause().catch((err) => { console.error('[AudioEngine] pause failed:', err) })
  }

  // 恢复播放
  public async play(): Promise<boolean> {
    if (isWebAudioMode()) {
      // Web Audio: 如果是暂停状态则恢复，否则是全新播放（由 audioPlayerManager 触发）
      if (webAudioOutputEngine.isPaused) {
        webAudioOutputEngine.resume()
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

  // 应用 effective gain = volume * boost 到底层引擎
  private async applyEffectiveVolume(): Promise<void> {
    const effectiveGain = this.currentVolume * this.volumeBoost
    if (isWebAudioMode()) {
      webAudioOutputEngine.setVolume(effectiveGain)
      return
    }
    const api = this.getApi()
    if (!api) return
    await api.setVolume(effectiveGain).catch((err) => { console.error('[AudioEngine] setVolume failed:', err) })
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
    await api.setPlaybackRate?.(rate).catch((err) => { console.error('[AudioEngine] setPlaybackRate failed:', err) })
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
        const ceiling = -0.3 - (strength * 2.7)
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
        const ceiling = -0.3 - (strength * 2.7)
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
        lowShelf: 'lowShelf', highShelf: 'highShelf', peaking: 'peaking', notch: 'notch'
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
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
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
      api.setLoudnessEnabled(enabled).catch(() => { /* ignore */ })
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
    } catch { /* ignore */ }
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
}

// 导出全局单例
export const audioEngine = new AudioEngine()

// 便于外部使用的独立函数
export const onFftData = (callback: (spectrum: number[]) => void): (() => void) =>
  audioEngine.onFftData(callback)

// 默认导出
export default audioEngine
