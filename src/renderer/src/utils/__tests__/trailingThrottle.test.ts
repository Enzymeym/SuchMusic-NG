import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTrailingThrottle } from '../trailingThrottle'

describe('createTrailingThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次调用立即执行', () => {
    const fn = vi.fn()
    const throttled = createTrailingThrottle(fn, 30)
    throttled(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
  })

  it('窗口内连续调用只在窗口结束时补一次最新值（不丢最终值）', () => {
    const fn = vi.fn()
    const throttled = createTrailingThrottle(fn, 30)

    throttled(10) // 立即执行
    vi.setSystemTime(5)
    throttled(20) // 落入窗口，排队
    vi.setSystemTime(10)
    throttled(30) // 覆盖排队值
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30)
    expect(fn).toHaveBeenCalledTimes(2)
    // 尾调用必须是最后一次输入，而不是被丢弃的中间值
    expect(fn).toHaveBeenLastCalledWith(30)
  })

  it('拖到一半松手（最后一次输入落在窗口内）最终值仍会落地', () => {
    const fn = vi.fn()
    const throttled = createTrailingThrottle(fn, 30)
    throttled(0)
    vi.setSystemTime(10)
    throttled(80) // 用户松手时的最终音量
    vi.advanceTimersByTime(30)
    expect(fn).toHaveBeenLastCalledWith(80)
  })

  it('窗口结束后再次调用立即执行，且不会重复执行挂起的尾调用', () => {
    const fn = vi.fn()
    const throttled = createTrailingThrottle(fn, 30)
    throttled(1)
    vi.setSystemTime(5)
    throttled(2) // 排队
    vi.setSystemTime(40)
    throttled(3) // 窗口已过 → 立即执行，作废排队的 2
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith(3)
    vi.advanceTimersByTime(60)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel() 丢弃挂起的尾调用', () => {
    const fn = vi.fn()
    const throttled = createTrailingThrottle(fn, 30)
    throttled(1)
    vi.setSystemTime(5)
    throttled(2)
    throttled.cancel()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
