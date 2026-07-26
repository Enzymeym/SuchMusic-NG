/**
 * Web Audio API DSP 处理链
 *
 * 在渲染进程中用原生 Web Audio API 节点构建完整的音频效果处理链，
 * 与 Rust 引擎的 DSP 链功能对等。在 Web Audio 输出模式下使用。
 *
 * 处理链顺序：
 *   input → EQ (10x BiquadFilter) → Compressor → Limiter
 *         → Loudness (low/high shelf) → Virtual Bass → Soft Clipper → output
 *
 * 所有节点始终连接在链中；禁用效果时参数设置为中性值（旁通），
 * 避免动态重连带来的音频断续。
 */

// ====== DSP 参数类型（与 useAudioEngine 中定义等价，避免循环引用） ======

export interface EqBandSettings {
  frequency: number
  preGain: number
  postGain: number
  preQ: number
  postQ: number
  bandType?: 'lowShelf' | 'highShelf' | 'peaking' | 'notch'
}

export interface CompressorParams {
  threshold: number
  ratio: number
  attack: number
  release: number
  knee: number
}

export interface LimiterParams {
  ceiling: number
  release: number
}

export interface LoudnessParams {
  enabled: boolean
  compensation: number
  referenceLoudness: number
  direction: 'low' | 'high' | 'both'
}

export interface VirtualBassParams {
  enabled: boolean
  intensity: number
  crossoverFreq: number
}

export interface SoftClipperParams {
  enabled: boolean
  threshold: number
  makeupGain: number
}

// ====== 默认频段频率（10 段） ======
const EQ_BAND_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/** 将 Web Audio 滤波器类型字符串映射到 BiquadFilterType */
function toBiquadType(type: string): BiquadFilterType {
  switch (type) {
    case 'lowShelf': return 'lowshelf'
    case 'highShelf': return 'highshelf'
    case 'peaking': return 'peaking'
    case 'notch': return 'notch'
    default: return 'peaking'
  }
}

/**
 * Web Audio API DSP 处理链
 */
export class WebAudioDspChain {
  // === EQ 节点 ===
  private eqNodes: BiquadFilterNode[] = []
  private _eqEnabled = false
  private eqBandSettings: EqBandSettings[] = EQ_BAND_FREQUENCIES.map((freq) => ({
    frequency: freq,
    preGain: 0,
    postGain: 0,
    preQ: 1,
    postQ: 1,
    bandType: 'peaking' as const
  }))

  // === 压缩器节点 ===
  private compressorNode: DynamicsCompressorNode | null = null
  private _compressorEnabled = false

  // === 限制器节点 ===
  private limiterNode: DynamicsCompressorNode | null = null
  private _limiterEnabled = false

  // === 等响度节点 ===
  private loudnessLowShelf: BiquadFilterNode | null = null
  private loudnessHighShelf: BiquadFilterNode | null = null
  private _loudnessEnabled = false
  private loudnessCompensation = 1.0
  private loudnessDirection: 'low' | 'high' | 'both' = 'both'

  // === 虚拟低频节点 ===
  private virtualBassLowpass: BiquadFilterNode | null = null
  private virtualBassShaper: WaveShaperNode | null = null
  private virtualBassWetGain: GainNode | null = null
  private virtualBassDryGain: GainNode | null = null
  private virtualBassMixGain: GainNode | null = null
  private _virtualBassEnabled = false
  private virtualBassIntensity = 50
  private virtualBassCrossover = 120

  // === 软限幅器节点 ===
  private softClipperNode: WaveShaperNode | null = null
  private softClipperPreGain: GainNode | null = null
  private softClipperPostGain: GainNode | null = null
  private _softClipperEnabled = false
  private softClipperThreshold = 2.0
  private softClipperMakeupGain = 0

  // === 链连接状态 ===
  private _isConnected = false

  // ====== 属性访问器 ======

  get eqEnabled(): boolean { return this._eqEnabled }
  get compressorEnabled(): boolean { return this._compressorEnabled }
  get limiterEnabled(): boolean { return this._limiterEnabled }
  get loudnessEnabled(): boolean { return this._loudnessEnabled }
  get virtualBassEnabled(): boolean { return this._virtualBassEnabled }
  get softClipperEnabled(): boolean { return this._softClipperEnabled }

  // ====== 生命周期 ======

  /**
   * 将 DSP 链插入到 inputNode → outputNode 之间
   * @param inputNode 输入节点（通常为音量 GainNode 或 AudioBufferSourceNode）
   * @param outputNode 输出节点（通常为 ctx.destination）
   */
  connect(inputNode: AudioNode, outputNode: AudioNode): void {
    const ctx = inputNode.context as BaseAudioContext
    this.disconnect()

    // 构建完整处理链
    let prevNode: AudioNode = inputNode

    // --- EQ (10 段 BiquadFilter) ---
    this.eqNodes = []
    for (let i = 0; i < 10; i++) {
      const filter = ctx.createBiquadFilter()
      const settings = this.eqBandSettings[i]
      filter.type = toBiquadType(settings.bandType || 'peaking')
      filter.frequency.value = settings.frequency
      filter.gain.value = this._eqEnabled ? settings.preGain : 0
      filter.Q.value = settings.preQ
      prevNode.connect(filter)
      prevNode = filter
      this.eqNodes.push(filter)
    }

    // --- Compressor ---
    this.compressorNode = ctx.createDynamicsCompressor()
    this.applyCompressorDefaults()
    prevNode.connect(this.compressorNode)
    prevNode = this.compressorNode

    // --- Limiter ---
    this.limiterNode = ctx.createDynamicsCompressor()
    this.applyLimiterDefaults()
    prevNode.connect(this.limiterNode)
    prevNode = this.limiterNode

    // --- Loudness (low shelf + high shelf) ---
    this.loudnessLowShelf = ctx.createBiquadFilter()
    this.loudnessLowShelf.type = 'lowshelf'
    this.loudnessLowShelf.frequency.value = 200
    this.loudnessLowShelf.gain.value = 0
    prevNode.connect(this.loudnessLowShelf)
    prevNode = this.loudnessLowShelf

    this.loudnessHighShelf = ctx.createBiquadFilter()
    this.loudnessHighShelf.type = 'highshelf'
    this.loudnessHighShelf.frequency.value = 8000
    this.loudnessHighShelf.gain.value = 0
    prevNode.connect(this.loudnessHighShelf)
    prevNode = this.loudnessHighShelf

    // --- Virtual Bass (parallel: dry + waveshaper) ---
    // Dry path
    this.virtualBassDryGain = ctx.createGain()
    this.virtualBassDryGain.gain.value = 1
    prevNode.connect(this.virtualBassDryGain)

    // Wet path
    this.virtualBassLowpass = ctx.createBiquadFilter()
    this.virtualBassLowpass.type = 'lowpass'
    this.virtualBassLowpass.frequency.value = this.virtualBassCrossover
    this.virtualBassLowpass.Q.value = 0.5
    prevNode.connect(this.virtualBassLowpass)

    this.virtualBassShaper = ctx.createWaveShaper()
    this.virtualBassShaper.curve = this.makeSineShaperCurve(0) as Float32Array<ArrayBuffer>
    this.virtualBassShaper.oversample = '2x'
    this.virtualBassLowpass.connect(this.virtualBassShaper)

    this.virtualBassWetGain = ctx.createGain()
    this.virtualBassWetGain.gain.value = 0
    this.virtualBassShaper.connect(this.virtualBassWetGain)

    // Mix both paths
    this.virtualBassMixGain = ctx.createGain()
    this.virtualBassMixGain.gain.value = 1
    this.virtualBassDryGain.connect(this.virtualBassMixGain)
    this.virtualBassWetGain.connect(this.virtualBassMixGain)
    prevNode = this.virtualBassMixGain

    // --- Soft Clipper ---
    this.softClipperPreGain = ctx.createGain()
    this.softClipperPreGain.gain.value = 1
    prevNode.connect(this.softClipperPreGain)
    prevNode = this.softClipperPreGain

    this.softClipperNode = ctx.createWaveShaper()
    this.softClipperNode.curve = this.makeLinearCurve() as Float32Array<ArrayBuffer>
    this.softClipperNode.oversample = 'none'
    prevNode.connect(this.softClipperNode)
    prevNode = this.softClipperNode

    this.softClipperPostGain = ctx.createGain()
    this.softClipperPostGain.gain.value = 1
    prevNode.connect(this.softClipperPostGain)
    prevNode = this.softClipperPostGain

    // 输出
    prevNode.connect(outputNode)

    this._isConnected = true

    // 应用已保存的参数
    this.syncAllParams()
  }

  /**
   * 断开所有节点连接并释放引用
   */
  disconnect(): void {
    this.eqNodes.forEach((n) => {
      try { n.disconnect() } catch { /* ignore */ }
    })
    this.eqNodes = []

    const nodes: (AudioNode | null)[] = [
      this.compressorNode, this.limiterNode,
      this.loudnessLowShelf, this.loudnessHighShelf,
      this.virtualBassLowpass, this.virtualBassShaper,
      this.virtualBassWetGain, this.virtualBassDryGain, this.virtualBassMixGain,
      this.softClipperNode, this.softClipperPreGain, this.softClipperPostGain
    ]
    nodes.forEach((n) => {
      if (n) {
        try { n.disconnect() } catch { /* ignore */ }
      }
    })

    this.compressorNode = null
    this.limiterNode = null
    this.loudnessLowShelf = null
    this.loudnessHighShelf = null
    this.virtualBassLowpass = null
    this.virtualBassShaper = null
    this.virtualBassWetGain = null
    this.virtualBassDryGain = null
    this.virtualBassMixGain = null
    this.softClipperNode = null
    this.softClipperPreGain = null
    this.softClipperPostGain = null

    this._isConnected = false
  }

  /**
   * 释放所有资源（disconnect + 清空 ctx 引用）
   */
  dispose(): void {
    this.disconnect()
  }

  // ====== 参数同步 ======

  /** 将所有内部状态同步到已连接的节点 */
  private syncAllParams(): void {
    if (!this._isConnected) return
    this.syncEq()
    this.syncCompressor()
    this.syncLimiter()
    this.syncLoudness()
    this.syncVirtualBass()
    this.syncSoftClipper()
  }

  // ====== EQ 控制 ======

  /**
   * 设置 EQ 启用状态
   */
  setEqEnabled(enabled: boolean): void {
    this._eqEnabled = enabled
    this.syncEq()
  }

  /**
   * 设置单个 EQ 频段参数
   */
  setEqBand(index: number, settings: Partial<EqBandSettings>): void {
    if (index < 0 || index >= this.eqBandSettings.length) return
    const current = this.eqBandSettings[index]
    this.eqBandSettings[index] = { ...current, ...settings }

    if (this._isConnected && this.eqNodes[index]) {
      const band = this.eqBandSettings[index]
      const filter = this.eqNodes[index]
      filter.type = toBiquadType(band.bandType || 'peaking')
      filter.frequency.value = band.frequency
      filter.gain.value = this._eqEnabled ? band.preGain : 0
      filter.Q.value = band.preQ
    }
  }

  /**
   * 设置所有 EQ 频段增益（preGain）
   */
  setEqGains(gains: number[]): void {
    for (let i = 0; i < Math.min(gains.length, this.eqBandSettings.length); i++) {
      this.eqBandSettings[i] = { ...this.eqBandSettings[i], preGain: gains[i] }
    }
    this.syncEq()
  }

  private syncEq(): void {
    if (!this._isConnected) return
    for (let i = 0; i < this.eqNodes.length; i++) {
      const filter = this.eqNodes[i]
      const settings = this.eqBandSettings[i]
      if (filter) {
        filter.type = toBiquadType(settings.bandType || 'peaking')
        filter.frequency.value = settings.frequency
        filter.gain.value = this._eqEnabled ? settings.preGain : 0
        filter.Q.value = settings.preQ
      }
    }
  }

  // ====== 压缩器控制 ======

  /**
   * 设置压缩器启用状态
   */
  setCompressorEnabled(enabled: boolean): void {
    this._compressorEnabled = enabled
    this.syncCompressor()
  }

  /**
   * 设置压缩器参数
   */
  setCompressorParams(params: CompressorParams): void {
    if (this.compressorNode) {
      this.compressorNode.threshold.value = params.threshold
      this.compressorNode.ratio.value = params.ratio
      this.compressorNode.attack.value = Math.max(0.0001, params.attack / 1000)
      this.compressorNode.release.value = Math.max(0.001, params.release / 1000)
      this.compressorNode.knee.value = params.knee
    }
  }

  /**
   * 获取压缩器增益减少量（dB）
   */
  getCompressorGainReduction(): number {
    if (!this.compressorNode || !this._compressorEnabled) return 0
    return this.compressorNode.reduction
  }

  private applyCompressorDefaults(): void {
    if (!this.compressorNode) return
    this.compressorNode.threshold.value = 0
    this.compressorNode.ratio.value = 1
    this.compressorNode.attack.value = 0.0001
    this.compressorNode.release.value = 0.25
    this.compressorNode.knee.value = 40
  }

  private syncCompressor(): void {
    if (!this.compressorNode) return
    if (this._compressorEnabled) {
      // 参数由 setCompressorParams 设置，这里不作改动
    } else {
      this.applyCompressorDefaults()
    }
  }

  // ====== 限制器控制 ======

  /**
   * 设置限制器启用状态
   */
  setLimiterEnabled(enabled: boolean): void {
    this._limiterEnabled = enabled
    this.syncLimiter()
  }

  /**
   * 设置限制器参数
   */
  setLimiterParams(params: LimiterParams): void {
    if (!this.limiterNode) return
    this.limiterNode.threshold.value = params.ceiling
    this.limiterNode.release.value = Math.max(0.001, params.release / 1000)
  }

  /**
   * 获取限制器增益减少量（dB）
   */
  getLimiterGainReduction(): number {
    if (!this.limiterNode || !this._limiterEnabled) return 0
    return this.limiterNode.reduction
  }

  private applyLimiterDefaults(): void {
    if (!this.limiterNode) return
    this.limiterNode.threshold.value = 0
    this.limiterNode.ratio.value = 1
    this.limiterNode.attack.value = 0.0001
    this.limiterNode.release.value = 0.05
    this.limiterNode.knee.value = 40
  }

  private syncLimiter(): void {
    if (!this.limiterNode) return
    if (this._limiterEnabled) {
      // 配置为砖墙限制器
      this.limiterNode.ratio.value = 20
      this.limiterNode.attack.value = 0.0001
      this.limiterNode.knee.value = 0
    } else {
      this.applyLimiterDefaults()
    }
    // threshold 和 release 由 setLimiterParams 设置，仅在 enabled 时生效
  }

  // ====== 等响度控制 ======

  /**
   * 设置等响度启用状态
   */
  setLoudnessEnabled(enabled: boolean): void {
    this._loudnessEnabled = enabled
    this.syncLoudness()
  }

  /**
   * 设置等响度参数
   */
  setLoudnessParams(params: LoudnessParams): void {
    if (params.enabled !== undefined) this._loudnessEnabled = params.enabled
    if (params.compensation !== undefined) this.loudnessCompensation = params.compensation
    if (params.direction !== undefined) this.loudnessDirection = params.direction
    this.syncLoudness()
  }

  private syncLoudness(): void {
    if (!this.loudnessLowShelf || !this.loudnessHighShelf) return
    if (this._loudnessEnabled) {
      // 基于 Fletcher-Munson 近似：低频 + 高频提升
      const comp = this.loudnessCompensation
      // 参考响度越低，补偿越大（反向关系）
      const lowBoost = this.loudnessDirection === 'high' ? 0 : comp * 6
      const highBoost = this.loudnessDirection === 'low' ? 0 : comp * 4
      this.loudnessLowShelf.gain.value = lowBoost
      this.loudnessHighShelf.gain.value = highBoost
    } else {
      this.loudnessLowShelf.gain.value = 0
      this.loudnessHighShelf.gain.value = 0
    }
  }

  // ====== 虚拟低频控制 ======

  /** 创建正弦波形整形曲线，用于生成谐波 */
  private makeSineShaperCurve(drive: number): Float32Array {
    const length = 1024
    const curve = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const x = (i / (length - 1)) * 2 - 1 // -1 to 1
      curve[i] = Math.sin(x * Math.PI * 0.5 * Math.max(0.1, drive * 2))
    }
    return curve
  }

  /**
   * 设置虚拟低频启用状态
   */
  setVirtualBassEnabled(enabled: boolean): void {
    this._virtualBassEnabled = enabled
    this.syncVirtualBass()
  }

  /**
   * 设置虚拟低频参数
   */
  setVirtualBassParams(params: VirtualBassParams): void {
    if (params.enabled !== undefined) this._virtualBassEnabled = params.enabled
    if (params.intensity !== undefined) this.virtualBassIntensity = params.intensity
    if (params.crossoverFreq !== undefined) this.virtualBassCrossover = params.crossoverFreq
    this.syncVirtualBass()
  }

  private syncVirtualBass(): void {
    if (!this.virtualBassLowpass || !this.virtualBassWetGain) return

    // 更新分频点
    this.virtualBassLowpass.frequency.value = this.virtualBassCrossover

    if (this._virtualBassEnabled) {
      // 更新波形整形曲线（驱动量基于 intensity）
      const drive = this.virtualBassIntensity / 100
      if (this.virtualBassShaper) {
        this.virtualBassShaper.curve = this.makeSineShaperCurve(drive) as Float32Array<ArrayBuffer>
      }
      this.virtualBassWetGain.gain.value = 0.5 * drive
    } else {
      this.virtualBassWetGain.gain.value = 0
    }
  }

  // ====== 软限幅器控制 ======

  /** 创建线性曲线（旁通） */
  private makeLinearCurve(): Float32Array {
    const length = 1024
    const curve = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const x = (i / (length - 1)) * 2 - 1
      curve[i] = x
    }
    return curve
  }

  /** 创建 tanh 软限幅曲线 */
  private makeTanhClipperCurve(threshold: number, makeupGain: number): Float32Array {
    const length = 1024
    const curve = new Float32Array(length)
    const t = Math.max(0.1, threshold)
    for (let i = 0; i < length; i++) {
      const x = (i / (length - 1)) * 2 - 1
      // y = tanh(x / threshold) * threshold，然后加 makeup gain
      let y = Math.tanh(x / t) * t
      // 应用补偿增益
      y *= Math.pow(10, makeupGain / 20)
      curve[i] = y
    }
    return curve
  }

  /**
   * 设置软限幅器启用状态
   */
  setSoftClipperEnabled(enabled: boolean): void {
    this._softClipperEnabled = enabled
    this.syncSoftClipper()
  }

  /**
   * 设置软限幅器参数
   */
  setSoftClipperParams(params: SoftClipperParams): void {
    if (params.enabled !== undefined) this._softClipperEnabled = params.enabled
    if (params.threshold !== undefined) {
      this.softClipperThreshold = params.threshold
      if (this.softClipperPreGain) {
        this.softClipperPreGain.gain.value = Math.max(1, 3 / params.threshold)
      }
    }
    if (params.makeupGain !== undefined) {
      this.softClipperMakeupGain = params.makeupGain
      if (this.softClipperPostGain) {
        this.softClipperPostGain.gain.value = Math.pow(10, params.makeupGain / 20)
      }
    }
    this.syncSoftClipper()
  }

  private syncSoftClipper(): void {
    if (!this.softClipperNode) return
    if (this._softClipperEnabled) {
      this.softClipperNode.curve = this.makeTanhClipperCurve(
        this.softClipperThreshold, this.softClipperMakeupGain
      ) as Float32Array<ArrayBuffer>
      this.softClipperNode.oversample = '2x'
    } else {
      this.softClipperNode.curve = this.makeLinearCurve() as Float32Array<ArrayBuffer>
      this.softClipperNode.oversample = 'none'
    }
  }
}
