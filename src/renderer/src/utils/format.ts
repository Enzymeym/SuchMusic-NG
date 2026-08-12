/**
 * 时间格式化工具（集中管理原先分散在多个组件中的 formatTime/formatDuration 实现）
 */

/**
 * 将秒格式化为 分:秒
 * @param seconds - 秒数
 * @param opts.padMinutes - 分钟是否补零（默认 false，输出 m:ss；true 时输出 mm:ss）
 * @param opts.fallback - 非法输入（NaN/Infinity）时的返回值，默认 '0:00'
 * @returns 格式化后的时间字符串
 *
 * @example
 * formatTime(125)            // '2:05'
 * formatTime(125, { padMinutes: true })  // '02:05'
 */
export function formatTime(
  seconds: number,
  opts: { padMinutes?: boolean; fallback?: string } = {}
): string {
  if (!isFinite(seconds)) return opts.fallback ?? '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const mm = opts.padMinutes ? m.toString().padStart(2, '0') : m.toString()
  return `${mm}:${s.toString().padStart(2, '0')}`
}

/**
 * 将毫秒时长格式化为 mm:ss
 * @param dt - 时长（毫秒），0/空值时返回 '--:--'
 * @returns 格式化后的时间字符串
 *
 * @example
 * formatDuration(125000)  // '02:05'
 */
export function formatDuration(dt?: number): string {
  if (!dt) return '--:--'
  const totalSeconds = Math.floor(dt / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}
