/**
 * 节流函数 - 限制函数在指定时间间隔内最多执行一次
 * 适用于 resize、scroll 等高频事件
 *
 * @param fn - 需要节流的函数
 * @param delay - 时间间隔（毫秒）
 * @returns 节流后的函数，与原函数签名一致
 *
 * @example
 * const throttledResize = throttle(handleResize, 200)
 * window.addEventListener('resize', throttledResize)
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastTime = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  return (...args: Parameters<T>) => {
    const now = Date.now()
    const remaining = delay - (now - lastTime)

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      lastTime = now
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        lastTime = Date.now()
        timer = null
        fn(...args)
      }, remaining)
    }
  }
}

export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void
  /** 取消尚未执行的调用（搜索框被清空时必须用它，否则旧关键词会“复活”） */
  cancel: () => void
  /** 立即执行挂起的调用 */
  flush: () => void
}

/**
 * 防抖函数 - 延迟执行直到调用停止超过指定时间
 * 适用于搜索输入、表单验证等场景
 *
 * @param fn - 需要防抖的函数
 * @param delay - 等待时间（毫秒）
 * @returns 节流后的函数，附带 cancel / flush
 *
 * @example
 * const debouncedSearch = debounce(performSearch, 300)
 * input.addEventListener('input', debouncedSearch)
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T> | null = null

  const run = (): void => {
    timer = null
    if (!lastArgs) return
    const args = lastArgs
    lastArgs = null
    fn(...args)
  }

  const wrapped = ((...args: Parameters<T>) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delay)
  }) as DebouncedFunction<T>

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    lastArgs = null
  }

  wrapped.flush = () => {
    if (timer) clearTimeout(timer)
    run()
  }

  return wrapped
}

/**
 * requestAnimationFrame 节流 - 确保在浏览器下一帧执行
 * 适用于需要与渲染同步的操作，减少不必要的布局计算
 *
 * @param fn - 需要节流的函数
 * @returns 节流后的函数，与原函数签名一致
 *
 * @example
 * const rafScroll = rafThrottle(updateScrollPosition)
 * element.addEventListener('scroll', rafScroll)
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  fn: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null

  return (...args: Parameters<T>) => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      fn(...args)
      rafId = null
    })
  }
}
