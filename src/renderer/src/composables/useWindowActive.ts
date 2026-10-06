import { readonly, ref } from 'vue'

/**
 * 窗口是否处于可见（非最小化/未被隐藏）状态。
 *
 * 主窗口设置了 `backgroundThrottling: false`（为保证隐藏到托盘后进度同步不中断），
 * 这会导致窗口最小化时 requestAnimationFrame 仍全速运行。渲染层通过与
 * `document.visibilitychange` 联动，在窗口不可见时暂停背景渲染、歌词逐帧动画等，
 * 避免后台持续占用 CPU/GPU 与内存。
 *
 * 说明：仅以 `document.hidden`（最小化/被隐藏）作为判据，不把失焦（blur）计为不可见，
 * 否则窗口仍显示在屏幕上但用户切到其他应用时，背景与歌词动画会异常停摆。
 */
const isWindowActive = ref(true)

let bound = false

/** 注册全局可见性监听（整个应用只注册一次） */
function bindWindowActiveListener(): void {
  if (bound || typeof document === 'undefined') return
  bound = true
  const update = (): void => {
    isWindowActive.value = !document.hidden
  }
  document.addEventListener('visibilitychange', update)
  update()
}

/**
 * 获取窗口可见状态（只读响应式引用）
 * @returns `true` 表示窗口可见（可继续渲染动画）
 */
export function useWindowActive(): Readonly<typeof isWindowActive> {
  bindWindowActiveListener()
  return readonly(isWindowActive)
}