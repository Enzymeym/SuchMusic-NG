/**
 * Web Audio API DSP 处理链
 *
 * 在渲染进程中用原生 Web Audio API 节点构建完整的音频效果处理链，
 * 与 Rust 引擎的 DSP 链功能对等。在 Web Audio 输出模式下使用。
 *
 * 处理链顺序：
 *   input → EQ (10x BiquadFilter) → Loudness (EQ 响度补偿 + 低音量补偿架)
 *         → Compressor → Limiter → Virtual Bass → Soft Clipper → output
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
  /** 阈值（dB，对应 ceiling） */
  ceiling: number
  release: number
  /** 启动时间（ms，可选，默认 5） */
  attack?: number
  /** 限幅比（可选，默认 20） */
  ratio?: number
  /** 后增益（dB，可选，默认 0） */
  postGain?: number
}

/**
 * 等响度参数
 *
 * 包含两套互相独立的响度处理：
 * 1. **EQ 响度补偿**（`enabled` / `compensation`）：调整 EQ 后保持整体响度与调整前一致。
 *    DSP 按各频段在整体响度中的权重算出当前 PEQ 曲线带来的响度变化，再施加等量反向增益。
 * 2. **低音量高低频补偿**（`followVolume` / `followStrength` / `referenceLoudness`）：
 *    Fletcher-Munson 近似 —— 音量越低，人耳对高低频越不敏感，因此按音量缺口自动提升两端。
 */
export interface LoudnessParams {
  /** EQ 响度补偿开关 */
  enabled: boolean
  /** EQ 响度补偿强度倍率：0 = 不补偿，1 = 完全抵消 EQ 引起的响度变化（默认），最大 2 */
  compensation: number
  /** 低音量高低频补偿开关（Fletcher-Munson 近似） */
  followVolume?: boolean
  /** 低音量补偿强度倍率（0 ~ 2，1 = 默认） */
  followStrength?: number
  /** 基准音量（dB，0 = 满音量）：音量低于该值才开始低音量补偿 */
  referenceLoudness?: number
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

/**
 * 各频段在「整体响度」中的权重（与 EQ_BAND_FREQUENCIES 一一对应，和为 1）。
 *
 * 近似依据：等频程带宽下粉噪声谱能量近似均匀，再叠加人耳在 250Hz~4kHz
 * 的等响敏感度峰值 —— 因此中频段权重最高，两端最低。
 * 用它加权平均各频段增益，即得到该 EQ 曲线对整体响度的净影响（dB）。
 */
export const LOUDNESS_BAND_WEIGHTS = [0.05, 0.08, 0.11, 0.14, 0.14, 0.14, 0.13, 0.11, 0.06, 0.04]

/**
 * 计算一组 EQ 增益（dB）对整体响度的净影响（dB）。
 *
 * 返回正数表示该曲线整体变响，负数表示变轻；等响度补偿即取相反数。
 */
export function computeEqLoudnessDb(gains: number[]): number {
  let weighted = 0
  let total = 0
  const n = Math.min(gains.length, LOUDNESS_BAND_WEIGHTS.length)
  for (let i = 0; i < n; i++) {
    const g = gains[i]
    if (typeof g !== 'number' || !Number.isFinite(g)) continue
    weighted += g * LOUDNESS_BAND_WEIGHTS[i]
    total += LOUDNESS_BAND_WEIGHTS[i]
  }
  return total > 0 ? weighted / total : 0
}

/** 等响度补偿增益的下限 / 上限（dB）：削得多一些，补得保守一些，避免削顶 */
export const LOUDNESS_COMP_MIN_DB = -18
export const LOUDNESS_COMP_MAX_DB = 12


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
  private limiterMakeupGain: GainNode | null = null
  private _limiterEnabled = false
  private limiterAttack = 5
  private limiterRatio = 20
  private limiterPostGain = 0

  // === 等响度节点 ===
  /** EQ 响度补偿增益：按 PEQ 曲线反向补偿整体响度 */
  private loudnessGainNode: GainNode | null = null
  /** 低音量补偿：低架 / 高架 */
  private loudnessLowShelf: BiquadFilterNode | null = null
  private loudnessHighShelf: BiquadFilterNode | null = null
  private _loudnessEnabled = false
  /** EQ 补偿强度倍率（0~2，1 = 完全补偿） */
  private loudnessCompensation = 1.0
  /** 最近一次实际下发的 EQ 补偿增益（dB），供 UI 回读 */
  private _loudnessCompDb = 0
  /** 低音量高低频补偿开关 */
  private _loudnessFollowVolume = false
  /** 低音量补偿强度倍率（0~2） */
  private loudnessFollowStrength = 1.0
  /** 基准音量（dB，0dB = 满音量），低于该值才开始低音量补偿 */
  private loudnessReferenceDb = 0
  /** 当前音量换算出的 dB（满音量 = 0dB） */
  private loudnessVolumeDb = 0
  /** 最近一次实际下发的低/高频提升量（dB），供 UI 回读 */
  private _loudnessLowBoost = 0
  private _loudnessHighBoost = 0

  /** 低音量补偿的上限（dB） */
  private static readonly FOLLOW_LOW_MAX_DB = 15
  private static readonly FOLLOW_HIGH_MAX_DB = 12
  /** 音量缺口达到该值（dB）时补偿到达上限 */
  private static readonly FOLLOW_FULL_DEFICIT_DB = 30

  // === 声道平衡节点（分频→左右独立增益→合并） ===
  private balanceSplitter: ChannelSplitterNode | null = null
  private balanceGainL: GainNode | null = null
  private balanceGainR: GainNode | null = null
  private balanceMerger: ChannelMergerNode | null = null
  private _balanceEnabled = false
  private balanceLDb = 0
  private balanceRDb = 0

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
  private _builtNodes: AudioNode[] = [] // 缓存已构建的内部节点，用于重建时复用
  private _ctx: BaseAudioContext | null = null

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
   * 首次调用时构建全部内部节点，后续调用仅重新连线输入/输出
   * @param inputNode 输入节点（通常为音量 GainNode）
   * @param outputNode 输出节点（通常为 ctx.destination）
   */
  connect(inputNode: AudioNode, outputNode: AudioNode): void {
    const ctx = inputNode.context as BaseAudioContext

    // 如果已构建内部节点且 AudioContext 未变，仅重新连线输入/输出
    if (this._builtNodes.length > 0 && this._ctx === ctx) {
      // 注意：这里不能先断开 eqNodes[0] 的全部输出 —— AudioNode.disconnect()
      // 会切断其所有输出连接（包括 EQ[0] → EQ[1] 的内部链），导致整条链路静音。
      // 旧的外部输入连接由调用方（masterGain.disconnect）清理，重复 connect
      // 同一输入/输出对是幂等的，因此直接接线即可。
      this.wireInputOutput(inputNode, outputNode)
      this._isConnected = true
      return
    }

    // 首次构建或 AudioContext 已变更：完整重建
    this.disconnect()
    this._ctx = ctx
    this.buildChain(ctx, inputNode, outputNode)
    this._isConnected = true

    // 应用已保存的参数
    this.syncAllParams()
  }

  /** 构建完整 DSP 节点链（仅首次或 AudioContext 变更时调用） */
  private buildChain(ctx: BaseAudioContext, inputNode: AudioNode, outputNode: AudioNode): void {
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

    // --- Loudness：EQ 响度补偿增益 + 低音量高低频补偿架 ---
    // 放在压缩/限幅之前：提升量（低音量补偿最多 +15dB）会被后级限幅器接住，
    // 不会在链路末端直接削顶；关闭动态处理时位置无影响。
    this.loudnessGainNode = ctx.createGain()
    this.loudnessGainNode.gain.value = 1
    prevNode.connect(this.loudnessGainNode)
    prevNode = this.loudnessGainNode

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

    // --- Limiter 后增益 ---
    this.limiterMakeupGain = ctx.createGain()
    this.limiterMakeupGain.gain.value = 1
    prevNode.connect(this.limiterMakeupGain)
    prevNode = this.limiterMakeupGain

    // --- Virtual Bass (parallel: dry + waveshaper) ---
    this.virtualBassDryGain = ctx.createGain()
    this.virtualBassDryGain.gain.value = 1
    prevNode.connect(this.virtualBassDryGain)

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

    // --- 声道平衡（L/R 独立增益）---
    this.balanceSplitter = ctx.createChannelSplitter(2)
    this.balanceGainL = ctx.createGain()
    this.balanceGainR = ctx.createGain()
    this.balanceMerger = ctx.createChannelMerger(2)
    prevNode.connect(this.balanceSplitter)
    this.balanceSplitter.connect(this.balanceGainL, 0)
    this.balanceSplitter.connect(this.balanceGainR, 1)
    this.balanceGainL.connect(this.balanceMerger, 0, 0)
    this.balanceGainR.connect(this.balanceMerger, 0, 1)
    prevNode = this.balanceMerger

    // 输出
    prevNode.connect(outputNode)

    // 缓存所有内部节点的引用
    this._builtNodes = [
      ...this.eqNodes,
      this.loudnessGainNode, this.loudnessLowShelf, this.loudnessHighShelf,
      this.compressorNode, this.limiterNode, this.limiterMakeupGain,
      this.virtualBassLowpass, this.virtualBassShaper,
      this.virtualBassWetGain, this.virtualBassDryGain, this.virtualBassMixGain,
      this.softClipperNode, this.softClipperPreGain, this.softClipperPostGain,
      this.balanceSplitter, this.balanceGainL, this.balanceGainR, this.balanceMerger
    ].filter((n): n is NonNullable<typeof n> => n != null)
  }

  /** 仅连接输入/输出（内部链已在 buildChain 中连接好，无需重建） */
  private wireInputOutput(inputNode: AudioNode, outputNode: AudioNode): void {
    // 先断开输出端的旧连接：只断链的末端节点即可清理上次接线遗留的输出，
    // 绝不能动 eqNodes[0] —— AudioNode.disconnect() 会切断其所有输出
    // （含 EQ[0] → EQ[1] 内部链），导致整条链路静音。
    try { this.balanceMerger?.disconnect() } catch { /* ignore */ }
    // 输入：inputNode → 第一个 EQ 节点
    if (this.eqNodes.length > 0) {
      inputNode.connect(this.eqNodes[0])
    }
    // 输出：末端节点（balanceMerger）→ outputNode
    if (this.balanceMerger) {
      this.balanceMerger.connect(outputNode)
    }
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
      this.loudnessGainNode, this.loudnessLowShelf, this.loudnessHighShelf,
      this.compressorNode, this.limiterNode, this.limiterMakeupGain,
      this.virtualBassLowpass, this.virtualBassShaper,
      this.virtualBassWetGain, this.virtualBassDryGain, this.virtualBassMixGain,
      this.softClipperNode, this.softClipperPreGain, this.softClipperPostGain,
      this.balanceSplitter, this.balanceGainL, this.balanceGainR, this.balanceMerger
    ]
    nodes.forEach((n) => {
      if (n) {
        try { n.disconnect() } catch { /* ignore */ }
      }
    })

    this.compressorNode = null
    this.limiterNode = null
    this.limiterMakeupGain = null
    this.loudnessGainNode = null
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
    this.balanceSplitter = null
    this.balanceGainL = null
    this.balanceGainR = null
    this.balanceMerger = null

    this._builtNodes = []
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
    this.syncBalance()
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
    // 单频段变化同样影响整体响度，保持等响度补偿跟随
    this.syncLoudness()
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
    if (this._isConnected) {
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
    // EQ 曲线变化会改变整体响度，需同步等响度补偿
    this.syncLoudness()
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
   * 设置限制器参数（阈值 / 释放 / 启动时间 / 限幅比 / 后增益）
   */
  setLimiterParams(params: LimiterParams): void {
    if (params.attack !== undefined) this.limiterAttack = params.attack
    if (params.ratio !== undefined) this.limiterRatio = params.ratio
    if (params.postGain !== undefined) this.limiterPostGain = params.postGain
    if (!this.limiterNode) return
    this.limiterNode.threshold.value = params.ceiling
    this.limiterNode.release.value = Math.max(0.001, params.release / 1000)
    this.syncLimiter()
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
      // 应用用户设置的启动时间 / 限幅比，knee=0 使其接近砖墙限制器
      this.limiterNode.ratio.value = Math.max(1, Math.min(20, this.limiterRatio))
      this.limiterNode.attack.value = Math.max(0.0001, this.limiterAttack / 1000)
      this.limiterNode.knee.value = 0
    } else {
      this.applyLimiterDefaults()
    }
    // 限制器后增益：任一状态下都按用户设定应用（关闭时为 0dB → 1x）
    if (this.limiterMakeupGain) {
      const db = this._limiterEnabled ? this.limiterPostGain : 0
      this.limiterMakeupGain.gain.value = Math.pow(10, db / 20)
    }
    // threshold 和 release 由 setLimiterParams 设置
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
    if (params.compensation !== undefined) {
      this.loudnessCompensation = Math.max(0, Math.min(2, params.compensation))
    }
    if (params.followVolume !== undefined) this._loudnessFollowVolume = params.followVolume
    if (params.followStrength !== undefined) {
      this.loudnessFollowStrength = Math.max(0, Math.min(2, params.followStrength))
    }
    if (params.referenceLoudness !== undefined) {
      this.loudnessReferenceDb = Math.max(-40, Math.min(0, params.referenceLoudness))
    }
    this.syncLoudness()
  }

  /**
   * 上报当前播放音量（0..1），用于低音量高低频补偿。
   * 满音量 = 0dB，音量越低该值越负，补偿量随之增大。
   */
  setLoudnessVolume(volume: number): void {
    const v = Math.max(0.0001, Math.min(1, volume))
    this.loudnessVolumeDb = 20 * Math.log10(v)
    this.syncLoudness()
  }

  /** 当前实际下发的 EQ 响度补偿增益（dB，正数=提升），供 UI 回读显示 */
  get loudnessCompensationDb(): number {
    return this._loudnessCompDb
  }

  /** 当前实际下发的低频提升量（dB），供 UI 回读显示 */
  get loudnessLowBoost(): number {
    return this._loudnessLowBoost
  }

  /** 当前实际下发的高频提升量（dB），供 UI 回读显示 */
  get loudnessHighBoost(): number {
    return this._loudnessHighBoost
  }

  /**
   * 同步等响度两个部分。
   */
  private syncLoudness(): void {
    // --- 1) EQ 响度补偿：调整 EQ 后保持整体响度与调整前一致 ---
    // 按频段权重求出当前 PEQ 曲线带来的响度变化，再施加等量反向增益；
    // 例如整体 +3dB 的曲线会被补偿 -3dB，音色变了但响度不变。EQ 旁通时不补偿。
    if (this.loudnessGainNode) {
      let compDb = 0
      if (this._loudnessEnabled && this._eqEnabled) {
        const loudnessDelta = computeEqLoudnessDb(this.eqBandSettings.map((b) => b.preGain))
        compDb = Math.max(
          LOUDNESS_COMP_MIN_DB,
          Math.min(LOUDNESS_COMP_MAX_DB, -loudnessDelta * this.loudnessCompensation)
        )
      }
      this._loudnessCompDb = compDb
      this.loudnessGainNode.gain.value = Math.pow(10, compDb / 20)
    }

    // --- 2) 低音量高低频补偿（Fletcher-Munson 近似）---
    if (!this.loudnessLowShelf || !this.loudnessHighShelf) return
    if (this._loudnessFollowVolume) {
      // 音量缺口：比基准低多少 dB（高于基准则为 0，不补偿）
      const deficitDb = Math.max(
        0,
        Math.min(
          WebAudioDspChain.FOLLOW_FULL_DEFICIT_DB,
          this.loudnessReferenceDb - this.loudnessVolumeDb
        )
      )
      const ratio =
        (deficitDb / WebAudioDspChain.FOLLOW_FULL_DEFICIT_DB) * this.loudnessFollowStrength
      const lowBoost = Math.min(ratio * WebAudioDspChain.FOLLOW_LOW_MAX_DB, 18)
      const highBoost = Math.min(ratio * WebAudioDspChain.FOLLOW_HIGH_MAX_DB, 15)
      this._loudnessLowBoost = lowBoost
      this._loudnessHighBoost = highBoost
      this.loudnessLowShelf.gain.value = lowBoost
      this.loudnessHighShelf.gain.value = highBoost
    } else {
      this._loudnessLowBoost = 0
      this._loudnessHighBoost = 0
      this.loudnessLowShelf.gain.value = 0
      this.loudnessHighShelf.gain.value = 0
    }
  }

  // ====== 虚拟低频控制 ======

  /**
   * 创建用于生成低频谐波的非线性曲线。
   *
   * 旧实现为 `sin(x * π/2 * drive*2)`：当 drive > 0.5 时自变量超过 π/2，
   * 曲线在 |x| 较大处回折（非单调），输入越大输出反而越小，产生折叠失真，
   * 听感是「越增强越糊/越乱」。改为归一化 tanh（严格单调奇对称）：
   * drive 越大谐波越丰富但永不回折，低音增强干净可控。
   */
  private makeSineShaperCurve(drive: number): Float32Array {
    const length = 1024
    const curve = new Float32Array(length)
    const k = 1 + Math.max(0, drive) * 3
    const norm = Math.tanh(k) || 1
    for (let i = 0; i < length; i++) {
      const x = (i / (length - 1)) * 2 - 1 // -1 to 1
      curve[i] = Math.tanh(k * x) / norm
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
      // 湿声（谐波）增益：控制在 0.35 以内，避免与干声直接相加后低频过冲
      this.virtualBassWetGain.gain.value = 0.35 * drive
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

  // ====== 声道平衡控制 ======

  /**
   * 设置声道平衡（L/R 独立增益，单位 dB）。
   * 关闭时左右均回到 0dB（1x）。
   */
  setChannelBalance(enabled: boolean, leftDb: number, rightDb: number): void {
    this._balanceEnabled = enabled
    this.balanceLDb = leftDb
    this.balanceRDb = rightDb
    this.syncBalance()
  }

  private syncBalance(): void {
    if (!this.balanceGainL || !this.balanceGainR) return
    // 钳制到 [-60, 12] dB：-60dB 近似静音，避免 Math.pow 出现 0/NaN
    const lDb = this._balanceEnabled ? Math.max(-60, Math.min(12, this.balanceLDb)) : 0
    const rDb = this._balanceEnabled ? Math.max(-60, Math.min(12, this.balanceRDb)) : 0
    this.balanceGainL.gain.value = Math.pow(10, lDb / 20)
    this.balanceGainR.gain.value = Math.pow(10, rDb / 20)
  }
}
