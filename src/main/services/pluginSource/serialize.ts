/**
 * 把插件返回值收敛为「可跨 IPC 传输」的纯数据。
 *
 * 音源插件的对象来自 vm 沙箱 realm，可能是 Proxy、类实例、带 getter 的对象，
 * 直接作为 ipcMain.handle 的返回值会让 Electron 的结构化克隆失败，渲染层收到的
 * 只是 `An object could not be cloned.`（完全看不到真实结果）。
 * 因此凡是把插件数据交回渲染层的地方，都要先过一遍这里。
 */
export function toSerializable<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  // 嵌套过深（插件自引用结构）直接截断，避免无限递归
  if (depth > 12) return undefined as unknown as T
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item, depth + 1, seen)) as unknown as T
  }
  if (seen.has(value as object)) return undefined as unknown as T
  seen.add(value as object)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'function' || typeof v === 'symbol') continue
    out[key] = toSerializable(v, depth + 1, seen)
  }
  return out as T
}
