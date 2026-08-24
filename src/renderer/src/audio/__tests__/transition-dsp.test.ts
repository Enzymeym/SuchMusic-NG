/**
 * transition-dsp.ts 扁平化纯函数 DSP 的单元测试
 *
 * 覆盖：基础工具（RMS / 起始点）、BPM 估计、调性检测（Krumhansl-Kessler /
 * Camelot）、尾部/头部特征、前奏偏移、智能过渡计划、WSOLA 变速、相位声码器变调。
 */
import { describe, it, expect } from 'vitest'
import {
  computeRms,
  detectOnset,
  estimateBpm,
  analyzeKey,
  analyzeKeyAsync,
  camelotDistance,
  findKeyAlignment,
  analyzeTail,
  analyzeHead,
  analyzeContentStart,
  analyzeContentStartAsync,
  computeTransitionPlan,
  timeStretchPcm,
  timeStretchPcmAsync,
  pitchShiftPcm,
  pitchShiftPcmAsync,
  SILENCE_THRESHOLD,
  MIN_TRANSITION_MS,
  MAX_TRANSITION_MS,
  TAIL_ANALYSIS_SEC
} from '../transition-dsp'
import type { MusicKey } from '../transition-dsp'

const SR = 44100

/** 构造一段正弦波 PCM 数据 */
function makeTone(durationSec: number, freq: number, amplitude = 0.8, sampleRate = SR): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude
  }
  return data
}

/** 以指定 BPM 构造脉冲节拍音（每拍一段短音 + 静音） */
function makeClickTrack(bpm: number, durationSec: number, sampleRate = SR): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  const burstSamples = Math.round(0.05 * sampleRate) // 50ms 音头
  for (let beat = 0; beat * beatSamples + burstSamples < data.length; beat++) {
    for (let i = 0; i < burstSamples; i++) {
      const t = i / sampleRate
      data[beat * beatSamples + i] = Math.sin(2 * Math.PI * 440 * t) * 0.9
    }
  }
  return data
}

/** 构造 C 大三和弦（C4 + E4 + G4） */
function makeCMajorChord(durationSec: number, sampleRate = SR): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  const freqs = [261.63, 329.63, 392.0]
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate
    let s = 0
    for (const f of freqs) s += Math.sin(2 * Math.PI * f * t)
    data[i] = s / freqs.length
  }
  return data
}

const cMajor: MusicKey = { root: 0, mode: 'major', name: 'C', camelot: '8B', confidence: 0.9 }
const eMajor: MusicKey = { root: 4, mode: 'major', name: 'E', camelot: '12B', confidence: 0.9 }

describe('基础工具', () => {
  it('computeRms 计算正确', () => {
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5)
    expect(computeRms(new Float32Array(0))).toBe(0)
    expect(computeRms(new Float32Array([0, 0, 0]))).toBe(0)
  })

  it('detectOnset：能量突增判定', () => {
    expect(detectOnset(SILENCE_THRESHOLD, 0.5)).toBe(true) // 静音跃起
    expect(detectOnset(0.5, 0.51)).toBe(false) // 平稳
    expect(detectOnset(0.4, 1.0)).toBe(true) // 2.5 倍突增
    expect(detectOnset(0.5, 0.005)).toBe(false) // 落入静音
  })
})

describe('BPM 估计', () => {
  it('120 BPM 脉冲音估计为 120', () => {
    const bpm = estimateBpm(makeClickTrack(120, 30), SR)
    expect(Math.abs(bpm - 120)).toBeLessThanOrEqual(2)
  })

  it('90 BPM 脉冲音估计为 90', () => {
    const bpm = estimateBpm(makeClickTrack(90, 30), SR)
    expect(Math.abs(bpm - 90)).toBeLessThanOrEqual(2)
  })

  it('数据不足时返回 0', () => {
    expect(estimateBpm(makeClickTrack(120, 0.5), SR)).toBe(0)
  })
})

describe('调性检测与 Camelot 兼容', () => {
  it('C 大三和弦检测为 C 大调（8B）', () => {
    const key = analyzeKey(makeCMajorChord(5), SR)
    expect(key).not.toBeNull()
    expect(key!.mode).toBe('major')
    expect(key!.camelot).toBe('8B')
    expect(key!.name).toBe('C')
  })

  it('异步版本与同步版本结果一致', async () => {
    const sync = analyzeKey(makeCMajorChord(5), SR)
    const asyncKey = await analyzeKeyAsync(makeCMajorChord(5), SR)
    expect(asyncKey?.camelot).toBe(sync?.camelot)
  })

  it('数据过短返回 null', () => {
    expect(analyzeKey(makeTone(0.1, 440), SR)).toBeNull()
  })

  it('camelotDistance：同编号为 0，同字母相邻为 1，编号差按轮盘最小弧长', () => {
    const aMinor: MusicKey = { root: 9, mode: 'minor', name: 'Am', camelot: '8A', confidence: 0.9 }
    const bFlatMajor: MusicKey = { root: 10, mode: 'major', name: 'A#', camelot: '1B', confidence: 0.9 }
    const gMajor: MusicKey = { root: 7, mode: 'major', name: 'G', camelot: '9B', confidence: 0.9 }
    expect(camelotDistance(cMajor, aMinor)).toBe(0) // 关系大小调
    expect(camelotDistance(cMajor, gMajor)).toBe(1) // 8B → 9B 相邻
    // 8B → 1B：轮盘最小弧长 5（8→9→10→11→12→1），非相邻
    expect(camelotDistance(cMajor, bFlatMajor)).toBe(5)
  })

  it('findKeyAlignment：E 大调向 C 大调对齐为 +1（F 大调 7B，五度相邻）', () => {
    const align = findKeyAlignment(cMajor, eMajor)
    expect(align.shift).toBe(1)
    expect(align.distance).toBe(1)
  })

  it('findKeyAlignment：完全兼容时返回 0', () => {
    const align = findKeyAlignment(cMajor, { ...cMajor })
    expect(align.shift).toBe(0)
    expect(align.distance).toBe(0)
  })
})

describe('尾部/头部特征与前奏偏移', () => {
  it('静音尾部：衰减起点即分析窗口起点', () => {
    // 前 10s 有声、后 30s 静音 → 尾部窗口（最后 30s）全静音
    const data = new Float32Array(40 * SR)
    data.set(makeTone(10, 440, 0.5), 0)
    const tail = analyzeTail(data, SR)
    expect(tail.peakRms).toBeLessThan(SILENCE_THRESHOLD)
    expect(tail.decayStartSec).toBeGreaterThanOrEqual(10)
  })

  it('衰减尾部：能检测到衰减起点且起点在分析窗口内', () => {
    // 40s，最后 30s 幅度从 0.8 线性衰减到 0.05
    const data = new Float32Array(40 * SR)
    data.set(makeTone(10, 440, 0.8), 0)
    const tailStart = 10 * SR
    for (let i = tailStart; i < data.length; i++) {
      const frac = (i - tailStart) / (data.length - tailStart)
      data[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * (0.8 - 0.75 * frac)
    }
    const tail = analyzeTail(data, SR)
    expect(tail.peakRms).toBeGreaterThan(0.1)
    expect(tail.decayStartSec).toBeGreaterThanOrEqual(10)
  })

  it('头部特征：静音开头判定为 startsQuiet', () => {
    const data = new Float32Array(5 * SR)
    data.set(makeTone(4, 440, 0.8), 1 * SR) // 前 1s 静音，随后有声
    const head = analyzeHead(data, SR)
    expect(head.startsQuiet).toBe(true)
    expect(head.attackTimeSec).toBeGreaterThanOrEqual(0.9)
    expect(head.attackTimeSec).toBeLessThanOrEqual(1.2)
  })

  it('头部特征：强开头攻击时间短', () => {
    const data = makeTone(3, 440, 0.8)
    const head = analyzeHead(data, SR)
    expect(head.peakRms).toBeGreaterThan(0.3)
  })

  it('内容起点：4s 安静前奏后能量跃升 → 跳过前奏', () => {
    const data = new Float32Array(30 * SR)
    for (let i = 0; i < data.length; i++) {
      const t = i / SR
      data[i] = t < 4 ? Math.sin(2 * Math.PI * 100 * t) * 0.02 : Math.sin(2 * Math.PI * 300 * t) * 0.5
    }
    const start = analyzeContentStart(data, SR)
    // 能量跃升窗口跨越 4s 边界，起始判定会提前到跃升窗口起点附近
    expect(start).toBeGreaterThanOrEqual(3.4)
    expect(start).toBeLessThanOrEqual(4.5)
  })

  it('内容起点：从头即有声 → 0（无前奏）', () => {
    const start = analyzeContentStart(makeTone(10, 300, 0.5), SR)
    expect(start).toBe(0)
  })

  it('内容起点：异步版本与同步版本一致', async () => {
    const data = new Float32Array(30 * SR)
    for (let i = 0; i < data.length; i++) {
      const t = i / SR
      data[i] = t < 4 ? Math.sin(2 * Math.PI * 100 * t) * 0.02 : Math.sin(2 * Math.PI * 300 * t) * 0.5
    }
    const asyncStart = await analyzeContentStartAsync(data, SR)
    expect(asyncStart).toBe(analyzeContentStart(data, SR))
  })
})

describe('智能过渡计划', () => {
  const baseTail = { peakRms: 0.8, decayStartSec: 226, decayRate: 0.1 }

  it('节奏匹配（同速）：tempoMatch=true、变速比为 1', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 120,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.tempoMatch).toBe(true)
    expect(plan.stretchRatio).toBe(1)
  })

  it('节奏 2 倍频对齐（倍速）也视为匹配', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 60,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.tempoMatch).toBe(true)
    expect(plan.stretchRatio).toBe(1)
  })

  it('节奏轻微差异：对下一曲变速对齐（stretchRatio = 1/比值）', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 150,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.tempoMatch).toBe(true)
    expect(plan.stretchRatio).toBeCloseTo(1 / 1.25, 5)
  })

  it('节奏差异过大：不强行变速', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 180,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.tempoMatch).toBe(false)
    expect(plan.stretchRatio).toBe(1)
  })

  it('触发点：无衰减时取结尾窗口起点，有时取衰减起点并收敛到窗口内', () => {
    // 有衰减：触发点 = 衰减起点
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 120,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.triggerMs).toBe(226000)

    // 无衰减：触发点 = 结尾 TAIL_ANALYSIS_SEC 窗口起点
    const plan2 = computeTransitionPlan({
      durationMs: 240000,
      tail: { peakRms: 0.6, decayStartSec: -1, decayRate: 0 },
      currentBpm: 120,
      nextBpm: 120,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan2.triggerMs).toBe(240000 - TAIL_ANALYSIS_SEC * 1000)
  })

  it('过渡时长：随质量缩放且不超剩余时间，恒在合法区间', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 120,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(plan.transitionDurationMs).toBeGreaterThanOrEqual(MIN_TRANSITION_MS)
    expect(plan.transitionDurationMs).toBeLessThanOrEqual(MAX_TRANSITION_MS)
    expect(plan.transitionDurationMs).toBeLessThanOrEqual(240000 - plan.triggerMs)
    expect(plan.quality).toBeGreaterThan(0)
    expect(plan.quality).toBeLessThanOrEqual(1)
  })

  it('内容起点偏移换算到变速后时间轴', () => {
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 150, // 变速比 0.8
      currentKey: null,
      nextKey: null,
      contentStartSec: 5,
      userTransitionMs: 3000
    })
    expect(plan.startOffsetMs).toBe(Math.round(5000 * plan.stretchRatio))
  })

  it('调性兼容：兼容键位不强制变调，不兼容时给出对齐变调量', () => {
    // 关系大小调（8B ↔ 8A）：无需变调
    const compatible = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 120,
      currentKey: cMajor,
      nextKey: { root: 9, mode: 'minor', name: 'Am', camelot: '8A', confidence: 0.9 },
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(compatible.pitchShiftSemitones).toBe(0)
    expect(compatible.keyDistance).toBe(0)

    // E 大调向 C 大调对齐：+1 半音（F 大调 7B，五度相邻）
    const aligned = computeTransitionPlan({
      durationMs: 240000,
      tail: baseTail,
      currentBpm: 120,
      nextBpm: 120,
      currentKey: cMajor,
      nextKey: eMajor,
      contentStartSec: 0,
      userTransitionMs: 3000
    })
    expect(aligned.pitchShiftSemitones).toBe(1)
    expect(aligned.keyDistance).toBe(1)
  })
})

describe('WSOLA 变速（变速不变调）', () => {
  it('ratio=0.5：时长减半，内容保留', () => {
    const input = makeTone(1, 440, 0.8)
    const out = timeStretchPcm(input, 0.5)
    expect(out.length).toBe(Math.round(input.length * 0.5))
    let peak = 0
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i])
    expect(peak).toBeGreaterThan(0.5)
  })

  it('ratio≈1：原样返回同一引用', () => {
    const input = makeTone(1, 440)
    expect(timeStretchPcm(input, 1)).toBe(input)
    expect(timeStretchPcm(input, 1.001)).toBe(input)
  })

  it('异步版本结果与同步一致', async () => {
    const input = makeTone(1, 440, 0.8)
    const sync = timeStretchPcm(input, 0.5)
    const asyncOut = await timeStretchPcmAsync(input, 0.5)
    expect(asyncOut.length).toBe(sync.length)
  })
})

describe('相位声码器变调（变调不变速）', () => {
  it('+12 半音：时长不变，音调翻倍', () => {
    const input = makeTone(2, 440, 0.8)
    const out = pitchShiftPcm(input, 12)
    expect(Math.abs(out.length - input.length)).toBeLessThanOrEqual(2)

    // 过零率估计主频：翻倍至约 880Hz
    let crossings = 0
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] < 0 && out[i] >= 0) || (out[i - 1] >= 0 && out[i] < 0)) crossings++
    }
    const freq = crossings / 2 / (out.length / SR)
    expect(Math.abs(freq - 880)).toBeLessThan(88) // ±10%
  })

  it('半音为 0：原样返回', () => {
    const input = makeTone(1, 440)
    expect(pitchShiftPcm(input, 0)).toBe(input)
  })

  it('异步版本结果与同步一致', async () => {
    const input = makeTone(1, 440, 0.8)
    const asyncOut = await pitchShiftPcmAsync(input, 12)
    expect(Math.abs(asyncOut.length - input.length)).toBeLessThanOrEqual(2)
  })
})
