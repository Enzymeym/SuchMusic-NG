/**
 * Web Audio API 音频输出引擎
 *
 * 使用浏览器内置 AudioContext 进行音频播放，作为跨平台音频输出后端。
 * 与 WASAPI 不同，此引擎直接在渲染进程运行，无需主进程桥接。
 *
 * 数据流：
 *   browser decodeAudioData → AudioBuffer → AudioBufferSourceNode
 *     → 子增益（gainA/gainB，交叉淡化） → masterGain（用户音量）
 *     → (optional) WebAudioDspChain → 系统输出
 *
 * 双音源结构（Automix 智能过渡）：
 *   sourceA/gainA = 当前曲，sourceB/gainB = 下一曲
 *   通过 AudioParam 精确时间调度实现交叉淡化，sourceB 完成后提升为当前源
 */

import { WebAudioDspChain } from './web-audio-dsp'

export class WebAudioOutputEngine {
  private audioContext: AudioContext | null = null

  // ====== 双音源结构 ======
  /** 当前曲音源 */
  private sourceA: AudioBufferSourceNode | null = null
  /** 下一曲音源（交叉淡化用） */
  private sourceB: AudioBufferSourceNode | null = null
  /** 用户音量节点（DSP 链/输出的入口），替代原 gainNode 语义 */
  private masterGain: GainNode | null = null
  /** 当前曲子增益（交叉淡化用），初始 1 */
  private gainA: GainNode | null = null
  /** 下一曲子增益（交叉淡化用），初始 1 */
  private gainB: GainNode | null = null

  private audioBuffer: AudioBuffer | null = null
  /** 下一曲解码缓冲（Automix 预加载，不打断当前播放） */
  private nextBuffer: AudioBuffer | null = null

  /** Web Audio DSP 处理链（懒初始化） */
  dspChain: WebAudioDspChain | null = null

  // ====== 音频可视化 ======

  private analyserNode: AnalyserNode | null = null
  private fftCallbacks: Array<(spectrum: number[]) => void> = []
  private timeDomainCallbacks: Array<(data: Float32Array) => void> = []
  private timeDomainBuffer: Float32Array<ArrayBuffer> | null = null
  private fftRafId: number | null = null

  /**
   * 注册 FFT 频谱数据回调（Web Audio 模式）
   * 通过 AnalyserNode 获取实时频谱，RAF 轮询
   *
   * @param callback 接收归一化频谱数据 [0, 1]，128 bins
   * @returns 取消注册函数
   */
  onFftData(callback: (spectrum: number[]) => void): () => void {
    this.fftCallbacks.push(callback)
    if (this.fftCallbacks.length === 1) {
      this.ensureAnalyserNode()
      this.startFftLoop()
    }
    return () => {
      this.fftCallbacks = this.fftCallbacks.filter((cb) => cb !== callback)
      if (this.fftCallbacks.length === 0 && this.timeDomainCallbacks.length === 0) {
        this.stopFftLoop()
      }
    }
  }

  /**
   * 注册实时时域帧数据回调（Web Audio 模式）
   * 与 onFftData 共享同一个 RAF 循环，每次 tick 同时读取频谱与时域数据
   *
   * @param callback 接收 Float32Array 时域采样（fftSize=256 时 256 个采样，快照语义，共享实例）
   * @returns 取消注册函数
   */
  onTimeDomainData(callback: (data: Float32Array) => void): () => void {
    this.timeDomainCallbacks.push(callback)
    if (this.timeDomainCallbacks.length === 1) {
      this.ensureAnalyserNode()
      this.startFftLoop()
    }
    return () => {
      this.timeDomainCallbacks = this.timeDomainCallbacks.filter((cb) => cb !== callback)
      if (this.fftCallbacks.length === 0 && this.timeDomainCallbacks.length === 0) {
        this.stopFftLoop()
      }
    }
  }

  /** 确保 AnalyserNode 已插入音频链路 */
  private ensureAnalyserNode(): void {
    if (this.analyserNode || !this.audioContext || !this.masterGain) return

    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8

    // 插入到 masterGain 和 destination 之间，建立持久连接避免每次 doPlay 重复 connect
    this.analyserNode = analyser
    this.analyserNode.connect(this.audioContext.destination)
    this.timeDomainBuffer = new Float32Array(analyser.fftSize)
  }

  /**
   * 音频上下文就绪后，若已有注册的 FFT/时域回调则补建 AnalyserNode 并启动读取循环。
   *
   * 解决时序问题：onFftData/onTimeDomainData 可能在 audioContext 创建之前被注册
   * （如 TransitionController.init 在 PlayerBar.onMounted 中调用，此时尚未加载歌曲），
   * 此时 ensureAnalyserNode 因 audioContext 为空而跳过，startFftLoop 也因 analyserNode
   * 为空而立即退出。之后歌曲加载创建 audioContext，但无人再次调用初始化，
   * 导致回调永远不触发。本方法在 audioContext 创建后被调用，弥补这一缺口。
   */
  private restoreAnalyserIfNeeded(): void {
    if (this.fftCallbacks.length === 0 && this.timeDomainCallbacks.length === 0) return
    this.ensureAnalyserNode()
    if (this.analyserNode && this.fftRafId === null) {
      this.startFftLoop()
    }
  }

  /** 启动 RAF 频谱/时域读取循环 */
  private startFftLoop(): void {
    if (this.fftRafId !== null) return // 防止重复启动
    const buffer = new Uint8Array(128)
    const normalized = new Array<number>(128)
    const tick = () => {
      if (
        !this.analyserNode ||
        (this.fftCallbacks.length === 0 && this.timeDomainCallbacks.length === 0)
      ) {
        this.fftRafId = null
        return
      }
      // FFT 频谱数据（喂给 onFftData 回调）
      if (this.fftCallbacks.length > 0) {
        this.analyserNode.getByteFrequencyData(buffer)
        for (let i = 0; i < 128; i++) {
          normalized[i] = buffer[i] / 255
        }
        for (const cb of this.fftCallbacks) {
          cb(normalized)
        }
      }
      // 实时时域帧数据（喂给 onTimeDomainData 回调）
      if (this.timeDomainCallbacks.length > 0 && this.timeDomainBuffer) {
        this.analyserNode.getFloatTimeDomainData(this.timeDomainBuffer)
        for (const cb of this.timeDomainCallbacks) {
          cb(this.timeDomainBuffer)
        }
      }
      this.fftRafId = requestAnimationFrame(tick)
    }
    this.fftRafId = requestAnimationFrame(tick)
  }

  /** 停止 RAF 频谱读取循环 */
  private stopFftLoop(): void {
    if (this.fftRafId !== null) {
      cancelAnimationFrame(this.fftRafId)
      this.fftRafId = null
    }
  }

  private _isPlaying = false
  private _isPaused = false
  private _pausedOffset = 0 // 暂停时的播放位置（秒）
  private _startTime = 0 // context.currentTime 记录
  private _sampleRate = 44100
  private _channels = 2
  private _duration = 0 // 音频总时长（秒）

  private onEndedCallback: (() => void) | null = null

  // ====== 交叉淡化状态 ======

  private _isCrossfading = false
  private onCrossfadeCompleteRef: (() => void) | null = null
  /** 兜底定时器：防止 sourceA 异常未触发 onended 导致卡死 */
  private crossfadeFallbackTimer: number | null = null

  // ====== 初始化与销毁 ======

  /**
   * 初始化 AudioContext 和 GainNode
   * @param sampleRate 采样率（Hz）
   * @param channels 声道数
   */
  init(sampleRate: number, channels: number): void {
    this.dispose()

    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext
    const ctx = new AudioContextClass({ sampleRate })
    const gain = ctx.createGain()
    gain.gain.value = 1.0
    gain.connect(ctx.destination)
    this.audioContext = ctx
    this.masterGain = gain

    this._sampleRate = sampleRate
    this._channels = channels

    this.restoreAnalyserIfNeeded()
  }

  /**
   * 加载 PCM 数据并创建 AudioBuffer
   * @param pcmData f32 交错 PCM 数据
   * @param sampleRate 采样率
   * @param channels 声道数
   */
  loadPcm(pcmData: Float32Array, sampleRate: number, channels: number): boolean {
    if (!this.audioContext || !this.masterGain) {
      return false
    }

    this.stop()

    // 显式释放旧 AudioBuffer
    this.audioBuffer = null

    this._sampleRate = sampleRate
    this._channels = channels

    const sampleCount = Math.floor(pcmData.length / channels)
    this.audioBuffer = this.audioContext.createBuffer(channels, sampleCount, sampleRate)
    this._duration = sampleCount / sampleRate

    // 交错 PCM → 分离声道
    if (channels === 1) {
      this.audioBuffer.copyToChannel(pcmData as Float32Array<ArrayBuffer>, 0)
    } else {
      // 多声道：直接写入 AudioBuffer 的声道 buffer，避免中间数组分配
      const channelBufs: Float32Array[] = []
      for (let ch = 0; ch < channels; ch++) {
        channelBufs.push(this.audioBuffer.getChannelData(ch))
      }
      for (let i = 0; i < sampleCount; i++) {
        for (let ch = 0; ch < channels; ch++) {
          channelBufs[ch][i] = pcmData[i * channels + ch]
        }
      }
    }

    return true
  }

  /**
   * 从原始音频文件 Buffer 加载（使用浏览器原生解码器）
   * MP3/FLAC/OGG/WAV 等常见格式均支持，无需 Rust 端解码
   * 首次调用自动创建 AudioContext
   * @param buffer 原始音频文件 Buffer
   * @returns Promise，解析成功返回 true
   */
  async loadFromArrayBuffer(buffer: ArrayBuffer): Promise<boolean> {
    let ctx = this.audioContext
    let gain = this.masterGain

    // 自动初始化（首次调用时创建 AudioContext + GainNode）
    if (!ctx) {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext
      ctx = new AudioContextClass() as AudioContext
      gain = ctx.createGain()
      gain.gain.value = 1.0
      gain.connect(ctx.destination)
      this.audioContext = ctx
      this.masterGain = gain
      this.restoreAnalyserIfNeeded()
    }

    // 确保 AudioContext 处于运行状态（某些环境可能自动挂起）
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    this.stop()

    // 显式释放旧 AudioBuffer（大块 PCM 数据 ~84MB/首），
    // 避免 decodeAudioData 异步解码期间旧 buffer 仍占内存
    this.audioBuffer = null

    try {
      this.audioBuffer = await ctx.decodeAudioData(buffer)
      this._sampleRate = this.audioBuffer.sampleRate
      this._channels = this.audioBuffer.numberOfChannels
      this._duration = this.audioBuffer.duration
      return true
    } catch (err) {
      console.error('[WebAudioEngine] decodeAudioData 失败:', err)
      return false
    }
  }

  /**
   * 解码下一曲（Automix 预加载），不打断当前播放、不影响 sourceA
   * 首次调用自动创建 AudioContext（参考 loadFromArrayBuffer 的自动初始化逻辑）
   * @param buffer 原始音频文件 Buffer
   * @returns 解码成功与否
   */
  async loadNextFromArrayBuffer(buffer: ArrayBuffer): Promise<boolean> {
    let ctx = this.audioContext

    // 自动初始化（首次调用时创建 AudioContext + GainNode）
    if (!ctx) {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext
      ctx = new AudioContextClass() as AudioContext
      const gain = ctx.createGain()
      gain.gain.value = 1.0
      gain.connect(ctx.destination)
      this.audioContext = ctx
      this.masterGain = gain
      this.restoreAnalyserIfNeeded()
    }

    // 确保 AudioContext 处于运行状态（某些环境可能自动挂起）
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    try {
      const decoded = await ctx.decodeAudioData(buffer)
      this.nextBuffer = decoded
      return true
    } catch (err) {
      console.error('[WebAudioEngine] decodeAudioData 失败 (loadNext):', err)
      this.nextBuffer = null
      return false
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.stop()
    this.stopFftLoop()
    if (this.dspChain) {
      this.dspChain.dispose()
      this.dspChain = null
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect()
      this.analyserNode = null
    }
    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        console.warn('[WebAudioEngine] AudioContext close failed:', err)
      })
      this.audioContext = null
    }
    this.masterGain = null
    this.gainA = null
    this.gainB = null
    this.audioBuffer = null
    this.nextBuffer = null
    this.onCrossfadeCompleteRef = null
    this._isPlaying = false
    this._isPaused = false
  }

  // ====== 播放控制 ======

  /**
   * 开始/恢复播放
   * @param offsetSeconds 从指定秒数开始播放（用于 seek），默认 0
   */
  play(offsetSeconds: number = 0): void {
    if (!this.audioContext || !this.audioBuffer || !this.masterGain) {
      return
    }

    // 确保 AudioContext 运行 — 但即使 resume 失败也要尝试播放（start 会在挂起的 context 上排队）
    if (this.audioContext.state === 'suspended') {
      this.audioContext
        .resume()
        .then(() => this.doPlay(offsetSeconds))
        .catch((err) => {
          console.warn('[WebAudioEngine] AudioContext resume failed, attempting playback:', err)
          this.doPlay(offsetSeconds)
        })
      return
    }

    this.doPlay(offsetSeconds)
  }

  /** 实际执行播放的内部方法 */
  private doPlay(offsetSeconds: number): void {
    if (!this.audioContext || !this.audioBuffer || !this.masterGain) return

    // 停止当前 playback（如果有）
    this.stopSourceNode()

    // 防御性：若仍处于交叉淡化（正常流程下 play 前应已打断），先清理
    if (this._isCrossfading) {
      this.interruptCrossfade()
    }

    const ctx = this.audioContext

    // 确保子增益节点存在（懒创建；AudioNode.connect 对同一输出/输入对是幂等的）
    if (!this.gainA) {
      this.gainA = ctx.createGain()
      this.gainA.gain.value = 1.0
      this.gainA.connect(this.masterGain)
    }

    this.sourceA = ctx.createBufferSource()
    this.sourceA.buffer = this.audioBuffer

    // 连接链路：sourceA -> gainA -> masterGain -> [可选 DSP 链] -> [可选 AnalyserNode] -> destination
    // 用户音量（masterGain）放在 DSP 链之前，让限制器/软限幅器捕获 boost 后的峰值
    this.sourceA.connect(this.gainA)

    // AnalyserNode 已在 ensureAnalyserNode 中建立到 destination 的持久连接
    const finalDest = this.analyserNode ?? ctx.destination

    if (this.dspChain) {
      // DSP 链的 connect() 已优化为复用内部节点，仅在首次时构建
      // 此处仅重新连线 masterGain → DSP 链 → finalDest
      this.dspChain.connect(this.masterGain, finalDest)
    } else {
      this.masterGain.connect(finalDest)
    }

    const now = ctx.currentTime
    // 复位子增益
    try {
      this.gainA.gain.cancelScheduledValues(now)
    } catch {
      /* 忽略 */
    }
    this.gainA.gain.value = 1.0

    const offset = this._pausedOffset > 0 ? this._pausedOffset : offsetSeconds
    this._pausedOffset = 0

    this.attachSourceEndedHandler(this.sourceA)

    this.sourceA.start(0, offset)
    this._startTime = ctx.currentTime - offset
    this._isPlaying = true
    this._isPaused = false
  }

  /**
   * 暂停播放（保持 position）
   */
  pause(): void {
    if (!this.audioContext || !this._isPlaying) {
      return
    }

    // 若处于交叉淡化中，打断并清理（复位增益、停止 sourceB、触发 onended 供上层感知）
    this.interruptCrossfade()

    // 先捕获播放位置再翻转状态标志（getPositionSeconds 依赖 _isPlaying=true 才会计算，
    // 若先置 false 将永远读到 _pausedOffset，导致暂停后位置丢失）
    const pos = this.audioContext.currentTime - this._startTime
    this._pausedOffset = Math.max(0, pos)
    this._isPaused = true
    this._isPlaying = false

    if (this.audioContext.state === 'running') {
      this.audioContext.suspend().catch(() => {
        /* 忽略 suspend 失败 */
      })
    }
  }

  /**
   * 恢复播放
   */
  resume(): void {
    if (!this.audioContext || !this._isPaused) {
      return
    }
    this.play()
  }

  /**
   * 停止播放并重置
   */
  stop(): void {
    // 若处于交叉淡化中，先打断（复位增益、停止 sourceB、清空 nextBuffer、触发 onended）
    this.interruptCrossfade()
    this.stopSourceNode()
    this._isPlaying = false
    this._isPaused = false
    this._pausedOffset = 0
    this._startTime = 0
  }

  /**
   * 跳转到指定位置
   * @param positionMs 目标位置（毫秒）
   */
  seek(positionMs: number): void {
    const offsetSeconds = Math.max(0, Math.min(positionMs / 1000, this._duration))
    // 若处于交叉淡化中，先打断（复位增益、停止 sourceB、清空 nextBuffer、触发 onended）
    this.interruptCrossfade()
    this.stopSourceNode()
    this._pausedOffset = offsetSeconds
    this._isPlaying = false
    this._isPaused = false
  }

  // ====== 音频控制 ======

  /**
   * 设置输出音量/增益
   * @param volume 音量增益（>= 0.0，可大于 1.0 用于增强）
   */
  setVolume(volume: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, volume)
    }
  }

  // ====== 交叉淡化（Automix 智能过渡） ======

  /**
   * 开始交叉淡化过渡到下一曲
   * 前置条件：正在播放（sourceA 活跃）且 nextBuffer 存在，否则返回 false
   * 使用 AudioParam 精确时间调度（setValueAtTime + linearRampToValueAtTime），非 JS 定时器步进
   *
   * @param durationMs 交叉淡化时长（毫秒）
   * @param nextStartOffsetMs 下一曲起始偏移（毫秒），用于跳过前奏；默认 0（从头播放）
   * @returns 是否成功启动
   */
  beginCrossfade(durationMs: number, nextStartOffsetMs: number = 0): boolean {
    if (!this.audioContext || !this.masterGain) return false
    if (!this._isPlaying || !this.sourceA) return false
    if (!this.nextBuffer) return false
    if (this._isCrossfading) return false

    const ctx = this.audioContext
    const now = ctx.currentTime
    const dur = Math.max(0, durationMs / 1000)

    // 下一曲起始偏移（跳过前奏），钳制在缓冲时长内
    const offsetSec = Math.max(
      0,
      Math.min(nextStartOffsetMs / 1000, Math.max(0, this.nextBuffer.duration - 0.01))
    )

    // 确保 gainB 子增益节点存在（懒创建，初始 1，淡入前先置 0）
    if (!this.gainB) {
      this.gainB = ctx.createGain()
      this.gainB.gain.value = 1.0
      this.gainB.connect(this.masterGain)
    }

    // 创建并接线 sourceB（下一曲）
    const srcB = ctx.createBufferSource()
    srcB.buffer = this.nextBuffer
    srcB.connect(this.gainB)
    this.sourceB = srcB

    // 精确时间调度：gainA → 0，gainB: 0 → 1
    if (this.gainA) {
      this.gainA.gain.cancelScheduledValues(now)
      this.gainA.gain.setValueAtTime(this.gainA.gain.value, now)
      this.gainA.gain.linearRampToValueAtTime(0, now + dur)
    }
    this.gainB.gain.cancelScheduledValues(now)
    this.gainB.gain.setValueAtTime(0, now)
    this.gainB.gain.linearRampToValueAtTime(1, now + dur)

    // 记录 sourceB 的起始时间：减去起始偏移，收尾后 position getter 返回源B 的真实曲内位置
    this._startTime = now - offsetSec

    this._isCrossfading = true

    // 兜底：sourceA 异常未触发 onended 时强制收尾（finalizeCrossfade 幂等，可防重入）
    this.crossfadeFallbackTimer = window.setTimeout(
      () => {
        this.finalizeCrossfade()
      },
      dur * 1000 + 200
    )

    srcB.start(now, offsetSec)
    return true
  }

  /**
   * 设置交叉淡化完成回调
   * 当 sourceB 提升为当前源（过渡完成）时触发
   * @param callback 回调函数
   */
  setOnCrossfadeComplete(callback: (() => void) | null): void {
    this.onCrossfadeCompleteRef = callback
  }

  /**
   * 是否正在交叉淡化过渡中
   */
  get isCrossfading(): boolean {
    return this._isCrossfading
  }

  /**
   * 是否已有解码好的下一曲（Automix 预加载）
   */
  get hasNextBuffer(): boolean {
    return this.nextBuffer !== null
  }

  /**
   * 已解码的下一曲 AudioBuffer（Automix 预加载，供 head 特征分析使用）
   * 与 nextBuffer 指向同一对象；无预加载时返回 null
   */
  get nextAudioBuffer(): AudioBuffer | null {
    return this.nextBuffer
  }

  /**
   * 当前播放/加载曲目的 AudioBuffer（Automix 人声结尾分析用）
   * 只读引用，调用方不得修改或 detach；未加载曲目时为 null
   */
  get currentAudioBuffer(): AudioBuffer | null {
    return this.audioBuffer
  }

  /**
   * 用变速处理后的缓冲替换预解码的下一曲（Automix BPM 对齐变速用）
   * @param buf 变速后的 AudioBuffer
   */
  setNextAudioBuffer(buf: AudioBuffer): void {
    this.nextBuffer = buf
  }

  /**
   * 交叉淡化收尾（幂等）：将 sourceB 提升为当前源
   * 由 sourceA 自然结束（onended）或兜底定时器触发
   */
  private finalizeCrossfade(): void {
    if (!this._isCrossfading) return // 幂等保护，防止兜底与 onended 重入
    this._isCrossfading = false

    if (this.crossfadeFallbackTimer !== null) {
      clearTimeout(this.crossfadeFallbackTimer)
      this.crossfadeFallbackTimer = null
    }

    const now = this.audioContext?.currentTime ?? 0

    // 停止并断开已结束的 sourceA
    if (this.sourceA) {
      try {
        this.sourceA.onended = null
        this.sourceA.stop()
      } catch {
        // 已自然结束，忽略
      }
      this.sourceA.disconnect()
      this.sourceA = null
    }

    // 槽位交换：sourceB 提升为当前源
    this.sourceA = this.sourceB
    this.sourceB = null
    if (this.sourceA) {
      // 恢复常规结束语义（自然结束 → _isPlaying=false + onEndedCallback）
      this.attachSourceEndedHandler(this.sourceA)
    }

    // 子增益角色交换：原 gainB（已 ramp 到 1）接管当前曲；原 gainA 复位备用
    const oldGainA = this.gainA
    this.gainA = this.gainB
    this.gainB = oldGainA
    if (this.gainA) {
      try {
        this.gainA.gain.cancelScheduledValues(now)
      } catch {
        /* 忽略 */
      }
      this.gainA.gain.value = 1.0
    }
    if (this.gainB) {
      try {
        this.gainB.gain.cancelScheduledValues(now)
      } catch {
        /* 忽略 */
      }
      this.gainB.gain.value = 1.0
    }

    // audioBuffer 引用指向下一曲，同步元数据
    if (this.nextBuffer) {
      this.audioBuffer = this.nextBuffer
      this._duration = this.audioBuffer.duration
      this._sampleRate = this.audioBuffer.sampleRate
      this._channels = this.audioBuffer.numberOfChannels
    }
    this.nextBuffer = null

    const cb = this.onCrossfadeCompleteRef
    // 注意：不能在此置空回调。控制器依赖每次交叉淡化完成通知来复位
    // isTransitioning / active / executed 等状态并开启下一曲过渡循环；
    // 若置空，首次过渡之后的完成事件无人处理，控制器卡死（isTransitioning
    // 恒为 true），歌曲自然结束时 handleSongEnd 被阻塞，引擎静默。
    cb?.()
  }

  /**
   * 打断交叉淡化（stop/seek/pause/dispose/loadFromArrayBuffer 共用）
   * 复位子增益、停止并断开 sourceB、清空 nextBuffer、清除兜底定时器，
   * 并触发 onended 供上层 handleSongEnd 感知（保持现有语义）
   */
  private interruptCrossfade(): void {
    if (!this._isCrossfading) return
    this._isCrossfading = false

    if (this.crossfadeFallbackTimer !== null) {
      clearTimeout(this.crossfadeFallbackTimer)
      this.crossfadeFallbackTimer = null
    }

    const now = this.audioContext?.currentTime ?? 0
    if (this.gainA) {
      try {
        this.gainA.gain.cancelScheduledValues(now)
      } catch {
        /* 忽略 */
      }
      this.gainA.gain.value = 1.0
    }
    if (this.gainB) {
      try {
        this.gainB.gain.cancelScheduledValues(now)
      } catch {
        /* 忽略 */
      }
      this.gainB.gain.value = 1.0
    }

    // 停止并断开 sourceB
    if (this.sourceB) {
      try {
        this.sourceB.onended = null
        this.sourceB.stop()
      } catch {
        // 可能已经停止
      }
      this.sourceB.disconnect()
      this.sourceB = null
    }

    this.nextBuffer = null

    // 触发 onended，供上层 handleSongEnd 感知
    this.onEndedCallback?.()
  }

  // ====== 状态查询 ======

  /** 是否正在播放 */
  get isPlaying(): boolean {
    return this._isPlaying
  }

  /** 是否处于暂停状态 */
  get isPaused(): boolean {
    return this._isPaused
  }

  /** 是否已初始化 */
  get isReady(): boolean {
    return this.audioContext !== null && this.audioBuffer !== null
  }

  /**
   * 获取当前播放位置（毫秒）
   */
  getPositionMs(): number {
    if (!this.audioContext) return 0
    if (this._isPaused) {
      return Math.round(this._pausedOffset * 1000)
    }
    if (!this._isPlaying) {
      return this._pausedOffset > 0 ? Math.round(this._pausedOffset * 1000) : 0
    }
    return Math.round(this.getPositionSeconds() * 1000)
  }

  /**
   * 获取当前播放位置（秒）
   */
  getPositionSeconds(): number {
    if (!this.audioContext || !this._isPlaying) return this._pausedOffset
    const elapsed = this.audioContext.currentTime - this._startTime
    return Math.max(0, elapsed)
  }

  /**
   * 获取音频总时长（毫秒）
   */
  getDurationMs(): number {
    return Math.round(this._duration * 1000)
  }

  /**
   * 获取采样率
   */
  get sampleRate(): number {
    return this._sampleRate
  }

  /**
   * 获取声道数
   */
  get channels(): number {
    return this._channels
  }

  // ====== 事件回调 ======

  /**
   * 设置播放结束回调
   * @param callback 回调函数
   */
  setOnEnded(callback: (() => void) | null): void {
    this.onEndedCallback = callback
  }

  // ====== 内部方法 ======

  /**
   * 为音频源挂载结束处理
   * 交叉淡化中 sourceA 自然结束即视为过渡完成（收尾提升 sourceB）；
   * 常规结束则复位播放状态并触发 onEndedCallback
   */
  private attachSourceEndedHandler(src: AudioBufferSourceNode): void {
    src.onended = () => {
      if (this._isCrossfading) {
        // 交叉淡化收尾：sourceA 自然结束，sourceB 已接管播放（_isPlaying 保持 true）
        this.finalizeCrossfade()
        return
      }
      this._isPlaying = false
      this._isPaused = false
      if (this.sourceA?.buffer === this.audioBuffer) {
        this.onEndedCallback?.()
      }
    }
  }

  /**
   * 停止并清理当前/待播 source 节点（双源）
   */
  private stopSourceNode(): void {
    if (this.sourceA) {
      try {
        this.sourceA.onended = null
        this.sourceA.stop()
      } catch {
        // 可能已经停止
      }
      this.sourceA.disconnect()
      this.sourceA = null
    }
    if (this.sourceB) {
      try {
        this.sourceB.onended = null
        this.sourceB.stop()
      } catch {
        // 可能已经停止
      }
      this.sourceB.disconnect()
      this.sourceB = null
    }
  }
}

/** 全局 Web Audio 引擎单例 */
export const webAudioOutputEngine = new WebAudioOutputEngine()

export default webAudioOutputEngine
