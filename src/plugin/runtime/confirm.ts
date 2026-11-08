/**
 * 敏感操作确认队列
 *
 * `@grant system` 的调用（执行程序、读写文件、写音频标签）每次执行前要经用户确认。
 * 一个插件在短时间内连续做多个操作时，合并成一批弹一次窗。
 *
 * 与 v1 实现的区别：队列**按 pluginId 分组**。v1 把 100ms 窗口内所有插件的操作
 * 塞进同一批、并用「触发时传入的 pluginId」标注归属，两个插件同时操作时会张冠李戴。
 */
import { randomUUID } from 'node:crypto'
import type {
  BatchConfirmRequest,
  BatchConfirmResponse,
  PendingConfirmItem,
  SensitiveOperation
} from '../types'

/** 操作合并窗口 */
const DEBOUNCE_MS = 100
/** 用户无响应时的自动拒绝时间 */
const OP_TIMEOUT_MS = 30_000

export interface ConfirmQueueDeps {
  /** 把批量请求推给渲染层 */
  send(request: BatchConfirmRequest): void
  /** 渲染进程是否可用（窗口未创建/已销毁时直接拒绝） */
  isAvailable(): boolean
}

interface QueuedOp {
  item: PendingConfirmItem
  resolve: (confirmed: boolean) => void
  timer: NodeJS.Timeout
}

interface InflightBatch {
  pluginId: string
  ops: QueuedOp[]
}

export class ConfirmQueue {
  /** 本次会话内已授权、不再询问的 `${pluginId}:${operation}` */
  private skipSession = new Set<string>()
  /** 待合并的操作，按插件分组 */
  private queues = new Map<string, { pluginName: string; ops: QueuedOp[]; timer: NodeJS.Timeout | null }>()
  /** 已发出、等待用户响应的批次 */
  private inflight = new Map<string, InflightBatch>()

  constructor(private readonly deps: ConfirmQueueDeps) {}

  /**
   * 请求一次确认。
   * @returns true 表示用户同意（或本次会话已同意过），false 表示拒绝/超时
   */
  request(
    pluginId: string,
    pluginName: string,
    operation: SensitiveOperation,
    detail: string
  ): Promise<boolean> {
    if (this.skipSession.has(`${pluginId}:${operation}`)) return Promise.resolve(true)
    if (!this.deps.isAvailable()) {
      // 没有窗口可弹：明确拒绝，而不是静默放行
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      const entry = this.queues.get(pluginId) ?? { pluginName, ops: [], timer: null }
      entry.pluginName = pluginName

      const op: QueuedOp = {
        item: { opId: randomUUID(), operation, detail },
        resolve,
        timer: setTimeout(() => {
          this.dropOp(pluginId, op.item.opId)
          resolve(false)
        }, OP_TIMEOUT_MS)
      }
      entry.ops.push(op)
      this.queues.set(pluginId, entry)

      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => this.flush(pluginId), DEBOUNCE_MS)
    })
  }

  /** 处理渲染层的响应 */
  resolve(response: BatchConfirmResponse): void {
    const batch = this.inflight.get(response.requestId)
    if (!batch) return
    this.inflight.delete(response.requestId)

    const rejected = new Set(response.rejectedOpIds ?? [])
    for (const op of batch.ops) {
      clearTimeout(op.timer)
      const ok = response.confirmed && !rejected.has(op.item.opId)
      if (ok && response.skipSession) {
        this.skipSession.add(`${batch.pluginId}:${op.item.operation}`)
      }
      op.resolve(ok)
    }
  }

  /** 卸载插件时清理其挂起请求（一律拒绝） */
  cancelPlugin(pluginId: string): void {
    const entry = this.queues.get(pluginId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      for (const op of entry.ops) {
        clearTimeout(op.timer)
        op.resolve(false)
      }
      this.queues.delete(pluginId)
    }
    for (const [requestId, batch] of [...this.inflight.entries()]) {
      if (batch.pluginId !== pluginId) continue
      this.inflight.delete(requestId)
      for (const op of batch.ops) {
        clearTimeout(op.timer)
        op.resolve(false)
      }
    }
  }

  /** 清空本次会话的免确认记录（应用重启语义） */
  resetSession(): void {
    this.skipSession.clear()
  }

  private dropOp(pluginId: string, opId: string): void {
    const entry = this.queues.get(pluginId)
    if (!entry) return
    const idx = entry.ops.findIndex((o) => o.item.opId === opId)
    if (idx >= 0) entry.ops.splice(idx, 1)
    if (entry.ops.length === 0) {
      if (entry.timer) clearTimeout(entry.timer)
      this.queues.delete(pluginId)
    }
    for (const batch of this.inflight.values()) {
      const i = batch.ops.findIndex((o) => o.item.opId === opId)
      if (i >= 0) batch.ops.splice(i, 1)
    }
  }

  private flush(pluginId: string): void {
    const entry = this.queues.get(pluginId)
    if (!entry) return
    this.queues.delete(pluginId)
    if (entry.ops.length === 0) return

    if (!this.deps.isAvailable()) {
      for (const op of entry.ops) {
        clearTimeout(op.timer)
        op.resolve(false)
      }
      return
    }

    const requestId = randomUUID()
    this.inflight.set(requestId, { pluginId, ops: entry.ops })
    this.deps.send({
      requestId,
      pluginId,
      pluginName: entry.pluginName,
      operations: entry.ops.map((o) => o.item)
    })
  }
}
