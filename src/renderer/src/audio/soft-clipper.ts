/**
 * 软限幅爆音抑制器
 * 
 * 使用 WaveShaperNode + tanh 曲线实现模拟风格的软限幅，
 * 在防止数字削波（clipping）的同时保持音频动态范围和自然音色。
 * 
 * 原理：
 * - tanh 曲线在信号接近 0dBFS 时逐渐饱和，而非硬切
 * - 通过 threshold 参数控制限幅起点
 * - makeupGain 补偿限幅造成的音量损失
 */

/**
 * 软限幅器参数
 */
export interface SoftClipperParams {
  /** 是否启用 */
  enabled: boolean
  /** 限幅阈值强度 [0.5, 5.0]，默认 2.0 */
  threshold: number
  /** 补偿增益 [0, 6] dB，默认 0 */
  makeupGain: number
}

/**
 * 软限幅器类
 * 实现模拟风格的爆音抑制
 */
export class SoftClipper {
  private audioContext: AudioContext | null = null
  private waveShaper: WaveShaperNode | null = null
  private makeupNode: GainNode | null = null
  private bypassGain: GainNode | null = null
  private enabled: boolean = false

  /** 当前参数 */
  private params: SoftClipperParams = {
    enabled: false,
    threshold: 2.0,
    makeupGain: 0
  }

  /**
   * 将软限幅器接入音频图
   * @param source - 音频源节点
   * @param destination - 音频目标节点
   */
  public connect(source: AudioNode, destination: AudioNode): void {
    const ctx = source.context as AudioContext
    this.audioContext = ctx

    // 创建波形整形器 —— 软限幅曲线
    this.waveShaper = ctx.createWaveShaper()
    this.waveShaper.curve = this.createSoftClipCurve(this.params.threshold) as any
    this.waveShaper.oversample = '2x'

    // 创建补偿增益节点
    this.makeupNode = ctx.createGain()
    this.makeupNode.gain.value = this.dbToLinear(this.params.makeupGain)

    // 旁路增益节点（禁用时直通）
    this.bypassGain = ctx.createGain()
    this.bypassGain.gain.value = this.enabled ? 0 : 1

    // 构建音频图：
    // source → waveShaper → makeupNode ──┐
    // source → bypassGain ───────────────┤
    //                                     ↓
    //                                  destination
    source.connect(this.waveShaper)
    this.waveShaper.connect(this.makeupNode)
    this.makeupNode.connect(destination)

    source.connect(this.bypassGain)
    this.bypassGain.connect(destination)
  }

  /**
   * 断开音频连接
   */
  public disconnect(): void {
    try {
      this.waveShaper?.disconnect()
      this.makeupNode?.disconnect()
      this.bypassGain?.disconnect()
    } catch (e) {
      // 忽略断开错误
    }
  }

  /**
   * 将软限幅器的输出重新路由到新目标节点
   * 用于在软限幅器和最终输出之间插入 AnalyserNode 等中间节点
   * @param newDestination - 新的输出目标节点
   */
  public rerouteOutput(newDestination: AudioNode): void {
    try {
      this.makeupNode?.disconnect()
      this.bypassGain?.disconnect()
    } catch {
      // 忽略断开错误
    }
    this.makeupNode?.connect(newDestination)
    this.bypassGain?.connect(newDestination)
  }

  /**
   * 释放资源
   */
  public dispose(): void {
    this.disconnect()
    this.waveShaper = null
    this.makeupNode = null
    this.bypassGain = null
    this.audioContext = null
  }

  /**
   * 设置参数
   * @param params - 软限幅器参数（部分更新）
   */
  public setParams(params: Partial<SoftClipperParams>): void {
    if (params.enabled !== undefined) {
      this.enabled = params.enabled
      this.params.enabled = params.enabled
    }
    if (params.threshold !== undefined) {
      this.params.threshold = Math.min(5.0, Math.max(0.5, params.threshold))
    }
    if (params.makeupGain !== undefined) {
      this.params.makeupGain = Math.min(6, Math.max(0, params.makeupGain))
    }

    this.applyParams()
  }

  /**
   * 应用当前参数到音频节点
   */
  private applyParams(): void {
    if (!this.audioContext) return

    const now = this.audioContext.currentTime

    // 更新限幅曲线
    if (this.waveShaper) {
      this.waveShaper.curve = this.createSoftClipCurve(this.params.threshold) as any
    }

    // 更新补偿增益，禁用时置零防止与旁路信号叠加
    if (this.makeupNode) {
      const targetGain = this.enabled
        ? this.dbToLinear(this.params.makeupGain)
        : 0
      this.makeupNode.gain.setTargetAtTime(targetGain, now, 0.015)
    }

    // 旁路控制：启用时限幅路径增益为1，旁路增益为0；禁用时相反
    if (this.bypassGain) {
      const targetBypassGain = this.enabled ? 0 : 1
      this.bypassGain.gain.setTargetAtTime(targetBypassGain, now, 0.015)
    }
  }

  /**
   * 创建软限幅曲线
   * 使用 tanh 函数实现平滑饱和特性
   * @param threshold - 限幅阈值强度，值越大限幅越接近硬限幅
   * @returns 波形整形曲线数组（65536 个采样点）
   */
  private createSoftClipCurve(threshold: number): Float32Array {
    const curve = new Float32Array(65536)
    const length = 65536
    for (let i = 0; i < length; i++) {
      const x = (i - length / 2) / (length / 2) // [-1, 1]
      // tanh 软限幅：threshold 越大越接近硬限幅
      curve[i] = Math.tanh(x * threshold) / Math.tanh(threshold)
    }
    return curve
  }

  /**
   * 将 dB 值转换为线性增益值
   * @param db - dB 值
   * @returns 线性增益值
   */
  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20)
  }

  /**
   * 获取当前参数
   * @returns 当前参数对象
   */
  public getParams(): SoftClipperParams {
    return { ...this.params }
  }
}
