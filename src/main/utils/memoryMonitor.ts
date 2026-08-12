/**
 * 主进程内存监控
 *
 * 周期采样主进程 process.memoryUsage() 与全应用各进程内存指标
 * （app.getAppMetrics），用于验证内存优化效果与检测泄漏。
 */
import { app } from 'electron'

interface ProcessMetric {
  pid: number
  type: string
  rss: number
  cpu: number
}

export interface MainMemorySnapshot {
  t: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  processes: ProcessMetric[]
  totalProcesses: number
}

class MainMemoryMonitor {
  /** 快照历史（最多保留 MAX_SNAPSHOTS 条） */
  private snapshots: MainMemorySnapshot[] = []

  /** 采样定时器 ID */
  private timer: ReturnType<typeof setInterval> | null = null

  /** 最大快照条数 */
  private readonly MAX_SNAPSHOTS = 24

  /**
   * 采集一次全量快照
   * @returns 当前主进程与各子进程内存指标
   */
  getSnapshot(): MainMemorySnapshot {
    const mem = process.memoryUsage()
    let processes: ProcessMetric[] = []
    try {
      processes = app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        rss: m.memory ? m.memory.workingSetSize : 0,
        cpu: m.cpu ? m.cpu.percentCPUUsage : 0
      }))
    } catch {
      // getAppMetrics 在个别平台可能不可用，忽略
    }

    const snapshot: MainMemorySnapshot = {
      t: Date.now(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers ?? 0,
      processes,
      totalProcesses: processes.length
    }

    this.snapshots.push(snapshot)
    if (this.snapshots.length > this.MAX_SNAPSHOTS) {
      this.snapshots.shift()
    }
    return snapshot
  }

  /**
   * 开始周期采样
   * @param intervalMs 采样间隔（毫秒），默认 10000
   */
  start(intervalMs = 10000): void {
    if (this.timer !== null) return
    this.getSnapshot()
    this.timer = setInterval(() => this.getSnapshot(), intervalMs)
  }

  /** 停止采样（保留已采集数据） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 统计报告（基于 rss 汇总）
   * @returns 当前快照 + min/max/avg + 采样时长
   */
  getReport(): {
    current: MainMemorySnapshot | null
    min: number
    max: number
    avg: number
    count: number
    durationMs: number
  } {
    const rssList = this.snapshots.map((s) => s.rss)
    return {
      current: this.snapshots.length ? this.snapshots[this.snapshots.length - 1] : null,
      min: rssList.length ? Math.min(...rssList) : 0,
      max: rssList.length ? Math.max(...rssList) : 0,
      avg: rssList.length ? rssList.reduce((a, b) => a + b, 0) / rssList.length : 0,
      count: this.snapshots.length,
      durationMs: this.snapshots.length
        ? this.snapshots[this.snapshots.length - 1].t - this.snapshots[0].t
        : 0
    }
  }

  /** 将 MB 换算（用于输出） */
  toMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
}

/** 全局主进程内存监控单例 */
export const mainMemoryMonitor = new MainMemoryMonitor()
