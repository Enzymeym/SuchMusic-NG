/**
 * 渲染进程内存监控
 *
 * 基于 Chromium 的 performance.memory API（Electron 渲染进程可用）周期采样
 * JavaScript 堆内存，用于验证内存优化效果与检测内存泄漏。
 *
 * @example
 * rendererMemoryMonitor.start()
 * // ... 运行一段时间后
 * console.log(rendererMemoryMonitor.getReport())
 */
interface MemorySample {
  t: number
  usedJSHeapSize: number
  totalJSHeapSize: number
}

class RendererMemoryMonitor {
  /** 采样记录（最多保留 MAX_SAMPLES 条） */
  private samples: MemorySample[] = []

  /** 采样定时器 ID */
  private timer: ReturnType<typeof setInterval> | null = null

  /** 采样间隔（毫秒） */
  private readonly INTERVAL_MS = 5000

  /** 最大采样条数（5s 一条 ≈ 20 分钟） */
  private readonly MAX_SAMPLES = 240

  /**
   * 读取当前 JS 堆内存快照
   * @returns 堆内存信息，performance.memory 不可用时返回 null
   */
  private getMemoryInfo(): { usedJSHeapSize: number; totalJSHeapSize: number } | null {
    try {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
      if (!mem || typeof mem.usedJSHeapSize !== 'number') return null
      return { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize }
    } catch {
      return null
    }
  }

  /** 采集一次样本 */
  private sample(): void {
    const info = this.getMemoryInfo()
    if (!info) return
    this.samples.push({ t: Date.now(), ...info })
    if (this.samples.length > this.MAX_SAMPLES) {
      this.samples.shift()
    }
  }

  /** 开始周期采样 */
  start(): void {
    if (this.timer !== null) return
    this.sample()
    this.timer = setInterval(() => this.sample(), this.INTERVAL_MS)
  }

  /** 停止采样（保留已采集数据） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 当前快照
   * @returns 最新一次采样，无采样记录时返回 null
   */
  getSnapshot(): { t: number; usedJSHeapSize: number; totalJSHeapSize: number } | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null
  }

  /**
   * 统计报告
   * @returns 当前值 / 最小值 / 最大值 / 平均值 / 样本数 / 采样时长
   */
  getReport(): {
    current: number
    min: number
    max: number
    avg: number
    count: number
    durationMs: number
    samples: MemorySample[]
  } {
    const usedList = this.samples.map((s) => s.usedJSHeapSize)
    const min = usedList.length ? Math.min(...usedList) : 0
    const max = usedList.length ? Math.max(...usedList) : 0
    const avg = usedList.length ? usedList.reduce((a, b) => a + b, 0) / usedList.length : 0
    const current = this.samples.length ? this.samples[this.samples.length - 1].usedJSHeapSize : 0
    const durationMs = this.samples.length
      ? this.samples[this.samples.length - 1].t - this.samples[0].t
      : 0
    return {
      current,
      min,
      max,
      avg,
      count: this.samples.length,
      durationMs,
      samples: this.samples
    }
  }

  /** 将 MB 换算（用于输出） */
  toMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
}

/** 全局渲染进程内存监控单例 */
export const rendererMemoryMonitor = new RendererMemoryMonitor()
