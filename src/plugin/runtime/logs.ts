/**
 * 插件日志环形缓冲
 *
 * 日志不落盘：每插件保留最近 N 条，设置模态框的「日志」页按需拉取。
 * 同时把日志镜像到主进程终端，便于开发者不打开 UI 也能排查。
 */
import type { PluginLogEntry } from '../../shared/plugin/types'

const DEFAULT_CAPACITY = 500

/** 把任意值折叠成一行文本（避免插件把巨大对象塞进日志） */
function formatArg(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[Circular]'
        seen.add(v as object)
      }
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'function') return '[Function]'
      return v
    })
    return text === undefined ? String(value) : text
  } catch {
    try {
      return String(value)
    } catch {
      return '[Unserializable]'
    }
  }
}

/** 单条日志最大字符数，超出截断 */
const MAX_LINE = 2000

export class PluginLogRing {
  private buffer: PluginLogEntry[] = []

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  push(level: PluginLogEntry['level'], args: unknown[]): void {
    let message = args.map(formatArg).join(' ')
    if (message.length > MAX_LINE) message = `${message.slice(0, MAX_LINE)}…`
    this.buffer.push({ t: Date.now(), level, message })
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
  }

  /** 取最近 limit 条（默认全部），按时间正序 */
  entries(limit?: number): PluginLogEntry[] {
    if (!limit || limit >= this.buffer.length) return [...this.buffer]
    return this.buffer.slice(this.buffer.length - limit)
  }

  clear(): void {
    this.buffer = []
  }
}
