/**
 * 性能监控类，用于采集和上报 Web Vitals 等关键性能指标
 * 基于 Web Performance API 和 PerformanceObserver
 */
class PerformanceMonitor {
  /** 存储自定义 mark 名称集合 */
  private marks: Set<string> = new Set()

  /** 存储所有 measure 和 event 记录 */
  private records: Array<{ name: string; duration: number; timestamp: number }> = []

  /** 最大记录数量，防止长期运行后数组无限增长 */
  private readonly MAX_RECORDS = 200

  /**
   * 添加记录并自动裁剪超限条目
   */
  private addRecord(record: { name: string; duration: number; timestamp: number }): void {
    this.records.push(record)
    if (this.records.length > this.MAX_RECORDS) {
      this.records.shift()
    }
  }

  /**
   * 记录自定义时间标记
   * @param name - 标记名称，用于后续与另一个标记配对 measure
   */
  mark(name: string): void {
    try {
      performance.mark(name)
      this.marks.add(name)
    } catch {
      // performance.mark 在非标准环境下可能不可用
    }
  }

  /**
   * 测量两个标记点之间的时间差，并记录到监控数据中
   * @param name - 测量名称，用于标识此次测量
   * @param startMark - 起始标记名称
   * @param endMark - 结束标记名称
   * @returns 时间差（毫秒），如果标记不存在则返回 -1
   */
  measure(name: string, startMark: string, endMark: string): number {
    try {
      const measure = performance.measure(name, startMark, endMark)
      this.addRecord({
        name,
        duration: measure.duration,
        timestamp: Date.now()
      })
      return measure.duration
    } catch {
      return -1
    }
  }

  /**
   * 获取所有 Web Vitals 核心指标（FCP、LCP、CLS、INP、TTFB）
   * 使用 PerformanceObserver 监听 paint、layout-shift、longtask 等事件类型
   * @returns Promise，解析为包含各指标值的对象
   */
  getWebVitals(): Promise<{
    fcp: number
    lcp: number
    cls: number
    inp: number
    ttfb: number
  }> {
    return new Promise((resolve) => {
      const result = {
        fcp: 0,
        lcp: 0,
        cls: 0,
        inp: 0,
        ttfb: 0
      }
      let resolved = false

      /**
       * 在所有指标收到至少一次更新后 resolve
       */
      const tryResolve = (): void => {
        if (resolved) return
        // FCP 和 TTFB 是必须的基线指标
        if (result.fcp > 0 && result.ttfb > 0) {
          resolved = true
          resolve(result)
        }
      }

      // 超时兜底：3 秒后无论是否收集完整都返回
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve(result)
        }
      }, 3000)

      try {
        // 监听 FCP（首次内容绘制）
        const fcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries()
          if (entries.length > 0) {
            result.fcp = entries[0].startTime
            fcpObserver.disconnect()
            tryResolve()
          }
        })
        fcpObserver.observe({ type: 'paint', buffered: true })

        // 监听 LCP（最大内容绘制）
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries()
          if (entries.length > 0) {
            result.lcp = entries[entries.length - 1].startTime
            tryResolve()
          }
        })
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })

        // 监听 CLS（累积布局偏移）
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const layoutShiftEntry = entry as any
            if (!layoutShiftEntry.hadRecentInput) {
              result.cls += layoutShiftEntry.value
            }
          }
        })
        clsObserver.observe({ type: 'layout-shift', buffered: true })

        // 监听 INP（交互到下一次绘制），通过 longtask 和 event timing 近似估算
        const inpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const interactionEntry = entry as any
            if (interactionEntry.interactionId) {
              result.inp = Math.max(result.inp, interactionEntry.duration)
            }
          }
        })
        inpObserver.observe({ type: 'event', buffered: true } as any)

        // 获取 TTFB（首字节时间）
        const navEntries = performance.getEntriesByType('navigation')
        if (navEntries.length > 0) {
          const navEntry = navEntries[0] as PerformanceNavigationTiming
          result.ttfb = navEntry.responseStart - navEntry.requestStart
          tryResolve()
        }

        // 如果 paint 事件已经触发过（buffered），手动检查
        const paintEntries = performance.getEntriesByType('paint')
        for (const entry of paintEntries) {
          if (entry.name === 'first-contentful-paint') {
            result.fcp = entry.startTime
            tryResolve()
          }
        }

        // 5 秒后断开所有观察器，释放资源
        setTimeout(() => {
          fcpObserver.disconnect()
          lcpObserver.disconnect()
          clsObserver.disconnect()
          inpObserver.disconnect()
        }, 5000)
      } catch {
        // PerformanceObserver 不可用时直接返回
        resolved = true
        resolve(result)
      }
    })
  }

  /**
   * 记录自定义事件的耗时
   * @param eventName - 事件名称
   * @param duration - 耗时（毫秒）
   */
  logEvent(eventName: string, duration: number): void {
    this.addRecord({
      name: eventName,
      duration,
      timestamp: Date.now()
    })
  }

  /**
   * 获取所有已采集的性能数据报告
   * @returns 包含所有测量记录和事件记录的完整报告对象
   */
  getReport(): {
    records: Array<{ name: string; duration: number; timestamp: number }>
    totalEvents: number
  } {
    return {
      records: [...this.records],
      totalEvents: this.records.length
    }
  }

  /**
   * 输出性能报告到控制台（仅开发环境使用）
   * @param label - 报告标签，用于在控制台中标识
   */
  printReport(label = '性能报告'): void {
    const report = this.getReport()
    console.group(`📊 ${label}`)
    for (const record of report.records) {
      console.log(`  ⏱ ${record.name}: ${record.duration.toFixed(2)}ms`)
    }
    console.log(`  📋 总计 ${report.totalEvents} 条记录`)
    console.groupEnd()
  }
}

/** 全局性能监控单例 */
export const performanceMonitor = new PerformanceMonitor()
