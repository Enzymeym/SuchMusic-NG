/**
 * `virtual-bass.worklet.mjs` 的类型声明。
 *
 * 该文件是纯 JavaScript（AudioWorklet 模块不能在运行时 import 其他模块，
 * 因此必须自包含），这里只为渲染层与单元测试提供类型。
 */

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface VirtualBassConfig {
  fs?: number
  /** 扬声器下限（Hz） */
  fLow?: number
  /** 旁链低通转折频率（Hz） */
  fCross?: number
  /** 旁链低通二阶节数量：4 = LR8 = 48 dB/oct */
  crossoverSections?: number
  /** 湿路高通二阶节数量：2 = LR4 */
  wetHighpassSections?: number
  sigma?: number
  gamma?: number
  maxOrder?: number
  dryHighpass?: boolean
  wetHighpass?: boolean
  /** 电平门（dBFS） */
  gateDb?: number
  /** 混音上限：|dry + wet| 的硬上界（0..1） */
  ceiling?: number
  /** 是否对湿路做限幅 / 压缩（只压湿路，干路仍严格恒等） */
  limitWet?: boolean
  /** 软膝起点：|wet| ≤ limitKnee·剩余空间 时完全线性（0.9 = 只碰最顶端） */
  limitKnee?: number
  /** 湿声增益下压速度（ms） */
  limitAttackMs?: number
  /** 湿声增益回弹时间常数（ms） */
  limitReleaseMs?: number
  /** 干路余量包络的窗长（ms） */
  limitWindowMs?: number
  /** 干路余量包络的释放时间常数（ms） */
  limitEnvReleaseMs?: number
  /** 归一化窗 = 1/envWindowHz 秒 */
  envWindowHz?: number
  /** 归一化包络的释放时间常数（ms）；0 = 纯滑动窗（会台阶掉下来） */
  envReleaseMs?: number
  kStarSmooth?: number
  useF0?: boolean
  f0Override?: number
}

export declare function designLowpass(freq: number, fs: number, q?: number): BiquadCoeffs
export declare function designHighpass(freq: number, fs: number, q?: number): BiquadCoeffs
export declare function lrMag(
  freq: number,
  corner: number,
  sections: number,
  highpass: boolean
): number
export declare function lr4LowpassMag(freq: number, corner: number): number
export declare function lr4HighpassMag(freq: number, corner: number): number

export declare class Biquad {
  constructor(coeffs?: BiquadCoeffs)
  setCoeffs(c: BiquadCoeffs): void
  reset(): void
  process(x: number): number
}

export declare class SlidingMax {
  constructor(size: number)
  readonly W: number
  reset(): void
  push(v: number): number
}

export declare class SmoothedMax {
  constructor(size: number, fs: number, releaseMs: number)
  readonly max: SlidingMax
  readonly v: number
  setRelease(fs: number, releaseMs: number): void
  reset(): void
  push(x: number): number
}

export declare class F0Tracker {
  constructor(fs?: number)
  f0: number
  confidence: number
  configure(fs: number): void
  reset(): void
  push(x: number): boolean
}

export declare function chebWeights(
  kStar: number,
  sigma: number,
  fLow: number,
  f0Hat: number,
  maxOrder: number
): { weights: Float64Array; sum: number }

export declare class VbCore {
  constructor(options?: VirtualBassConfig)
  cfg: Required<VirtualBassConfig>
  kStar: number
  makeup: number
  /** Σw_k(T_k−T_k(0)) 在 u∈[-1,1] 上的峰值 */
  shaperPeak: number
  f0: number
  weights: Float64Array
  tracker: F0Tracker
  /** 限幅器介入的样本数（诊断用；只统计 useLimit 的块） */
  limitHits: number
  /** 已处理样本数（诊断用） */
  sampleCount: number
  configure(options?: VirtualBassConfig): this
  reset(): void
  processBlock(
    inCh: Float32Array[],
    outCh: Float32Array[],
    n: number,
    wetGain?: number,
    wetOnly?: boolean
  ): void
}

export declare class SuchVirtualBassProcessor {
  constructor(options?: unknown)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}
