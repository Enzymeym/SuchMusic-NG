/**
 * 虚拟低频增强处理器
 * 
 * 基于心理声学「基音缺失」(Missing Fundamental) 原理：
 * 当播放基频的谐波序列时，大脑会感知到基频音调，即使基频本身不存在。
 * 
 * 算法流程：
 * Input → LowPassFilter → WaveShaper(谐波生成) → BandPassFilter → GainNode ──┐
 *   │                                                                         ├→ Output
 *   └→ HighPassFilter(干信号直通) ───────────────────────────────────────────┘
 */

/**
 * 虚拟低频处理器参数
 */
export interface VirtualBassParams {
  /** 是否启用 */
  enabled: boolean
  /** 力度 0-100，控制虚拟低音的混合强度 */
  intensity: number
  /** 分频点频率，低于此频率的信号会被处理，默认 120Hz */
  crossoverFreq: number
}

/**
 * 虚拟低频处理器类
 * 使用 Web Audio API 实现虚拟低频增强
 */
export class VirtualBassProcessor {
  private audioContext: AudioContext | null = null
  private lowPassFilter: BiquadFilterNode | null = null
  private highPassFilter: BiquadFilterNode | null = null
  private bandPassFilter: BiquadFilterNode | null = null
  private waveShaper: WaveShaperNode | null = null
  private wetGainNode: GainNode | null = null
  private dryGainNode: GainNode | null = null
  private mixGainNode: GainNode | null = null
  private enabled: boolean = false

  /** 当前参数 */
  private params: VirtualBassParams = {
    enabled: false,
    intensity: 50,
    crossoverFreq: 120
  }

  /**
   * 将虚拟低频处理器接入音频图
   * @param source - 音频源节点
   * @param destination - 音频目标节点
   */
  public connect(source: AudioNode, destination: AudioNode): void {
    const ctx = source.context as AudioContext
    this.audioContext = ctx

    // 创建低通滤波器 —— 提取低频成分（用于谐波生成）
    this.lowPassFilter = ctx.createBiquadFilter()
    this.lowPassFilter.type = 'lowpass'
    this.lowPassFilter.frequency.value = this.params.crossoverFreq
    this.lowPassFilter.Q.value = 0.7

    // 创建高通滤波器 —— 干信号高频直通
    this.highPassFilter = ctx.createBiquadFilter()
    this.highPassFilter.type = 'highpass'
    this.highPassFilter.frequency.value = this.params.crossoverFreq
    this.highPassFilter.Q.value = 0.7

    // 创建波形整形器 —— 生成谐波（软削波产生奇次和偶次谐波）
    this.waveShaper = ctx.createWaveShaper()
    this.waveShaper.curve = this.createHarmonicCurve() as any
    this.waveShaper.oversample = '2x'

    // 创建带通滤波器 —— 滤除直流分量和过高的高次谐波，保留 2/3/4 次谐波范围
    this.bandPassFilter = ctx.createBiquadFilter()
    this.bandPassFilter.type = 'bandpass'
    this.bandPassFilter.frequency.value = this.params.crossoverFreq * 2
    this.bandPassFilter.Q.value = 1.5

    // 创建湿信号增益节点 —— 控制虚拟低音的混合量
    this.wetGainNode = ctx.createGain()
    this.wetGainNode.gain.value = 0

    // 创建干信号增益节点 —— 高频直通
    this.dryGainNode = ctx.createGain()
    this.dryGainNode.gain.value = 1

    // 创建最终混音增益节点
    this.mixGainNode = ctx.createGain()
    this.mixGainNode.gain.value = 1

    // 构建音频图：
    // source → lowPassFilter → waveShaper → bandPassFilter → wetGainNode ──┐
    // source → highPassFilter → dryGainNode ──────────────────────────────┤
    //                                                                      ↓
    //                                                                  mixGainNode → destination
    source.connect(this.lowPassFilter)
    this.lowPassFilter.connect(this.waveShaper)
    this.waveShaper.connect(this.bandPassFilter)
    this.bandPassFilter.connect(this.wetGainNode)
    this.wetGainNode.connect(this.mixGainNode)

    source.connect(this.highPassFilter)
    this.highPassFilter.connect(this.dryGainNode)
    this.dryGainNode.connect(this.mixGainNode)

    this.mixGainNode.connect(destination)
  }

  /**
   * 断开音频连接
   */
  public disconnect(): void {
    try {
      this.lowPassFilter?.disconnect()
      this.highPassFilter?.disconnect()
      this.waveShaper?.disconnect()
      this.bandPassFilter?.disconnect()
      this.wetGainNode?.disconnect()
      this.dryGainNode?.disconnect()
      this.mixGainNode?.disconnect()
    } catch (e) {
      // 忽略断开错误
    }
  }

  /**
   * 释放资源
   */
  public dispose(): void {
    this.disconnect()
    this.lowPassFilter = null
    this.highPassFilter = null
    this.waveShaper = null
    this.bandPassFilter = null
    this.wetGainNode = null
    this.dryGainNode = null
    this.mixGainNode = null
    this.audioContext = null
  }

  /**
   * 设置参数
   * @param params - 虚拟低频参数（部分更新）
   */
  public setParams(params: Partial<VirtualBassParams>): void {
    if (params.enabled !== undefined) {
      this.enabled = params.enabled
      this.params.enabled = params.enabled
    }
    if (params.intensity !== undefined) {
      this.params.intensity = Math.min(100, Math.max(0, params.intensity))
    }
    if (params.crossoverFreq !== undefined) {
      this.params.crossoverFreq = params.crossoverFreq
    }

    this.applyParams()
  }

  /**
   * 应用当前参数到音频节点
   */
  private applyParams(): void {
    if (!this.audioContext) return

    // 更新分频点
    if (this.lowPassFilter) {
      this.lowPassFilter.frequency.setTargetAtTime(
        this.params.crossoverFreq,
        this.audioContext.currentTime,
        0.015
      )
    }
    if (this.highPassFilter) {
      this.highPassFilter.frequency.setTargetAtTime(
        this.params.crossoverFreq,
        this.audioContext.currentTime,
        0.015
      )
    }
    if (this.bandPassFilter) {
      this.bandPassFilter.frequency.setTargetAtTime(
        this.params.crossoverFreq * 2,
        this.audioContext.currentTime,
        0.015
      )
    }

    // 更新混合量：启用时按力度设置湿信号增益，关闭时湿信号增益为 0
    if (this.wetGainNode) {
      const targetGain = this.enabled ? this.params.intensity / 100 : 0
      this.wetGainNode.gain.setTargetAtTime(
        targetGain,
        this.audioContext.currentTime,
        0.015
      )
    }
  }

  /**
   * 创建谐波生成曲线
   * 使用不对称软削波曲线生成丰富的偶次和奇次谐波
   * @returns 波形整形曲线数组
   */
  private createHarmonicCurve(): Float32Array {
    const curve = new Float32Array(65536)
    const length = 65536
    for (let i = 0; i < length; i++) {
      const x = (i - length / 2) / (length / 2) // [-1, 1]
      // 不对称软削波：正半周使用更缓的曲线产生更多偶次谐波
      if (x > 0) {
        // 正半周：温和压缩，产生丰富谐波
        curve[i] = Math.tanh(x * 3.0) / Math.tanh(3.0) * 0.8
      } else {
        // 负半周：稍强压缩，产生不对称谐波
        curve[i] = Math.tanh(x * 4.5) / Math.tanh(4.5) * 0.85
      }
    }
    return curve
  }

  /**
   * 获取当前参数
   * @returns 当前参数对象
   */
  public getParams(): VirtualBassParams {
    return { ...this.params }
  }
}
