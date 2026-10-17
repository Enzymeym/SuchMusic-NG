/**
 * 内存基线采集工具（仅开发环境加载，生产包不包含）。
 *
 * 用法：
 * 1. `npm run dev` 启动应用；
 * 2. 在渲染进程 DevTools 控制台执行 `__memProbe.mk('idle-60s')` 打点；
 * 3. `__memProbe.dump()` 下载全部采样为 JSON，便于改动前后对比。
 *
 * 采样内容：
 * - 主进程：rss / heapUsed / external / arrayBuffers + 每个子进程的 rss/type
 * - 渲染进程：performance.memory 的 used/total JS 堆
 * - DOM 节点数与 <img> 数量（虚拟滚动验收的主指标）
 */

interface RendererProc {
  pid: number
  type: string
  rss: number
  cpu: number
}

interface MemSample {
  label: string
  at: string
  elapsedMs: number
  main: {
    rss: number
    heapUsed: number
    heapTotal: number
    external: number
    arrayBuffers: number
  }
  /** 按进程类型聚合的 rss（字节） */
  byType: Record<string, { count: number; rss: number }>
  processes: RendererProc[]
  renderer: { usedJSHeapSize: number; totalJSHeapSize: number }
  dom: { nodes: number; images: number }
}

function countDomNodes(): number {
  let count = 0
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) count++
  return count
}

export function installMemProbe(): void {
  const samples: MemSample[] = []
  const startedAt = Date.now()

  const snapshot = async (label: string): Promise<MemSample | null> => {
    const api = (window as any).api?.memory
    if (!api?.getReport) {
      console.warn('[memProbe] window.api.memory 不可用')
      return null
    }
    const report = await api.getReport()
    const current = report?.current
    const perf = (performance as any).memory

    const processes: RendererProc[] = Array.isArray(current?.processes)
      ? current.processes
      : []
    const byType: MemSample['byType'] = {}
    for (const p of processes) {
      const key = p.type || 'unknown'
      const agg = byType[key] ?? { count: 0, rss: 0 }
      agg.count++
      agg.rss += p.rss
      byType[key] = agg
    }

    const sample: MemSample = {
      label,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      main: {
        rss: current?.rss ?? 0,
        heapUsed: current?.heapUsed ?? 0,
        heapTotal: current?.heapTotal ?? 0,
        external: current?.external ?? 0,
        arrayBuffers: current?.arrayBuffers ?? 0
      },
      byType,
      processes,
      renderer: {
        usedJSHeapSize: perf?.usedJSHeapSize ?? 0,
        totalJSHeapSize: perf?.totalJSHeapSize ?? 0
      },
      dom: { nodes: countDomNodes(), images: document.images.length }
    }

    samples.push(sample)
    // 单行 JSON 便于在控制台直接复制/筛选
    console.log(`MEMPROBE ${JSON.stringify(sample)}`)
    return sample
  }

  const dump = (): void => {
    const blob = new Blob([JSON.stringify(samples, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `memprobe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const table = (): void => {
    // eslint-disable-next-line no-console
    console.table(
      samples.map((s) => ({
        label: s.label,
        mainRssMB: +(s.main.rss / 1048576).toFixed(1),
        arrayBuffersMB: +(s.main.arrayBuffers / 1048576).toFixed(1),
        tabRssMB: +((s.byType.Tab?.rss ?? 0) / 1048576).toFixed(1),
        rendererHeapMB: +(s.renderer.usedJSHeapSize / 1048576).toFixed(1),
        dom: s.dom.nodes,
        imgs: s.dom.images
      }))
    )
  }

  ;(window as any).__memProbe = { mk: snapshot, dump, table, samples }
  console.info(
    '[memProbe] 已安装：__memProbe.mk("label") 打点 / __memProbe.table() 汇总 / __memProbe.dump() 导出'
  )
}
