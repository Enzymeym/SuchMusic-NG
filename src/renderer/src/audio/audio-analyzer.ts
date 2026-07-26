/**
 * 音频内容分析工具
 * 通过分析 PCM 音频数据的能量特征自动确定最优交叉过渡参数
 */

/**
 * 能量分析结果，包含一段音频的 RMS 能量序列
 */
interface EnergySegment {
  /** 窗口起始时间（秒） */
  timeSec: number
  /** RMS 能量值，归一化到 0~1 */
  rms: number
}

/**
 * 尾部能量分析结果
 */
interface TailAnalysis {
  /** 分析窗口的能量序列 */
  segments: EnergySegment[]
  /** 尾部峰值能量 */
  peakRms: number
  /** 尾部平均能量 */
  avgRms: number
  /** 自然衰减起始偏移（秒，相对于尾部开始位置），-1 表示无明显衰减 */
  decayStartSec: number
  /** 尾部整体能量趋于静音的速率（能量下降斜率） */
  decayRate: number
}

/**
 * 头部能量分析结果
 */
interface HeadAnalysis {
  /** 分析窗口的能量序列 */
  segments: EnergySegment[]
  /** 头部峰值能量 */
  peakRms: number
  /** 头部平均能量 */
  avgRms: number
  /** 到达峰值所需时间（秒）—— 攻击速度 */
  attackTimeSec: number
  /** 头部初始能量是否极低（适合从静音开始） */
  startsQuiet: boolean
}

/**
 * 智能过渡参数计算结果
 */
export interface SmartTransitionResult {
  /** 交叉过渡在歌曲中的开始位置（毫秒），适配器在此位置自动触发过渡 */
  startPositionMs: number
  /** 实际过渡时长（毫秒） */
  transitionDurationMs: number
  /** 自然过渡质量评分（0~1），越高表示分析置信度越高 */
  quality: number
  /** 过渡策略描述 */
  strategy: 'natural_fade' | 'short_overlap' | 'medium_blend' | 'long_blend' | 'fallback'
}

/** 分析窗口大小（秒） */
const WINDOW_SIZE_SEC = 0.05
/** 尾部分析范围（秒） */
const TAIL_ANALYSIS_SEC = 8
/** 头部分析范围（秒） */
const HEAD_ANALYSIS_SEC = 5
/** 最小过渡时长（毫秒） */
const MIN_TRANSITION_MS = 400
/** 最大过渡时长（毫秒） */
const MAX_TRANSITION_MS = 8000
/** 静音判定阈值 */
const SILENCE_THRESHOLD = 0.01
/** 智能模式兜底过渡时长（毫秒） */
const DEFAULT_TRANSITION_MS = 3000

/**
 * 计算一段音频数据的 RMS 能量（均方根）
 * @param data 音频采样数据
 * @param start 起始采样索引
 * @param length 采样数
 * @returns 归一化的 RMS 能量值（0~1）
 */
function computeRMS(data: Float32Array, start: number, length: number): number {
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
 * 从交错 PCM 数据中提取指定声道的采样数据
 * @param pcmData 交错格式的 PCM 数据
 * @param channels 声道数
 * @param channelIndex 要提取的声道索引（0-based）
 * @returns 该声道的 Float32Array
 */
function extractChannel(pcmData: Float32Array, channels: number, channelIndex: number): Float32Array {
  const frameCount = Math.floor(pcmData.length / channels)
  const result = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    result[i] = pcmData[i * channels + channelIndex]
  }
  return result
}

/**
 * 分析音频尾部能量特征
 * @param pcmData 交错格式的 PCM 音频数据
 * @param sampleRate 采样率
 * @param channels 声道数
 * @param tailSec 分析尾部多少秒
 * @returns 尾部能量分析结果
 */
function analyzeTail(
  pcmData: Float32Array,
  sampleRate: number,
  channels: number,
  tailSec: number
): TailAnalysis {
  const totalFrames = Math.floor(pcmData.length / channels)
  const tailStartFrame = Math.max(0, totalFrames - Math.floor(tailSec * sampleRate))
  const tailLengthFrames = totalFrames - tailStartFrame
  const windowSamples = Math.floor(WINDOW_SIZE_SEC * sampleRate)

  const channel0 = extractChannel(pcmData, channels, 0)
  const segments: EnergySegment[] = []

  let peakRms = 0
  let sumRms = 0
  let segmentCount = 0

  for (let offset = 0; offset < tailLengthFrames; offset += windowSamples) {
    const rms = computeRMS(channel0, tailStartFrame + offset, windowSamples)
    const timeSec = (offset / sampleRate)
    segments.push({ timeSec, rms })
    if (rms > peakRms) peakRms = rms
    sumRms += rms
    segmentCount++
  }

  const avgRms = segmentCount > 0 ? sumRms / segmentCount : 0

  // 寻找自然衰减起始点：从后往前找第一个能量明显回升的位置
  let decayStartSec = -1
  const decayThreshold = Math.max(peakRms * 0.3, SILENCE_THRESHOLD * 2)

  let inDecay = false
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].rms < decayThreshold) {
      if (!inDecay) {
        inDecay = true
      }
    } else {
      if (inDecay && i < segments.length - 2) {
        decayStartSec = segments[i + 1].timeSec
        break
      }
    }
  }

  if (decayStartSec < 0 && inDecay && peakRms > SILENCE_THRESHOLD) {
    decayStartSec = 0
  }

  // 计算衰减速率
  let decayRate = 0
  if (decayStartSec >= 0) {
    const decayStartIdx = segments.findIndex((s) => s.timeSec >= decayStartSec)
    if (decayStartIdx >= 0 && decayStartIdx < segments.length - 1) {
      const startEnergy = segments[decayStartIdx].rms
      const endEnergy = segments[segments.length - 1].rms
      const decayTime = segments[segments.length - 1].timeSec - segments[decayStartIdx].timeSec
      if (decayTime > 0 && startEnergy > 0) {
        decayRate = (startEnergy - endEnergy) / decayTime / startEnergy
      }
    }
  }

  return { segments, peakRms, avgRms, decayStartSec, decayRate }
}

/**
 * 分析音频头部能量特征
 * @param pcmData 交错格式的 PCM 音频数据
 * @param sampleRate 采样率
 * @param channels 声道数
 * @param headSec 分析头部多少秒
 * @returns 头部能量分析结果
 */
function analyzeHead(
  pcmData: Float32Array,
  sampleRate: number,
  channels: number,
  headSec: number
): HeadAnalysis {
  const totalFrames = Math.floor(pcmData.length / channels)
  const headLengthFrames = Math.min(totalFrames, Math.floor(headSec * sampleRate))
  const windowSamples = Math.floor(WINDOW_SIZE_SEC * sampleRate)

  const channel0 = extractChannel(pcmData, channels, 0)
  const segments: EnergySegment[] = []

  let peakRms = 0
  let sumRms = 0
  let segmentCount = 0
  let attackTimeSec = -1
  let foundAttack = false

  for (let offset = 0; offset < headLengthFrames; offset += windowSamples) {
    const rms = computeRMS(channel0, offset, windowSamples)
    const timeSec = (offset / sampleRate)
    segments.push({ timeSec, rms })
    if (rms > peakRms) peakRms = rms
    sumRms += rms
    segmentCount++

    if (!foundAttack && rms >= peakRms * 0.5 && rms > SILENCE_THRESHOLD) {
      attackTimeSec = timeSec
      foundAttack = true
    }
  }

  const avgRms = segmentCount > 0 ? sumRms / segmentCount : 0
  const startsQuiet = segments.length > 0 && segments[0].rms < SILENCE_THRESHOLD * 2

  if (attackTimeSec < 0 && peakRms > SILENCE_THRESHOLD) {
    attackTimeSec = 0
  }

  return { segments, peakRms, avgRms, attackTimeSec, startsQuiet }
}

/**
 * 根据两首歌曲的能量特征计算智能过渡参数
 * 过渡时长完全由音频内容分析决定，不依赖用户配置
 * @param currentPcm 当前播放歌曲的交错 PCM 数据
 * @param nextPcm 下一首歌曲的交错 PCM 数据
 * @param sampleRate 采样率（两首歌曲采样率一致）
 * @param channels 声道数
 * @returns 智能过渡参数
 */
export function computeSmartTransition(
  currentPcm: Float32Array,
  nextPcm: Float32Array,
  sampleRate: number,
  channels: number
): SmartTransitionResult {
  const tail = analyzeTail(currentPcm, sampleRate, channels, TAIL_ANALYSIS_SEC)
  const head = analyzeHead(nextPcm, sampleRate, channels, HEAD_ANALYSIS_SEC)

  const totalFrames = Math.floor(currentPcm.length / channels)
  const totalDurationMs = (totalFrames / sampleRate) * 1000

  // 策略：根据尾部衰减情况和头部攻击情况综合判断
  if (tail.peakRms < SILENCE_THRESHOLD) {
    // 尾部几乎是静音，使用短过渡
    const transitionMs = Math.min(DEFAULT_TRANSITION_MS * 0.5, 1500)
    const startPositionMs = Math.max(0, totalDurationMs - transitionMs)
    return {
      startPositionMs,
      transitionDurationMs: transitionMs,
      quality: 0.9,
      strategy: 'short_overlap'
    }
  }

  if (tail.decayStartSec >= 0 && tail.decayRate > 0.05) {
    // 检测到明显的自然衰减，在衰减点处开始交叉过渡
    const tailStartFromEnd = TAIL_ANALYSIS_SEC - tail.decayStartSec
    const naturalFadeRemaining = tailStartFromEnd * 1000

    // 过渡时长基于自然衰减的剩余时间和头部攻击速度
    let transitionMs: number
    if (head.startsQuiet) {
      transitionMs = naturalFadeRemaining
    } else if (head.attackTimeSec < 0.5) {
      transitionMs = Math.min(naturalFadeRemaining * 0.7, naturalFadeRemaining)
    } else {
      transitionMs = Math.min(naturalFadeRemaining, head.attackTimeSec * 1000 * 3)
    }

    const startPositionMs = Math.max(0, totalDurationMs - naturalFadeRemaining)

    return {
      startPositionMs,
      transitionDurationMs: Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, transitionMs)),
      quality: Math.min(1, 0.5 + tail.decayRate * 5),
      strategy: 'natural_fade'
    }
  }

  // 无自然衰减，需要根据头部能量特征决定
  if (head.startsQuiet && head.attackTimeSec > 1) {
    const transitionMs = head.attackTimeSec * 1000 * 2.5
    const startPositionMs = Math.max(0, totalDurationMs - transitionMs)
    return {
      startPositionMs,
      transitionDurationMs: Math.min(MAX_TRANSITION_MS, transitionMs),
      quality: 0.6,
      strategy: 'long_blend'
    }
  }

  if (head.attackTimeSec < 0.3 && head.peakRms > 0.1) {
    const transitionMs = Math.min(DEFAULT_TRANSITION_MS * 0.6, 2000)
    const startPositionMs = Math.max(0, totalDurationMs - transitionMs)
    return {
      startPositionMs,
      transitionDurationMs: Math.max(MIN_TRANSITION_MS, transitionMs),
      quality: 0.7,
      strategy: 'medium_blend'
    }
  }

  // 兜底：使用默认时长
  const fallbackStartMs = Math.max(0, totalDurationMs - DEFAULT_TRANSITION_MS)
  return {
    startPositionMs: fallbackStartMs,
    transitionDurationMs: DEFAULT_TRANSITION_MS,
    quality: 0.3,
    strategy: 'fallback'
  }
}

/**
 * 根据策略获取中文描述
 * @param strategy 策略名称
 * @returns 中文描述
 */
export function getStrategyLabel(strategy: SmartTransitionResult['strategy']): string {
  const labels: Record<SmartTransitionResult['strategy'], string> = {
    natural_fade: '跟随自然衰减',
    short_overlap: '快速切换',
    medium_blend: '中等混合',
    long_blend: '长混合过渡',
    fallback: '默认过渡'
  }
  return labels[strategy]
}
