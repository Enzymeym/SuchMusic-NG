/**
 * 单元测试：请求超时 / 重试退避 / 挂起登记表（§3.11）。
 * 运行：npx vitest run
 *
 * 关键回归：退避必须**真正生效**——旧实现算出 300/900ms 却立即重发（实际间隔≈超时值）。
 * 这里用可注入的虚拟时钟，断言「先退避、后退避满才重发」。
 */

import { describe, it, expect, vi } from 'vitest'
import { RequestTracker, decideRetry, type Scheduler } from './requests'

/**
 * 虚拟时钟调度器：`advance(ms)` 按到期先后触发到期的定时器。
 * 相比「一次性触发全部」，它能精确断言退避时长。
 */
class VirtualClockScheduler implements Scheduler {
  private now = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; fn: () => void }>()

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1
    const handle = this.seq
    this.timers.set(handle, { due: this.now + ms, fn })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** 前进 ms 并触发所有已到期定时器（含回调中新登记的）。 */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let nextHandle = -1
      let nextDue = Number.POSITIVE_INFINITY
      for (const [handle, timer] of this.timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextDue = timer.due
          nextHandle = handle
        }
      }
      if (nextHandle < 0) break
      const timer = this.timers.get(nextHandle)!
      this.timers.delete(nextHandle)
      this.now = timer.due
      timer.fn()
    }
    this.now = target
  }

  /** 当前仍在等待的定时器数量。 */
  get pendingCount(): number {
    return this.timers.size
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
    const scheduler = new VirtualClockScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('w-0b12-0001', 'playback.next')
    expect(tracker.size).toBe(1)
    tracker.resolve('w-0b12-0001', 'ok')
    await expect(promise).resolves.toBe('ok')
    expect(tracker.size).toBe(0)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('无重发回调时超时直接 reject(E_TIMEOUT)', async () => {
    const scheduler = new VirtualClockScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('w-0b12-0002', 'playback.toggle', 1)
    scheduler.advance(3000)
    await expect(promise).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(tracker.size).toBe(0)
  })

  it('超时后**先退避 300ms 再重发**（退避期间不重发）', () => {
    const scheduler = new VirtualClockScheduler()
    const resend = vi.fn()
    const tracker = new RequestTracker<string>(3000, scheduler, resend)
    tracker.track('w-0b12-t1', 'state.get', 1)

    scheduler.advance(3000) // 触发超时，进入退避
    expect(resend).not.toHaveBeenCalled() // 关键：未立即重发

    scheduler.advance(299) // 退避未满
    expect(resend).not.toHaveBeenCalled()

    scheduler.advance(1) // 累计 300ms
    expect(resend).toHaveBeenCalledTimes(1)
    expect(resend).toHaveBeenLastCalledWith('w-0b12-t1', 'state.get', 2)
    expect(tracker.attempts('w-0b12-t1')).toBe(2)
    expect(tracker.size).toBe(1)
  })

  it('第二次退避 900ms，第三次超时后放弃（同 id 重试 ≤2 次）', async () => {
    const scheduler = new VirtualClockScheduler()
    const resend = vi.fn()
    const tracker = new RequestTracker<string>(3000, scheduler, resend)
    const promise = tracker.track('w-0b12-t2', 'state.get', 1)

    scheduler.advance(3000 + 300) // 第 1 次超时 + 退避 300 → 重发（attempts=2）
    expect(resend).toHaveBeenCalledTimes(1)
    expect(resend).toHaveBeenLastCalledWith('w-0b12-t2', 'state.get', 2)

    scheduler.advance(3000) // 第 2 次超时，进入退避
    expect(resend).toHaveBeenCalledTimes(1) // 退避中
    scheduler.advance(899)
    expect(resend).toHaveBeenCalledTimes(1)
    scheduler.advance(1) // 累计 900ms
    expect(resend).toHaveBeenCalledTimes(2)
    expect(resend).toHaveBeenLastCalledWith('w-0b12-t2', 'state.get', 3)

    scheduler.advance(3000) // 第 3 次超时 → 放弃
    await expect(promise).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(resend).toHaveBeenCalledTimes(2)
    expect(tracker.size).toBe(0)
  })

  it('重发之后收到响应可正常 resolve', async () => {
    const scheduler = new VirtualClockScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler, vi.fn())
    const promise = tracker.track('w-0b12-0005', 'playback.play', 1)
    scheduler.advance(3000) // 超时 → 进入退避
    scheduler.advance(300) // 退避满 → 发生一次重发
    tracker.resolve('w-0b12-0005', 'done')
    await expect(promise).resolves.toBe('done')
  })

  it('退避期间收到响应也能正常 resolve，且清除退避计时', async () => {
    const scheduler = new VirtualClockScheduler()
    const resend = vi.fn()
    const tracker = new RequestTracker<string>(3000, scheduler, resend)
    const promise = tracker.track('w-0b12-0006', 'playback.play', 1)
    scheduler.advance(3000) // 超时 → 进入退避（尚未重发）
    tracker.resolve('w-0b12-0006', 'early')
    await expect(promise).resolves.toBe('early')
    expect(resend).not.toHaveBeenCalled()
    expect(scheduler.pendingCount).toBe(0)
  })

  it('reject 指定错误码；rejectAll 清空全部挂起', async () => {
    const scheduler = new VirtualClockScheduler()
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
    const scheduler = new VirtualClockScheduler()
    const tracker = new RequestTracker<string>(3000, scheduler)
    const promise = tracker.track('a', 'playback.play')
    expect(tracker.reject('nope', 'E_INTERNAL', 'x')).toBe(false)
    expect(tracker.reject('a', 'E_NOT_READY', '未就绪')).toBe(true)
    await expect(promise).rejects.toMatchObject({ code: 'E_NOT_READY' })
  })
})
