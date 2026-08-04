/**
 * WebNN 可选加速层（Web Machine Learning）
 *
 * 用于在支持 WebNN 的环境中，通过 NPU/GPU 加速音频特征推理（节拍/起始点检测）。
 * WebNN 属于实验性特性，绝大多数用户环境不可用，因此这里仅作为可选增强：
 * - 探测失败 / 推理失败一律静默降级为 CPU 计算
 * - 全程只输出 console.log，不抛出任何异常，不影响播放器正常运行
 */

import type { ML, MLContext, MLSupportLimits } from './webnn'

/** 分析后端类型：纯 CPU 计算，或 WebNN 各设备后端 */
export type AnalyzerBackend = 'cpu' | 'webnn-npu' | 'webnn-gpu' | 'webnn-cpu'

/** 音频特征推理（节拍/起始点检测）依赖的关键算子 */
const REQUIRED_OPS = ['conv2d', 'gemm', 'relu', 'mul', 'add', 'reduceMean']

/** 探测结果缓存，避免重复探测 */
let cachedBackend: AnalyzerBackend | null = null

/**
 * 探测分析后端
 *
 * 探测流程：
 * 1. 环境不支持 WebNN 时返回 'cpu'
 * 2. 依次尝试 npu -> gpu -> cpu 设备创建上下文
 * 3. 检查关键算子支持情况，缺失则尝试下一设备（cpu 后端缺失则回退纯 CPU）
 * 4. 全程容错，任何异常都降级为 'cpu'
 *
 * 结果会被缓存，重复调用直接返回缓存值
 */
export async function detectAnalyzerBackend(): Promise<AnalyzerBackend> {
  if (cachedBackend) return cachedBackend

  try {
    cachedBackend = await probe()
  } catch (e) {
    // probe 内部已全部容错，这里再做一次兜底
    console.log('[WebNNAnalyzer] 探测过程出现未预期异常，回退 CPU:', e)
    cachedBackend = 'cpu'
  }

  return cachedBackend
}

/**
 * 同步获取分析后端（未探测或探测失败时返回 'cpu'）
 */
export function getAnalyzerBackend(): AnalyzerBackend {
  return cachedBackend ?? 'cpu'
}

/**
 * 当前是否启用了 WebNN 加速（后端不为 'cpu' 即视为可用）
 */
export function isWebNnAvailable(): boolean {
  return getAnalyzerBackend() !== 'cpu'
}

/** 实际探测逻辑（内部使用，保证不抛异常） */
async function probe(): Promise<AnalyzerBackend> {
  // 1. 环境不支持 WebNN，直接使用 CPU 计算
  if (!('ml' in navigator)) {
    console.log('[WebNNAnalyzer] 当前环境不支持 WebNN，使用 CPU 计算')
    return 'cpu'
  }

  const ml = navigator.ml as ML | undefined
  if (!ml) {
    console.log('[WebNNAnalyzer] navigator.ml 不可用，使用 CPU 计算')
    return 'cpu'
  }

  // 2. 依次尝试 npu -> gpu -> cpu 设备
  const deviceTypes: Array<'npu' | 'gpu' | 'cpu'> = ['npu', 'gpu', 'cpu']
  for (const deviceType of deviceTypes) {
    let context: MLContext
    try {
      context = await ml.createContext({ deviceType })
    } catch (e) {
      console.log(`[WebNNAnalyzer] 创建 ${deviceType} 上下文失败:`, e)
      continue
    }

    // 3. 检查关键算子支持情况
    if (!isOpSupportSatisfied(context)) {
      // npu/gpu 缺算子时尝试下一个设备；cpu 后端缺算子则直接回退纯 CPU 计算
      if (deviceType === 'cpu') {
        console.log('[WebNNAnalyzer] CPU 后端缺少关键算子，回退纯 CPU 计算')
        return 'cpu'
      }
      continue
    }

    console.log(`[WebNNAnalyzer] 已启用 WebNN 加速（设备: ${deviceType}）`)
    if (deviceType === 'npu') return 'webnn-npu'
    if (deviceType === 'gpu') return 'webnn-gpu'
    return 'webnn-cpu'
  }

  // 4. 所有设备均不可用，回退 CPU
  console.log('[WebNNAnalyzer] WebNN 所有设备均不可用，回退 CPU 计算')
  return 'cpu'
}

/** 检查上下文是否满足关键算子要求（opSupportLimits 不存在时按满足处理） */
function isOpSupportSatisfied(context: MLContext): boolean {
  if (!context.opSupportLimits) {
    // 老实现没有 opSupportLimits 接口，无法校验，按支持处理
    return true
  }

  try {
    const limits: MLSupportLimits = context.opSupportLimits()
    const supportedOps = getSupportedOps(limits)

    // 空列表通常意味着该环境的算子支持查询未正确填充（DirectML 已知问题），
    // 不代表算子真的不支持；记录日志后放行，避免据此误回退
    if (supportedOps.length === 0) {
      console.log('[WebNNAnalyzer] opSupportLimits 返回空算子列表，跳过算子校验（可能为环境查询问题）')
      return true
    }

    const missing = REQUIRED_OPS.filter((op) => !supportedOps.includes(op))
    if (missing.length > 0) {
      console.log(`[WebNNAnalyzer] 缺少关键算子: ${missing.join(', ')}`)
      return false
    }
    return true
  } catch (e) {
    // 查询算子支持失败，按保守策略视为不满足（会尝试其他设备或回退 CPU）
    console.log('[WebNNAnalyzer] 查询算子支持失败:', e)
    return false
  }
}

/** 从 opSupportLimits 结果中提取支持的算子名列表（兼容数组与对象两种形式） */
function getSupportedOps(limits: MLSupportLimits): string[] {
  const ops = limits.ops
  if (!ops) return []
  if (Array.isArray(ops)) return ops
  // 对象形式：键为算子名，如 { conv2d: {...}, relu: {...} }
  return Object.keys(ops)
}
