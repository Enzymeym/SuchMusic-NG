/**
 * 带尾调用的节流器（trailing throttle）
 *
 * 常见的前缘节流（`if (now - last >= delay) fn()`）会把节流窗口内的最后一次调用
 * **直接丢弃**。用在音量滑块上后果很严重：n-slider 拖动时以 ~8ms 的粒度连续发
 * 事件，松手瞬间的那个值大概率落在窗口内被丢掉，于是
 *  - store 里的音量停在 30ms 前的旧值；
 *  - 受控滑块按旧值重新渲染 → 手指离开时音量条「回弹」，听感上就是音量调不动。
 *
 * 本实现保证：窗口内立即执行一次（响应快），并把窗口内最后一次参数留到窗口结束
 * 时补执行（不丢最终值）。
 *
 * @param fn 需要节流执行的函数
 * @param delay 节流窗口（毫秒）
 * @returns 节流后的函数，附带 `cancel()` 用于组件卸载时清理挂起的尾调用
 */
export function createTrailingThrottle<T extends (value: number) => void>(
  fn: T,
  delay: number
): ((value: number) => void) & { cancel: () => void } {
  // 初值为 -Infinity：首次调用必须立即执行（若用 0，在 Date.now() 接近 0 的
  // 测试时钟下 elapsed 会算成 0，首次输入反被当成「窗口内」而延迟下发）
  let lastCallAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: number | null = null

  const throttled = (value: number): void => {
    const now = Date.now()
    const elapsed = now - lastCallAt

    // 窗口已过：立即执行，并作废尚未触发的尾调用（它的值已被本次取代）
    if (elapsed >= delay) {
      lastCallAt = now
      pending = null
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fn(value)
      return
    }

    // 窗口内：只记录最新值，等到窗口结束补一次
    pending = value
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      lastCallAt = Date.now()
      if (pending !== null) {
        const latest = pending
        pending = null
        fn(latest)
      }
    }, delay - elapsed)
  }

  throttled.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return throttled
}
