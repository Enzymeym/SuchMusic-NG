/**
 * 单元测试：请求超时 / 重试策略 / 挂起登记表（§3.11）。
 * 运行：pnpm test:unit
 */

import { describe, it, expect, vi } from 'vitest'
import { RequestTracker, decideRetry, type Scheduler } from './requests'

/** 可手动触发的假定时器，保证测试确定性。 */
class FakeScheduler implements Scheduler {
  private handle = 0
  private tasks = new Map<number, () => void>()

  setTimeout(fn: () => void, _ms: number): unknown {
    this.handle += 1
    this.tasks.set(this.handle, fn)
    return this.handle
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  /** 触发所有当前已登记的定时器（模拟一批超时）。 */
  runAll(): void {
    const pending = [...this.tasks.values()]
    this.tasks.clear()
    pending.forEach((fn) => fn())
  }

  get pendingCount(): number {
    return this.tasks.size
  }
}

describe('重试判定（§3.11）', () => {
  it('E_TIMEOUT / E_LINK 前两次失败才重试，退避 300/900', () => {
    expect(decideRetry('E_TIMEOUT', 1)).toEqual({ retry: true, delayMs: 300 })
    expect(decideRetry('E_LINK', 2)).toEqual({ retry: true, delayMs: 900 })
    expect(decideRetry('E_TIMEOUT', 3)).toEqual({ retry: false, delayMs: 0 })
  })

  it('E_UNSUPPORTED / E_BADREQ 不重试', () => {
    expect(decideRetry('E_UNSUPPORTED', 1)).toEqual({ retry: false, delayMs: 0 })
    expect(decideRetry('E_BADREQ', 1)).toEqual({ retry: false, delayMs: 0 })
  })
})

describe('RequestTracker（§3.11）', () => {
  it('成功 resolve 后不再触发超时', async () => {
    const scheduler = new FakeScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('w-0b12-0001', 'playback.next')
    expect(tracker.size).toBe(1)
    tracker.resolve('w-0b12-0001', 'ok')
    await expect(promise).resolves.toBe('ok')
    expect(tracker.size).toBe(0)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('无重发回调时超时直接 reject(E_TIMEOUT)', async () => {
    const scheduler = new FakeScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('w-0b12-0002', 'playback.toggle', 1)
    scheduler.runAll()
    await expect(promise).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(tracker.size).toBe(0)
  })

  it('有重发回调时同 id 重试 ≤2 次，随后 reject', async () => {
    const scheduler = new FakeScheduler()
    const resend = vi.fn()
    const tracker = new RequestTracker<string>(3000, scheduler, resend)
    const promise = tracker.track('w-0b12-0003', 'state.get', 1)

    scheduler.runAll() // 第 1 次超时 → 重发（attempts=2）
    expect(resend).toHaveBeenCalledWith('w-0b12-0003', 'state.get', 2)
    expect(tracker.attempts('w-0b12-0003')).toBe(2)
    expect(tracker.size).toBe(1)

    scheduler.runAll() // 第 2 次超时 → 重发（attempts=3）
    expect(resend).toHaveBeenCalledWith('w-0b12-0003', 'state.get', 3)

    scheduler.runAll() // 第 3 次超时 → 放弃
    await expect(promise).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(resend).toHaveBeenCalledTimes(2)
    expect(tracker.size).toBe(0)
  })

  it('重发期间收到响应可正常 resolve', async () => {
    const scheduler = new FakeScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler, vi.fn())
    const promise = tracker.track('w-0b12-0005', 'playback.play', 1)
    scheduler.runAll() // 触发一次重发
    tracker.resolve('w-0b12-0005', 'done')
    await expect(promise).resolves.toBe('done')
  })

  it('reject 指定错误码；rejectAll 清空全部挂起', async () => {
    const scheduler = new FakeScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const p1 = tracker.track('a', 'playback.play')
    const p2 = tracker.track('b', 'playback.pause')
    expect(tracker.size).toBe(2)
    tracker.rejectAll('E_LINK', '链路断开')
    await expect(p1).rejects.toMatchObject({ code: 'E_LINK' })
    await expect(p2).rejects.toMatchObject({ code: 'E_LINK' })
    expect(tracker.size).toBe(0)
    expect(tracker.has('a')).toBe(false)
  })

  it('reject 指定 id 返回 true，未知 id 返回 false', async () => {
    const scheduler = new FakeScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('a', 'playback.play')
    expect(tracker.reject('nope', 'E_INTERNAL', 'x')).toBe(false)
    expect(tracker.reject('a', 'E_NOT_READY', '未就绪')).toBe(true)
    await expect(promise).rejects.toMatchObject({ code: 'E_NOT_READY' })
  })
})
