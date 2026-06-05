/**
 * Rust 音频引擎适配器
 * 将 Rust N-API 音频引擎与 Web Audio API 集成
 * 
 * 功能：
 * 1. 使用 Rust 引擎加载和解码音频文件
 * 2. 使用 Rust 引擎应用音效（EQ、压缩器、限制器）
 * 3. 使用 Web Audio API + AudioWorklet 播放 Rust 引擎处理后的音频流
 */

import { usePlayerStore } from '../stores/playerStore'
import type { DecodedAudio } from '../apis/audio-decoder.types'

// 获取 Rust 音频引擎 API
function getRustAudioAPI() {
  return (window as any).api?.rustAudio
}

/**
 * Rust 音频引擎适配器类
 */
export class RustAudioAdapter {
  private audioContext: AudioContext | null = null
  private gainNode: GainNode | null = null
  private audioWorkletNode: AudioWorkletNode | null = null
  private positionTimer: number | null = null
  private volume: number = 1
  private onEndedCallback: (() => void) | null = null
  
  // 流式播放状态
  private isStreaming: boolean = false
  private streamInterval: number | null = null
  private audioBufferQueue: Float32Array[] = []
  private sampleRate: number = 44100
  private channels: number = 2

  // Web Audio API 播放状态（用于位置跟踪）
  private webAudioSource: AudioBufferSourceNode | null = null
  private webAudioStartTime: number = 0
  private webAudioPauseTime: number = 0
  private isWebAudioMode: boolean = false
  private currentAudioBuffer: AudioBuffer | null = null  // 当前播放的音频缓冲区

  // Web Audio API 音效处理节点
  private eqFilters: BiquadFilterNode[] = []
  private compressorNode: DynamicsCompressorNode | null = null
  private eqEnabled: boolean = false
  private compressorEnabled: boolean = false

  // 主动交叉过渡调度状态
  private pendingTransitionBuffer: AudioBuffer | null = null
  private pendingTransitionDurationMs: number = 0
  private pendingTransitionStartPositionMs: number = 0

  // 防止重复触发结束回调（positionTimer 每100ms检查一次，stream loop 和 source.onended 也会触发）
  private hasEndedCallbackTriggered: boolean = false

  // 确保 AudioContext 初始化
  public ensureContext(): void {
    if (this.audioContext) return

    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) {
      console.warn('[RustAudioAdapter] Web Audio API not supported')
      return
    }

    try {
      const context = new Ctx()
      const gain = context.createGain()
      gain.connect(context.destination)

      this.audioContext = context
      this.gainNode = gain
      this.sampleRate = context.sampleRate

      // 设置初始音量
      if (this.gainNode) {
        this.gainNode.gain.value = this.volume
      }
    } catch (error) {
      console.error('[RustAudioAdapter] Failed to create AudioContext:', error)
    }
  }

  // 设置 AudioWorklet
  private async setupAudioWorklet(): Promise<void> {
    if (!this.audioContext || this.audioWorkletNode) return

    const workletCode = `
      class RustAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.audioBuffer = new Float32Array(0);
          this.port.onmessage = (e) => {
            if (e.data.type === 'buffer') {
              // 追加新数据到缓冲区
              const newBuffer = new Float32Array(this.audioBuffer.length + e.data.buffer.length);
              newBuffer.set(this.audioBuffer);
              newBuffer.set(e.data.buffer, this.audioBuffer.length);
              this.audioBuffer = newBuffer;
            } else if (e.data.type === 'clear') {
              this.audioBuffer = new Float32Array(0);
            }
          };
        }

        process(inputs, outputs, parameters) {
          const output = outputs[0];
          if (!output || output.length === 0) return true;
          
          const channel = output[0];
          const channelCount = output.length;
          
          // 从缓冲区读取数据
          if (this.audioBuffer.length >= channel.length * channelCount) {
            for (let ch = 0; ch < channelCount; ch++) {
              for (let i = 0; i < channel.length; i++) {
                output[ch][i] = this.audioBuffer[i * channelCount + ch];
              }
            }
            // 移除已播放的数据
            this.audioBuffer = this.audioBuffer.subarray(channel.length * channelCount);
          } else {
            // 缓冲区不足，输出静音
            for (let ch = 0; ch < channelCount; ch++) {
              output[ch].fill(0);
            }
          }
          
          return true;
        }
      }
      registerProcessor('rust-audio-processor', RustAudioProcessor);
    `;

    try {
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(url);

      this.audioWorkletNode = new AudioWorkletNode(
        this.audioContext,
        'rust-audio-processor',
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [this.channels],
        }
      );
      this.audioWorkletNode.connect(this.gainNode!);
      
      console.log('[RustAudioAdapter] AudioWorklet setup complete');
    } catch (error) {
      console.error('[RustAudioAdapter] Failed to setup AudioWorklet:', error);
      throw error;
    }
  }

  // 启动 Rust 音频流
  private startRustAudioStream(): void {
    if (this.isStreaming) return;
    
    const api = getRustAudioAPI();
    if (!api) {
      console.error('[RustAudioAdapter] Rust audio API not available');
      return;
    }

    this.isStreaming = true;
    console.log('[RustAudioAdapter] Starting audio stream...');

    // 使用 requestAnimationFrame 定期从 Rust 获取音频数据
    const streamLoop = () => {
      if (!this.isStreaming) return;

      try {
        // 从 Rust 引擎读取 PCM 数据
        const bufferSize = 2048; // 每次读取的采样数
        if (typeof api.readAudioBuffer === 'function') {
          const pcmData = api.readAudioBuffer(bufferSize);
          
          if (pcmData && pcmData.length > 0 && this.audioWorkletNode) {
            // 发送到 AudioWorklet
            this.audioWorkletNode.port.postMessage({
              type: 'buffer',
              buffer: new Float32Array(pcmData)
            });
          }
        }

        // 检查是否播放完成
        if (typeof api.isStreaming === 'function' && typeof api.hasAudioData === 'function') {
          if (!api.isStreaming() && api.hasAudioData() === false) {
            // 播放完成，触发回调
            setTimeout(() => this.triggerEndedCallback(), 500);
          }
        }
      } catch (error) {
        console.error('[RustAudioAdapter] Error in stream loop:', error);
      }

      // 每 20ms 读取一次（约 50fps）
      setTimeout(() => {
        if (this.isStreaming) {
          requestAnimationFrame(streamLoop);
        }
      }, 20);
    };

    streamLoop();
  }

  // 停止流式播放
  private stopAudioStream(): void {
    this.isStreaming = false;
    
    if (this.streamInterval !== null) {
      window.clearInterval(this.streamInterval);
      this.streamInterval = null;
    }

    // 清空 AudioWorklet 缓冲区
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'clear' });
    }

    console.log('[RustAudioAdapter] Audio stream stopped');
  }

  // 停止位置更新
  private stopProgressUpdates(): void {
    if (this.positionTimer !== null) {
      window.clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  // 开始位置定时器
  private startPositionTimer() {
    if (this.positionTimer !== null) {
      window.clearInterval(this.positionTimer);
    }

    // 重置结束回调触发标志，允许新歌曲结束时再次触发
    this.hasEndedCallbackTriggered = false

    const p = usePlayerStore()
    const durationMs = p.currentSong?.durationMs ?? 0
    const api = getRustAudioAPI();

    this.positionTimer = window.setInterval(async () => {
      let positionMs = 0;

      if (this.isWebAudioMode && this.audioContext) {
        // Web Audio API 模式：使用 currentTime 计算位置
        positionMs = (this.audioContext.currentTime - this.webAudioStartTime) * 1000;
      } else if (api && typeof api.getPositionMs === 'function') {
        // Rust 引擎模式：从引擎获取位置
        try {
          positionMs = await api.getPositionMs();
        } catch (error) {
          // 忽略获取位置的错误
          return;
        }
      } else {
        return;
      }

      p.setPosition(positionMs);

      // 检查是否有待执行的主动交叉过渡
      if (this.pendingTransitionBuffer && positionMs >= this.pendingTransitionStartPositionMs) {
        const buffer = this.pendingTransitionBuffer
        const duration = this.pendingTransitionDurationMs
        this.pendingTransitionBuffer = null
        this.pendingTransitionDurationMs = 0
        this.pendingTransitionStartPositionMs = 0

        console.log(
          `[RustAudioAdapter] 主动触发交叉过渡, 位置=${positionMs.toFixed(0)}ms, 过渡=${duration}ms`
        )

        // 停止位置定时器，crossfadeToBuffer 会重新启动
        this.stopProgressUpdates()
        // 异步执行交叉过渡，不阻塞定时器清理
        this.crossfadeToBuffer(buffer, duration)
        return
      }

      // 检查是否播放完成（没有待过渡时才触发结束回调）
      if (positionMs >= durationMs - 100) {
        this.triggerEndedCallback();
      }
    }, 100);
  }

  // 停止当前播放
  public stop(): void {
    this.stopProgressUpdates()
    this.stopAudioStream()
    this.clearPendingTransition()

    // 停止 Rust 引擎播放
    const api = getRustAudioAPI()
    if (api && typeof api.stop === 'function') {
      api.stop().catch((e: any) => console.warn('[RustAudioAdapter] 停止 Rust 引擎失败:', e))
    }

    // 停止 Web Audio 播放（先清除 onended 回调防止异步触发 handleSongEnd）
    if (this.webAudioSource) {
      this.webAudioSource.onended = null
      try {
        this.webAudioSource.stop()
      } catch (e) {
        // 忽略停止错误
      }
      this.webAudioSource.disconnect()
      this.webAudioSource = null
    }

    // 重置 Web Audio 模式状态
    this.isWebAudioMode = false
    this.webAudioStartTime = 0
    this.webAudioPauseTime = 0
    this.currentAudioBuffer = null
  }

  // 淡出并停止
  public async fadeOutAndStop(durationMs: number): Promise<void> {
    this.stopProgressUpdates()

    // 立即停止之前的音频源，避免多个音频同时播放
    if (this.webAudioSource) {
      this.webAudioSource.onended = null
      try {
        this.webAudioSource.stop()
        this.webAudioSource.disconnect()
      } catch (e) {
        // 忽略停止错误
      }
      this.webAudioSource = null
    }

    if (!this.audioContext || !this.gainNode) {
      this.stop()
      return
    }

    const originalVolume = this.volume
    const now = this.audioContext.currentTime
    const gain = this.gainNode.gain
    const current = gain.value
    const durationSec = Math.max(durationMs, 0) / 1000

    gain.cancelScheduledValues(now)
    gain.setValueAtTime(current, now)
    gain.linearRampToValueAtTime(0, now + durationSec)

    await new Promise((resolve) => setTimeout(resolve, durationMs))
    this.stop()
    this.gainNode.gain.value = 0
    this.volume = originalVolume
  }

  // 暂停播放
  public async pause(): Promise<void> {
    if (this.audioContext?.state === 'running') {
      await this.audioContext.suspend()
    }
    this.stopProgressUpdates()
    this.stopAudioStream()

    // 暂停 Rust 引擎播放
    const api = getRustAudioAPI()
    if (api && typeof api.pause === 'function') {
      api.pause().catch((e: any) => console.warn('[RustAudioAdapter] 暂停 Rust 引擎失败:', e))
    }

    // 记录 Web Audio 暂停时间
    if (this.isWebAudioMode && this.audioContext) {
      this.webAudioPauseTime = this.audioContext.currentTime
    }
  }

  // 恢复播放
  public async play(): Promise<boolean> {
    this.ensureContext()

    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }

    // 处理 Web Audio 模式
    if (this.isWebAudioMode) {
      // 计算暂停时长并调整启动时间
      if (this.webAudioPauseTime > 0 && this.webAudioStartTime > 0) {
        const pauseDuration = this.audioContext!.currentTime - this.webAudioPauseTime
        this.webAudioStartTime += pauseDuration
        this.webAudioPauseTime = 0
      }

      this.startPositionTimer()

      // 淡入音量
      if (this.gainNode) {
        this.fadeTo(this.volume, 200)
      }

      return true
    }

    // 恢复 Rust 引擎播放
    const api = getRustAudioAPI()
    if (api && typeof api.play === 'function') {
      const result = await api.play()
      if (!result.success) {
        console.error('[RustAudioAdapter] Rust 引擎播放失败:', result.error)
        return false
      }
    }

    // 启动音频流
    this.startRustAudioStream()
    this.startPositionTimer()

    // 淡入音量
    if (this.gainNode) {
      this.gainNode.gain.value = 0
      this.fadeTo(this.volume, 200)
    }

    return true
  }

  // 仅恢复 AudioContext
  public async resume(): Promise<void> {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }

    if (this.positionTimer === null && this.isStreaming) {
      this.startPositionTimer()
    }
  }

  // 跳转到指定位置
  public seek(positionMs: number) {
    const p = usePlayerStore()

    if (this.isWebAudioMode) {
      // Web Audio API 模式：重新创建源节点并从新位置播放
      if (this.audioContext && this.currentAudioBuffer) {
        // 停止当前播放（先清除 onended 回调防止异步触发 handleSongEnd）
        if (this.webAudioSource) {
          this.webAudioSource.onended = null
          try {
            this.webAudioSource.stop()
          } catch (e) {
            // 忽略停止错误
          }
          this.webAudioSource.disconnect()
        }

        // 停止位置更新定时器（会在创建新源后重新启动）
        this.stopProgressUpdates()

        // 创建新的源节点
        const source = this.audioContext.createBufferSource()
        source.buffer = this.currentAudioBuffer

        // 连接音效处理链
        this.connectWebAudioEffects(source)

        // 从新位置开始播放
        const offsetSec = Math.max(0, Math.min(positionMs / 1000, this.currentAudioBuffer.duration))
        source.start(0, offsetSec)

        // 更新源节点和启动时间
        this.webAudioSource = source
        this.webAudioStartTime = this.audioContext.currentTime - offsetSec
        this.webAudioPauseTime = 0

        // 监听播放结束
        source.onended = () => {
          this.triggerEndedCallback()
        }

        // 重新启动位置更新定时器
        this.startPositionTimer()

        // 更新位置
        const actualPositionMs = offsetSec * 1000
        p.setPosition(actualPositionMs)
        console.log('[RustAudioAdapter] Web Audio 跳转到:', actualPositionMs, 'ms')
      }
      return
    }

    const api = getRustAudioAPI()
    if (api && typeof api.seek === 'function') {
      api.seek(positionMs).catch((e: any) => console.warn('[RustAudioAdapter] Rust 引擎跳转失败:', e))
    }

    p.setPosition(positionMs)
  }

  // 设置播放结束回调
  public setOnEndedCallback(callback: () => void) {
    this.onEndedCallback = callback
  }

  // 移除播放结束回调
  public removeOnEndedCallback() {
    this.onEndedCallback = null
  }

  /**
   * 触发播放结束回调
   * 使用防重复标志位，避免 positionTimer、stream loop、source.onended 多源重复触发
   * 导致 handleSongEnd → playNext 被多次调用，造成歌曲跳变
   */
  private triggerEndedCallback() {
    if (this.hasEndedCallbackTriggered) return
    this.hasEndedCallbackTriggered = true
    // 立即停止位置定时器，防止 100ms 后再次触发
    this.stopProgressUpdates()
    if (this.onEndedCallback) {
      this.onEndedCallback()
    }
  }

  /**
   * 交叉渐入渐出过渡到新的音频缓冲区
   * 创建并行的音频图，对旧音频淡出同时对新音频淡入
   * @param audioBuffer 新的音频缓冲区
   * @param durationMs 过渡时长（毫秒）
   */
  public async crossfadeToBuffer(audioBuffer: AudioBuffer, durationMs: number): Promise<void> {
    this.ensureContext()
    if (!this.audioContext) return

    const effectiveDuration = Math.max(durationMs, 100)

    // 停止位置更新（过渡完成后再重新启动）
    this.stopProgressUpdates()

    // 保存旧音频状态引用
    const oldSource = this.webAudioSource
    const oldGainNode = this.gainNode
    const oldEqFilters = [...this.eqFilters]
    const oldCompressor = this.compressorNode

    // 创建新的音量控制节点（新音频独享）
    const newGainNode = this.audioContext.createGain()
    newGainNode.gain.value = 0
    newGainNode.connect(this.audioContext.destination)

    // 创建新的音频源节点
    const newSource = this.audioContext.createBufferSource()
    newSource.buffer = audioBuffer

    // 为新音频源创建独立的音效处理链（复制当前音效参数）
    const newEqFilters: BiquadFilterNode[] = []
    let lastNode: AudioNode = newSource

    if (this.eqEnabled && this.eqFilters.length > 0) {
      for (const existingFilter of this.eqFilters) {
        const newFilter = this.audioContext.createBiquadFilter()
        newFilter.type = existingFilter.type
        newFilter.frequency.value = existingFilter.frequency.value
        newFilter.gain.value = existingFilter.gain.value
        newFilter.Q.value = existingFilter.Q.value
        lastNode.connect(newFilter)
        lastNode = newFilter
        newEqFilters.push(newFilter)
      }
    }

    let newCompressorNode: DynamicsCompressorNode | null = null
    if (this.compressorEnabled && this.compressorNode) {
      newCompressorNode = this.audioContext.createDynamicsCompressor()
      newCompressorNode.threshold.value = this.compressorNode.threshold.value
      newCompressorNode.ratio.value = this.compressorNode.ratio.value
      newCompressorNode.attack.value = this.compressorNode.attack.value
      newCompressorNode.release.value = this.compressorNode.release.value
      newCompressorNode.knee.value = this.compressorNode.knee.value
      lastNode.connect(newCompressorNode)
      lastNode = newCompressorNode
    }

    // 新音频链连接到新的增益节点
    lastNode.connect(newGainNode)

    // 启动新音频源的播放（音量从 0 开始）
    const now = this.audioContext.currentTime
    newSource.start(now)

    // 保存当前音频缓冲区引用
    this.currentAudioBuffer = audioBuffer

    // 停止 Rust 引擎的音频流（如果处于流式播放模式）
    this.stopAudioStream()
    const api = getRustAudioAPI()
    if (api && typeof api.stop === 'function') {
      api.stop().catch((e: any) => console.warn('[RustAudioAdapter] 停止 Rust 引擎失败:', e))
    }

    // 执行交叉淡入淡出
    const durationSec = effectiveDuration / 1000

    // 淡出旧的增益节点
    if (oldGainNode && oldGainNode.gain.value > 0) {
      oldGainNode.gain.cancelScheduledValues(now)
      oldGainNode.gain.setValueAtTime(oldGainNode.gain.value, now)
      oldGainNode.gain.linearRampToValueAtTime(0, now + durationSec)
    }

    // 淡入新的增益节点
    newGainNode.gain.setValueAtTime(0, now)
    newGainNode.gain.linearRampToValueAtTime(this.volume, now + durationSec)

    // 等待过渡完成
    await new Promise((resolve) => setTimeout(resolve, effectiveDuration))

    // 清理旧的音频图
    if (oldSource) {
      oldSource.onended = null
      try {
        oldSource.stop()
      } catch (e) {
        // 忽略停止错误
      }
      oldSource.disconnect()
    }

    oldEqFilters.forEach((f) => {
      try {
        f.disconnect()
      } catch (e) {
        // 忽略断开错误
      }
    })

    if (oldCompressor) {
      try {
        oldCompressor.disconnect()
      } catch (e) {
        // 忽略断开错误
      }
    }

    if (oldGainNode) {
      try {
        oldGainNode.disconnect()
      } catch (e) {
        // 忽略断开错误
      }
    }

    // 将新音频图设为主音频图
    this.webAudioSource = newSource
    this.gainNode = newGainNode
    this.eqFilters = newEqFilters
    this.compressorNode = newCompressorNode
    this.isWebAudioMode = true
    this.isStreaming = true
    this.webAudioStartTime = now
    this.webAudioPauseTime = 0

    // 设置播放结束回调
    newSource.onended = () => {
      this.triggerEndedCallback()
    }

    // 更新播放器 store 的时长
    const p = usePlayerStore()
    p.setDuration(audioBuffer.duration * 1000)

    // 清除过渡状态标记，恢复正常切歌逻辑
    p.setTransitioning(false)

    // 重新启动位置更新
    this.startPositionTimer()
  }

  /**
   * 仅解码音频数据，不播放
   * @param data 音频文件的 ArrayBuffer 数据
   * @returns 解码后的 AudioBuffer
   */
  public async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.ensureContext()
    if (!this.audioContext) {
      throw new Error('[RustAudioAdapter] AudioContext not available')
    }
    const audioBuffer = await this.audioContext.decodeAudioData(data)
    return audioBuffer
  }

  /**
   * 检查当前是否正在播放（Web Audio 模式）
   * 仅当有可交叉过渡的音频源时才返回 true
   * @returns 是否可通过交叉过渡切换
   */
  public isCurrentlyPlaying(): boolean {
    if (this.isWebAudioMode && this.webAudioSource !== null) {
      return true
    }
    return false
  }

  /**
   * 调度主动交叉过渡，在歌曲播放到指定位置时自动触发
   * 用于歌曲自然结束前的智能过渡，无需依赖 handleSongEnd
   * @param nextBuffer 下一首歌曲的 AudioBuffer
   * @param transitionDurationMs 过渡时长（毫秒）
   * @param startPositionMs 在当前歌曲中的起始位置（毫秒）
   */
  public schedulePendingTransition(
    nextBuffer: AudioBuffer,
    transitionDurationMs: number,
    startPositionMs: number
  ): void {
    this.pendingTransitionBuffer = nextBuffer
    this.pendingTransitionDurationMs = transitionDurationMs
    this.pendingTransitionStartPositionMs = startPositionMs

    // 标记正在过渡，防止 handleSongEnd 在等待期间触发自动切歌
    const p = usePlayerStore()
    p.setTransitioning(true)

    console.log(
      `[RustAudioAdapter] 已调度交叉过渡, 起始位置=${startPositionMs.toFixed(0)}ms, 过渡=${transitionDurationMs}ms`
    )
  }

  /**
   * 清除已调度的待定交叉过渡
   */
  public clearPendingTransition(): void {
    this.pendingTransitionBuffer = null
    this.pendingTransitionDurationMs = 0
    this.pendingTransitionStartPositionMs = 0
  }

  /**
   * 获取当前正在播放的 AudioBuffer
   * 用于音频分析以计算智能过渡参数
   * @returns 当前音频缓冲区，无缓冲区时返回 null
   */
  public getCurrentAudioBuffer(): AudioBuffer | null {
    return this.currentAudioBuffer
  }

  // 淡出到目标音量
  private fadeTo(target: number, durationMs: number): void {
    if (!this.audioContext || !this.gainNode) return
    const now = this.audioContext.currentTime
    const gain = this.gainNode.gain
    const current = gain.value
    const durationSec = Math.max(durationMs, 0) / 1000
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(current, now)
    gain.linearRampToValueAtTime(target, now + durationSec)
  }

  // 设置全局音量
  public setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1)

    if (this.gainNode) {
      this.gainNode.gain.value = this.volume
    }
  }

  // === Web Audio API 音效处理 ===

  /**
   * 设置 EQ 启用状态（Web Audio API 模式）
   * @param enabled - 是否启用
   */
  public setEqEnabled(enabled: boolean): void {
    this.eqEnabled = enabled
    this.updateWebAudioEq()
    // 如果正在播放，立即重新连接音频链以应用更改
    if (this.webAudioSource && this.isWebAudioMode) {
      this.reconnectWebAudioEffects()
    }
  }

  /**
   * 设置 EQ 频段（Web Audio API 模式）
   * @param bandIndex - 频段索引
   * @param settings - 频段设置
   */
  public setEqBand(bandIndex: number, settings: {
    frequency: number
    preGain: number
    postGain: number
    preQ: number
    postQ: number
    bandType: string
  }): void {
    if (!this.audioContext) return

    // 确保 EQ 滤波器数组已初始化
    while (this.eqFilters.length <= bandIndex) {
      const filter = this.audioContext.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = 1000
      filter.gain.value = 0
      filter.Q.value = 1
      this.eqFilters.push(filter)
    }

    const filter = this.eqFilters[bandIndex]
    filter.frequency.value = settings.frequency
    filter.gain.value = settings.preGain
    filter.Q.value = settings.preQ

    // 根据 bandType 设置滤波器类型
    const typeMap: Record<string, BiquadFilterType> = {
      'lowShelf': 'lowshelf',
      'highShelf': 'highshelf',
      'peaking': 'peaking',
      'notch': 'notch'
    }
    filter.type = typeMap[settings.bandType] || 'peaking'

    this.updateWebAudioEq()
  }

  /**
   * 更新 Web Audio EQ 连接
   */
  private updateWebAudioEq(): void {
    if (!this.audioContext || !this.gainNode) return

    // 断开所有 EQ 滤波器的连接
    this.eqFilters.forEach(filter => {
      filter.disconnect()
    })

    if (!this.eqEnabled || this.eqFilters.length === 0) {
      // EQ 禁用或没有滤波器，直接连接
      return
    }

    // 重新连接 EQ 滤波器链
    // 注意：需要在播放时动态连接，这里只更新状态
  }

  /**
   * 设置压缩器参数（Web Audio API 模式）
   * @param params - 压缩器参数
   */
  public setCompressor(params: {
    thresholdDb: number
    ratio: number
    attackMs: number
    releaseMs: number
    kneeDb: number
  }): void {
    if (!this.audioContext) return

    if (!this.compressorNode) {
      this.compressorNode = this.audioContext.createDynamicsCompressor()
    }

    this.compressorNode.threshold.value = params.thresholdDb
    this.compressorNode.ratio.value = params.ratio
    this.compressorNode.attack.value = params.attackMs / 1000
    this.compressorNode.release.value = params.releaseMs / 1000
    this.compressorNode.knee.value = params.kneeDb
  }

  /**
   * 设置压缩器启用状态（Web Audio API 模式）
   * @param enabled - 是否启用
   */
  public setCompressorEnabled(enabled: boolean): void {
    this.compressorEnabled = enabled
    // 如果正在播放，立即重新连接音频链以应用更改
    if (this.webAudioSource && this.isWebAudioMode) {
      this.reconnectWebAudioEffects()
    }
  }

  /**
   * 重新连接 Web Audio 音效处理链
   * 在启用/禁用音效时立即生效
   */
  private reconnectWebAudioEffects(): void {
    if (!this.audioContext || !this.gainNode || !this.webAudioSource || !this.currentAudioBuffer) return

    // 获取当前播放位置（加上淡出时间的补偿）
    const currentTime = this.audioContext.currentTime
    const currentOffsetSec = currentTime - this.webAudioStartTime

    // 短暂淡出时间（10ms）
    const fadeOutDuration = 0.01

    // 立即停止并断开旧源，避免重音
    const oldSource = this.webAudioSource
    oldSource.onended = null

    try {
      oldSource.stop()
      oldSource.disconnect()
    } catch (e) {
      // 忽略停止错误
    }

    // 清除当前源引用，防止重复停止
    this.webAudioSource = null

    // 计算补偿后的播放位置（加上淡出时间）
    const offsetWithCompensation = currentOffsetSec + fadeOutDuration
    const offset = Math.max(0, Math.min(offsetWithCompensation, this.currentAudioBuffer.duration))

    // 淡出音量
    this.gainNode.gain.cancelScheduledValues(currentTime)
    this.gainNode.gain.setValueAtTime(this.volume, currentTime)
    this.gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + fadeOutDuration)

    // 创建新的音频源节点
    const newSource = this.audioContext.createBufferSource()
    newSource.buffer = this.currentAudioBuffer

    // 连接音效处理链（使用最新的启用状态）
    this.connectWebAudioEffects(newSource)

    // 从补偿后的位置开始播放
    newSource.start(currentTime + fadeOutDuration, offset)

    // 更新源节点和启动时间（考虑调度延迟）
    this.webAudioSource = newSource
    this.webAudioStartTime = currentTime + fadeOutDuration - offset

    // 重新设置播放结束回调
    newSource.onended = () => {
      this.triggerEndedCallback()
    }

    // 淡入恢复音量
    const fadeInStartTime = currentTime + fadeOutDuration
    this.gainNode.gain.setValueAtTime(0.001, fadeInStartTime)
    this.gainNode.gain.exponentialRampToValueAtTime(this.volume, fadeInStartTime + fadeOutDuration)

    console.log('[RustAudioAdapter] 音效链已重新连接，位置:', offset.toFixed(3), '秒')
  }

  // 从 URL 加载并播放（使用 Rust 引擎流式播放，回退到 Web Audio API）
  public async loadFromUrl(url: string): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    await this.fadeOutAndStop(200)
    
    // 使用 Rust 引擎加载音频
    const api = getRustAudioAPI()
    if (api && typeof api.load === 'function') {
      try {
        // 设置 AudioWorklet
        await this.setupAudioWorklet()
        
        const result = await api.load(url)
        if (result.success && result.trackInfo) {
          console.log('[RustAudioAdapter] Rust 引擎加载成功:', result.trackInfo)
          // 更新播放器 store 的时长
          const p = usePlayerStore()
          p.setDuration(result.trackInfo.durationMs)
          
          // 更新采样率和声道数
          this.sampleRate = result.trackInfo.sampleRate || 44100
          this.channels = result.trackInfo.channels || 2
          return
        } else {
          console.error('[RustAudioAdapter] Rust 引擎加载失败:', result.error)
        }
      } catch (error) {
        console.error('[RustAudioAdapter] Rust 引擎加载错误:', error)
      }
    }
    
    // Rust 引擎不可用或加载失败，回退到 Web Audio API
    console.log('[RustAudioAdapter] 回退到 Web Audio API 加载 URL')
    await this.loadFromUrlWithWebAudio(url)
  }
  
  // 使用 Web Audio API 从 URL 加载音频
  private async loadFromUrlWithWebAudio(url: string): Promise<void> {
    try {
      // 获取音频数据
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      
      // 使用已实现的 loadFromFileData 方法解码和播放
      await this.loadFromFileData(arrayBuffer)
    } catch (error) {
      console.error('[RustAudioAdapter] Web Audio API 加载 URL 失败:', error)
      throw error
    }
  }

  // 从文件数据加载并播放（使用 Web Audio API 解码）
  public async loadFromFileData(data: ArrayBuffer): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    await this.fadeOutAndStop(200)

    // 恢复音量（fadeOutAndStop 会将音量设为 0）
    this.gainNode.gain.value = this.volume

    try {
      // 使用 Web Audio API 解码音频数据
      const audioBuffer = await this.audioContext.decodeAudioData(data)
      console.log('[RustAudioAdapter] Web Audio API 解码成功:', audioBuffer.duration, '秒')

      // 保存音频缓冲区，用于 seek 时重新创建源
      this.currentAudioBuffer = audioBuffer

      // 创建缓冲源节点
      const source = this.audioContext.createBufferSource()
      source.buffer = audioBuffer

      // 连接音效处理链
      this.connectWebAudioEffects(source)

      // 保存 Web Audio 源节点和启动时间
      this.webAudioSource = source
      this.webAudioStartTime = this.audioContext.currentTime
      this.webAudioPauseTime = 0
      this.isWebAudioMode = true

      // 播放
      source.start(0)

      // 更新状态
      this.isStreaming = true

      // 更新播放器 store 的时长
      const p = usePlayerStore()
      p.setDuration(audioBuffer.duration * 1000)

      // 监听播放结束
      source.onended = () => {
        this.triggerEndedCallback()
      }

      // 启动位置更新定时器
      this.startPositionTimer()
    } catch (error) {
      console.error('[RustAudioAdapter] Web Audio API 解码失败:', error)
      throw error
    }
  }

  /**
   * 连接 Web Audio API 音效处理链
   * @param source - 音频源节点
   */
  private connectWebAudioEffects(source: AudioBufferSourceNode): void {
    if (!this.audioContext || !this.gainNode) return

    // 先断开所有音效节点的连接，避免重复连接
    this.eqFilters.forEach(filter => {
      try {
        filter.disconnect()
      } catch (e) {
        // 忽略断开错误
      }
    })
    if (this.compressorNode) {
      try {
        this.compressorNode.disconnect()
      } catch (e) {
        // 忽略断开错误
      }
    }

    let lastNode: AudioNode = source

    // 连接 EQ 滤波器链
    if (this.eqEnabled && this.eqFilters.length > 0) {
      this.eqFilters.forEach(filter => {
        lastNode.connect(filter)
        lastNode = filter
      })
    }

    // 连接压缩器
    if (this.compressorEnabled && this.compressorNode) {
      lastNode.connect(this.compressorNode)
      lastNode = this.compressorNode
    }

    // 最终连接到音量节点
    lastNode.connect(this.gainNode)
  }

  // 播放已加载的音频（流式播放）
  public async playFromUrl(url: string): Promise<void> {
    await this.loadFromUrl(url)
    await this.play()
  }

  public async playFromFileData(data: ArrayBuffer): Promise<void> {
    await this.loadFromFileData(data)
    await this.play()
  }

  // 获取当前音量
  public getVolume(): number {
    return this.volume
  }

  // 检查是否正在播放
  public isPlaying(): boolean {
    const api = getRustAudioAPI()
    if (api && typeof api.isStreaming === 'function') {
      return api.isStreaming() || this.isStreaming
    }
    return this.isStreaming
  }

  // 获取当前位置（毫秒）
  public async getCurrentPosition(): Promise<number> {
    const api = getRustAudioAPI()
    if (api && typeof api.getPositionMs === 'function') {
      try {
        return await api.getPositionMs()
      } catch (error) {
        return 0
      }
    }
    return 0
  }
}

// 导出单例
export const rustAudioAdapter = new RustAudioAdapter()
