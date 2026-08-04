/**
 * 实时过渡点分析核心 DSP（纯函数，无 DOM 依赖）
 *
 * 本模块被两个执行环境复用：
 * 1. Web Worker（transition-analyzer.worker.ts）—— 流式实时分析
 * 2. 主线程降级（transition-analyzer.ts）—— Worker 不可用时直接调用
 *
 * 分析思路（与 audio-analyzer.ts 的离线分析理念一致，但按帧流式处理）：
 * - 滚动 RMS 能量包络：每帧（AnalyserNode fftSize=256）计算 RMS，EMA 平滑抑制波动
 * - 起始点检测：能量相对前一帧突增（倍数阈值）
 * - 尾部衰减检测：最近 ~15s 窗口内峰值之后能量下降到 70% 以下，判定自然衰减起点
 * - 决策产出：尾部衰减起点 + 下一首头部特征 → TransitionDecision
 */

import { computeMagnitudeSpectrum } from './onset-model'

// ====== 常量 ======

/** 静音判定阈值 */
export const SILENCE_THRESHOLD = 0.01
/** 起始点能量突增倍数阈值 */
export const ONSET_RATIO_THRESHOLD = 2.5
/** 起始点最低 RMS（避免把极微弱噪声跳变误判为起始点） */
export const ONSET_MIN_RMS = 0.05
/** RMS EMA 平滑系数（帧间波动抑制） */
export const ONSET_EMA = 0.4
/** 尾部衰减检测窗口（秒） */
export const TAIL_WINDOW_SEC = 15
/** 峰值能量下降到该比例判定为衰减起点 */
export const TAIL_DECAY_RATIO = 0.7
/** 最小过渡时长（毫秒） */
export const MIN_TRANSITION_MS = 400
/** 最大过渡时长（毫秒） */
export const MAX_TRANSITION_MS = 8000
/** 智能模式兜底过渡时长（毫秒） */
export const DEFAULT_TRANSITION_MS = 3000
/** 头部特征分析范围（秒） */
export const HEAD_ANALYSIS_SEC = 5
/** 头部能量分析窗口大小（秒） */
export const WINDOW_SIZE_SEC = 0.05
/** 前奏分析范围（秒）：用于计算"跳过前奏"的下一曲起始偏移 */
export const CONTENT_ANALYSIS_SEC = 30
/** 头部"内容起点"认定：距歌曲开头超过该秒数才视为存在可跳过的前奏 */
export const CONTENT_START_MIN_SEC = 1.5
/** 节拍量化：过渡起点与最近拍点的最大偏移（毫秒），超出则保持原起点 */
export const BEAT_MAX_SHIFT_MS = 500
/** 拍点（起始点）历史保留时长（秒），供节拍量化使用 */
export const BEAT_HISTORY_SEC = 60
/** 距歌曲结束多少秒内必然产出决策（过渡时机限制在结尾 30s 窗口内） */
export const EARLY_DECIDE_SEC = 30
/** 结尾人声分析范围（秒）：从歌曲结尾向前扫描该窗口内最后一个持续人声段 */
export const VOCAL_END_ANALYSIS_SEC = 90
/** 两次决策产出的最小间隔（秒） */
export const DECIDE_MIN_INTERVAL_SEC = 0.5
/** 尾部分析所需最少历史时长（秒），数据不足不产出决策 */
export const MIN_TAIL_DATA_SEC = 2
/** 能量包络额外保留时长（秒）：用于区分"结尾静音尾奏"与"开篇静音"，静音窗口之前是否有实质内容 */
export const SILENT_HISTORY_MARGIN_SEC = 45

// ====== 类型 ======

/** 能量包络样本（帧级） */
export interface EnergySample {
  /** 相对歌曲开头的播放位置（秒） */
  positionSec: number
  /** RMS 能量（0~1） */
  rms: number
}

/** 下一首歌曲头部特征 */
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

/** 当前歌曲尾部特征 */
export interface TailFeatures {
  /** 尾部窗口内峰值能量 */
  peakRms: number
  /** 尾部窗口平均能量 */
  avgRms: number
  /** 尾部窗口结束时能量 */
  endRms: number
  /** 自然衰减起点（相对歌曲开头，秒）；未检测到衰减则为 -1 */
  decayStartSec: number
  /** 衰减速率（能量相对每秒下降比例，0~1） */
  decayRate: number
}

/** 过渡策略 */
export type TransitionStrategy =
  'natural_fade' | 'short_overlap' | 'medium_blend' | 'long_blend' | 'fallback'

/** 智能过渡决策 */
export interface TransitionDecision {
  /** 过渡开始位置（相对歌曲开头，毫秒） */
  startPositionMs: number
  /** 实际过渡时长（毫秒） */
  transitionDurationMs: number
  /** 自然过渡质量评分（0~1） */
  quality: number
  /** 过渡策略 */
  strategy: TransitionStrategy
}

// ====== 纯函数 ======

/** 计算一帧时域数据的 RMS 能量（0~1） */
export function computeRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i]
  }
  if (frame.length === 0) return 0
  return Math.min(1, Math.sqrt(sum / frame.length))
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

/**
 * 尾部衰减分析：在最近 tailWindowSec 的能量包络上检测自然衰减
 *
 * 检测逻辑：
 * 1. 窗口内峰值能量低于静音阈值 → 视为静音尾部，衰减起点为窗口起点
 * 2. 否则从峰值位置向后找第一个降到峰值 TAIL_DECAY_RATIO 以下的位置作为衰减起点
 * 3. 衰减速率 = (起点能量 - 末尾能量) / 时间跨度 / 起点能量（相对每秒下降比例）
 */
export function analyzeTail(
  envelope: EnergySample[],
  tailWindowSec: number = TAIL_WINDOW_SEC
): TailFeatures {
  const empty: TailFeatures = { peakRms: 0, avgRms: 0, endRms: 0, decayStartSec: -1, decayRate: 0 }
  if (envelope.length === 0) return empty

  const endPos = envelope[envelope.length - 1].positionSec
  const windowStart = Math.max(0, endPos - tailWindowSec)
  const win = envelope.filter((s) => s.positionSec >= windowStart)
  if (win.length === 0) return empty

  let peakRms = 0
  let sum = 0
  for (const s of win) {
    sum += s.rms
    if (s.rms > peakRms) peakRms = s.rms
  }
  const avgRms = sum / win.length
  const endRms = win[win.length - 1].rms

  // 静音尾部：整段几乎无能量，衰减起点即窗口起点
  if (peakRms < SILENCE_THRESHOLD) {
    return { peakRms, avgRms, endRms, decayStartSec: win[0].positionSec, decayRate: 0 }
  }

  // 峰值位置之后第一个降到阈值以下的位置即为衰减起点
  const peakIdx = win.reduce((bestIdx, s, i) => (s.rms > win[bestIdx].rms ? i : bestIdx), 0)
  const decayThreshold = Math.max(peakRms * TAIL_DECAY_RATIO, SILENCE_THRESHOLD * 2)
  let decayStartSec = -1
  for (let i = peakIdx; i < win.length; i++) {
    if (win[i].rms <= decayThreshold) {
      decayStartSec = win[i].positionSec
      break
    }
  }

  // 衰减速率
  let decayRate = 0
  if (decayStartSec >= 0) {
    const startSample = win.find((s) => s.positionSec >= decayStartSec)
    if (startSample && endPos > decayStartSec) {
      const spanSec = endPos - decayStartSec
      decayRate = Math.max(0, startSample.rms - endRms) / spanSec / Math.max(startSample.rms, 1e-6)
    }
  }

  return { peakRms, avgRms, endRms, decayStartSec, decayRate }
}

/** 计算指定窗口内数据的 RMS */
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
 * 下一首歌曲头部特征分析（复用 audio-analyzer.ts 的头部分析思路）
 * @param channelData 单声道 PCM 数据
 * @param sampleRate 采样率
 * @param headSec 分析范围（秒）
 */
export function analyzeHead(
  channelData: Float32Array,
  sampleRate: number,
  headSec: number = HEAD_ANALYSIS_SEC
): HeadFeatures {
  const windowSamples = Math.floor(WINDOW_SIZE_SEC * sampleRate)
  const length = Math.min(channelData.length, Math.floor(headSec * sampleRate))
  const segments: Array<{ timeSec: number; rms: number }> = []

  let peakRms = 0
  let sumRms = 0
  let segmentCount = 0
  let attackTimeSec = -1
  let foundAttack = false

  for (let offset = 0; offset < length; offset += windowSamples) {
    const rms = computeWindowRms(channelData, offset, windowSamples)
    const timeSec = offset / sampleRate
    segments.push({ timeSec, rms })
    if (rms > peakRms) peakRms = rms
    sumRms += rms
    segmentCount++

    if (
      !foundAttack &&
      rms >= Math.max(peakRms * 0.5, SILENCE_THRESHOLD) &&
      rms > SILENCE_THRESHOLD
    ) {
      attackTimeSec = timeSec
      foundAttack = true
    }
  }

  const avgRms = segmentCount > 0 ? sumRms / segmentCount : 0
  const startsQuiet = segments.length > 0 && segments[0].rms < SILENCE_THRESHOLD * 2

  if (attackTimeSec < 0 && peakRms > SILENCE_THRESHOLD) {
    attackTimeSec = 0
  }

  return {
    peakRms,
    avgRms,
    attackTimeSec,
    startsQuiet,
    initialRms: segments.length > 0 ? segments[0].rms : 0
  }
}

// ====== 跳过前奏分析（人声起点优先） ======

/** 人声频段（Hz）：歌声基音谐波与共振峰的主要集中区，乐器前奏通常在此频段能量较弱 */
const VOCAL_BAND_MIN_HZ = 1000
const VOCAL_BAND_MAX_HZ = 4000
/** 人声占比判定阈值：相对全段 70 分位水平的比例 */
const VOCAL_LEVEL_RATIO = 0.6
/** 频段分析窗口采样数（2 的幂，约 46ms @44.1kHz） */
const SPECTRUM_WINDOW = 2048

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
 * 让出主线程的辅助函数：将 CPU 密集的分析/变速按块执行，块间让出，
 * 避免单次同步计算长时间阻塞 UI（播放卡死）。
 */
function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 人声频谱分析每批处理的窗口数（约 64×46ms ≈ 3s 音频，单批阻塞 < 20ms） */
const PROFILE_CHUNK_WINDOWS = 64

/** Hann 窗缓存（2048 点，只读复用，避免每首歌分析都重新分配） */
let cachedHannWindow: Float32Array | null = null
function getHannWindow(size: number): Float32Array {
  if (!cachedHannWindow || cachedHannWindow.length !== size) {
    cachedHannWindow = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      cachedHannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
    }
  }
  return cachedHannWindow
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
    const mag = computeMagnitudeSpectrum(frame)
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

/**
 * 分块异步版本：逐窗口计算 RMS 与人声频段占比，每 PROFILE_CHUNK_WINDOWS 个
 * 窗口让出一次主线程，避免长时间同步 FFT 分析阻塞 UI（播放卡死）。
 * 结果与同步版本完全一致。
 */
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
    const mag = computeMagnitudeSpectrum(frame)
    let total = 0
    let vocal = 0
    for (let k = 1; k < mag.length; k++) {
      const freq = k * binFreq
      total += mag[k]
      if (freq >= VOCAL_BAND_MIN_HZ && freq <= VOCAL_BAND_MAX_HZ) vocal += mag[k]
    }
    windows.push({ startSec: offset / sampleRate, rms, vocalRatio: total > 0 ? vocal / total : 0 })
    processed++
    if (processed % PROFILE_CHUNK_WINDOWS === 0) {
      await yieldMainThread()
    }
  }
  return { windows, windowSec: winSamples / sampleRate }
}

/**
 * 从频谱窗口序列中判定"人声结尾"（纯函数，同步/异步版本共用）
 * 从结尾向前扫描最后一个持续人声活跃段（1k-4kHz 占比显著且能量达底限），
 * 返回该段结束位置；器乐曲（无人声信号）返回 -1。
 * @returns 人声结尾位置（秒，相对歌曲开头）；未检测到人声返回 -1
 */
function findVocalEnd(windows: VocalWindow[], windowSec: number): number {
  if (windows.length < 10) return -1

  // 阈值与人声起点检测一致：全段 70 分位的 60%，能量需高于内容底限
  const sorted = [...windows.map((w) => w.vocalRatio)].sort((a, b) => a - b)
  const vocalLevel = sorted[Math.floor(sorted.length * 0.7)]
  const threshold = Math.max(0.05, vocalLevel * VOCAL_LEVEL_RATIO)
  const minContentRms = Math.max(ONSET_MIN_RMS * 0.6, SILENCE_THRESHOLD * 2)
  const sustainCount = Math.max(1, Math.round(0.5 / windowSec))

  // 从结尾往回找最后一个持续人声段；段尾（最后一个 vocal 窗口的结束位置）即"人声结尾"
  let run = 0
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i]
    const active = w.vocalRatio >= threshold && w.rms >= minContentRms
    if (active) {
      run++
      if (run >= Math.max(1, Math.ceil(sustainCount * 0.6))) {
        return w.startSec + windowSec
      }
    } else {
      run = 0
    }
  }
  return -1
}

/**
 * 当前歌曲"人声结尾"分析（智能过渡触发点）
 * 过渡应从上一首"人声接近结尾处"开始：从歌曲结尾向前扫描最后一个持续
 * 人声活跃段（1k-4kHz 占比显著且能量达底限），返回该段结束位置。
 * 结尾的器乐尾奏 / 静音段不计入人声；器乐曲（无人声信号）返回 -1，由调用方回退。
 *
 * 注意：本函数为同步版本，扫描 90s 约需数百 ms，阻塞主线程；播放路径
 * 请使用 analyzeVocalEndAsync（分块让出主线程，避免 UI 卡死）。
 *
 * @param channelData 单声道 PCM 数据
 * @param sampleRate 采样率
 * @param maxSec 从歌曲结尾向前分析的范围（秒），默认 VOCAL_END_ANALYSIS_SEC
 * @returns 人声结尾位置（秒，相对歌曲开头）；未检测到人声返回 -1
 */
export function analyzeVocalEnd(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = VOCAL_END_ANALYSIS_SEC
): number {
  const startSample = Math.max(0, channelData.length - Math.floor(maxSec * sampleRate))
  const { windows, windowSec } = computeVocalProfile(channelData, sampleRate, startSample)
  return findVocalEnd(windows, windowSec)
}

/**
 * 分块异步版本的"人声结尾"分析：与 analyzeVocalEnd 结果一致，但每批窗口
 * 处理完让出主线程，避免长时间同步 FFT 阻塞 UI（播放卡死）。
 */
export async function analyzeVocalEndAsync(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = VOCAL_END_ANALYSIS_SEC
): Promise<number> {
  const startSample = Math.max(0, channelData.length - Math.floor(maxSec * sampleRate))
  const { windows, windowSec } = await computeVocalProfileAsync(
    channelData,
    sampleRate,
    startSample
  )
  return findVocalEnd(windows, windowSec)
}

/**
 * 从频谱窗口序列中判定"内容起点"（纯函数，同步/异步版本共用）
 * 主歌通常从人声开始，优先检测"人声进入"（1k-4kHz 占比显著持续升高）；
 * 无人声信号（器乐/纯音）时回退到能量跃升检测。
 * @returns 应跳过的前奏长度（秒），无前奏返回 0
 */
function findContentStart(windows: VocalWindow[], windowSec: number): number {
  const rmsValues = windows.map((w) => w.rms)
  const vocalRatios = windows.map((w) => w.vocalRatio)
  if (rmsValues.length < 10) return 0

  // 全曲近静音 → 无内容可跳
  let peak = 0
  for (const r of rmsValues) {
    if (r > peak) peak = r
  }
  if (peak < SILENCE_THRESHOLD) return 0

  const sustainCount = Math.max(1, Math.round(0.5 / windowSec))
  const minContentRms = Math.max(ONSET_MIN_RMS * 0.6, SILENCE_THRESHOLD * 2)

  // 1) 人声起点（主歌从人声开始）：1k-4kHz 占比相对之前基线显著跃升
  const vocalStart = detectVocalRise(vocalRatios, rmsValues, windowSec, sustainCount, minContentRms)
  if (vocalStart >= 0) {
    // 开头即有人声（< CONTENT_START_MIN_SEC）视为无前奏
    return vocalStart >= CONTENT_START_MIN_SEC ? vocalStart : 0
  }

  // 2) 能量跃升兜底（无人声信号的器乐曲 / 纯音）
  const energyStart = detectEnergyJump(rmsValues, windowSec, sustainCount, minContentRms)
  if (energyStart >= CONTENT_START_MIN_SEC) return energyStart
  return 0
}

/**
 * 下一首歌曲"内容起点"分析（跳过前奏）
 * 主歌通常从人声开始，因此优先检测"人声进入"：以 2048 点窗口计算频谱，
 * 取 1k-4kHz 人声频段能量占比（歌声谐波/共振峰集中区），首个占比显著
 * 持续升高且能量达底限的窗口即内容起点；无人声信号（器乐/纯音）时
 * 回退到能量跃升检测。
 *
 * 注意：本函数为同步版本，扫描 30s 约需数百 ms，阻塞主线程；播放路径
 * 请使用 analyzeContentStartAsync（分块让出主线程，避免 UI 卡死）。
 *
 * @param channelData 单声道 PCM 数据
 * @param sampleRate 采样率
 * @param maxSec 分析范围（秒），默认 CONTENT_ANALYSIS_SEC
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

/**
 * 分块异步版本的"内容起点"分析：与 analyzeContentStart 结果一致，但每批
 * 窗口处理完让出主线程，避免长时间同步 FFT 阻塞 UI（播放卡死）。
 */
export async function analyzeContentStartAsync(
  channelData: Float32Array,
  sampleRate: number,
  maxSec: number = CONTENT_ANALYSIS_SEC
): Promise<number> {
  const length = Math.min(channelData.length, Math.floor(maxSec * sampleRate))
  const { windows, windowSec } = await computeVocalProfileAsync(channelData, sampleRate, 0, length)
  return findContentStart(windows, windowSec)
}

/**
 * 人声起点检测（相对跃升）：首个"1k-4kHz 占比相对之前约 2s 基线显著跃升
 * 且持续约 0.5s"的窗口。人声进入的标志是频段占比突然上升——器乐前奏
 * 即使本身含高频成分（吉他扫弦 / 镲片等），只要占比没有显著跃升，
 * 就不会被误判为人声起点（避免前奏被当作主歌、偏移错误归零）。
 * @returns 人声起点（秒）；未检测到显著人声跃升返回 -1
 */
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
    // 相对跃升（≥1.5 倍）且绝对提升 ≥ 0.05：占比显著上升才算人声进入
    const rise = ratios[i] - prevLevel
    if (ratios[i] < Math.max(prevLevel * 1.5, prevLevel + 0.05)) continue
    // 后续窗口占比保持在接近跃升后的水平，避免孤立尖峰误判
    let sustained = 0
    const sustainFloor = prevLevel + Math.max(0.03, rise * 0.5)
    for (let j = i; j < i + sustainCount; j++) {
      if (ratios[j] >= sustainFloor) sustained++
    }
    if (sustained >= Math.ceil(sustainCount * 0.6)) {
      return i * windowSec
    }
  }
  return -1
}

/**
 * 能量跃升检测：首个"后续约 0.5s 持续能量显著高于之前约 2s"的窗口。
 * @returns 内容起点（秒）；无显著跃升返回 -1
 */
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
    const ratio = nextLevel / Math.max(prevLevel, 1e-4)
    if (ratio >= 1.6) {
      return i * windowSec
    }
  }
  return -1
}

/**
 * 根据当前歌曲尾部特征与下一首头部特征计算智能过渡决策
 * @param tail 当前歌曲尾部特征
 * @param head 下一首头部特征（可为 null，此时用兜底策略）
 * @param totalDurationMs 当前歌曲总时长（毫秒）
 */
export function decideTransition(
  tail: TailFeatures,
  head: HeadFeatures | null,
  totalDurationMs: number
): TransitionDecision {
  const clampDuration = (ms: number, upperBound?: number): number => {
    const max =
      upperBound !== undefined ? Math.min(MAX_TRANSITION_MS, upperBound) : MAX_TRANSITION_MS
    return Math.max(MIN_TRANSITION_MS, Math.min(max, ms))
  }

  // 过渡起点统一钳制在"结尾 30s 窗口"内：衰减点 / 静音起点早于结尾前 30s 时，
  // 也等进入窗口再过渡（同时避免歌曲中途静音段落触发提前切换）
  const minStartMs = Math.max(0, totalDurationMs - EARLY_DECIDE_SEC * 1000)
  const finalize = (
    startPositionMs: number,
    transitionDurationMs: number,
    quality: number,
    strategy: TransitionStrategy
  ): TransitionDecision => {
    const s = Math.max(startPositionMs, minStartMs)
    const remainingMs = Math.max(0, totalDurationMs - s)
    return {
      startPositionMs: s,
      transitionDurationMs: Math.min(
        transitionDurationMs,
        Math.max(remainingMs, MIN_TRANSITION_MS)
      ),
      quality,
      strategy
    }
  }

  // 1. 尾部几乎静音 → 快速切换
  // 过渡起点取静音起点（decayStartSec），配合上方钳制保证不早于结尾前 30s
  if (tail.peakRms < SILENCE_THRESHOLD) {
    const transitionMs = Math.min(DEFAULT_TRANSITION_MS * 0.5, 1500)
    const startPositionMs =
      tail.decayStartSec >= 0
        ? Math.max(0, Math.round(tail.decayStartSec * 1000))
        : Math.max(0, totalDurationMs - transitionMs)
    return finalize(startPositionMs, clampDuration(transitionMs), 0.9, 'short_overlap')
  }

  // 2. 检测到明显自然衰减 → 在衰减点处开始交叉过渡
  if (tail.decayStartSec >= 0 && tail.decayRate > 0.02) {
    const remainingMs = Math.max(0, totalDurationMs - tail.decayStartSec * 1000)
    let transitionMs: number
    if (head) {
      if (head.startsQuiet) {
        transitionMs = remainingMs
      } else if (head.attackTimeSec >= 0 && head.attackTimeSec < 0.5) {
        transitionMs = remainingMs * 0.7
      } else {
        transitionMs = Math.min(remainingMs, Math.max(0, head.attackTimeSec) * 3000)
      }
    } else {
      transitionMs = remainingMs * 0.8
    }

    return finalize(
      Math.max(0, totalDurationMs - remainingMs),
      clampDuration(transitionMs, remainingMs),
      Math.min(1, 0.5 + tail.decayRate * 5),
      'natural_fade'
    )
  }

  // 3. 无自然衰减，根据头部特征决定
  if (head) {
    if (head.startsQuiet && head.attackTimeSec > 1) {
      const transitionMs = head.attackTimeSec * 2500
      return finalize(
        Math.max(0, totalDurationMs - transitionMs),
        clampDuration(transitionMs),
        0.6,
        'long_blend'
      )
    }

    if (head.attackTimeSec >= 0 && head.attackTimeSec < 0.3 && head.peakRms > 0.1) {
      const transitionMs = Math.min(DEFAULT_TRANSITION_MS * 0.6, 2000)
      return finalize(
        Math.max(0, totalDurationMs - transitionMs),
        clampDuration(transitionMs),
        0.7,
        'medium_blend'
      )
    }
  }

  // 4. 兜底
  return finalize(
    Math.max(0, totalDurationMs - DEFAULT_TRANSITION_MS),
    clampDuration(DEFAULT_TRANSITION_MS),
    0.3,
    'fallback'
  )
}

/**
 * 智能过渡触发提前量（毫秒）
 * 触发点最晚为"结尾前 过渡时长 + 该提前量"：为节拍对齐等待与完整淡化预留时间，
 * 保证淡化在歌曲自然结束前完成，避免淡化被截断而失去丝滑感。
 */
export const BEAT_TRIGGER_MARGIN_MS = 1200

/** 智能过渡触发点计算参数 */
export interface SmartTriggerParams {
  /** 当前曲总时长（毫秒） */
  durationMs: number
  /** 配置的过渡（淡化）时长（毫秒） */
  transitionMs: number
  /** 人声结尾触发点（毫秒，相对歌曲开头）；<= 0 表示未检测到人声 */
  vocalEndTriggerMs: number
  /** 实时分析决策的过渡起点（毫秒）；<= 0 表示无决策 */
  decisionStartMs: number
}

/**
 * 计算智能过渡的触发点（毫秒）
 *
 * 过渡必须限制在"歌曲结尾 30s 窗口"内开始（EARLY_DECIDE_SEC），窗口外提前
 * 过渡会让歌曲中途就被切走（如人声结束很早、后半段是长器乐尾声时，人声结尾
 * 分析点会落在歌曲中间）：
 * - 分析点（人声结尾 / 实时决策）在窗口内且早于最晚触发点 → 按分析点触发
 *   （过渡从上一首"人声接近结尾处"开始，衔接最自然）
 * - 分析点早于窗口起点 → 钳制到窗口起点（结尾前 30s），歌曲结束前 30s 内才开始
 * - 分析点缺失或过晚（歌曲以人声/镲片收尾、人声几乎持续到结尾）→ 回退到最晚
 *   触发点——结尾前"过渡时长 + 节拍提前量"，保证节拍对齐等待与完整淡化在
 *   歌曲自然结束前完成，避免淡化被截断而失去丝滑感
 */
export function computeSmartTriggerMs(params: SmartTriggerParams): number {
  const latestStartMs = Math.max(
    0,
    params.durationMs - params.transitionMs - BEAT_TRIGGER_MARGIN_MS
  )
  // 最早触发点：过渡不得早于"结尾前 30s"窗口，避免歌曲中途被切走
  const earliestStartMs = Math.max(0, params.durationMs - EARLY_DECIDE_SEC * 1000)
  const analyticalMs =
    params.vocalEndTriggerMs > 0
      ? params.vocalEndTriggerMs
      : params.decisionStartMs > 0
        ? params.decisionStartMs
        : -1
  if (analyticalMs <= 0) return latestStartMs
  return Math.min(Math.max(analyticalMs, earliestStartMs), latestStartMs)
}

// ====== 流式分析器（Worker 与主线程降级共用） ======

/** 流式分析单帧结果 */
export interface StreamingFrameResult {
  /** 是否检测到起始点 */
  onset: boolean
  /** 本帧对应的播放位置（秒） */
  positionSec: number
  /** 是否产出（或更新）了过渡决策；无变化时为 null */
  decision: TransitionDecision | null
}

/**
 * 流式能量分析器
 *
 * 纯计算、无 DOM 依赖，可在 Web Worker 内运行，也可在主线程降级运行：
 * - update()：逐帧喂入时域数据，维护滚动能量包络，检测起始点与尾部衰减
 * - 到达歌曲结尾窗口（EARLY_DECIDE_SEC）或检测到自然衰减时自动产出决策
 * - setHeadFeatures()：下一首头部特征就绪后触发一次重新评估
 */
export class StreamingAnalyzer {
  private history: EnergySample[] = []
  private lastSmoothedRms = 0
  private headFeatures: HeadFeatures | null = null
  private lastEmitAt = -1
  private lastDecisionKey = ''
  private _latestDecision: TransitionDecision | null = null

  readonly trackId: string
  readonly durationMs: number
  readonly sampleRate: number

  constructor(trackId: string, durationMs: number, sampleRate: number = 44100) {
    this.trackId = trackId
    this.durationMs = durationMs
    this.sampleRate = sampleRate
  }

  /** 最近一次产出的决策（可能为 null） */
  get latestDecision(): TransitionDecision | null {
    return this._latestDecision
  }

  /** 当前能量包络（快照拷贝） */
  getEnvelope(): EnergySample[] {
    return [...this.history]
  }

  /** 逐帧分析 */
  update(frame: Float32Array, positionSec: number): StreamingFrameResult {
    const rawRms = computeRms(frame)
    const smoothedRms = ONSET_EMA * rawRms + (1 - ONSET_EMA) * this.lastSmoothedRms
    const onset = detectOnset(this.lastSmoothedRms, smoothedRms)
    this.lastSmoothedRms = smoothedRms

    const sample: EnergySample = { positionSec, rms: smoothedRms }
    this.history.push(sample)

    // 裁剪历史：仅保留尾部窗口 + 足够余量（用于静音尾奏的"音乐已结束"判定），避免长曲内存膨胀
    const cutoff = positionSec - (TAIL_WINDOW_SEC + SILENT_HISTORY_MARGIN_SEC)
    if (cutoff > 0) {
      this.history = this.history.filter((s) => s.positionSec >= cutoff)
    }

    // 决策产出频率限制（0.5s 一次）
    let decision: TransitionDecision | null = null
    if (positionSec - this.lastEmitAt >= DECIDE_MIN_INTERVAL_SEC) {
      decision = this.evaluate()
      if (decision) this.lastEmitAt = positionSec
    }

    return { onset, positionSec, decision }
  }

  /** 投递下一首头部特征，并触发一次重新评估 */
  setHeadFeatures(head: HeadFeatures): void {
    this.headFeatures = head
    this.evaluate()
  }

  /**
   * 基于当前状态重新评估决策
   * - 数据不足（少于 MIN_TAIL_DATA_SEC）时返回 null
   * - 未接近结尾且未检测到衰减时不产出
   * - 决策无变化时返回 null（避免重复下发）
   */
  evaluate(): TransitionDecision | null {
    if (this.history.length === 0) return null
    const endPos = this.history[this.history.length - 1].positionSec
    if (endPos < MIN_TAIL_DATA_SEC) return null

    const tail = analyzeTail(this.history, TAIL_WINDOW_SEC)
    const nearEnd = endPos >= this.durationMs / 1000 - EARLY_DECIDE_SEC
    const silentTail = tail.peakRms < SILENCE_THRESHOLD
    // 静音尾部仅在"音乐已实质结束"（分析窗口之前存在内容）或接近歌曲结尾时才判定，
    // 避免歌曲开篇静音 / 无内容的静音段提前产出决策
    const musicEnded =
      silentTail &&
      this.history.some((s) => s.positionSec < endPos - TAIL_WINDOW_SEC && s.rms >= ONSET_MIN_RMS)
    const hasDecay = tail.decayStartSec >= 0 && (!silentTail || musicEnded)
    if (!nearEnd && !hasDecay) return null

    const decision = decideTransition(tail, this.headFeatures, this.durationMs)
    const key = `${decision.startPositionMs}|${decision.transitionDurationMs}|${decision.strategy}`
    if (key === this.lastDecisionKey) return null
    this.lastDecisionKey = key
    this._latestDecision = decision
    return decision
  }

  /** 清空全部状态（切歌/中断时调用） */
  reset(): void {
    this.history = []
    this.lastSmoothedRms = 0
    this.headFeatures = null
    this.lastEmitAt = -1
    this.lastDecisionKey = ''
    this._latestDecision = null
  }
}

// ====== BPM 匹配与变速（变速不变调） ======

/** BPM 端点分析窗口（秒）：上一曲结尾 / 下一曲开头的节奏对比范围 */
export const BPM_ANALYSIS_WINDOW_SEC = 30
/** BPM 差异阈值：差异超过该比例时对下一曲变速对齐 */
export const BPM_MATCH_THRESHOLD = 0.08
/** 有效 BPM 下限 */
export const BPM_MIN = 60
/** 有效 BPM 上限 */
export const BPM_MAX = 180
/** 能量包络窗口（秒），用于 BPM 的 onset 检测 */
const BPM_ENVELOPE_WINDOW_SEC = 0.05
/** onset 间隔有效范围（毫秒）：对应 30-300 BPM 区间 */
const ONSET_INTERVAL_MIN_MS = 200
const ONSET_INTERVAL_MAX_MS = 2000
/** WSOLA 分析窗（采样数，约 46ms @44.1kHz） */
const WSOLA_ANALYSIS_WINDOW = 2048
/** WSOLA 合成步进（采样数） */
const WSOLA_SYNTH_HOP = 512
/** WSOLA 相关搜索步长（性能：大值更快但对齐精度下降） */
const WSOLA_SEARCH_STEP = 2
/** WSOLA 相关性计算降采样倍数 */
const WSOLA_CORRELATION_DECIMATION = 4

/**
 * 估计音频片段的 BPM
 * 能量包络 → 相对跃升 onset 检测 → onset 间隔中位数 → BPM（归一化到 60-180）。
 * 用于对比上一曲结尾 30s 与下一曲开头 30s 的节奏。
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
  // 1) 在标称输入位置附近搜索与输出上一段尾部（重叠区）最相似的输入起点
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

  // 2) 交叉淡化合成：重叠区与前段尾部线性交叉淡化，其余直接拷贝
  for (let k = 0; k < H; k++) {
    const gain = k / H
    output[writePos + k] = input[bestPos + k] * gain + output[writePos - H + k] * (1 - gain)
  }
  for (let k = H; k < N; k++) {
    output[writePos + k] = input[bestPos + k]
  }

  // 下一帧标称输入位置：输出前进 H 对应输入前进 H/ratio（时间轴按比例映射）
  return bestPos + H / ratio
}

/**
 * WSOLA 变速（变速不变调）
 * 通过波形相似性重叠相加（Waveform Similarity Overlap-Add）实现 time-stretch：
 * 每个合成帧在输入中搜索与前一帧重叠区最相似的起点，交叉淡化拼接，
 * 只改变播放时长与节奏速度，音调保持不变。
 * 合成帧在输出中每帧前进 H（合成步进），对应的输入标称位置每帧前进 H/ratio：
 * ratio<1 时输入前进更快（跳过内容加速）、ratio>1 时输入前进更慢（内容重叠减速），
 * 因此输出时长 = 输入时长 × ratio。
 *
 * 注意：本函数为同步版本，整曲变速约需数十亿次运算、阻塞主线程数秒；
 * 播放路径请使用 timeStretchPcmAsync（分块让出主线程，避免 UI 卡死）。
 *
 * @param input 单声道 PCM 数据
 * @param ratio 输出/输入时长比例（<1 加速、>1 减速、≈1 原样返回）
 * @returns 变速后的 PCM 数据
 */
export function timeStretchPcm(
  input: Float32Array<ArrayBufferLike>,
  ratio: number
): Float32Array<ArrayBufferLike> {
  if (!isFinite(ratio) || ratio <= 0) return input
  if (Math.abs(ratio - 1) < 0.01) return input

  const N = WSOLA_ANALYSIS_WINDOW
  const H = WSOLA_SYNTH_HOP
  const step = WSOLA_SEARCH_STEP
  const decim = WSOLA_CORRELATION_DECIMATION
  // ratio 为"输出/输入时长比例"：<1 加速、>1 减速，输出采样数 = 输入 × ratio
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const output = new Float32Array(outLen)

  // 过短信号：直接等比拷贝
  if (input.length <= N) {
    for (let i = 0; i < Math.min(outLen, input.length); i++) output[i] = input[i]
    return output
  }

  // 第一帧直接拷贝作为输出起点
  const firstLen = Math.min(N, outLen)
  for (let i = 0; i < firstLen; i++) output[i] = input[i]

  let readNominal = N
  let writePos = firstLen

  while (writePos + N <= outLen && readNominal < input.length) {
    readNominal = stretchSynthFrame(input, output, readNominal, writePos, N, H, step, decim, ratio)
    writePos += H
  }

  // 尾部直接拷贝填充（信号已接近结束）
  while (writePos < outLen && readNominal < input.length) {
    output[writePos] = input[Math.floor(readNominal)]
    writePos++
    readNominal++
  }

  return output
}

/** 变速每批处理的合成帧数（每帧约 6.8 万次运算，单批阻塞 < 20ms） */
const STRETCH_CHUNK_FRAMES = 24

/**
 * 分块异步版本的 WSOLA 变速：与 timeStretchPcm 结果完全一致，但每批
 * STRETCH_CHUNK_FRAMES 帧让出一次主线程，避免整曲变速长时间同步计算
 * 阻塞 UI（播放卡死）。
 */
export async function timeStretchPcmAsync(
  input: Float32Array<ArrayBufferLike>,
  ratio: number
): Promise<Float32Array<ArrayBufferLike>> {
  if (!isFinite(ratio) || ratio <= 0) return input
  if (Math.abs(ratio - 1) < 0.01) return input

  const N = WSOLA_ANALYSIS_WINDOW
  const H = WSOLA_SYNTH_HOP
  const step = WSOLA_SEARCH_STEP
  const decim = WSOLA_CORRELATION_DECIMATION
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
    readNominal = stretchSynthFrame(input, output, readNominal, writePos, N, H, step, decim, ratio)
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
