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
import { VirtualBassProcessor, type VirtualBassParams } from './virtual-bass'
import { SoftClipper, type SoftClipperParams } from './soft-clipper'
import { audioVisualizer } from './audio-visualizer'

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
  private playbackRate: number = 1.0
  private onEndedCallback: (() => void) | null = null
  
  // 流式播放状态
  private isStreaming: boolean = false
  private streamInterval: number | null = null
  private channels: number = 2

  // Web Audio API 播放状态（用于位置跟踪）
  private webAudioSource: AudioBufferSourceNode | null = null
  private webAudioStartTime: number = 0
  private webAudioPauseTime: number = 0
  private webAudioSourceStarted: boolean = false // 标记 source 是否已调用 start()
  private isWebAudioMode: boolean = false
  private currentAudioBuffer: AudioBuffer | null = null  // 当前播放的音频缓冲区

  // Web Audio API 音效处理节点
  private eqFilters: BiquadFilterNode[] = []
  private compressorNode: DynamicsCompressorNode | null = null
  private eqEnabled: boolean = false
  private compressorEnabled: boolean = false

  // EQ 频段目标增益存储（用于启用/禁用时的增益恢复）
  private eqBandTargetGains: number[] = []

  // 虚拟低频处理器
  private virtualBassProcessor: VirtualBassProcessor | null = null
  private virtualBassParams: VirtualBassParams = {
    enabled: false,
    intensity: 50,
    crossoverFreq: 120
  }

  // 软限幅爆音抑制器
  private softClipper: SoftClipper | null = null
  private softClipperParams: SoftClipperParams = {
    enabled: false,
    threshold: 2.0,
    makeupGain: 0
  }

  // 等响度补偿滤波器
  private loudnessBassFilter: BiquadFilterNode | null = null
  private loudnessTrebleFilter: BiquadFilterNode | null = null
  private loudnessEnabled: boolean = false
  private loudnessCompensation: number = 1.0
  private loudnessDirection: 'low' | 'high' | 'both' = 'both'

  // 音频处理链是否已初始化
  private processingChainInitialized: boolean = false

  // 处理链输入节点（用于连接音频源到处理链）
  private chainInputNode: GainNode | null = null

  // 存储压缩器目标阈值（用于启用/禁用恢复）
  private savedCompressorThreshold: number = -24

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

      // 设置初始音量
      if (this.gainNode) {
        this.gainNode.gain.value = this.volume
      }

      // 初始化音频处理链
      this.initAudioProcessingChain()
    } catch (error) {
      console.error('[RustAudioAdapter] Failed to create AudioContext:', error)
    }
  }

  /**
   * 初始化音频处理链
   * 一次性预建所有音效节点并建立固定连接，后续只需直接修改 AudioParam 即可实时生效。
   * 音频链路（串行）：
   * chainInput → EQ[0..9] → compressor → postProcGain →
   *   virtualBass → vbOutGain → softClipper → gainNode → destination
   */
  private initAudioProcessingChain(): void {
    if (this.processingChainInitialized || !this.audioContext) return

    const ctx = this.audioContext

    // 创建处理链输入节点
    this.chainInputNode = ctx.createGain()
    this.chainInputNode.gain.value = 1

    // 创建 10 段 EQ 滤波器并串行连接
    const eqFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    this.eqFilters = []
    this.eqBandTargetGains = new Array(10).fill(0)

    let lastNode: AudioNode = this.chainInputNode
    for (let i = 0; i < 10; i++) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = eqFrequencies[i]
      filter.gain.value = 0
      filter.Q.value = 1.0
      lastNode.connect(filter)
      lastNode = filter
      this.eqFilters.push(filter)
    }

    // 创建压缩器节点并连接到 EQ 链末端
    this.compressorNode = ctx.createDynamicsCompressor()
    this.compressorNode.threshold.value = -24
    this.compressorNode.ratio.value = 4
    this.compressorNode.attack.value = 0.01
    this.compressorNode.release.value = 0.1
    this.compressorNode.knee.value = 6
    lastNode.connect(this.compressorNode)
    lastNode = this.compressorNode

    // 等响度补偿滤波器组（低架 + 高架），放在压缩器之后
    // 低架滤波器：补偿低频（100Hz），高架滤波器：补偿高频（10kHz）
    this.loudnessBassFilter = ctx.createBiquadFilter()
    this.loudnessBassFilter.type = 'lowshelf'
    this.loudnessBassFilter.frequency.value = 100
    this.loudnessBassFilter.gain.value = 0
    this.loudnessBassFilter.Q.value = 0.7

    this.loudnessTrebleFilter = ctx.createBiquadFilter()
    this.loudnessTrebleFilter.type = 'highshelf'
    this.loudnessTrebleFilter.frequency.value = 10000
    this.loudnessTrebleFilter.gain.value = 0
    this.loudnessTrebleFilter.Q.value = 0.7

    lastNode.connect(this.loudnessBassFilter)
    this.loudnessBassFilter.connect(this.loudnessTrebleFilter)
    lastNode = this.loudnessTrebleFilter

    // 后处理级联节点：postProc → [virtualBass] → vbOut → [softClipper] → gainNode
    const postProcGain = ctx.createGain()
    postProcGain.gain.value = 1
    lastNode.connect(postProcGain)

    const vbOutGain = ctx.createGain()
    vbOutGain.gain.value = 1

    // 虚拟低频处理器：postProcGain → virtualBass 内部处理 → vbOutGain
    this.virtualBassProcessor = new VirtualBassProcessor()
    this.virtualBassProcessor.connect(postProcGain, vbOutGain)

    // 软限幅器：vbOutGain → softClipper 内部处理 → gainNode
    this.softClipper = new SoftClipper()
    this.softClipper.connect(vbOutGain, this.gainNode!)

    // 在软限幅器和主音量之间插入音频可视化分析器
    if (!audioVisualizer.isInitialized()) {
      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 256
      analyserNode.smoothingTimeConstant = 0.8
      analyserNode.connect(this.gainNode!)
      // 将软限幅器的输出重新路由到分析器节点
      this.softClipper.rerouteOutput(analyserNode)
      // 通过内部方法直接设置 analyserNode（绕过 initialize 的前置条件检查）
      ;(audioVisualizer as any).analyserNode = analyserNode
      ;(audioVisualizer as any).frequencyData = new Uint8Array(analyserNode.frequencyBinCount)
      ;(audioVisualizer as any).timeDomainData = new Uint8Array(analyserNode.fftSize)
      ;(audioVisualizer as any).initialized = true
    }

    this.processingChainInitialized = true
    console.log('[RustAudioAdapter] 音频处理链初始化完成')
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
      // 注意：durationMs 可能为 0（时长尚未加载），此时不应触发结束回调
      if (durationMs > 0 && positionMs >= durationMs - 100) {
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
    this.webAudioSourceStarted = false
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

  /**
   * 恢复播放
   * 如果 source 尚未启动（load-only 模式），则先启动 source 再开始位置定时器
   * @returns 是否成功恢复播放
   */
  public async play(): Promise<boolean> {
    this.ensureContext()

    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }

    // 处理 Web Audio 模式
    if (this.isWebAudioMode) {
      // 如果 source 尚未启动（load-only 模式导致），则启动播放
      if (!this.webAudioSourceStarted && this.webAudioSource) {
        try {
          this.webAudioSource.start(0)
          this.webAudioSource.playbackRate.value = this.playbackRate
          this.webAudioSourceStarted = true
          this.isStreaming = true

          // 设置播放结束回调
          this.webAudioSource.onended = () => {
            this.triggerEndedCallback()
          }

          // 重置启动时间为当前时间，确保 positionMs 从 0 开始计算
          this.webAudioStartTime = this.audioContext!.currentTime
          this.webAudioPauseTime = 0
        } catch (e) {
          // source 可能已经被外部启动，忽略错误
          console.warn('[RustAudioAdapter] 启动 source 失败:', e)
        }
      }
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

  /**
   * 跳转到指定位置
   * @param positionMs 目标位置（毫秒）
   * @param startPlaying 是否启动播放，默认为 true；设为 false 则仅定位但不播放
   */
  public seek(positionMs: number, startPlaying: boolean = true) {
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

        // 计算目标偏移秒数
        const offsetSec = Math.max(0, Math.min(positionMs / 1000, this.currentAudioBuffer.duration))

        // 更新源节点和启动时间（无论是否播放，都先设置好位置信息）
        this.webAudioSource = source
        this.webAudioPauseTime = 0

        if (startPlaying) {
          // 从新位置开始播放
          source.start(0, offsetSec)
          source.playbackRate.value = this.playbackRate
          this.webAudioSourceStarted = true
          this.webAudioStartTime = this.audioContext.currentTime - offsetSec

          // 监听播放结束
          source.onended = () => {
            this.triggerEndedCallback()
          }

          // 重新启动位置更新定时器
          this.startPositionTimer()
        } else {
          // 仅定位不播放：保存启动时间偏移，等待 play() 调用时真正启动
          this.webAudioSourceStarted = false
          this.webAudioStartTime = this.audioContext.currentTime - offsetSec
        }

        // 更新位置
        const actualPositionMs = offsetSec * 1000
        p.setPosition(actualPositionMs)
        console.log('[RustAudioAdapter] Web Audio 跳转到:', actualPositionMs, 'ms', startPlaying ? '(播放)' : '(仅定位)')
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
   * 使用预构建的处理链，实现简洁高效的过渡
   * @param audioBuffer 新的音频缓冲区
   * @param durationMs 过渡时长（毫秒）
   */
  public async crossfadeToBuffer(audioBuffer: AudioBuffer, durationMs: number): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.chainInputNode || !this.gainNode) return

    const effectiveDuration = Math.max(durationMs, 100)

    // 停止位置更新（过渡完成后再重新启动）
    this.stopProgressUpdates()

    // 保存旧源引用
    const oldSource = this.webAudioSource

    // 清理待过渡状态
    this.clearPendingTransition()

    // 停止旧音频源（先清除 onended 回调防止异步触发）
    if (oldSource) {
      oldSource.onended = null
      try {
        oldSource.stop()
      } catch (e) {
        // 忽略停止错误
      }
      oldSource.disconnect()
    }

    // 停止 Rust 引擎的音频流
    this.stopAudioStream()
    const api = getRustAudioAPI()
    if (api && typeof api.stop === 'function') {
      api.stop().catch((e: any) => console.warn('[RustAudioAdapter] 停止 Rust 引擎失败:', e))
    }

    // 保存当前音频缓冲区
    this.currentAudioBuffer = audioBuffer

    // 创建新的音频源节点并连接到预构建处理链
    const newSource = this.audioContext.createBufferSource()
    newSource.buffer = audioBuffer
    newSource.connect(this.chainInputNode)
    newSource.playbackRate.value = this.playbackRate

    // 执行淡入淡出
    const now = this.audioContext.currentTime
    const durationSec = effectiveDuration / 1000

    // 淡出增益节点
    this.gainNode.gain.cancelScheduledValues(now)
    this.gainNode.gain.setValueAtTime(this.volume, now)
    this.gainNode.gain.linearRampToValueAtTime(0, now + durationSec * 0.5)

    // 淡入恢复
    this.gainNode.gain.setValueAtTime(0, now + durationSec * 0.5)
    this.gainNode.gain.linearRampToValueAtTime(this.volume, now + durationSec)

    // 启动新音频源
    newSource.start(now + durationSec * 0.5)
    this.webAudioSourceStarted = true

    // 更新状态
    this.webAudioSource = newSource
    this.isWebAudioMode = true
    this.isStreaming = true
    this.webAudioStartTime = now + durationSec * 0.5
    this.webAudioPauseTime = 0

    // 设置播放结束回调
    newSource.onended = () => {
      this.triggerEndedCallback()
    }

    // 更新播放器 store 的时长
    const p = usePlayerStore()
    p.setDuration(audioBuffer.duration * 1000)

    // 清除过渡状态标记
    p.setTransitioning(false)

    // 等待过渡完成
    await new Promise((resolve) => setTimeout(resolve, effectiveDuration))

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

  /**
   * 设置播放速度倍率
   * @param rate 播放速度倍率（0.25 - 4.0）
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.min(Math.max(rate, 0.25), 4.0)
    // 如果正在 Web Audio 模式播放，立即应用新的播放速率
    if (this.webAudioSource && this.isWebAudioMode) {
      this.webAudioSource.playbackRate.value = this.playbackRate
    }
  }

  /**
   * 获取当前播放速度倍率
   * @returns 当前播放速度倍率
   */
  public getPlaybackRate(): number {
    return this.playbackRate
  }

  // 设置全局音量
  public setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1)

    if (this.gainNode) {
      this.gainNode.gain.value = this.volume
    }

    // 音量变化时更新等响度补偿（补偿量与音量成反比）
    this.updateLoudnessCompensation()
  }

  // === Web Audio API 音效处理 ===

  /**
   * 设置 EQ 启用状态（Web Audio API 模式）
   * 使用旁路方式：启用时恢复目标增益，禁用时将所有频段增益设为 0
   * @param enabled - 是否启用
   */
  public setEqEnabled(enabled: boolean): void {
    this.eqEnabled = enabled

    // 直接修改已连接滤波器的增益值
    for (let i = 0; i < this.eqFilters.length; i++) {
      const targetGain = enabled ? (this.eqBandTargetGains[i] ?? 0) : 0
      if (this.audioContext) {
        this.eqFilters[i].gain.setTargetAtTime(targetGain, this.audioContext.currentTime, 0.015)
      } else {
        this.eqFilters[i].gain.value = targetGain
      }
    }
  }

  /**
   * 设置 EQ 频段（Web Audio API 模式）
   * 直接修改已连接滤波器的 AudioParam，无需断开/重连
   * @param bandIndex - 频段索引 (0-9)
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
    if (!this.audioContext || bandIndex < 0 || bandIndex >= this.eqFilters.length) return

    const filter = this.eqFilters[bandIndex]
    const now = this.audioContext.currentTime

    // 更新滤波器频率
    filter.frequency.setTargetAtTime(settings.frequency, now, 0.015)

    // 更新滤波器 Q 值
    filter.Q.setTargetAtTime(settings.preQ, now, 0.015)

    // 保存目标增益（用于启用/禁用恢复）
    this.eqBandTargetGains[bandIndex] = settings.preGain

    // 根据 bandType 设置滤波器类型
    const typeMap: Record<string, BiquadFilterType> = {
      'lowShelf': 'lowshelf',
      'highShelf': 'highshelf',
      'peaking': 'peaking',
      'notch': 'notch'
    }
    filter.type = typeMap[settings.bandType] || 'peaking'

    // 仅在 EQ 启用时应用增益
    if (this.eqEnabled) {
      filter.gain.setTargetAtTime(settings.preGain, now, 0.015)
    }
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
    if (!this.audioContext || !this.compressorNode) return

    const now = this.audioContext.currentTime
    const comp = this.compressorNode

    // 保存目标阈值（用于启用/禁用恢复）
    this.savedCompressorThreshold = params.thresholdDb

    // 仅在压缩器启用时应用实际阈值
    if (this.compressorEnabled) {
      comp.threshold.setTargetAtTime(params.thresholdDb, now, 0.015)
    }
    comp.ratio.setTargetAtTime(params.ratio, now, 0.015)
    comp.attack.setTargetAtTime(params.attackMs / 1000, now, 0.015)
    comp.release.setTargetAtTime(params.releaseMs / 1000, now, 0.015)
    comp.knee.setTargetAtTime(params.kneeDb, now, 0.015)
  }

  /**
   * 设置压缩器启用状态（Web Audio API 模式）
   * 使用阈值旁路：禁用时将阈值设为 0dB（不触发压缩），启用时恢复目标阈值
   * @param enabled - 是否启用
   */
  public setCompressorEnabled(enabled: boolean): void {
    this.compressorEnabled = enabled
    if (!this.audioContext || !this.compressorNode) return

    const now = this.audioContext.currentTime
    // 禁用时设阈值为 0dB（最大，不压缩），启用时恢复保存的目标阈值
    const targetThreshold = enabled ? this.savedCompressorThreshold : 0
    this.compressorNode.threshold.setTargetAtTime(targetThreshold, now, 0.015)
  }

  /**
   * 设置虚拟低频参数（Web Audio API 模式）
   * @param params - 虚拟低频参数
   */
  public setVirtualBassParams(params: Partial<VirtualBassParams>): void {
    if (params.enabled !== undefined) this.virtualBassParams.enabled = params.enabled
    if (params.intensity !== undefined) this.virtualBassParams.intensity = params.intensity
    if (params.crossoverFreq !== undefined) this.virtualBassParams.crossoverFreq = params.crossoverFreq

    if (this.virtualBassProcessor) {
      this.virtualBassProcessor.setParams(this.virtualBassParams)
    }
  }

  /**
   * 设置软限幅器参数（Web Audio API 模式）
   * @param params - 软限幅器参数
   */
  public setSoftClipperParams(params: Partial<SoftClipperParams>): void {
    if (params.enabled !== undefined) this.softClipperParams.enabled = params.enabled
    if (params.threshold !== undefined) this.softClipperParams.threshold = params.threshold
    if (params.makeupGain !== undefined) this.softClipperParams.makeupGain = params.makeupGain

    if (this.softClipper) {
      this.softClipper.setParams(this.softClipperParams)
    }
  }

  // === 等响度补偿控制（Web Audio API 模式） ===

  /**
   * 设置等响度补偿启用状态
   * 基于弗莱彻-曼森等响度曲线，小音量时提升低频和高频以保持感知响度平坦
   * @param enabled - 是否启用等响度补偿
   */
  public setLoudnessEnabled(enabled: boolean): void {
    this.loudnessEnabled = enabled
    this.updateLoudnessCompensation()
  }

  /**
   * 设置等响度补偿参数
   * @param params - 等响度补偿参数
   * @param params.compensation - 补偿强度 (0-1)，1 为最大补偿
   * @param params.referenceLoudness - 参考响度 LUFS (-40 到 -10)
   * @param params.direction - 补偿方向：'low' 仅低频, 'high' 仅高频, 'both' 双向
   */
  public setLoudnessParams(params: {
    enabled?: boolean
    compensation?: number
    referenceLoudness?: number
    direction?: 'low' | 'high' | 'both'
  }): void {
    if (params.enabled !== undefined) this.loudnessEnabled = params.enabled
    if (params.compensation !== undefined) this.loudnessCompensation = params.compensation
    if (params.direction !== undefined) this.loudnessDirection = params.direction

    this.updateLoudnessCompensation()
  }

  /**
   * 根据当前音量和参数计算并应用等响度补偿增益
   *
   * 算法原理：
   * - 基于弗莱彻-曼森等响度曲线，人耳在小音量时对低频和高频敏感度大幅下降
   * - 补偿增益与音量成反比：音量越低，补偿越多；音量最大时补偿为零
   * - 低频补偿中心频率 100Hz，最大增益 ~15dB
   * - 高频补偿中心频率 10kHz，最大增益 ~12dB
   * - 补偿强度受 compensation 参数缩放 (0-1)
   * - 方向参数控制补偿范围
   */
  private updateLoudnessCompensation(): void {
    if (!this.audioContext) return

    const now = this.audioContext.currentTime

    if (!this.loudnessEnabled) {
      // 禁用时清零增益
      if (this.loudnessBassFilter) {
        this.loudnessBassFilter.gain.setTargetAtTime(0, now, 0.03)
      }
      if (this.loudnessTrebleFilter) {
        this.loudnessTrebleFilter.gain.setTargetAtTime(0, now, 0.03)
      }
      return
    }

    // 计算基于当前音量的补偿系数
    // 音量越低，补偿越大；音量为 1.0 时补偿为 0
    const volumeFactor = 1.0 - this.volume
    const compensationRatio = this.loudnessCompensation * volumeFactor

    // 根据方向计算低频和高频增益
    // 低频最大补偿 15dB，高频最大补偿 12dB（基于等响度曲线数据）
    const maxBassGain = 15.0
    const maxTrebleGain = 12.0

    const applyLow = this.loudnessDirection === 'low' || this.loudnessDirection === 'both'
    const applyHigh = this.loudnessDirection === 'high' || this.loudnessDirection === 'both'

    const bassGain = applyLow ? maxBassGain * compensationRatio : 0
    const trebleGain = applyHigh ? maxTrebleGain * compensationRatio : 0

    // 平滑应用增益变化
    if (this.loudnessBassFilter) {
      this.loudnessBassFilter.gain.setTargetAtTime(bassGain, now, 0.03)
    }
    if (this.loudnessTrebleFilter) {
      this.loudnessTrebleFilter.gain.setTargetAtTime(trebleGain, now, 0.03)
    }
  }

  /**
   * 从 URL 加载音频（使用 Rust 引擎流式播放，回退到 Web Audio API）
   * @param url 音频文件的 URL
   * @param startPlaying 是否立即开始播放，默认为 true；设为 false 则仅加载但不播放
   */
  public async loadFromUrl(url: string, startPlaying: boolean = true): Promise<void> {
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
          
          // 更新声道数
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
    await this.loadFromUrlWithWebAudio(url, startPlaying)
  }
  
  /**
   * 使用 Web Audio API 从 URL 加载音频
   * @param url 音频文件的 URL
   * @param startPlaying 是否立即开始播放
   */
  private async loadFromUrlWithWebAudio(url: string, startPlaying: boolean = true): Promise<void> {
    try {
      // 获取音频数据
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      
      // 使用已实现的 loadFromFileData 方法解码和播放
      await this.loadFromFileData(arrayBuffer, startPlaying)
    } catch (error) {
      console.error('[RustAudioAdapter] Web Audio API 加载 URL 失败:', error)
      throw error
    }
  }

  /**
   * 从文件数据加载音频
   * @param data 音频文件的 ArrayBuffer 数据
   * @param startPlaying 是否立即开始播放，默认为 true；设为 false 则仅解码和准备但不播放
   */
  public async loadFromFileData(data: ArrayBuffer, startPlaying: boolean = true): Promise<void> {
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

      if (startPlaying) {
        // 播放
        source.start(0)
        source.playbackRate.value = this.playbackRate
        this.webAudioSourceStarted = true

        // 更新状态
        this.isStreaming = true

        // 监听播放结束
        source.onended = () => {
          this.triggerEndedCallback()
        }

        // 启动位置更新定时器
        this.startPositionTimer()
      } else {
        this.webAudioSourceStarted = false
      }

      // 更新播放器 store 的时长
      const p = usePlayerStore()
      p.setDuration(audioBuffer.duration * 1000)
    } catch (error) {
      console.error('[RustAudioAdapter] Web Audio API 解码失败:', error)
      throw error
    }
  }

  /**
   * 连接 Web Audio API 音效处理链
   * 处理链已预构建，只需将音频源连接到 chainInputNode
   * @param source - 音频源节点
   */
  private connectWebAudioEffects(source: AudioBufferSourceNode): void {
    if (!this.audioContext || !this.chainInputNode) return

    // 直接连接到预构建的处理链输入
    source.connect(this.chainInputNode)
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
