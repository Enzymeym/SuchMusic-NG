/**
 * 动态 EQ（Dynamic EQ）核心算法
 *
 * 实时根据音频频谱情况推理各频段增益修正，使声音时刻贴合用户选定的走势
 * （低音增强 / 高音增强 / V 形 / 倒 V 形）。
 *
 * 工作原理（动态延伸 + 分析微调，不静态套用曲线）：
 *   1. 延伸层：开启后各频段修正量从 0 平滑延伸向走势目标 T（按强度缩放
 *      S·T），曲线在播放中逐渐"长"成目标走势 —— 不是瞬间跳到走势曲线；
 *   2. 微调层：实时分析频谱得到内容形状偏差 d[i]（该频段相对整体锚点
 *      偏亮/偏暗多少 dB），叠加 β·(T[i] − d[i]) 做逐曲自适应微调：
 *      内容比走势"瘦"就多补、"肥"就少补。
 *
 *   修正量 delta[i] = clamp(S·T[i] + β·(T[i] − d[i]), ±Gmax)
 *   最终下发增益：effective[i] = base[i] + delta[i]（base 为用户 EQ 基准曲线）
 *
 *   两条边界（防止走势外频段被"顺带"拉起来）：
 *   a. 走势未覆盖的频段（T[i] = 0）delta 恒为 0 —— 例如低音增强走势下
 *      500Hz 以上完全不参与微调；
 *   b. 走势覆盖的频段，delta 只能沿走势方向 —— 目标为正就只允许 [0, +Gmax]，
 *      目标为负只允许 [−Gmax, 0]。"内容瘦多补 / 内容肥少补"都在这个方向内，
 *      不会反向（低音增强不会削高频、高音增强不会削低频）。
 *
 *   修正量为比例式（非积分式）：delta 不参与 err 的计算路径，不存在
 *   正反馈积累，对 pre / post-EQ 取样点均稳定收敛。
 *
 * 框架无关（无 Vue / AudioContext 依赖），可离线单测。
 */

/** 动态 EQ 走势（四种互斥单选） */
export type DynamicEqShape = 'bassBoost' | 'trebleBoost' | 'vShape' | 'invertedV'

/** 走势中文名（UI 用） */
export const DYNAMIC_EQ_SHAPE_LABELS: Record<DynamicEqShape, string> = {
  bassBoost: '低音增强',
  trebleBoost: '高音增强',
  vShape: 'V 形',
  invertedV: '倒 V 形'
}

/** 10 段 EQ 中心频率（与 web-audio-dsp 的 EQ_BAND_FREQUENCIES 一致） */
export const DYNAMIC_EQ_BAND_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/**
 * 四种走势的目标曲线（10 频段，dB）。
 *
 * - bassBoost：低频整体抬升，中高频保持
 * - trebleBoost：高频整体抬升
 * - vShape：两端抬升、中频略收（经典 V 字）
 * - invertedV：中频抬升、两端略收（人声突出）
 */
export const SHAPE_TARGETS: Record<DynamicEqShape, number[]> = {
  bassBoost: [8, 7, 5, 2, 0, 0, 0, 0, 0, 0],
  trebleBoost: [0, 0, 0, 0, 1, 2, 3, 4, 5, 6],
  vShape: [7, 6, 4, 1, -1, -1, 1, 4, 6, 7],
  invertedV: [-4, -3, -1, 2, 4, 4, 2, -1, -3, -4]
}

/**
 * 5 档效果强度（= 动态增强力度）映射：
 * - shapeScale：走势延伸比例（修正量向目标曲线延伸多少，1 = 完整走势）
 * - fineTune：逐曲自适应微调系数 β（分析结果对修正量的修正力度）
 * - maxDeltaDb：单频段最大修正量（dB）
 *
 * 强度越高 → 延伸越深、微调越积极；所有系数保持比例式（非积分），闭环稳定。
 */
export const STRENGTH_PRESETS: Array<{
  shapeScale: number
  fineTune: number
  maxDeltaDb: number
}> = [
  { shapeScale: 0.25, fineTune: 0.15, maxDeltaDb: 4 },
  { shapeScale: 0.4, fineTune: 0.22, maxDeltaDb: 5.5 },
  { shapeScale: 0.55, fineTune: 0.3, maxDeltaDb: 7 },
  { shapeScale: 0.75, fineTune: 0.38, maxDeltaDb: 8.5 },
  { shapeScale: 1.0, fineTune: 0.45, maxDeltaDb: 10 }
]

/**
 * 5 档算法效率映射：分析间隔与平滑时间常数。
 * 效率越高 → 分析越频繁、响应越灵敏（CPU 略高）；
 * release τ ≥ 2 × attack τ，防止节奏性内容（鼓点）产生"抽吸/泵感"。
 */
export const EFFICIENCY_PRESETS: Array<{
  intervalMs: number
  attackTauSec: number
  releaseTauSec: number
}> = [
  { intervalMs: 300, attackTauSec: 2.5, releaseTauSec: 5.0 },
  { intervalMs: 200, attackTauSec: 1.8, releaseTauSec: 3.6 },
  { intervalMs: 140, attackTauSec: 1.2, releaseTauSec: 2.4 },
  { intervalMs: 100, attackTauSec: 0.9, releaseTauSec: 1.8 },
  { intervalMs: 60, attackTauSec: 0.6, releaseTauSec: 1.2 }
]

/** 死区（dB）：误差小于该值不修正，避免持续微抖 */
const DEAD_ZONE_DB = 1
/** 静音门（dB，频段加权平均能量）：低于该值冻结当前 delta，防止间隙/停播时漂移 */
const SILENCE_GATE_DB = -60
/**
 * "无数据"判据（dB）：aggregateBandLevels 对没有 bin 的频段返回 -100 哨兵，
 * 这类频段不能参与偏差分析（否则会被当成极瘦内容而拉满修正）。
 */
const NO_DATA_LEVEL_DB = -99.5
/** 单次更新最大步进（dB）：限制突变 */
const MAX_STEP_DB = 0.5
/** 每秒最大增益变化斜率（dB/s） */
const MAX_SLEW_DB_PER_SEC = 6

/**
 * 把实时频谱（线性 bin，dB 或 [0,1] 归一化）聚合为 10 个 EQ 频段能量（dB）。
 *
 * - 频段边界取相邻中心频率的几何均值（如 32/64 段边界 = √(32×64) ≈ 45Hz）
 * - bin 频率 = i / binCount × nyquist，按频率归入频段
 * - binValueDb 为 null 时（归一化线性值）先按 20·log10(v+ε) 转 dB
 * - binCount 与 nyquist 自适应：Web Audio（1024 bins）与 WASAPI（bin 数未知）均可用
 * - 某频段内没有 bin 时（低分辨率频谱的低频段），取可用的最近 bin / 返回 -100dB
 *
 * @param spectrum 频谱数据（逐 bin）
 * @param isLinear true = [0,1] 归一化线性值（WASAPI），false = 已是 dB（Web Audio）
 * @param nyquist 奈奎斯特频率（采样率 / 2）
 * @returns 长度 10 的频段能量数组（dB），空输入返回 null
 */
export function aggregateBandLevels(
  spectrum: ArrayLike<number>,
  isLinear: boolean,
  nyquist: number
): number[] | null {
  const binCount = spectrum.length
  if (binCount === 0 || !(nyquist > 0)) return null

  const bands = DYNAMIC_EQ_BAND_FREQUENCIES
  const levels = new Array<number>(bands.length).fill(-100)

  // 每个频段收集 bin 的 dB 能量，之后取平均
  const sums = new Array<number>(bands.length).fill(0)
  const counts = new Array<number>(bands.length).fill(0)

  for (let i = 0; i < binCount; i++) {
    const binFreq = ((i + 0.5) / binCount) * nyquist
    if (binFreq < bands[0] / 2) continue // DC 附近，跳过
    // 找到所属频段：边界 = 相邻中心频率几何均值
    let band = -1
    for (let b = 0; b < bands.length; b++) {
      const lo = b === 0 ? 0 : Math.sqrt(bands[b - 1] * bands[b])
      const hi = b === bands.length - 1 ? Infinity : Math.sqrt(bands[b] * bands[b + 1])
      if (binFreq >= lo && binFreq < hi) {
        band = b
        break
      }
    }
    if (band < 0) continue

    const v = spectrum[i]
    if (!Number.isFinite(v)) continue
    const db = isLinear ? 20 * Math.log10(Math.max(v, 1e-6)) : v
    // 空 bin（本体 -100 / -120 下限）不参与平均：否则频段内 bin 越多、
    // 平均后越低（1024 bins 的 16k 段有几百个 bin），既失真又会让
    // 偏差分析把正常频段误判成"很瘦"，进而过度增强
    if (db <= NO_DATA_LEVEL_DB) continue
    sums[band] += db
    counts[band]++
  }

  for (let b = 0; b < bands.length; b++) {
    if (counts[b] > 0) {
      levels[b] = sums[b] / counts[b]
    }
  }
  return levels
}

/** 频段响度权重（与 web-audio-dsp 的 LOUDNESS_BAND_WEIGHTS 一致，和为 1） */
const LOUDNESS_WEIGHTS = [0.05, 0.08, 0.11, 0.14, 0.14, 0.14, 0.13, 0.11, 0.06, 0.04]

/** 一阶低通 EMA 系数：τ（秒）+ 间隔 dt（秒）→ 平滑系数 */
function emaCoeff(tauSec: number, dtSec: number): number {
  return 1 - Math.exp(-dtSec / Math.max(tauSec, 0.001))
}

const clampDb = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * 动态 EQ 引擎：输入频段能量，输出当前各频段修正量 delta（dB）。
 * 内部含非对称 EMA 平滑、死区、静音门、斜率限制与硬限幅。
 */
export class DynamicEqEngine {
  private strength = 3
  private efficiency = 3

  /** 各频段平滑后的能量（dB） */
  private smoothLevels: number[] | null = null
  /** 当前修正量（dB） */
  private delta: number[] = new Array(10).fill(0)
  /** 上次 update 的时间戳（ms，调用方时钟） */
  private lastUpdateMs: number | null = null

  setStrength(v: number): void {
    this.strength = clampDb(Math.round(v), 1, 5)
  }

  setEfficiency(v: number): void {
    this.efficiency = clampDb(Math.round(v), 1, 5)
  }

  /** 当前修正量快照（dB），供 UI 展示 */
  getDelta(): number[] {
    return [...this.delta]
  }

  /** 重置内部状态（切换走势 / 停止时调用） */
  reset(): void {
    this.smoothLevels = null
    this.delta = new Array(10).fill(0)
    this.lastUpdateMs = null
  }

  /**
   * 输入一帧频段能量，推进动态层，返回当前各频段修正量 delta（dB）。
   *
   * 修正量 = 走势延伸（S·T）+ 分析微调（β·(T − 内容偏差)），
   * 经非对称 EMA 平滑 + 斜率限制后逼近目标；delta 从 0 起逐步延伸，
   * 曲线在播放中逐渐长成目标走势，而非瞬间套用静态曲线。
   *
   * 微调只在走势覆盖的频段（T ≠ 0）内生效，且方向与走势一致：
   * 走势目标为 0 的频段（如低音增强的 500Hz 以上）delta 恒为 0。
   *
   * @param bandLevels 10 频段能量（dB）
   * @param nowMs 当前时间戳（ms），与上次调用的差值决定平滑系数与斜率限制
   * @returns 修正量数组（长度 10，dB），调用方按 base + delta 下发
   */
  update(bandLevels: number[], nowMs: number): number[] {
    const strengthCfg = STRENGTH_PRESETS[this.strength - 1]
    const effCfg = EFFICIENCY_PRESETS[this.efficiency - 1]
    const dtSec = this.lastUpdateMs === null ? effCfg.intervalMs / 1000 : Math.max(0.01, Math.min(2, (nowMs - this.lastUpdateMs) / 1000))
    this.lastUpdateMs = nowMs

    if (!bandLevels || bandLevels.length !== 10 || bandLevels.some((v) => !Number.isFinite(v))) {
      return [...this.delta]
    }

    // --- 非对称 EMA 平滑：attack 快 / release 慢 ---
    const attackCoeff = emaCoeff(effCfg.attackTauSec, dtSec)
    const releaseCoeff = emaCoeff(effCfg.releaseTauSec, dtSec)
    if (!this.smoothLevels) {
      this.smoothLevels = [...bandLevels]
    } else {
      for (let i = 0; i < 10; i++) {
        const c = bandLevels[i] > this.smoothLevels[i] ? attackCoeff : releaseCoeff
        this.smoothLevels[i] += (bandLevels[i] - this.smoothLevels[i]) * c
      }
    }

    // --- 响度锚点：加权平均能量 ---
    let weighted = 0
    let totalW = 0
    for (let i = 0; i < 10; i++) {
      weighted += this.smoothLevels[i] * LOUDNESS_WEIGHTS[i]
      totalW += LOUDNESS_WEIGHTS[i]
    }
    const anchor = totalW > 0 ? weighted / totalW : 0

    // --- 静音门：整体能量过低时冻结当前 delta ---
    if (anchor < SILENCE_GATE_DB) {
      return [...this.delta]
    }

    // --- 动态修正：延伸 S·T + 微调 β·(T − d)，平滑逼近 ---
    const shapeTarget = this.currentTarget
    const slewLimit = MAX_SLEW_DB_PER_SEC * dtSec
    for (let i = 0; i < 10; i++) {
      const target = shapeTarget[i]
      let desired = 0
      // 走势在该频段没有意图（T = 0）→ 不参与微调，目标修正恒为 0，
      // 只剩平滑回落（切换走势时从旧值自然收拢，不会残留）。
      if (target !== 0) {
        const deviation = this.smoothLevels[i] - anchor
        let err = target - deviation
        // 频谱没有该频段数据（aggregateBandLevels 的 -100dB 哨兵，低分辨率
        // 频谱的极低频/极高频常见）不能当成"内容很瘦"→ 微调归零，只保留延伸项
        if (this.smoothLevels[i] <= NO_DATA_LEVEL_DB) err = 0
        // 死区：内容已贴合走势时微调项归零（延伸项保持）
        if (Math.abs(err) < DEAD_ZONE_DB) err = 0
        desired = clampDb(
          strengthCfg.shapeScale * target + strengthCfg.fineTune * err,
          -strengthCfg.maxDeltaDb,
          strengthCfg.maxDeltaDb
        )
        // 方向门：修正量只能沿走势方向（多补 / 少补都落在这半轴上），
        // 否则"内容比锚点暗"会把走势外的频段整体推上去
        desired = target > 0 ? Math.max(0, desired) : Math.min(0, desired)
      }
      // 非对称 EMA 平滑（延伸过程自然渐进）
      const coeff = desired > this.delta[i] ? attackCoeff : releaseCoeff
      let step = (desired - this.delta[i]) * coeff
      // 单步 + 每秒斜率限制，防止突变
      const stepLimit = Math.min(MAX_STEP_DB, slewLimit)
      step = clampDb(step, -stepLimit, stepLimit)
      this.delta[i] = clampDb(this.delta[i] + step, -strengthCfg.maxDeltaDb, strengthCfg.maxDeltaDb)
    }

    return [...this.delta]
  }

  /** 当前走势目标向量（由 runner 设置；算法层默认低音增强） */
  private currentTarget: number[] = SHAPE_TARGETS.bassBoost

  setShapeTarget(target: number[]): void {
    if (target && target.length === 10 && target.every((v) => Number.isFinite(v))) {
      this.currentTarget = [...target]
    }
  }
}
