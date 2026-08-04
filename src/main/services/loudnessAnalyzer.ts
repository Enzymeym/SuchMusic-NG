/**
 * EBU R128 / ITU-R BS.1770-4 集成响度（LUFS）分析器
 *
 * 实现要点：
 * - K 加权：每声道级联「高通滤波器（f0=38.135Hz, Q=0.5003）」+
 *   「高架滤波器（fL=1681.97Hz, +4dB, S=1）」两个 biquad，
 *   系数使用 RBJ cookbook 按实际采样率计算。
 * - 以 400ms 为块累计各声道 K 加权均方能量，计算块响度（含 -0.691 dB 预缩放）。
 * - 集成响度：绝对门限 -70 LUFS + 相对门限（首次门限结果 -10 LUFS）两步 gating 后取功率平均。
 * - 尾部不足 400ms 的残块直接丢弃（与主流实现一致）。
 */

export interface AudioChunk {
  sampleRate: number
  channels: number
  data: number[]
}

interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** 计算 2 阶高通滤波器（RBJ cookbook）系数 */
function computeHighpassCoeffs(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: -(1 + cosW0) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0
  }
}

/** 计算 2 阶高架滤波器（RBJ cookbook）系数 */
function computeHighShelfCoeffs(fs: number, f0: number, gainDb: number, s: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2)
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
  const a0 = (A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha
  return {
    b0: (A * ((A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cosW0)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cosW0)) / a0,
    a2: ((A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha) / a0
  }
}

/** 单声道 K 加权滤波器（两段级联 biquad） */
class KWeightedFilter {
  private readonly hp: BiquadCoeffs
  private readonly hs: BiquadCoeffs
  private hpX1 = 0
  private hpX2 = 0
  private hpY1 = 0
  private hpY2 = 0
  private hsX1 = 0
  private hsX2 = 0
  private hsY1 = 0
  private hsY2 = 0

  constructor(fs: number) {
    this.hp = computeHighpassCoeffs(fs, 38.13547087602444, 0.5003270373238773)
    this.hs = computeHighShelfCoeffs(fs, 1681.9744509555319, 3.999843853973347, 1.0)
  }

  process(x: number): number {
    const hp = this.hp
    const y1 = hp.b0 * x + hp.b1 * this.hpX1 + hp.b2 * this.hpX2 - hp.a1 * this.hpY1 - hp.a2 * this.hpY2
    this.hpX2 = this.hpX1
    this.hpX1 = x
    this.hpY2 = this.hpY1
    this.hpY1 = y1

    const hs = this.hs
    const y2 = hs.b0 * y1 + hs.b1 * this.hsX1 + hs.b2 * this.hsX2 - hs.a1 * this.hsY1 - hs.a2 * this.hsY2
    this.hsX2 = this.hsX1
    this.hsX1 = y1
    this.hsY2 = this.hsY1
    this.hsY1 = y2
    return y2
  }
}

/** 绝对门限（LUFS）：低于此响度的块视为静音 */
const ABSOLUTE_GATE_LUFS = -70
/** 相对门限偏移（LUFS）：相对门限 = 首次门限结果 - 10 */
const RELATIVE_GATE_OFFSET = 10
/** BS.1770 预缩放常数（dB） */
const PRE_SCALING_DB = -0.691
/** 块时长（秒） */
const BLOCK_SECONDS = 0.4

export class LoudnessAnalyzer {
  private sampleRate = 0
  private channels = 0
  private filters: KWeightedFilter[] = []
  private blockSamples = 0
  private blockSampleCount = 0
  private blockEnergies: number[] = []
  private blockLoudness: number[] = []

  /** 接收一段解码后的交错 PCM 数据（f32），增量累计 */
  pushChunk(chunk: AudioChunk): void {
    if (this.sampleRate === 0) {
      this.sampleRate = chunk.sampleRate || 44100
      this.channels = Math.max(1, chunk.channels || 1)
      this.blockSamples = Math.round(BLOCK_SECONDS * this.sampleRate)
      this.blockEnergies = new Array(this.channels).fill(0)
      for (let c = 0; c < this.channels; c++) {
        this.filters.push(new KWeightedFilter(this.sampleRate))
      }
    }

    const data = chunk.data
    const ch = this.channels
    // 按帧（每帧 = ch 个交错样本）迭代，blockSampleCount 计数帧数而非交错样本数
    for (let i = 0; i + ch - 1 < data.length; i += ch) {
      for (let c = 0; c < ch; c++) {
        const y = this.filters[c].process(data[i + c])
        this.blockEnergies[c] += y * y
      }
      this.blockSampleCount++
      if (this.blockSampleCount >= this.blockSamples) {
        this.finalizeBlock()
      }
    }
  }

  /** 完成一个 400ms 块：计算块响度并重置累计 */
  private finalizeBlock(): void {
    let sumWeighted = 0
    for (let c = 0; c < this.channels; c++) {
      // 多声道（≥3 声道）时后置声道加权 1.41，1/2 声道加权 1.0
      const gain = c >= 2 ? 1.41 : 1.0
      sumWeighted += gain * (this.blockEnergies[c] / this.blockSamples)
    }
    this.blockEnergies.fill(0)
    this.blockSampleCount = 0
    this.blockLoudness.push(PRE_SCALING_DB + 10 * Math.log10(Math.max(sumWeighted, 1e-12)))
  }

  /** 在功率域求平均后转回 LUFS */
  private meanLoudness(blocks: number[]): number {
    let sum = 0
    for (const l of blocks) {
      sum += Math.pow(10, l / 10)
    }
    return 10 * Math.log10(sum / blocks.length)
  }

  /**
   * 获取集成响度（LUFS）
   * @returns 集成响度；有效块不足或全部被门限剔除时返回 null
   */
  getIntegratedLoudness(): number | null {
    const blocks = this.blockLoudness
    if (blocks.length === 0) return null

    // 第一步：绝对门限（剔除静音块）
    let passing = blocks.filter((l) => l > ABSOLUTE_GATE_LUFS)
    if (passing.length === 0) return null

    const gated = this.meanLoudness(passing)

    // 第二步：相对门限（首次门限结果 - 10 LUFS）
    const relativeGate = gated - RELATIVE_GATE_OFFSET
    passing = passing.filter((l) => l > relativeGate)
    if (passing.length === 0) return gated

    return this.meanLoudness(passing)
  }

  reset(): void {
    this.sampleRate = 0
    this.channels = 0
    this.filters = []
    this.blockSamples = 0
    this.blockSampleCount = 0
    this.blockEnergies = []
    this.blockLoudness = []
  }
}

/** 将集成响度换算为补偿增益（dB），并钳制在 ±maxGainDb 内 */
export function lufsToGainDb(integratedLufs: number, targetLufs: number, maxGainDb: number): number {
  const gain = targetLufs - integratedLufs
  return Math.min(maxGainDb, Math.max(-maxGainDb, gain))
}
