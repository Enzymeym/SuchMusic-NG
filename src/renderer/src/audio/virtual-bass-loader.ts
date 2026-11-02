/**
 * such-virtual-bass AudioWorklet 模块加载器
 * ==========================================
 *
 * addModule 的两个坑（见 docs/spec/virtual-bass/feasibility-report.md Phase 1 风险点）：
 * 1. 同一个 AudioContext 只能 addModule 同一模块一次，重复加载会抛错；
 *    且并发调用可能竞态 —— 这里按 AudioContext 用 WeakMap 缓存进行中的 Promise。
 * 2. 打包产物跑在 file:// 协议下时，部分环境对 worklet 脚本的直接加载有限制，
 *    此时降级为 fetch → Blob URL → addModule。
 *
 * 两级都失败时调用方应保持旁通 GainNode，功能静默降级（见 web-audio-dsp.mountVirtualBass）。
 */

const modulePromises = new WeakMap<BaseAudioContext, Promise<void>>()

/** worklet 模块相对本文件的路径 */
const WORKLET_URL = new URL('./worklets/virtual-bass.worklet.mjs', import.meta.url)

async function addModulePrimary(ctx: BaseAudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(WORKLET_URL)
}

/** file:// 打包产物兜底：fetch 源码 → Blob URL → addModule */
async function addModuleViaBlob(ctx: BaseAudioContext): Promise<void> {
  const res = await fetch(WORKLET_URL)
  if (!res.ok) throw new Error(`fetch virtual-bass worklet failed: ${res.status}`)
  const source = await res.text()
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * 确保 worklet 模块已在给定 AudioContext 上加载（幂等、并发安全）。
 * @throws 两级路径都失败时抛出最后一次的错误
 */
export function ensureVirtualBassModule(ctx: BaseAudioContext): Promise<void> {
  const existing = modulePromises.get(ctx)
  if (existing) return existing

  const promise = addModulePrimary(ctx).catch((primaryErr: unknown) => {
    console.warn(
      '[virtual-bass-loader] addModule 直接加载失败，降级 Blob 路径:',
      primaryErr
    )
    return addModuleViaBlob(ctx)
  })

  // 失败时清除缓存，允许下次（比如换输出模式重建链后）重试
  promise.catch(() => {
    if (modulePromises.get(ctx) === promise) modulePromises.delete(ctx)
  })
  modulePromises.set(ctx, promise)
  return promise
}
