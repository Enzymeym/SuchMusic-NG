/**
 * 音频可视化核心类
 * 封装 AnalyserNode 的管理和频谱/波形数据读取，
 * 为 Canvas 渲染组件提供实时音频分析数据。
 */

/**
 * 音频可视化分析器类
 */
export class AudioVisualizerAnalyzer {
  private analyserNode: AnalyserNode | null = null
  private frequencyData: Uint8Array | null = null
  private timeDomainData: Uint8Array | null = null
  private initialized: boolean = false

  /**
   * 初始化 AnalyserNode 并接入音频处理链
   * @param audioContext - 已激活的 AudioContext 实例
   * @param previousNode - 上游节点（softClipper 的输出目标）
   * @param outputNode - 下游节点（gainNode，即最终输出目标）
   */
  public initialize(
    audioContext: AudioContext,
    previousNode: AudioNode,
    outputNode: AudioNode
  ): void {
    if (this.initialized) return

    // 创建 AnalyserNode
    this.analyserNode = audioContext.createAnalyser()
    this.analyserNode.fftSize = 256
    this.analyserNode.smoothingTimeConstant = 0.8

    // 预分配数据缓冲区
    const bufferLength = this.analyserNode.frequencyBinCount // fftSize/2 = 128
    this.frequencyData = new Uint8Array(bufferLength)
    this.timeDomainData = new Uint8Array(this.analyserNode.fftSize)

    // 插入到处理链：previousNode → analyserNode → outputNode
    try {
      previousNode.connect(this.analyserNode)
    } catch {
      // 若已连接则忽略
    }
    this.analyserNode.connect(outputNode)

    this.initialized = true
    console.log('[AudioVisualizer] 分析器已初始化并接入音频处理链')
  }

  /**
   * 获取当前频率数据（频谱）
   * @returns Uint8Array，长度为 fftSize/2 (128)，范围 0-255
   */
  public getFrequencyData(): Uint8Array {
    if (!this.analyserNode || !this.frequencyData) {
      return new Uint8Array(128)
    }
    this.analyserNode.getByteFrequencyData(this.frequencyData as any)
    return this.frequencyData
  }

  /**
   * 获取当前时域波形数据
   * @returns Uint8Array，长度为 fftSize (256)，范围 0-255
   */
  public getTimeDomainData(): Uint8Array {
    if (!this.analyserNode || !this.timeDomainData) {
      return new Uint8Array(256)
    }
    this.analyserNode.getByteTimeDomainData(this.timeDomainData as any)
    return this.timeDomainData
  }

  /**
   * 获取原始 AnalyserNode 实例（供高级场景使用）
   * @returns AnalyserNode 实例，未初始化时返回 null
   */
  public getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode
  }

  /**
   * 是否已初始化
   * @returns 初始化状态
   */
  public isInitialized(): boolean {
    return this.initialized
  }

  /**
   * 销毁分析器，断开所有连接并释放资源
   */
  public dispose(): void {
    try {
      this.analyserNode?.disconnect()
    } catch {
      // 忽略断开错误
    }
    this.analyserNode = null
    this.frequencyData = null
    this.timeDomainData = null
    this.initialized = false
  }
}

/** 全局单例 */
export const audioVisualizer = new AudioVisualizerAnalyzer()
