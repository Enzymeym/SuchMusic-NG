/**
 * SuchMusic 手环通信 · req.id 幂等去重（Windows 端）
 *
 * 对齐设计文档 §3.11：
 * 「接收端保留最近 64 个已处理 req.id 的 LRU；收到重复 id 直接回放缓存响应，不重复执行」
 *
 * 约束：本文件不得引用任何 Electron API。
 */

import { DEDUP_LRU_SIZE } from './protocol'

/**
 * 带响应缓存的 LRU 去重器。
 *
 * 用法：收到请求先用 `begin(id)` 判定是否重复；
 * 非重复则执行并把结果 `remember(id, value)`；重复则直接 `recall(id)` 回放。
 */
export class LruDeduper<T = unknown> {
  private readonly capacity: number
  private readonly cache = new Map<string, T>()

  constructor(capacity: number = DEDUP_LRU_SIZE) {
    this.capacity = capacity > 0 ? Math.floor(capacity) : DEDUP_LRU_SIZE
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.cache.size
  }

  /** 判断 id 是否已处理过（命中会把该键移为最新，符合 LRU）。 */
  has(id: string): boolean {
    if (!this.cache.has(id)) return false
    // 命中后重新插入以刷新 LRU 顺序
    const value = this.cache.get(id) as T
    this.cache.delete(id)
    this.cache.set(id, value)
    return true
  }

  /** 取回已缓存的处理结果；未命中返回 undefined。 */
  recall(id: string): T | undefined {
    if (!this.cache.has(id)) return undefined
    const value = this.cache.get(id) as T
    this.cache.delete(id)
    this.cache.set(id, value)
    return value
  }

  /** 记录 id 及其处理结果。 */
  remember(id: string, value: T): void {
    if (this.cache.has(id)) this.cache.delete(id)
    this.cache.set(id, value)
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }

  /**
   * 一步式判定：
   * - `{duplicate:false}` → 调用方应执行请求，随后 `remember` 结果；
   * - `{duplicate:true, cached}` → 直接回放 `cached`，不得重复执行。
   */
  begin(id: string): { duplicate: boolean; cached?: T } {
    if (this.has(id)) {
      return { duplicate: true, cached: this.recall(id) }
    }
    return { duplicate: false }
  }

  /** 清空（断线重连后调用，避免跨会话误判）。 */
  clear(): void {
    this.cache.clear()
  }

  /** 当前缓存的所有 id（从旧到新）。 */
  keys(): string[] {
    return [...this.cache.keys()]
  }
}
