/**
 * 智能过渡核心 DSP（纯函数，无 DOM / Worker / ML 依赖）
 *
 * 扁平化设计：移除 onnxruntime 起始点模型与 Web Worker 架构，
 * 所有分析在主线程分块异步执行（yieldMainThread 让出），对外暴露一致的
 * 同步版本（测试 / 小窗口）与分块异步版本（播放路径，避免 UI 卡死）。
 *
 * 「完美过渡」三要素：
 * 1. 节奏（Rhythm）：能量包络 → BPM 估计，两曲节奏不一致时对下一曲做
 *    WSOLA 变速不变调；过渡执行在拍点（实时能量起始点）上对齐
 * 2. 调性（Key）：色度向量 + Krumhansl-Kessler 键位轮廓相关 → 调性检测，
 *    经 Camelot Wheel 判定和谐兼容性；不兼容时对下一曲做相位声码器变调对齐
 * 3. 能量（Energy）：当前曲尾部衰减 / 下一曲头部攻击，决定过渡起点与时长
 */

// ====== 常量 ======

/** 静音判定阈值 */
export const SILENCE_THRESHOLD = 0.01
/** 起始点能量突增倍数阈值 */
export const ONSET_RATIO_THRESHOLD = 2.5
/** 起始点最低 RMS（避免把极微弱噪声跳变误判为起始点） */
export const ONSET_MIN_RMS = 0.05
/** RMS EMA 平滑系数（帧间波动抑制） */
export const ONSET_EMA = 0.4
/** 最小过渡时长（毫秒） */
export const MIN_TRANSITION_MS = 400
/** 最大过渡时长（毫秒） */
export const MAX_TRANSITION_MS = 8000
/** 智能模式兜底过渡时长（毫秒） */
export const DEFAULT_TRANSITION_MS = 3000
/** 尾部衰减分析 / 结尾触发窗口（秒）：过渡不得早于结尾前该窗口开始 */
export const TAIL_ANALYSIS_SEC = 30
/** 过渡触发提前量（毫秒）：最晚触发点 = 结尾前 过渡时长 + 该提前量，为节拍对齐等待与完整淡化预留时间 */
export const BEAT_TRIGGER_MARGIN_MS = 1200
/** 头部特征分析范围（秒） */
export const HEAD_ANALYSIS_SEC = 5
/** 前奏分析范围（秒）：用于计算"跳过前奏"的下一曲起始偏移 */
export const CONTENT_ANALYSIS_SEC = 30
/** 头部"内容起点"认定：距歌曲开头超过该秒数才视为存在可跳过的前奏 */
export const CONTENT_START_MIN_SEC = 1.5
/** BPM 端点分析窗口（秒）：上一曲结尾 / 下一曲开头的节奏对比范围 */
export const BPM_ANALYSIS_WINDOW_SEC = 30
/** BPM 差异阈值：差异超过该比例时对下一曲变速对齐 */
export const BPM_MATCH_THRESHOLD = 0.08
/** 有效 BPM 下限 */
export const BPM_MIN = 60
/** 有效 BPM 上限 */
export const BPM_MAX = 180
/** 调性对齐最大变调量（半音）：超出该范围不强行变调，仅降低兼容评分 */
export const MAX_PITCH_SHIFT_SEMITONES = 3
/** BPM 对齐变速窗口（秒）：仅对下一曲开头这 N 秒做变速/变调，其余原速原调拼接 */
export const STRETCH_HEAD_SEC = 30

// ====== 基础工具 ======

/** 让出主线程的辅助函数：将 CPU 密集分析按块执行，块间让出，避免阻塞 UI */
function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 计算一帧时域数据的 RMS 能量（0~1） */
export function computeRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i]
  }
  if (frame.length === 0) return 0
  return Math.min(1, Math.sqrt(sum / frame.length))
}

/** 计算指定窗口内数据的 RMS（0~1） */
function computeWindowRms(data: Float32Array, start: number, length: number): number {
  let sum = 0
  const end = Math.min(start + length, data.length)
  let count = 0
  for (let i = start; i < end; i++) {
    sum += data[i] * data[i]
    count++
  }
  if (count === 0) return 0
  return Math.min(1, Math.sqrt(sum / count))
}

/**
 * 起始点检测：当前能量相对上一帧突增
 * - 从静音跃起且能量足够大，也视为起始点
 * - 能量过低时不判定（避免噪声抖动误报）
 */
export function detectOnset(prevRms: number, currRms: number): boolean {
  if (currRms <= SILENCE_THRESHOLD) return false
  if (prevRms <= SILENCE_THRESHOLD) return currRms > ONSET_MIN_RMS
  return currRms >= prevRms * ONSET_RATIO_THRESHOLD
}

/** Hann 窗缓存（按需分配，只读复用） */
let cachedHann: Float32Array | null = null
function getHannWindow(size: number): Float32Array {
  if (!cachedHann || cachedHann.length !== size) {
    cachedHann = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      cachedHann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
    }
  }
  return cachedHann
}

/**
 * 就地基-2 FFT（迭代实现，长度必须为 2 的幂）
 * 计算完成后 re/im 为频域复数结果
 */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  // 蝶形运算
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

/** 就地逆 FFT（结果放大 1/n） */
function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]
  fft(re, im)
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] /= -n
  }
}

/** 计算帧的幅度谱（|X[k]|，k = 0..N/2），内部做 FFT */
function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  re.set(frame)
  fft(re, im)
  const half = (n >> 1) + 1
  const mag = new Float32Array(half)
  for (let k = 0; k < half; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
  }
  return mag
}

/** 相位展开到 [-π, π) */
function princarg(x: number): number {
  let y = x % (2 * Math.PI)
  if (y >= Math.PI) y -= 2 * Math.PI
  if (y < -Math.PI) y += 2 * Math.PI
  return y
}

// ====== BPM 估计 ======

/** 能量包络窗口（秒），用于 BPM 的 onset 检测 */
const BPM_ENVELOPE_WINDOW_SEC = 0.05
/** onset 间隔有效范围（毫秒）：对应 30-300 BPM 区间 */
const ONSET_INTERVAL_MIN_MS = 200
const ONSET_INTERVAL_MAX_MS = 2000

/**
 * 估计音频片段的 BPM
 * 能量包络 → 相对跃升 onset 检测 → onset 间隔中位数 → BPM（归一化到 60-180）。
 * @param channelData 单声道 PCM 数据
 * @param sampleRate 采样率
 * @param startSec 分析起点（秒，相对音频开头）
 * @param endSec 分析终点（秒，相对音频开头，默认到结尾）
 * @returns BPM；数据不足 / 无法估计返回 0
 */
export function estimateBpm(
  channelData: Float32Array,
  sampleRate: number,
  startSec = 0,
  endSec = channelData.length / sampleRate
): number {
  const startSample = Math.max(0, Math.min(channelData.length, Math.floor(startSec * sampleRate)))
  const endSample = Math.max(
    startSample + 1,
    Math.min(channelData.length, Math.floor(endSec * sampleRate))
  )
  const winSamples = Math.max(1, Math.floor(BPM_ENVELOPE_WINDOW_SEC * sampleRate))

  // 1) 能量包络
  const envelope: number[] = []
  for (let offset = startSample; offset + winSamples <= endSample; offset += winSamples) {
    envelope.push(computeWindowRms(channelData, offset, winSamples))
  }
  if (envelope.length < 20) return 0

  // 2) onset：能量相对之前约 2s 基线显著跃升
  const lookbackCount = Math.max(1, Math.round(2 / BPM_ENVELOPE_WINDOW_SEC))
  const minContentRms = Math.max(ONSET_MIN_RMS * 0.6, SILENCE_THRESHOLD * 2)
  const onsetSecs: number[] = []
  for (let i = lookbackCount; i < envelope.length; i++) {
    if (envelope[i] < minContentRms) continue
    let prevSum = 0
    for (let j = i - lookbackCount; j < i; j++) prevSum += envelope[j]
    const prevLevel = prevSum / lookbackCount
    if (envelope[i] >= Math.max(prevLevel * 1.6, prevLevel + 0.02)) {
      onsetSecs.push(i * BPM_ENVELOPE_WINDOW_SEC)
    }
  }
  if (onsetSecs.length < 4) return 0

  // 3) onset 间隔中位数 → BPM（间隔可能隔拍/半拍，归一化到合理区间）
  const intervals: number[] = []
  for (let i = 1; i < onsetSecs.length; i++) {
    const dMs = (onsetSecs[i] - onsetSecs[i - 1]) * 1000
    if (dMs >= ONSET_INTERVAL_MIN_MS && dMs <= ONSET_INTERVAL_MAX_MS) intervals.push(dMs)
  }
  if (intervals.length < 3) return 0
  intervals.sort((a, b) => a - b)
  const medianMs = intervals[Math.floor(intervals.length / 2)]
  if (medianMs <= 0) return 0
  let bpm = 60000 / medianMs
  while (bpm > BPM_MAX) bpm /= 2
  while (bpm < BPM_MIN) bpm *= 2
  return Math.round(bpm)
}

// ====== 调性（Key）检测与和谐兼容 ======

/** Krumhansl-Kessler 键位轮廓（C 大调 / A 小调，12 个音级的相对权重） */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** Camelot 轮盘编号（大调，根音 0..11 → 编号 1..12） */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
/** Camelot 轮盘编号（小调，根音 0..11 → 编号 1..12） */
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

/** 调性（音乐键） */
export interface MusicKey {
  /** 根音（0=C, 1=C# ... 11=B） */
  root: number
  /** 调式 */
  mode: 'major' | 'minor'
  /** 显示名，如 "C" / "Am" */
  name: string
  /** Camelot 轮盘编号，如 "8B" / "8A" */
  camelot: string
  /** 检测置信度（0~1） */
  confidence: number
}

/** 色度分析窗口大小（采样数，约 186ms @44.1kHz） */
const CHROMA_WINDOW = 8192
/** 色度分析步进（采样数） */
const CHROMA_HOP = 2048
/** 色度映射的频段范围（Hz），滤除次低频噪声与高频混叠 */
const CHROMA_MIN_HZ = 60
const CHROMA_MAX_HZ = 5000
/** 参与调性检测的频点需达到的最小幅度（相对全曲峰值的比例） */
const CHROMA_MIN_MAG_RATIO = 0.01

/** 计算 12 维色度向量（音级能量分布），数据过短返回 null */
function computeChroma(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number
): Float32Array | null {
  const length = Math.min(channelData.length, Math.floor(maxSec * sampleRate))
  if (length < CHROMA_WINDOW) return null
  const hann = getHannWindow(CHROMA_WINDOW)
  const frame = new Float32Array(CHROMA_WINDOW)
  const chroma = new Float32Array(12)
  let peakMag = 0
  let windows = 0
  const binFreq = sampleRate / CHROMA_WINDOW

  for (let offset = 0; offset + CHROMA_WINDOW <= length; offset += CHROMA_HOP) {
    for (let i = 0; i < CHROMA_WINDOW; i++) {
      frame[i] = channelData[offset + i] * hann[i]
    }
    const mag = magnitudeSpectrum(frame)
    // 能量最大的前 1/4 频点（基音与谐波通常在此区间）
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      if (freq < CHROMA_MIN_HZ || freq > CHROMA_MAX_HZ) continue
      if (mag[k] > peakMag) peakMag = mag[k]
    }
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      if (freq < CHROMA_MIN_HZ || freq > CHROMA_MAX_HZ) continue
      if (peakMag > 0 && mag[k] < peakMag * CHROMA_MIN_MAG_RATIO) continue
      // 频率 → 音级：12*log2(f/440) + 9（A4=440Hz，音级 9）
      const exact = 12 * Math.log2(freq / 440) + 9
      const idx = Math.floor(exact)
      const frac = exact - idx
      const i0 = ((idx % 12) + 12) % 12
      const i1 = (i0 + 1) % 12
      chroma[i0] += mag[k] * (1 - frac)
      chroma[i1] += mag[k] * frac
    }
    windows++
  }

  if (windows === 0) return null
  return chroma
}

/** 分块异步版本：与 computeChroma 结果一致，每批窗口让出主线程（FFT 密集） */
async function computeChromaAsync(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number
): Promise<Float32Array | null> {
  const length = Math.min(channelData.length, Math.floor(maxSec * sampleRate))
  if (length < CHROMA_WINDOW) return null
  const hann = getHannWindow(CHROMA_WINDOW)
  const frame = new Float32Array(CHROMA_WINDOW)
  const chroma = new Float32Array(12)
  let peakMag = 0
  let windows = 0
  let processed = 0
  const binFreq = sampleRate / CHROMA_WINDOW

  for (let offset = 0; offset + CHROMA_WINDOW <= length; offset += CHROMA_HOP) {
    for (let i = 0; i < CHROMA_WINDOW; i++) {
      frame[i] = channelData[offset + i] * hann[i]
    }
    const mag = magnitudeSpectrum(frame)
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      if (freq < CHROMA_MIN_HZ || freq > CHROMA_MAX_HZ) continue
      if (mag[k] > peakMag) peakMag = mag[k]
    }
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      if (freq < CHROMA_MIN_HZ || freq > CHROMA_MAX_HZ) continue
      if (peakMag > 0 && mag[k] < peakMag * CHROMA_MIN_MAG_RATIO) continue
      const exact = 12 * Math.log2(freq / 440) + 9
      const idx = Math.floor(exact)
      const frac = exact - idx
      const i0 = ((idx % 12) + 12) % 12
      const i1 = (i0 + 1) % 12
      chroma[i0] += mag[k] * (1 - frac)
      chroma[i1] += mag[k] * frac
    }
    windows++
    processed++
    if (processed % 32 === 0) await yieldMainThread()
  }

  if (windows === 0) return null
  return chroma
}

/** 从色度向量判定调性（与 KK 轮廓循环相关，纯计算） */
function classifyKey(chroma: Float32Array): MusicKey {
  // 归一化色度向量
  let norm = 0
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i]
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
  const c = new Float32Array(12)
  for (let i = 0; i < 12; i++) c[i] = chroma[i] * inv

  let bestCos = -Infinity
  let bestRoot = 0
  let bestMode: 'major' | 'minor' = 'major'

  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? KK_MAJOR : KK_MINOR
    let pNorm = 0
    for (let i = 0; i < 12; i++) pNorm += profile[i] * profile[i]
    const pInv = 1 / Math.sqrt(pNorm)
    for (let shift = 0; shift < 12; shift++) {
      let dot = 0
      for (let i = 0; i < 12; i++) {
        dot += c[i] * (profile[(i + shift) % 12] * pInv)
      }
      if (dot > bestCos) {
        bestCos = dot
        bestRoot = (12 - shift) % 12 // 轮廓移 shift 对应根音为 -shift
        bestMode = mode
      }
    }
  }

  const camelot = bestMode === 'major' ? CAMELOT_MAJOR[bestRoot] : CAMELOT_MINOR[bestRoot]
  return {
    root: bestRoot,
    mode: bestMode,
    name: bestMode === 'major' ? KEY_NAMES[bestRoot] : `${KEY_NAMES[bestRoot]}m`,
    camelot: `${camelot}${bestMode === 'major' ? 'B' : 'A'}`,
    confidence: Math.max(0, Math.min(1, bestCos))
  }
}

/**
 * 调性检测：色度向量与 Krumhansl-Kessler 大/小调轮廓做循环相关，
 * 取相关度最高的根音与调式。
 * @param channelData 单声道 PCM 数据
 * @param sampleRate 采样率
 * @param maxSec 分析范围（秒），建议整曲或主干段落
 * @returns 调性；数据不足返回 null
 */
export function analyzeKey(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = TAIL_ANALYSIS_SEC
): MusicKey | null {
  const chroma = computeChroma(channelData, sampleRate, maxSec)
  return chroma ? classifyKey(chroma) : null
}

/** 分块异步版本的调性检测：FFT 密集部分块间让出主线程，结果与 analyzeKey 一致 */
export async function analyzeKeyAsync(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = TAIL_ANALYSIS_SEC
): Promise<MusicKey | null> {
  const chroma = await computeChromaAsync(channelData, sampleRate, maxSec)
  return chroma ? classifyKey(chroma) : null
}

/**
 * Camelot 轮盘距离（调和混音兼容度）
 * - 同编号（大小调相对 / 完全相同）→ 0（完美）
 * - 同字母、编号相邻 → 1（顺滑）
 * - 同字母、编号相差 N → N
 * - 字母不同且编号不同 → 编号距离 + 1
 */
export function camelotDistance(a: MusicKey, b: MusicKey): number {
  const aNum = parseInt(a.camelot)
  const bNum = parseInt(b.camelot)
  const aLetter = a.camelot[a.camelot.length - 1]
  const bLetter = b.camelot[b.camelot.length - 1]
  if (aNum === bNum) return 0
  const diff = Math.min((aNum - bNum + 12) % 12, (bNum - aNum + 12) % 12)
  return aLetter === bLetter ? diff : diff + 1
}

/**
 * 调性对齐：寻找使下一曲与当前曲最和谐的最小变调量（半音）
 * 变调只改变根音（调式不变），在 [−maxShift, +maxShift] 内枚举，
 * 优先距离更小，同距离时取更小的变调量。找不到明显改善时返回 0。
 * @returns shift：应用到下一曲的变调半音数（正=升调，负=降调）；distance：对齐后的 Camelot 距离
 */
export function findKeyAlignment(
  current: MusicKey,
  next: MusicKey,
  maxShift: number = MAX_PITCH_SHIFT_SEMITONES
): { shift: number; distance: number } {
  let best = { shift: 0, distance: camelotDistance(current, next) }
  for (let s = -maxShift; s <= maxShift; s++) {
    if (s === 0) continue
    const shiftedRoot = (((next.root + s) % 12) + 12) % 12
    const shifted: MusicKey = {
      root: shiftedRoot,
      mode: next.mode,
      name: '',
      camelot:
        next.mode === 'major' ? `${CAMELOT_MAJOR[shiftedRoot]}B` : `${CAMELOT_MINOR[shiftedRoot]}A`,
      confidence: next.confidence
    }
    const d = camelotDistance(current, shifted)
    if (d < best.distance || (d === best.distance && Math.abs(s) < Math.abs(best.shift))) {
      best = { shift: s, distance: d }
    }
  }
  return best
}

// ====== 尾部衰减 / 头部特征 / 跳过前奏 ======

/** 当前曲尾部特征 */
export interface TailDecay {
  /** 尾部窗口内峰值能量 */
  peakRms: number
  /** 自然衰减起点（相对歌曲开头，秒）；未检测到衰减则为 -1 */
  decayStartSec: number
  /** 衰减速率（能量相对每秒下降比例，0~1） */
  decayRate: number
}

/**
 * 当前曲尾部衰减分析（在结尾 tailSec 窗口内检测自然衰减 / 静音）
 * 过渡应在"音乐自然淡出"处开始，避免切在歌曲高潮处产生跳变。
 */
export function analyzeTail(
  channelData: Float32Array,
  sampleRate: number,
  tailSec: number = TAIL_ANALYSIS_SEC
): TailDecay {
  const empty: TailDecay = { peakRms: 0, decayStartSec: -1, decayRate: 0 }
  const durationSec = channelData.length / sampleRate
  if (durationSec <= 0) return empty

  const windowSec = 0.05
  const winSamples = Math.floor(windowSec * sampleRate)
  const startSample = Math.max(0, Math.floor((durationSec - tailSec) * sampleRate))
  const endSample = channelData.length

  const segments: Array<{ timeSec: number; rms: number }> = []
  let peakRms = 0
  for (let offset = startSample; offset + winSamples <= endSample; offset += winSamples) {
    const rms = computeWindowRms(channelData, offset, winSamples)
    segments.push({ timeSec: offset / sampleRate, rms })
    if (rms > peakRms) peakRms = rms
  }
  if (segments.length === 0) return empty

  const endRms = segments[segments.length - 1].rms
  const windowStartSec = startSample / sampleRate

  // 静音尾部：整段几乎无能量，衰减起点即窗口起点
  if (peakRms < SILENCE_THRESHOLD) {
    return { peakRms, decayStartSec: windowStartSec, decayRate: 0 }
  }

  // 峰值位置之后第一个降到峰值 70% 以下的位置即为衰减起点
  const peakIdx = segments.reduce((best, s, i) => (s.rms > segments[best].rms ? i : best), 0)
  const decayThreshold = Math.max(peakRms * 0.7, SILENCE_THRESHOLD * 2)
  let decayStartSec = -1
  for (let i = peakIdx; i < segments.length; i++) {
    if (segments[i].rms <= decayThreshold) {
      decayStartSec = segments[i].timeSec
      break
    }
  }

  // 衰减速率
  let decayRate = 0
  if (decayStartSec >= 0) {
    const startSampleSeg = segments.find((s) => s.timeSec >= decayStartSec)
    const spanSec = durationSec - decayStartSec
    if (startSampleSeg && spanSec > 0) {
      decayRate =
        Math.max(0, startSampleSeg.rms - endRms) / spanSec / Math.max(startSampleSeg.rms, 1e-6)
    }
  }

  return { peakRms, decayStartSec, decayRate }
}

/** 下一首头部特征 */
export interface HeadFeatures {
  /** 头部窗口内峰值能量 */
  peakRms: number
  /** 头部窗口平均能量 */
  avgRms: number
  /** 到达峰值一半所需时间（秒），-1 表示能量过低无法判定 */
  attackTimeSec: number
  /** 头部初始能量是否极低（适合从静音淡入） */
  startsQuiet: boolean
  /** 首个分析窗口的 RMS */
  initialRms: number
}

/**
 * 下一首头部特征分析：攻击速度 / 起始安静度决定过渡时长选择
 */
export function analyzeHead(
  channelData: Float32Array,
  sampleRate: number,
  headSec: number = HEAD_ANALYSIS_SEC
): HeadFeatures {
  const windowSamples = Math.floor(0.05 * sampleRate)
  const length = Math.min(channelData.length, Math.floor(headSec * sampleRate))
  const segments: Array<{ timeSec: number; rms: number }> = []

  let peakRms = 0
  let sumRms = 0
  let attackTimeSec = -1
  let foundAttack = false

  for (let offset = 0; offset < length; offset += windowSamples) {
    const rms = computeWindowRms(channelData, offset, windowSamples)
    const timeSec = offset / sampleRate
    segments.push({ timeSec, rms })
    if (rms > peakRms) peakRms = rms
    sumRms += rms
    if (
      !foundAttack &&
      rms >= Math.max(peakRms * 0.5, SILENCE_THRESHOLD) &&
      rms > SILENCE_THRESHOLD
    ) {
      attackTimeSec = timeSec
      foundAttack = true
    }
  }

  const avgRms = segments.length > 0 ? sumRms / segments.length : 0
  const startsQuiet = segments.length > 0 && segments[0].rms < SILENCE_THRESHOLD * 2
  if (attackTimeSec < 0 && peakRms > SILENCE_THRESHOLD) attackTimeSec = 0

  return {
    peakRms,
    avgRms,
    attackTimeSec,
    startsQuiet,
    initialRms: segments.length > 0 ? segments[0].rms : 0
  }
}

// ====== 跳过前奏（内容起点） ======

/** 人声频段（Hz）：歌声基音谐波与共振峰的主要集中区，乐器前奏通常在此频段能量较弱 */
const VOCAL_BAND_MIN_HZ = 1000
const VOCAL_BAND_MAX_HZ = 4000
/** 频段分析窗口采样数（2 的幂，约 46ms @44.1kHz） */
const SPECTRUM_WINDOW = 2048
/** 人声频谱分析每批处理的窗口数（约 64×46ms ≈ 3s 音频，单批阻塞 < 20ms） */
const PROFILE_CHUNK_WINDOWS = 64

/** 单窗口的频谱人声占比快照 */
interface VocalWindow {
  /** 窗口起始时间（秒，相对歌曲开头） */
  startSec: number
  /** 窗口 RMS */
  rms: number
  /** 1k-4kHz 人声频段能量占比（0~1） */
  vocalRatio: number
}

/**
 * 计算指定采样范围 [startSample, endSample) 内逐窗口的 RMS 与人声频段占比
 * Hann 窗抑制矩形窗的频谱泄漏，避免强能量音色向人声频段渗漏导致占比误判
 */
function computeVocalProfile(
  channelData: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number = channelData.length
): { windows: VocalWindow[]; windowSec: number } {
  const winSamples = SPECTRUM_WINDOW
  const hann = getHannWindow(winSamples)
  const frame = new Float32Array(winSamples)
  const windows: VocalWindow[] = []
  const binFreq = sampleRate / winSamples
  for (let offset = startSample; offset + winSamples <= endSample; offset += winSamples) {
    const rms = computeWindowRms(channelData, offset, winSamples)
    for (let i = 0; i < winSamples; i++) {
      frame[i] = channelData[offset + i] * hann[i]
    }
    const mag = magnitudeSpectrum(frame)
    let total = 0
    let vocal = 0
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      total += mag[k]
      if (freq >= VOCAL_BAND_MIN_HZ && freq <= VOCAL_BAND_MAX_HZ) vocal += mag[k]
    }
    windows.push({ startSec: offset / sampleRate, rms, vocalRatio: total > 0 ? vocal / total : 0 })
  }
  return { windows, windowSec: winSamples / sampleRate }
}

/** 分块异步版本：与 computeVocalProfile 结果一致，块间让出主线程 */
async function computeVocalProfileAsync(
  channelData: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number = channelData.length
): Promise<{ windows: VocalWindow[]; windowSec: number }> {
  const winSamples = SPECTRUM_WINDOW
  const hann = getHannWindow(winSamples)
  const frame = new Float32Array(winSamples)
  const windows: VocalWindow[] = []
  const binFreq = sampleRate / winSamples
  let processed = 0
  for (let offset = startSample; offset + winSamples <= endSample; offset += winSamples) {
    const rms = computeWindowRms(channelData, offset, winSamples)
    for (let i = 0; i < winSamples; i++) {
      frame[i] = channelData[offset + i] * hann[i]
    }
    const mag = magnitudeSpectrum(frame)
    let total = 0
    let vocal = 0
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      total += mag[k]
      if (freq >= VOCAL_BAND_MIN_HZ && freq <= VOCAL_BAND_MAX_HZ) vocal += mag[k]
    }
    windows.push({ startSec: offset / sampleRate, rms, vocalRatio: total > 0 ? vocal / total : 0 })
    processed++
    if (processed % PROFILE_CHUNK_WINDOWS === 0) await yieldMainThread()
  }
  return { windows, windowSec: winSamples / sampleRate }
}

/** 人声起点检测（相对跃升）：首个"1k-4kHz 占比相对之前约 2s 基线显著跃升且持续约 0.5s"的窗口 */
function detectVocalRise(
  ratios: number[],
  rmsValues: number[],
  windowSec: number,
  sustainCount: number,
  minContentRms: number
): number {
  const lookbackCount = Math.max(1, Math.round(2 / windowSec))
  for (let i = lookbackCount; i <= ratios.length - sustainCount; i++) {
    if (rmsValues[i] < minContentRms) continue
    let prevSum = 0
    for (let j = i - lookbackCount; j < i; j++) prevSum += ratios[j]
    const prevLevel = prevSum / lookbackCount
    const rise = ratios[i] - prevLevel
    if (ratios[i] < Math.max(prevLevel * 1.5, prevLevel + 0.05)) continue
    let sustained = 0
    const sustainFloor = prevLevel + Math.max(0.03, rise * 0.5)
    for (let j = i; j < i + sustainCount; j++) {
      if (ratios[j] >= sustainFloor) sustained++
    }
    if (sustained >= Math.ceil(sustainCount * 0.6)) return i * windowSec
  }
  return -1
}

/** 能量跃升检测：首个"后续约 0.5s 持续能量显著高于之前约 2s"的窗口 */
function detectEnergyJump(
  rmsValues: number[],
  windowSec: number,
  sustainCount: number,
  minContentRms: number
): number {
  const lookbackCount = Math.max(1, Math.round(2 / windowSec))
  for (let i = lookbackCount; i <= rmsValues.length - sustainCount; i++) {
    let prevSum = 0
    for (let j = i - lookbackCount; j < i; j++) prevSum += rmsValues[j]
    const prevLevel = prevSum / lookbackCount
    let nextSum = 0
    for (let j = i; j < i + sustainCount; j++) nextSum += rmsValues[j]
    const nextLevel = nextSum / sustainCount
    if (nextLevel < minContentRms) continue
    if (nextLevel / Math.max(prevLevel, 1e-4) >= 1.6) return i * windowSec
  }
  return -1
}

/** 从频谱窗口序列中判定"内容起点"（纯函数，同步/异步共用） */
function findContentStart(windows: VocalWindow[], windowSec: number): number {
  const rmsValues = windows.map((w) => w.rms)
  const vocalRatios = windows.map((w) => w.vocalRatio)
  if (rmsValues.length < 10) return 0

  let peak = 0
  for (const r of rmsValues) {
    if (r > peak) peak = r
  }
  if (peak < SILENCE_THRESHOLD) return 0

  const sustainCount = Math.max(1, Math.round(0.5 / windowSec))
  const minContentRms = Math.max(ONSET_MIN_RMS * 0.6, SILENCE_THRESHOLD * 2)

  // 1) 人声起点（主歌从人声开始）
  const vocalStart = detectVocalRise(vocalRatios, rmsValues, windowSec, sustainCount, minContentRms)
  if (vocalStart >= 0) return vocalStart >= CONTENT_START_MIN_SEC ? vocalStart : 0

  // 2) 能量跃升兜底（无人声信号的器乐曲 / 纯音）
  const energyStart = detectEnergyJump(rmsValues, windowSec, sustainCount, minContentRms)
  return energyStart >= CONTENT_START_MIN_SEC ? energyStart : 0
}

/**
 * 下一首"内容起点"分析（跳过前奏）
 * 优先检测"人声进入"（1k-4kHz 占比显著持续升高），无人声信号时回退能量跃升。
 * @returns 应跳过的前奏长度（秒），无前奏返回 0
 */
export function analyzeContentStart(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = CONTENT_ANALYSIS_SEC
): number {
  const length = Math.min(channelData.length, Math.floor(maxSec * sampleRate))
  const { windows, windowSec } = computeVocalProfile(channelData, sampleRate, 0, length)
  return findContentStart(windows, windowSec)
}

/** 分块异步版本的"内容起点"分析 */
export async function analyzeContentStartAsync(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = CONTENT_ANALYSIS_SEC
): Promise<number> {
  const length = Math.min(channelData.length, Math.floor(maxSec * sampleRate))
  const { windows, windowSec } = await computeVocalProfileAsync(channelData, sampleRate, 0, length)
  return findContentStart(windows, windowSec)
}

// ====== 智能过渡计划（节奏 + 调性联合决策） ======

/** 智能过渡计划 */
export interface TransitionPlan {
  /** 过渡触发点（毫秒，相对当前曲开头） */
  triggerMs: number
  /** 实际过渡时长（毫秒） */
  transitionDurationMs: number
  /** 过渡质量评分（0~1），越高表示衔接越自然 */
  quality: number
  /** 应用到下一曲的变速比（1 = 不变速；<1 加速、>1 减速） */
  stretchRatio: number
  /** 应用到下一曲的变调半音数（0 = 不变调） */
  pitchShiftSemitones: number
  /** 下一曲起始偏移（毫秒，变速后时间轴，跳过前奏） */
  startOffsetMs: number
  /** 变调对齐后的 Camelot 距离（0 = 和谐） */
  keyDistance: number
  /** 节奏是否匹配（差异在阈值内 / 2 倍频对齐） */
  tempoMatch: boolean
}

/** computeTransitionPlan 入参 */
export interface TransitionPlanParams {
  /** 当前曲总时长（毫秒，引擎缓冲时长） */
  durationMs: number
  /** 当前曲尾部衰减特征 */
  tail: TailDecay
  /** 当前曲结尾 BPM（0 = 无法估计） */
  currentBpm: number
  /** 下一曲开头 BPM（0 = 无法估计） */
  nextBpm: number
  /** 当前曲调性（null = 无法检测） */
  currentKey: MusicKey | null
  /** 下一曲调性（null = 无法检测） */
  nextKey: MusicKey | null
  /** 下一曲内容起点偏移（秒，跳过前奏，原时间轴） */
  contentStartSec: number
  /** 用户配置的过渡时长（毫秒），作为基准 */
  userTransitionMs: number
}

/**
 * 计算智能过渡计划
 *
 * 决策维度：
 * - 节奏：BPM 差异在阈值内视为匹配（tempoMatch）；超出时给出变速比（下一曲变速到当前曲节奏）
 * - 调性：Camelot 距离判定和谐度，不和谐时给出最小变调量（对齐到和谐键位）
 * - 能量：尾部自然衰减处触发；触发点限制在结尾 30s 窗口内，
 *   最晚不晚于"结尾前 过渡时长 + 节拍提前量"，保证节拍对齐等待与完整淡化
 *   在歌曲自然结束前完成，避免淡化被截断
 * - 时长：节奏与调性越匹配 → 过渡越长（越丝滑）；越不匹配 → 过渡越短（减少冲突听感）
 */
export function computeTransitionPlan(p: TransitionPlanParams): TransitionPlan {
  const { durationMs } = p
  const userMs = Math.max(
    MIN_TRANSITION_MS,
    Math.min(MAX_TRANSITION_MS, p.userTransitionMs || DEFAULT_TRANSITION_MS)
  )

  // ---- 1. 节奏 ----
  let stretchRatio = 1
  let tempoMatch = false
  if (p.currentBpm > 0 && p.nextBpm > 0) {
    const rawRatio = p.nextBpm / p.currentBpm
    if (Math.abs(rawRatio - 1) <= BPM_MATCH_THRESHOLD) {
      tempoMatch = true // 同速
    } else if (
      Math.abs(rawRatio - 0.5) <= BPM_MATCH_THRESHOLD ||
      Math.abs(rawRatio - 2) <= BPM_MATCH_THRESHOLD * 2
    ) {
      tempoMatch = true // 2 倍频对齐（半速 / 倍速）
    } else if (rawRatio >= 0.8 && rawRatio <= 1.25) {
      // 轻微差异：对下一曲变速对齐（1/比值，限 ±25%，超出不强变速）
      stretchRatio = 1 / rawRatio
      tempoMatch = true
    }
  }
  const tempoScore = tempoMatch ? 1 : Math.max(0, 1 - Math.abs(1 - 1 / stretchRatio) * 4)

  // ---- 2. 调性 ----
  let keyDistance = 2
  let pitchShiftSemitones = 0
  if (p.currentKey && p.nextKey) {
    const align = findKeyAlignment(p.currentKey, p.nextKey)
    keyDistance = align.distance
    pitchShiftSemitones = align.shift
  }
  const keyScore = Math.max(0, 1 - keyDistance / 4)

  // ---- 3. 触发点 ----
  const earliestMs = Math.max(0, durationMs - TAIL_ANALYSIS_SEC * 1000)
  const latestMs = Math.max(0, durationMs - userMs - BEAT_TRIGGER_MARGIN_MS)
  let triggerMs: number
  if (p.tail.decayStartSec >= 0) {
    triggerMs = p.tail.decayStartSec * 1000
  } else {
    triggerMs = earliestMs
  }
  triggerMs = Math.min(Math.max(triggerMs, earliestMs), latestMs)

  // ---- 4. 时长与质量 ----
  const energyScore = p.tail.peakRms > 0 ? Math.min(1, 0.4 + p.tail.decayRate * 2) : 0.5
  const quality = 0.4 * tempoScore + 0.4 * keyScore + 0.2 * energyScore
  // 越匹配过渡越长：基准时长 × (0.6 ~ 1.4)
  const baseDurationMs = Math.max(
    MIN_TRANSITION_MS,
    Math.min(MAX_TRANSITION_MS, Math.round(userMs * (0.6 + 0.8 * quality)))
  )
  // 剩余时间不足以完成淡化时收窄
  const remainingMs = Math.max(0, durationMs - triggerMs)
  const finalDurationMs = Math.max(MIN_TRANSITION_MS, Math.min(baseDurationMs, remainingMs))

  // ---- 5. 下一曲起始偏移（变速后时间轴） ----
  let startOffsetMs = Math.round(p.contentStartSec * 1000)
  if (stretchRatio !== 1 && p.contentStartSec < STRETCH_HEAD_SEC) {
    startOffsetMs = Math.round(startOffsetMs * stretchRatio)
  }

  return {
    triggerMs,
    transitionDurationMs: finalDurationMs,
    quality,
    stretchRatio,
    pitchShiftSemitones,
    startOffsetMs,
    keyDistance,
    tempoMatch
  }
}

// ====== WSOLA 变速不变调 ======

/** WSOLA 分析窗（采样数，约 46ms @44.1kHz） */
const WSOLA_ANALYSIS_WINDOW = 2048
/** WSOLA 合成步进（采样数） */
const WSOLA_SYNTH_HOP = 512
/** WSOLA 相关搜索步长 */
const WSOLA_SEARCH_STEP = 2
/** WSOLA 相关性计算降采样倍数 */
const WSOLA_CORRELATION_DECIMATION = 4
/** 变速每批处理的合成帧数（每帧约 6.8 万次运算，单批阻塞 < 20ms） */
const STRETCH_CHUNK_FRAMES = 24

/**
 * WSOLA 合成单帧（同步/异步版本共用）
 * 在标称输入位置附近搜索与输出上一段尾部（重叠区）最相似的输入起点，
 * 交叉淡化拼接后返回最优输入位置（供调用方推进 readNominal）。
 */
function stretchSynthFrame(
  input: Float32Array,
  output: Float32Array,
  readNominal: number,
  writePos: number,
  N: number,
  H: number,
  step: number,
  decim: number,
  ratio: number
): number {
  const candStart = Math.max(0, readNominal - H)
  const candEnd = Math.min(input.length - N, readNominal + H)
  let bestPos = Math.min(Math.max(readNominal, candStart), candEnd)
  let bestScore = -Infinity
  for (let cand = candStart; cand <= candEnd; cand += step) {
    let score = 0
    for (let k = 0; k < H; k += decim) {
      score += input[cand + k] * output[writePos - H + k]
    }
    if (score > bestScore) {
      bestScore = score
      bestPos = cand
    }
  }

  // 交叉淡化合成：重叠区与前段尾部线性交叉淡化，其余直接拷贝
  for (let k = 0; k < H; k++) {
    const gain = k / H
    output[writePos + k] = input[bestPos + k] * gain + output[writePos - H + k] * (1 - gain)
  }
  for (let k = H; k < N; k++) {
    output[writePos + k] = input[bestPos + k]
  }
  return bestPos + H / ratio
}

/**
 * WSOLA 变速（变速不变调）：只改变播放时长与节奏速度，音调保持不变。
 * @param input 单声道 PCM 数据
 * @param ratio 输出/输入时长比例（<1 加速、>1 减速、≈1 原样返回）
 */
export function timeStretchPcm(input: Float32Array, ratio: number): Float32Array {
  if (!isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return input
  const N = WSOLA_ANALYSIS_WINDOW
  const H = WSOLA_SYNTH_HOP
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const output = new Float32Array(outLen)
  if (input.length <= N) {
    for (let i = 0; i < Math.min(outLen, input.length); i++) output[i] = input[i]
    return output
  }
  const firstLen = Math.min(N, outLen)
  for (let i = 0; i < firstLen; i++) output[i] = input[i]
  let readNominal = N
  let writePos = firstLen
  while (writePos + N <= outLen && readNominal < input.length) {
    readNominal = stretchSynthFrame(
      input,
      output,
      readNominal,
      writePos,
      N,
      H,
      WSOLA_SEARCH_STEP,
      WSOLA_CORRELATION_DECIMATION,
      ratio
    )
    writePos += H
  }
  while (writePos < outLen && readNominal < input.length) {
    output[writePos] = input[Math.floor(readNominal)]
    writePos++
    readNominal++
  }
  return output
}

/** 分块异步版本的 WSOLA 变速：块间让出主线程，避免长时间同步计算阻塞 UI */
export async function timeStretchPcmAsync(
  input: Float32Array,
  ratio: number
): Promise<Float32Array> {
  if (!isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return input
  const N = WSOLA_ANALYSIS_WINDOW
  const H = WSOLA_SYNTH_HOP
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const output = new Float32Array(outLen)
  if (input.length <= N) {
    for (let i = 0; i < Math.min(outLen, input.length); i++) output[i] = input[i]
    return output
  }
  const firstLen = Math.min(N, outLen)
  for (let i = 0; i < firstLen; i++) output[i] = input[i]
  let readNominal = N
  let writePos = firstLen
  let framesInChunk = 0
  while (writePos + N <= outLen && readNominal < input.length) {
    readNominal = stretchSynthFrame(
      input,
      output,
      readNominal,
      writePos,
      N,
      H,
      WSOLA_SEARCH_STEP,
      WSOLA_CORRELATION_DECIMATION,
      ratio
    )
    writePos += H
    framesInChunk++
    if (framesInChunk >= STRETCH_CHUNK_FRAMES) {
      framesInChunk = 0
      await yieldMainThread()
    }
  }
  while (writePos < outLen && readNominal < input.length) {
    output[writePos] = input[Math.floor(readNominal)]
    writePos++
    readNominal++
  }
  return output
}

// ====== 相位声码器变调（变调不变速） ======

/** 相位声码器分析窗（采样数，约 46ms @44.1kHz） */
const PV_WINDOW = 2048
/** 相位声码器分析步进（采样数） */
const PV_ANALYSIS_HOP = 512
/** 相位声码器每批处理的帧数（单批阻塞 < 20ms） */
const PV_CHUNK_FRAMES = 8

/** 线性插值重采样：输出长度 = round(input.length × factor) */
function resample(input: Float32Array, factor: number): Float32Array {
  const outLen = Math.max(1, Math.round(input.length * factor))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i / factor
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const i1 = Math.min(i0 + 1, input.length - 1)
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** 相位声码器状态（跨批次保留相位连续性） */
interface PhaseVocoderState {
  ratio: number
  readPos: number
  writePos: number
  prevPhase: Float32Array
  synthPhase: Float32Array
  output: Float32Array
  /** 重叠相加权重累积（Hann²，用于 OLA 归一化） */
  accWin: Float32Array
}

/** 初始化相位声码器状态 */
function initPhaseVocoder(input: Float32Array, ratio: number): PhaseVocoderState {
  const N = PV_WINDOW
  const outLen = Math.max(1, Math.round(input.length * ratio))
  return {
    ratio,
    readPos: 0,
    writePos: 0,
    prevPhase: new Float32Array(N / 2 + 1),
    synthPhase: new Float32Array(N / 2 + 1),
    output: new Float32Array(outLen),
    accWin: new Float32Array(outLen)
  }
}

/**
 * 相位声码器处理一个批次（phase propagation 保持音调，合成步进按 ratio 缩放实现时长拉伸）
 * 处理完成后推进 readPos / writePos。
 */
function phaseVocoderProcess(
  input: Float32Array,
  state: PhaseVocoderState,
  maxFrames: number
): void {
  const N = PV_WINDOW
  const Ha = PV_ANALYSIS_HOP
  const Hs = Math.max(1, Math.round(Ha * state.ratio))
  const half = N / 2 + 1
  const hann = getHannWindow(N)
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const frame = new Float32Array(N)

  let frames = 0
  while (frames < maxFrames && state.writePos + N <= state.output.length) {
    if (state.readPos + N > input.length) break
    // 加窗 + FFT
    for (let i = 0; i < N; i++) {
      frame[i] = input[state.readPos + i] * hann[i]
    }
    re.set(frame)
    im.fill(0)
    fft(re, im)

    // 相位传播：期望相位 = 前一帧相位 + 2π·k·Ha/N；实际与期望的差作为修正量
    for (let k = 0; k < half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const phase = Math.atan2(im[k], re[k])
      const expected = state.prevPhase[k] + (2 * Math.PI * k * Ha) / N
      const delta = princarg(phase - expected)
      state.synthPhase[k] += (2 * Math.PI * k * Hs) / N + delta
      state.prevPhase[k] = phase
      re[k] = mag * Math.cos(state.synthPhase[k])
      im[k] = mag * Math.sin(state.synthPhase[k])
      // 共轭对称：负频部分（超出 half 的 bin）由 IFFT 对称性自动恢复
    }
    for (let k = half; k < N; k++) {
      re[k] = 0
      im[k] = 0
    }
    ifft(re, im)
    // 加窗 + 重叠相加：负频置零使输出幅度减半，×2 补偿；Hann² 权重累积用于 OLA 归一化
    for (let i = 0; i < N; i++) {
      const s = re[i] * 2 * hann[i]
      state.output[state.writePos + i] += s
      state.accWin[state.writePos + i] += hann[i] * hann[i]
    }
    state.readPos += Ha
    state.writePos += Hs
    frames++
  }
}

/** OLA 归一化：按重叠相加权重去除幅度纹波，返回归一化后的拉伸信号 */
function normalizePhaseVocoder(state: PhaseVocoderState): Float32Array {
  const { output, accWin } = state
  for (let i = 0; i < state.writePos; i++) {
    if (accWin[i] > 1e-6) output[i] /= accWin[i]
  }
  return output
}

/**
 * 相位声码器变调（变调不变速）
 * 两步法：先相位声码器拉伸时长（ratio = 2^(半音/12)），再线性重采样
 * 恢复原时长 → 时长不变、音调升高/降低 ratio 倍。
 * @param input 单声道 PCM 数据
 * @param semitones 变调量（半音，正=升调、负=降调）
 */
export function pitchShiftPcm(input: Float32Array, semitones: number): Float32Array {
  if (semitones === 0 || input.length < PV_WINDOW * 2) return input
  const ratio = Math.pow(2, semitones / 12)
  const state = initPhaseVocoder(input, ratio)
  phaseVocoderProcess(input, state, Number.MAX_SAFE_INTEGER)
  return resample(normalizePhaseVocoder(state), 1 / ratio)
}

/** 分块异步版本的相位声码器变调：块间让出主线程 */
export async function pitchShiftPcmAsync(
  input: Float32Array,
  semitones: number
): Promise<Float32Array> {
  if (semitones === 0 || input.length < PV_WINDOW * 2) return input
  const ratio = Math.pow(2, semitones / 12)
  const state = initPhaseVocoder(input, ratio)
  while (
    state.writePos + PV_WINDOW <= state.output.length &&
    state.readPos + PV_WINDOW <= input.length
  ) {
    phaseVocoderProcess(input, state, PV_CHUNK_FRAMES)
    await yieldMainThread()
  }
  return resample(normalizePhaseVocoder(state), 1 / ratio)
}
