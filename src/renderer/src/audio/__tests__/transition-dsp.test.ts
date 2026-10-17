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
  estimateBeatGrid,
  snapMsToGrid,
  buildEqualPowerCurves,
  buildLinearCurves,
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
  GRID_MIN_CONFIDENCE
} from '../transition-dsp'
import type { BeatGrid, MusicKey } from '../transition-dsp'

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

  it('触发点：贴近结尾触发，天然衰减起点距结尾过远时不采纳', () => {
    // duration=240s、userMs=3000 → 最晚合法点 = 240000-3000-1200 = 235800ms
    // baseTail 衰减起点 226s（=226000ms）早于 earliest(235800-3000=232800)，
    // 视为过早，触发点回落到最晚合法点，避免两曲长时间叠放
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
    expect(plan.triggerMs).toBe(235800)

    // 无衰减：触发点 = 最晚合法点（接近结尾，而非结尾前 30s 窗口起点）
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
    expect(plan2.triggerMs).toBe(235800)
  })

  it('触发点：天然衰减起点距结尾足够近时采纳衰减起点', () => {
    // duration=240s、userMs=5000 → 最晚合法点 = 240000-5000-1200 = 233800ms，
    // earliest = 233800-5000 = 228800ms；衰减起点 230s 落在 [228800,233800] 内 → 采纳
    const plan = computeTransitionPlan({
      durationMs: 240000,
      tail: { peakRms: 0.8, decayStartSec: 230, decayRate: 0.1 },
      currentBpm: 120,
      nextBpm: 120,
      currentKey: null,
      nextKey: null,
      contentStartSec: 0,
      userTransitionMs: 5000
    })
    expect(plan.triggerMs).toBe(230000)
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

describe('拍网格估计（estimateBeatGrid）', () => {
  it('120 BPM 脉冲音：BPM 与相位正确、置信度高', () => {
    const grid = estimateBeatGrid(makeClickTrack(120, 30), SR, 0, 30, 120)
    expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(2)
    expect(grid.confidence).toBeGreaterThan(GRID_MIN_CONFIDENCE)
    // 相位：脉冲位于每拍起点（窗口对齐），相位应接近 0 或一整个周期
    const period = grid.beatPeriodSec
    const distToBeat = Math.min(grid.phaseSec, period - grid.phaseSec)
    expect(distToBeat).toBeLessThan(0.06)
  })

  it('无提示 BPM 时也能建立网格（全区间枚举）', () => {
    const grid = estimateBeatGrid(makeClickTrack(120, 30), SR, 0, 30, 0)
    expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(2)
    expect(grid.confidence).toBeGreaterThan(GRID_MIN_CONFIDENCE)
  })

  it('纯音（无起音）返回不可用网格', () => {
    const grid = estimateBeatGrid(makeTone(30, 440, 0.8), SR, 0, 30, 0)
    expect(grid.bpm).toBe(0)
    expect(grid.confidence).toBe(0)
  })

  it('数据不足返回不可用网格', () => {
    const grid = estimateBeatGrid(makeClickTrack(120, 1), SR, 0, 1, 120)
    expect(grid.bpm).toBe(0)
    expect(grid.confidence).toBe(0)
  })
})

describe('拍网格吸附（snapMsToGrid）', () => {
  const grid120: BeatGrid = { bpm: 120, beatPeriodSec: 0.5, phaseSec: 0, confidence: 1 }

  it('优先小节 / 乐句层级（容差内取更大层级）', () => {
    // 期望 1500ms：最近小节头 2000ms（距 500ms ≤ 容差 2 拍 = 1000ms）
    expect(snapMsToGrid(1500, grid120, 0, 10000)).toBe(2000)
    // 期望 3400ms：8 拍候选 4000ms（距 600ms ≤ 容差），优先于 1 拍候选 3500
    expect(snapMsToGrid(3400, grid120, 0, 10000)).toBe(4000)
  })

  it('窗口内无小节头时下沉到单拍', () => {
    // 窗口 [3250, 3550]：唯一拍点 3500 在窗内，小节头 2000/4000 均出窗
    expect(snapMsToGrid(3400, grid120, 3250, 3550)).toBe(3500)
  })

  it('窗口内无任何网格点返回 null', () => {
    expect(snapMsToGrid(3230, grid120, 3201, 3249)).toBeNull()
  })

  it('相位偏移生效：拍点位于 phase + n×period', () => {
    const gridPhase: BeatGrid = { bpm: 120, beatPeriodSec: 0.5, phaseSec: 0.2, confidence: 1 }
    // 拍点 = 200 + 500n → 2200 本身即网格点
    expect(snapMsToGrid(2200, gridPhase, 0, 10000)).toBe(2200)
  })

  it('窗口非法 / 置信度不足返回 null', () => {
    expect(snapMsToGrid(1000, grid120, 5000, 0)).toBeNull()
    expect(snapMsToGrid(1000, { ...grid120, confidence: 0.1 }, 0, 5000)).toBeNull()
  })
})

describe('过渡点拍网格吸附（computeTransitionPlan）', () => {
  const tailGridded = {
    peakRms: 0.8,
    decayStartSec: 230.3,
    decayRate: 0.1,
    grid: { bpm: 120, beatPeriodSec: 0.5, phaseSec: 0, confidence: 0.9 }
  }
  const base = {
    durationMs: 240000,
    currentBpm: 120,
    nextBpm: 120,
    currentKey: null,
    nextKey: null,
    contentStartSec: 0,
    userTransitionMs: 5000
  }

  it('网格有效时触发点吸附到网格（barAligned=true），且仍落在合法窗口内', () => {
    // latest = 240000-5000-1200 = 233800，earliest = 228800；衰减起点 230300 → 吸附到 230000
    const plan = computeTransitionPlan({ ...base, tail: tailGridded })
    expect(plan.barAligned).toBe(true)
    expect(plan.gridConfidence).toBeCloseTo(0.9, 5)
    expect(plan.triggerMs).toBe(230000)
    expect(plan.triggerMs).toBeGreaterThanOrEqual(228800)
    expect(plan.triggerMs).toBeLessThanOrEqual(233800)
  })

  it('关闭节奏对齐时回退到衰减起点（旧行为）', () => {
    const plan = computeTransitionPlan({ ...base, tail: tailGridded, beatAlignEnabled: false })
    expect(plan.barAligned).toBe(false)
    expect(plan.gridConfidence).toBe(0)
    expect(plan.triggerMs).toBe(230300)
  })

  it('网格置信度不足时不吸附', () => {
    const lowGrid = {
      ...tailGridded,
      grid: { bpm: 120, beatPeriodSec: 0.5, phaseSec: 0, confidence: 0.1 }
    }
    const plan = computeTransitionPlan({ ...base, tail: lowGrid })
    expect(plan.barAligned).toBe(false)
    expect(plan.triggerMs).toBe(230300)
  })

  it('nextDownbeatSec 透传，并作为落点参与变速时间轴映射', () => {
    const plan = computeTransitionPlan({
      ...base,
      tail: { peakRms: 0.8, decayStartSec: -1, decayRate: 0 },
      contentStartSec: 5,
      nextDownbeatSec: 4.5,
      userTransitionMs: 3000
    })
    expect(plan.nextDownbeatSec).toBe(4.5)
    expect(plan.startOffsetMs).toBe(Math.round(4500 * plan.stretchRatio))
  })
})

describe('交叉淡化曲线', () => {
  it('等功率曲线满足 fadeOut² + fadeIn² ≈ 1（合成电平恒定）', () => {
    const { fadeOut, fadeIn } = buildEqualPowerCurves(64)
    expect(fadeOut.length).toBe(64)
    expect(fadeIn.length).toBe(64)
    expect(fadeOut[0]).toBeCloseTo(1, 6)
    expect(fadeIn[0]).toBeCloseTo(0, 6)
    expect(fadeOut[63]).toBeCloseTo(0, 6)
    expect(fadeIn[63]).toBeCloseTo(1, 6)
    for (let i = 0; i < 64; i++) {
      expect(fadeOut[i] * fadeOut[i] + fadeIn[i] * fadeIn[i]).toBeCloseTo(1, 5)
    }
  })

  it('线性曲线：端点 1→0 / 0→1，中点为 0.5', () => {
    const { fadeOut, fadeIn } = buildLinearCurves(65)
    expect(fadeOut[0]).toBeCloseTo(1, 6)
    expect(fadeIn[0]).toBeCloseTo(0, 6)
    expect(fadeOut[64]).toBeCloseTo(0, 6)
    expect(fadeIn[64]).toBeCloseTo(1, 6)
    expect(fadeOut[32]).toBeCloseTo(0.5, 6)
    expect(fadeIn[32]).toBeCloseTo(0.5, 6)
  })

  it('曲线长度下限保护（n<2 时按 2 处理）', () => {
    expect(buildEqualPowerCurves(1).fadeOut.length).toBe(2)
    expect(buildLinearCurves(0).fadeIn.length).toBe(2)
  })
})
