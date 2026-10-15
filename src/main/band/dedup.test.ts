/**
 * 单元测试：req.id LRU(64) 去重幂等（§3.11）。
 * 运行：pnpm test:unit
 */

import { describe, it, expect } from 'vitest'
import { LruDeduper } from './dedup'
import { DEDUP_LRU_SIZE } from './protocol'

describe('req.id 去重幂等（§3.11）', () => {
  it('首次未命中 → duplicate=false', () => {
    const deduper = new LruDeduper<string>()
    expect(deduper.begin('b-7fa1-0007')).toEqual({ duplicate: false })
  })

  it('重复 id 命中并回放缓存响应，不重复执行', () => {
    const deduper = new LruDeduper<string>()
    let executions = 0

    const handle = (id: string): string => {
      const { duplicate, cached } = deduper.begin(id)
      if (duplicate) return cached ?? ''
      executions += 1
      const response = JSON.stringify({ ok: true, seq: executions })
      deduper.remember(id, response)
      return response
    }

    const first = handle('b-7fa1-0007')
    const second = handle('b-7fa1-0007')
    const third = handle('b-7fa1-0007')

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(executions).toBe(1)
    expect(deduper.size).toBe(1)
  })

  it('LRU 容量为 64：访问最旧的键会因淘汰而重新执行', () => {
    const deduper = new LruDeduper<number>(DEDUP_LRU_SIZE)
    for (let i = 1; i <= DEDUP_LRU_SIZE; i += 1) {
      deduper.remember(`id-${i}`, i)
    }
    expect(deduper.size).toBe(DEDUP_LRU_SIZE)
    expect(deduper.has('id-1')).toBe(true)

    // 记住第 65 个 → 淘汰最旧的 id-2（id-1 因刚访问过而被保活）
    deduper.remember('id-65', 65)
    expect(deduper.size).toBe(DEDUP_LRU_SIZE)
    expect(deduper.has('id-1')).toBe(true)
    expect(deduper.has('id-2')).toBe(false)
    expect(deduper.has('id-65')).toBe(true)
  })

  it('容量 1 的极端情况', () => {
    const deduper = new LruDeduper<number>(1)
    deduper.remember('a', 1)
    deduper.remember('b', 2)
    expect(deduper.has('a')).toBe(false)
    expect(deduper.recall('b')).toBe(2)
  })

  it('clear 清空缓存（重连后调用）', () => {
    const deduper = new LruDeduper<number>()
    deduper.remember('a', 1)
    deduper.remember('b', 2)
    deduper.clear()
    expect(deduper.size).toBe(0)
    expect(deduper.begin('a')).toEqual({ duplicate: false })
  })

  it('keys 顺序从旧到新', () => {
    const deduper = new LruDeduper<number>()
    deduper.remember('a', 1)
    deduper.remember('b', 2)
    deduper.remember('c', 3)
    expect(deduper.keys()).toEqual(['a', 'b', 'c'])
  })
})
