/**
 * transition-dsp.ts 实时过渡点分析核心的单元测试
 *
 * 覆盖验收标准：
 * - TR-2.1: 输入构造的时域帧序列，能正确检测能量突变（起始点）
 * - TR-2.2: 输入尾部衰减的序列，能检测到衰减起点并产出合理 transitionDurationMs
 * 另覆盖 analyzeHead / decideTransition 全部分支与边界。
 */
import { describe, it, expect } from 'vitest'
import {
  StreamingAnalyzer,
  analyzeContentStart,
  analyzeContentStartAsync,
  analyzeHead,
  analyzeTail,
  analyzeVocalEnd,
  analyzeVocalEndAsync,
  analyzeVocalGap,
  analyzeVocalGapAsync,
  analyzeVocalStart,
  analyzeVocalStartAsync,
  computeSmartTriggerMs,
  decideTransition,
  detectOnset,
  estimateBpm,
  computeRms,
  timeStretchPcm,
  timeStretchPcmAsync,
  BEAT_TRIGGER_MARGIN_MS,
  TAIL_WINDOW_SEC,
  MIN_TRANSITION_MS,
  MAX_TRANSITION_MS,
  MIN_VOCAL_GAP_SEC
} from '../transition-dsp'
import type {
  EnergySample,
  HeadFeatures,
  TailFeatures,
  TransitionDecision
} from '../transition-dsp'

/** 构造一帧正弦波采样 */
function makeToneFrame(
  frequency: number,
  amplitude: number,
  sampleRate = 44100,
  frameSize = 256
): Float32Array {
  const frame = new Float32Array(frameSize)
  for (let i = 0; i < frameSize; i++) {
    frame[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude
  }
  return frame
}

/** 构造一帧静音采样 */
function makeSilentFrame(frameSize = 256): Float32Array {
  return new Float32Array(frameSize)
}

/** 构造指定长度的正弦波声道数据 */
function makeToneChannel(
  durationSec: number,
  frequency: number,
  amplitude: number,
  sampleRate = 44100
): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude
  }
  return data
}

/** 构造人声频段谐波声道数据（1k/2k/3k/4k 混合，模拟人声共振峰集中区） */
function makeVocalChannel(durationSec: number, sampleRate = 44100): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate
    data[i] =
      Math.sin(2 * Math.PI * 1000 * t) * 0.2 +
      Math.sin(2 * Math.PI * 2000 * t) * 0.2 +
      Math.sin(2 * Math.PI * 3000 * t) * 0.2 +
      Math.sin(2 * Math.PI * 4000 * t) * 0.2
  }
  return data
}

/** 拼接多个声道数据段 */
function concatChannels(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const data = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    data.set(p, offset)
    offset += p.length
  }
  return data
}

/** 构造节拍信号：短促衰减脉冲，按指定 BPM 等间隔出现 */
function makeBeatChannel(durationSec: number, bpm: number, sampleRate = 44100): Float32Array {
  const data = new Float32Array(Math.floor(durationSec * sampleRate))
  const interval = 60 / bpm
  const pulseLen = Math.floor(0.05 * sampleRate)
  let t = 0
  while (t < durationSec) {
    const start = Math.floor(t * sampleRate)
    for (let i = 0; i < pulseLen && start + i < data.length; i++) {
      // 指数衰减包络的短促脉冲，模拟鼓点/节拍
      const env = Math.exp(-i / (sampleRate * 0.008))
      data[start + i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.8 * env
    }
    t += interval
  }
  return data
}

/** 计算信号每秒过零次数（用于验证变速不变调：音调保持则过零率不变） */
function zeroCrossRate(data: Float32Array, sampleRate: number): number {
  let crossings = 0
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++
  }
  return crossings / (data.length / sampleRate)
}

describe('computeRms', () => {
  it('静音帧 RMS 为 0', () => {
    expect(computeRms(makeSilentFrame())).toBe(0)
  })

  it('正弦波帧 RMS 约为幅值的 1/√2', () => {
    const rms = computeRms(makeToneFrame(440, 0.8))
    expect(rms).toBeGreaterThan(0.5)
    expect(rms).toBeLessThan(0.65)
  })
})

describe('detectOnset', () => {
  it('从静音跃起且能量足够大时判定为起始点', () => {
    expect(detectOnset(0, 0.3)).toBe(true)
  })

  it('从静音跃起但能量过低时不判定（噪声抑制）', () => {
    expect(detectOnset(0, 0.01)).toBe(false)
  })

  it('能量无突增时不判定', () => {
    expect(detectOnset(0.3, 0.3)).toBe(false)
    expect(detectOnset(0.3, 0.5)).toBe(false)
  })

  it('能量超过倍数阈值时判定', () => {
    expect(detectOnset(0.1, 0.9)).toBe(true)
  })
})

describe('StreamingAnalyzer TR-2.1（起始点实时检测）', () => {
  it('静音后出现高能量帧时触发 onset', () => {
    const analyzer = new StreamingAnalyzer('t1', 60_000, 44100)

    // 前 20 帧（1s）静音
    for (let i = 0; i < 20; i++) {
      const result = analyzer.update(makeSilentFrame(), i * 0.05)
      expect(result.onset).toBe(false)
    }

    // 高能量帧 → 起始点
    const result = analyzer.update(makeToneFrame(440, 0.8), 20 * 0.05)
    expect(result.onset).toBe(true)
  })

  it('持续播放（能量稳定）不会误报起始点', () => {
    const analyzer = new StreamingAnalyzer('t2', 60_000, 44100)
    // 歌曲起始帧从静音跃起触发 onset 属正常行为
    analyzer.update(makeToneFrame(440, 0.6), 0)
    let onsetCount = 0
    // 后续能量稳定，不应再触发
    for (let i = 1; i < 40; i++) {
      const result = analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
      if (result.onset) onsetCount++
    }
    expect(onsetCount).toBe(0)
  })
})

describe('analyzeTail + decideTransition TR-2.2（尾部衰减检测）', () => {
  it('尾部能量递减序列能检测到衰减起点', () => {
    const analyzer = new StreamingAnalyzer('t3', 60_000, 44100)

    // 前 3 秒持续高能量
    for (let i = 0; i < 60; i++) {
      analyzer.update(makeToneFrame(440, 0.8), i * 0.05)
    }
    // 后 2 秒能量从 0.8 线性衰减到 0.01
    for (let i = 60; i < 100; i++) {
      const amplitude = 0.8 - 0.79 * ((i - 60) / 40)
      analyzer.update(makeToneFrame(440, amplitude), i * 0.05)
    }

    const tail = analyzeTail(analyzer.getEnvelope(), TAIL_WINDOW_SEC)
    expect(tail.decayStartSec).toBeGreaterThanOrEqual(0)

    // 决策应在 update 过程中随衰减检测自动产出
    const decision = analyzer.latestDecision
    expect(decision).not.toBeNull()
    expect(decision!.strategy).toBe('natural_fade')
    expect(decision!.transitionDurationMs).toBeGreaterThanOrEqual(MIN_TRANSITION_MS)
    expect(decision!.transitionDurationMs).toBeLessThanOrEqual(MAX_TRANSITION_MS)
  })

  it('接近歌曲结尾时自动产出兜底决策', () => {
    const analyzer = new StreamingAnalyzer('t4', 20_000, 44100)
    let lastDecision: TransitionDecision | null = null

    // 播放 10.5s，接近结尾窗口（20s - 10s）
    for (let i = 0; i < 210; i++) {
      const result = analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
      if (result.decision) lastDecision = result.decision
    }

    expect(lastDecision).not.toBeNull()
    expect(lastDecision!.transitionDurationMs).toBeGreaterThanOrEqual(MIN_TRANSITION_MS)
    expect(lastDecision!.startPositionMs).toBeLessThan(20_000)
  })

  it('数据不足（< 2s）时不出产决策', () => {
    const analyzer = new StreamingAnalyzer('t5', 60_000, 44100)
    for (let i = 0; i < 20; i++) {
      const result = analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
      expect(result.decision).toBeNull()
    }
    expect(analyzer.evaluate()).toBeNull()
  })

  it('结尾静音尾奏：过渡起点不早于结尾前 30s 窗口', () => {
    const analyzer = new StreamingAnalyzer('t7', 60_000, 44100)
    // 前 25s 持续高能量（音乐内容）
    for (let i = 0; i < 500; i++) {
      analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
    }
    // 后 20s 静音（无人声尾奏）
    let lastDecision: TransitionDecision | null = null
    for (let i = 500; i < 900; i++) {
      const result = analyzer.update(makeSilentFrame(), i * 0.05)
      if (result.decision) lastDecision = result.decision
    }
    expect(lastDecision).not.toBeNull()
    // 过渡起点被限制在结尾 30s 窗口内（>= 60s - 30s），而不是锚定到更早的音乐结束点
    expect(lastDecision!.startPositionMs).toBeGreaterThanOrEqual(30_000)
    expect(lastDecision!.startPositionMs).toBeLessThan(60_000)
  })

  it('开篇静音（无实质内容）不提前产出决策，接近结尾时才触发', () => {
    const analyzer = new StreamingAnalyzer('t8', 60_000, 44100)
    // 前 20s 全静音（仍处于歌曲前半段）
    for (let i = 0; i < 400; i++) {
      const result = analyzer.update(makeSilentFrame(), i * 0.05)
      expect(result.decision).toBeNull()
    }
  })

  it('结尾静音且接近歌曲结束：过渡起点显著早于"末尾前 1.5s"', () => {
    const analyzer = new StreamingAnalyzer('t9', 30_000, 44100)
    // 前 12s 高能量
    for (let i = 0; i < 240; i++) {
      analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
    }
    // 后 18s 静音，播放至 28s（已进入近结尾窗口：>= 30 - 10）
    let lastDecision: TransitionDecision | null = null
    for (let i = 240; i < 560; i++) {
      const result = analyzer.update(makeSilentFrame(), i * 0.05)
      if (result.decision) lastDecision = result.decision
    }
    expect(lastDecision).not.toBeNull()
    expect(lastDecision!.startPositionMs).toBeLessThan(28_500)
  })
})

describe('analyzeHead（下一首头部特征）', () => {
  it('静音开头判定 startsQuiet', () => {
    const head = analyzeHead(makeToneChannel(1, 440, 0), 44100)
    expect(head.startsQuiet).toBe(true)
    expect(head.peakRms).toBeLessThan(0.01)
  })

  it('立即高能量 → 快速攻击（attackTimeSec ≈ 0）', () => {
    const head = analyzeHead(makeToneChannel(1, 440, 0.8), 44100)
    expect(head.startsQuiet).toBe(false)
    expect(head.attackTimeSec).toBe(0)
    expect(head.peakRms).toBeGreaterThan(0.3)
  })
})

describe('analyzeContentStart（跳过前奏偏移）', () => {
  it('静音前奏后内容稳定出现 → 返回内容起点偏移', () => {
    const sr = 44100
    // 4s 静音 + 2s 内容
    const silence = new Float32Array(Math.floor(4 * sr))
    const content = makeToneChannel(2, 440, 0.5, sr)
    const data = new Float32Array(silence.length + content.length)
    data.set(silence)
    data.set(content, silence.length)
    const start = analyzeContentStart(data, sr)
    expect(start).toBeGreaterThanOrEqual(3.5)
    expect(start).toBeLessThanOrEqual(4.2)
  })

  it('轻声音乐前奏（非静音）后内容增强 → 跳过前奏', () => {
    const sr = 44100
    // 3s 轻声音乐前奏 + 2s 主内容
    const intro = makeToneChannel(3, 220, 0.08, sr)
    const content = makeToneChannel(2, 440, 0.5, sr)
    const data = new Float32Array(intro.length + content.length)
    data.set(intro)
    data.set(content, intro.length)
    const start = analyzeContentStart(data, sr)
    expect(start).toBeGreaterThanOrEqual(2.5)
    expect(start).toBeLessThanOrEqual(3.2)
  })

  it('低频器乐前奏后带人声谐波（1k-4kHz）的内容出现 → 从人声起点跳过前奏', () => {
    const sr = 44100
    // 3s 低频纯音前奏（无 1k-4kHz 成分，人声占比低）
    const intro = makeToneChannel(3, 220, 0.08, sr)
    // 2s 谐波丰富内容：1k/2k/3k/4k 分量（模拟人声频段能量占比高）
    const contentSec = 2
    const content = new Float32Array(Math.floor(contentSec * sr))
    for (let i = 0; i < content.length; i++) {
      const t = i / sr
      content[i] =
        Math.sin(2 * Math.PI * 1000 * t) * 0.2 +
        Math.sin(2 * Math.PI * 2000 * t) * 0.2 +
        Math.sin(2 * Math.PI * 3000 * t) * 0.2 +
        Math.sin(2 * Math.PI * 4000 * t) * 0.2
    }
    const data = new Float32Array(intro.length + content.length)
    data.set(intro)
    data.set(content, intro.length)
    const start = analyzeContentStart(data, sr)
    expect(start).toBeGreaterThanOrEqual(2.5)
    expect(start).toBeLessThanOrEqual(3.2)
  })

  it('高频器乐前奏（含 1k-4kHz 成分）后主歌人声进入 → 从人声起点跳过前奏（不误判前奏为人声）', () => {
    const sr = 44100
    // 6s 高频器乐前奏：220Hz 低频 + 4kHz 高频混合（人声频段占比中等但稳定）
    const introSec = 6
    const intro = new Float32Array(Math.floor(introSec * sr))
    for (let i = 0; i < intro.length; i++) {
      const t = i / sr
      intro[i] = Math.sin(2 * Math.PI * 220 * t) * 0.3 + Math.sin(2 * Math.PI * 4000 * t) * 0.15
    }
    // 2s 人声谐波（1k/2k/3k/4k，占比显著更高）
    const data = concatChannels(intro, makeVocalChannel(2, sr))
    const start = analyzeContentStart(data, sr)
    // 旧算法（绝对阈值）会把前奏判定为"人声起点"返回 0；新算法应跳过前奏到人声进入处
    expect(start).toBeGreaterThanOrEqual(5.5)
    expect(start).toBeLessThanOrEqual(6.2)
  })

  it('开头即有内容（无前奏）→ 返回 0', () => {
    expect(analyzeContentStart(makeToneChannel(3, 440, 0.5), 44100)).toBe(0)
  })

  it('全静音 → 返回 0', () => {
    expect(analyzeContentStart(makeToneChannel(5, 440, 0), 44100)).toBe(0)
  })
})

describe('analyzeVocalEnd（人声结尾触发点）', () => {
  it('人声段在结尾前结束，结尾为器乐尾奏 → 返回人声段结束位置', () => {
    const sr = 44100
    // 4s 人声 + 3s 低频器乐尾奏 + 1s 静音
    const data = concatChannels(
      makeVocalChannel(4, sr),
      makeToneChannel(3, 220, 0.15, sr),
      new Float32Array(Math.floor(1 * sr))
    )
    const end = analyzeVocalEnd(data, sr)
    // 人声在约 4s 处结束，器乐尾奏不计入
    expect(end).toBeGreaterThanOrEqual(3.5)
    expect(end).toBeLessThanOrEqual(4.2)
  })

  it('人声持续到结尾 → 返回接近歌曲结尾的位置', () => {
    const sr = 44100
    const end = analyzeVocalEnd(makeVocalChannel(6, sr), sr)
    expect(end).toBeGreaterThanOrEqual(5.5)
    expect(end).toBeLessThanOrEqual(6.2)
  })

  it('纯低频器乐（无人声频段）→ 返回 -1', () => {
    expect(analyzeVocalEnd(makeToneChannel(6, 220, 0.4), 44100)).toBe(-1)
  })

  it('全静音 → 返回 -1', () => {
    expect(analyzeVocalEnd(makeToneChannel(6, 440, 0), 44100)).toBe(-1)
  })

  it('歌曲短于分析窗口（结尾窗口覆盖整曲）时仍正常检测', () => {
    const sr = 44100
    // 2s 人声后紧接 0.5s 静音（长度 < VOCAL_END_ANALYSIS_SEC）
    const data = concatChannels(makeVocalChannel(2, sr), new Float32Array(Math.floor(0.5 * sr)))
    const end = analyzeVocalEnd(data, sr)
    expect(end).toBeGreaterThanOrEqual(1.5)
    expect(end).toBeLessThanOrEqual(2.2)
  })
})

describe('decideTransition（决策分支）', () => {
  const blendTail: TailFeatures = {
    peakRms: 0.5,
    avgRms: 0.4,
    endRms: 0.4,
    decayStartSec: -1,
    decayRate: 0
  }

  it('静音尾部 → short_overlap（快速切换）', () => {
    const quietTail: TailFeatures = {
      peakRms: 0.005,
      avgRms: 0.003,
      endRms: 0.001,
      decayStartSec: 0,
      decayRate: 0
    }
    const decision = decideTransition(quietTail, null, 60_000)
    expect(decision.strategy).toBe('short_overlap')
    expect(decision.transitionDurationMs).toBe(1500)
  })

  it('自然衰减尾部 → natural_fade（起点钳制在结尾 30s 内）', () => {
    const fadeTail: TailFeatures = {
      peakRms: 0.5,
      avgRms: 0.3,
      endRms: 0.05,
      decayStartSec: 5,
      decayRate: 0.2
    }
    const decision = decideTransition(fadeTail, null, 60_000)
    expect(decision.strategy).toBe('natural_fade')
    // 衰减点（5s）远早于结尾前 30s 窗口（30s）→ 起点钳制到 30s
    expect(decision.startPositionMs).toBe(30_000)
    expect(decision.transitionDurationMs).toBeLessThanOrEqual(MAX_TRANSITION_MS)
  })

  it('衰减点早于结尾 30s 时，过渡起点钳制在结尾前 30s', () => {
    const fadeTail: TailFeatures = {
      peakRms: 0.8,
      avgRms: 0.5,
      endRms: 0.01,
      decayStartSec: 40,
      decayRate: 0.3
    }
    const decision = decideTransition(fadeTail, null, 200_000)
    expect(decision.strategy).toBe('natural_fade')
    expect(decision.startPositionMs).toBe(170_000) // 200s - 30s
  })

  it('慢攻击头部 → long_blend（长混合过渡）', () => {
    const slowHead: HeadFeatures = {
      peakRms: 0.4,
      avgRms: 0.2,
      attackTimeSec: 2,
      startsQuiet: true,
      initialRms: 0.001
    }
    const decision = decideTransition(blendTail, slowHead, 60_000)
    expect(decision.strategy).toBe('long_blend')
    expect(decision.transitionDurationMs).toBe(5000)
  })

  it('快速攻击头部 → medium_blend（中等混合）', () => {
    const fastHead: HeadFeatures = {
      peakRms: 0.3,
      avgRms: 0.2,
      attackTimeSec: 0.1,
      startsQuiet: false,
      initialRms: 0.1
    }
    const decision = decideTransition(blendTail, fastHead, 60_000)
    expect(decision.strategy).toBe('medium_blend')
  })

  it('无衰减且无头部特征 → fallback（默认过渡）', () => {
    const decision = decideTransition(blendTail, null, 60_000)
    expect(decision.strategy).toBe('fallback')
    expect(decision.transitionDurationMs).toBe(3000)
  })

  it('决策时长始终在 [MIN, MAX] 范围内', () => {
    const cases: Array<{ tail: TailFeatures; head: HeadFeatures | null }> = [
      { tail: blendTail, head: null },
      { tail: { ...blendTail, decayStartSec: 50, decayRate: 0.1 }, head: null },
      {
        tail: blendTail,
        head: { peakRms: 0.9, avgRms: 0.5, attackTimeSec: -1, startsQuiet: false, initialRms: 0.5 }
      }
    ]
    for (const c of cases) {
      const decision = decideTransition(c.tail, c.head, 60_000)
      expect(decision.transitionDurationMs).toBeGreaterThanOrEqual(MIN_TRANSITION_MS)
      expect(decision.transitionDurationMs).toBeLessThanOrEqual(MAX_TRANSITION_MS)
      expect(decision.startPositionMs).toBeGreaterThanOrEqual(0)
      expect(decision.startPositionMs).toBeLessThanOrEqual(60_000)
    }
  })
})

describe('computeSmartTriggerMs（智能过渡触发点）', () => {
  it('人声结尾在结尾 30s 窗口内且早于最晚触发点 → 按人声结尾触发（过渡从人声接近结尾处开始）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: 220_000,
      decisionStartMs: -1
    })
    expect(t).toBe(220_000)
  })

  it('人声结尾过早（后半段为长器乐尾声）→ 钳制到结尾 30s 窗口起点，不在歌曲中途过渡', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: 120_000,
      decisionStartMs: -1
    })
    expect(t).toBe(240_000 - 30_000)
  })

  it('人声结尾接近歌曲结尾（歌曲以人声收尾）→ 钳制到最晚触发点：结尾前 过渡时长 + 提前量', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: 239_000,
      decisionStartMs: -1
    })
    expect(t).toBe(240_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
  })

  it('无人声且无决策 → 最晚触发点（不再塌缩到最后几秒）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(240_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
    // 相比旧逻辑（结尾前 min(transitionMs,1500)=1.5s），触发点显著提前
    expect(t).toBeLessThan(240_000 - 1500)
  })

  it('无人声但决策点早于结尾 30s 窗口 → 钳制到窗口起点（不在歌曲中途过渡）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: 200_000
    })
    expect(t).toBe(240_000 - 30_000)
  })

  it('决策点晚于最晚触发点 → 钳制到最晚触发点', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: 238_000
    })
    expect(t).toBe(240_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
  })

  it('过渡时长较长时提前量随之扩大（完整淡化在歌曲结束前播完）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 240_000,
      transitionMs: 8000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(240_000 - 8000 - BEAT_TRIGGER_MARGIN_MS)
  })

  it('极短歌曲（时长不足过渡 + 提前量）→ 触发点钳制为 0', () => {
    const t = computeSmartTriggerMs({
      durationMs: 2000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(0)
  })

  it('变速后歌曲：分析点在缓冲时间轴，时长须用实际缓冲时长（否则触发点被错误钳制 → 提前截断跳变）', () => {
    // 歌曲经 BPM 对齐变速后缓冲变长（元数据 240s → 缓冲 250s），
    // 人声间隙在缓冲时间轴 245s 处。若沿用元数据时长 240s（修复前的 bug），
    // 最晚触发点被钳制到 235.8s，歌曲在真正结束前 14s 被截断 → 听感为跳变
    const buggy = computeSmartTriggerMs({
      durationMs: 240_000, // 元数据时长（错误时间轴）
      transitionMs: 3000,
      vocalGapStartMs: 245_000,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(buggy).toBe(240_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)

    // 修复：时长用引擎实际缓冲时长 250s → 触发点保持在人声间隙 245s，不做错误钳制
    const fixed = computeSmartTriggerMs({
      durationMs: 250_000, // 实际缓冲时长（变速后时间轴）
      transitionMs: 3000,
      vocalGapStartMs: 245_000,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(fixed).toBe(245_000)
    // 修复后触发点必须显著晚于错误钳制点，保证过渡在歌曲真实结尾附近发生
    expect(fixed).toBeGreaterThan(240_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
  })

  it('加速后歌曲：时长须用实际缓冲时长（否则触发点超出缓冲末尾 → 永不过渡硬切跳变）', () => {
    // 歌曲变速缩短后缓冲为 235.5s（元数据仍 240s）。无分析点（纯器乐）时，
    // 若沿用元数据时长，最晚触发点 235.8s 超出实际缓冲末尾 235.5s，
    // 位置永远达不到 → 错过过渡，歌曲自然结束硬切（跳变）
    const buggy = computeSmartTriggerMs({
      durationMs: 240_000, // 元数据时长（错误时间轴）
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(buggy).toBeGreaterThan(235_500) // 超出实际缓冲末尾，不可达

    // 修复：时长用实际缓冲时长 → 触发点在缓冲末尾前，过渡可正常执行
    const fixed = computeSmartTriggerMs({
      durationMs: 235_500, // 实际缓冲时长
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(fixed).toBe(235_500 - 3000 - BEAT_TRIGGER_MARGIN_MS)
    expect(fixed).toBeLessThan(235_500)
  })
})

describe('StreamingAnalyzer 头部特征就绪后重新评估', () => {
  it('setHeadFeatures 后决策更新（head 缺失时无衰减兜底 → head 就绪后按头部特征）', () => {
    const analyzer = new StreamingAnalyzer('t6', 20_000, 44100)
    // 播放 12s 稳定能量，进入结尾窗口（20s - 10s）
    for (let i = 0; i < 240; i++) {
      analyzer.update(makeToneFrame(440, 0.6), i * 0.05)
    }
    // head 就绪前（无衰减）→ fallback
    const before = analyzer.latestDecision
    expect(before).not.toBeNull()
    expect(before!.strategy).toBe('fallback')

    // head 就绪后 → medium_blend
    const fastHead: HeadFeatures = {
      peakRms: 0.3,
      avgRms: 0.2,
      attackTimeSec: 0.1,
      startsQuiet: false,
      initialRms: 0.1
    }
    analyzer.setHeadFeatures(fastHead)
    const after = analyzer.latestDecision
    expect(after).not.toBeNull()
    expect(after!.strategy).toBe('medium_blend')
  })
})

describe('energy envelope 类型引用（保证导出可用）', () => {
  it('EnergySample 结构正确', () => {
    const sample: EnergySample = { positionSec: 1.5, rms: 0.3 }
    expect(sample.positionSec).toBe(1.5)
    expect(sample.rms).toBe(0.3)
  })
})

describe('estimateBpm（端点 BPM 估计）', () => {
  it('120 BPM 节拍信号 → 估计约 120', () => {
    const bpm = estimateBpm(makeBeatChannel(12, 120), 44100)
    expect(bpm).toBeGreaterThanOrEqual(110)
    expect(bpm).toBeLessThanOrEqual(130)
  })

  it('90 BPM 节拍信号 → 估计约 90', () => {
    const bpm = estimateBpm(makeBeatChannel(15, 90), 44100)
    expect(bpm).toBeGreaterThanOrEqual(82)
    expect(bpm).toBeLessThanOrEqual(98)
  })

  it('指定分析窗口 [startSec, endSec] 生效', () => {
    const sr = 44100
    // 前 10s 静音 + 后 10s 120 BPM 节拍
    const silence = new Float32Array(Math.floor(10 * sr))
    const beats = makeBeatChannel(10, 120, sr)
    const data = concatChannels(silence, beats)
    // 只分析 10-20s 段 → 约 120
    expect(estimateBpm(data, sr, 10, 20)).toBeGreaterThanOrEqual(110)
    expect(estimateBpm(data, sr, 10, 20)).toBeLessThanOrEqual(130)
    // 只分析 0-10s 静音段 → 无法估计返回 0
    expect(estimateBpm(data, sr, 0, 10)).toBe(0)
  })

  it('持续正弦（无节拍）→ 无法估计返回 0', () => {
    expect(estimateBpm(makeToneChannel(6, 440, 0.5), 44100)).toBe(0)
  })

  it('数据不足 → 返回 0', () => {
    expect(estimateBpm(makeBeatChannel(1, 120), 44100)).toBe(0)
  })
})

describe('timeStretchPcm（WSOLA 变速不变调）', () => {
  it('ratio≈1 时原样返回', () => {
    const input = makeToneChannel(1, 440, 0.6)
    expect(timeStretchPcm(input, 1.0)).toBe(input)
  })

  it('加速（ratio=0.5）：时长减半且音调不变', () => {
    const sr = 44100
    const input = makeToneChannel(4, 440, 0.6, sr)
    const out = timeStretchPcm(input, 0.5)
    // 时长约为输入一半
    expect(out.length).toBeGreaterThanOrEqual(Math.floor(input.length * 0.5) - sr)
    expect(out.length).toBeLessThanOrEqual(Math.ceil(input.length * 0.5) + sr)
    // 音调保持：过零率（每秒过零次数）基本不变
    const inRate = zeroCrossRate(input, sr)
    const outRate = zeroCrossRate(out, sr)
    expect(inRate).toBeGreaterThan(800)
    expect(inRate).toBeLessThan(920)
    expect(Math.abs(outRate - inRate) / inRate).toBeLessThan(0.06)
  })

  it('减速（ratio=2）：时长增加且音调不变', () => {
    const sr = 44100
    const input = makeToneChannel(3, 440, 0.6, sr)
    const out = timeStretchPcm(input, 2)
    expect(out.length).toBeGreaterThanOrEqual(Math.floor(input.length * 2) - sr)
    expect(out.length).toBeLessThanOrEqual(Math.ceil(input.length * 2) + sr)
    const inRate = zeroCrossRate(input, sr)
    const outRate = zeroCrossRate(out, sr)
    expect(Math.abs(outRate - inRate) / inRate).toBeLessThan(0.06)
  })

  it('无效 ratio → 原样返回', () => {
    const input = makeToneChannel(1, 440, 0.6)
    expect(timeStretchPcm(input, 0)).toBe(input)
    expect(timeStretchPcm(input, NaN)).toBe(input)
  })
})

describe('分块异步版本与同步版本结果一致（播放路径不阻塞主线程）', () => {
  it('analyzeVocalEndAsync 与 analyzeVocalEnd 结果一致', async () => {
    const channel = makeVocalChannel(240)
    const sync = analyzeVocalEnd(channel, 44100)
    const asyncResult = await analyzeVocalEndAsync(channel, 44100)
    expect(asyncResult).toBe(sync)
  })

  it('analyzeContentStartAsync 与 analyzeContentStart 结果一致', async () => {
    const channel = makeVocalChannel(240)
    const sync = analyzeContentStart(channel, 44100)
    const asyncResult = await analyzeContentStartAsync(channel, 44100)
    expect(asyncResult).toBe(sync)
  })

  it('timeStretchPcmAsync 与 timeStretchPcm 输出逐位一致', async () => {
    const sr = 44100
    const input = makeToneChannel(6, 440, 0.6, sr)
    const sync = timeStretchPcm(input, 0.85)
    const asyncResult = await timeStretchPcmAsync(input, 0.85)
    expect(asyncResult.length).toBe(sync.length)
    for (let i = 0; i < sync.length; i++) {
      expect(asyncResult[i]).toBe(sync[i])
    }
  })

  it('timeStretchPcmAsync ratio≈1 / 无效 ratio → 原样返回', async () => {
    const input = makeToneChannel(1, 440, 0.6)
    expect(await timeStretchPcmAsync(input, 1.0)).toBe(input)
    expect(await timeStretchPcmAsync(input, NaN)).toBe(input)
  })
})

describe('analyzeVocalGap（结尾无人声段分析）', () => {
  it('命中 ≥10s 无人声段（器乐间奏）→ 返回间隔起点与时长', () => {
    const sr = 44100
    // 20s 人声 + 12s 低频器乐间奏（500Hz，无 1k-4kHz 能量）+ 15s 人声，共 47s
    const data = concatChannels(
      makeVocalChannel(20, sr),
      makeToneChannel(12, 500, 0.3, sr),
      makeVocalChannel(15, sr)
    )
    const gap = analyzeVocalGap(data, sr)
    expect(gap).not.toBeNull()
    // 默认 30s 窗口覆盖 17-47s，间奏（20-32s）完整落在窗口内，起点约 20s
    expect(gap!.startSec).toBeGreaterThanOrEqual(18)
    expect(gap!.startSec).toBeLessThanOrEqual(22)
    expect(gap!.durationSec).toBeGreaterThanOrEqual(MIN_VOCAL_GAP_SEC)
  })

  it('多个 ≥10s 间隔 → 取最晚出现的间隔（而不是更早的）', () => {
    const sr = 44100
    // 10s 人声 + 11s 间奏 + 8s 人声 + 13s 间奏 + 8s 人声，共 50s
    const data = concatChannels(
      makeVocalChannel(10, sr),
      makeToneChannel(11, 500, 0.3, sr),
      makeVocalChannel(8, sr),
      makeToneChannel(13, 500, 0.3, sr),
      makeVocalChannel(8, sr)
    )
    const gap = analyzeVocalGap(data, sr)
    expect(gap).not.toBeNull()
    // 默认 30s 窗口覆盖 20-50s：第一个间奏（10-21s）仅 1s 落入窗口无法达标；
    // 命中的是第二个间奏（29-42s），起点约 29s，而不是第一个间奏的 10s
    expect(gap!.startSec).toBeGreaterThanOrEqual(27)
    expect(gap!.startSec).toBeLessThanOrEqual(31)
  })

  it('无人声段不足 10s → 返回 null', () => {
    const sr = 44100
    // 20s 人声 + 6s 间奏 + 15s 人声：间奏仅 6s < MIN_VOCAL_GAP_SEC
    const data = concatChannels(
      makeVocalChannel(20, sr),
      makeToneChannel(6, 500, 0.3, sr),
      makeVocalChannel(15, sr)
    )
    expect(analyzeVocalGap(data, sr)).toBeNull()
  })

  it('无任何人声（纯器乐）→ 返回 null', () => {
    // 全段 500Hz 纯音，无 1k-4kHz 人声频段能量，判定为无人声信号
    expect(analyzeVocalGap(makeToneChannel(40, 500, 0.3), 44100)).toBeNull()
  })

  it('windowSec 限定扫描范围：窗口内无人声 → null；窗口覆盖人声+尾奏 → 命中', () => {
    const sr = 44100
    // 25s 人声 + 20s 低频器乐尾奏，共 45s
    const data = concatChannels(makeVocalChannel(25, sr), makeToneChannel(20, 500, 0.3, sr))
    // 最后 10s 全是无人声尾奏、窗口内无任何人声 → 无人声信号 → null
    expect(analyzeVocalGap(data, sr, 10)).toBeNull()
    // 最后 30s（15-45s）内既有人声也有 20s 尾奏 → 命中，起点约 25s
    const gap = analyzeVocalGap(data, sr, 30)
    expect(gap).not.toBeNull()
    expect(gap!.startSec).toBeGreaterThanOrEqual(23)
    expect(gap!.startSec).toBeLessThanOrEqual(27)
    expect(gap!.durationSec).toBeGreaterThanOrEqual(MIN_VOCAL_GAP_SEC)
  })

  it('边界：间隔恰好 10s 命中（>= 边界语义）', () => {
    const sr = 44100
    // 15s 人声 + 10s 间奏 + 12s 人声，共 37s：间奏恰为 MIN_VOCAL_GAP_SEC
    const data = concatChannels(
      makeVocalChannel(15, sr),
      makeToneChannel(10, 500, 0.3, sr),
      makeVocalChannel(12, sr)
    )
    const gap = analyzeVocalGap(data, sr)
    expect(gap).not.toBeNull()
    expect(gap!.durationSec).toBeGreaterThanOrEqual(MIN_VOCAL_GAP_SEC)
    expect(gap!.startSec).toBeGreaterThanOrEqual(13)
    expect(gap!.startSec).toBeLessThanOrEqual(17)
  })

  it('analyzeVocalGapAsync 与 analyzeVocalGap 结果一致', async () => {
    const sr = 44100
    const data = concatChannels(
      makeVocalChannel(20, sr),
      makeToneChannel(12, 500, 0.3, sr),
      makeVocalChannel(15, sr)
    )
    const sync = analyzeVocalGap(data, sr)
    const asyncResult = await analyzeVocalGapAsync(data, sr)
    expect(sync).not.toBeNull()
    expect(asyncResult).not.toBeNull()
    expect(Math.abs(asyncResult!.startSec - sync!.startSec)).toBeLessThanOrEqual(1)
    expect(Math.abs(asyncResult!.durationSec - sync!.durationSec)).toBeLessThanOrEqual(0.5)
  })
})

describe('computeSmartTriggerMs（无人声段触发点优先级）', () => {
  it('vocalGapStartMs 优先于 vocalEndTriggerMs', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: 170_000,
      vocalEndTriggerMs: 180_000,
      decisionStartMs: 175_000
    })
    expect(t).toBe(170_000)
  })

  it('vocalGapStartMs 优先于 decisionStartMs', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: 172_000,
      vocalEndTriggerMs: -1,
      decisionStartMs: 178_000
    })
    expect(t).toBe(172_000)
  })

  it('无人声段缺失 → 回退 vocalEndTriggerMs（且未被窗口钳制改变）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: 180_000,
      decisionStartMs: 175_000
    })
    expect(t).toBe(180_000)
  })

  it('全部缺失 → 回退最晚触发点（结尾前 过渡时长 + 提前量）', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: -1,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(200_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
  })

  it('无人声段早于结尾 30s 窗口 → 钳制到窗口起点', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: 165_000,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(200_000 - 30_000)
  })

  it('无人声段晚于最晚触发点 → 钳制到最晚触发点', () => {
    const t = computeSmartTriggerMs({
      durationMs: 200_000,
      transitionMs: 3000,
      vocalGapStartMs: 196_500,
      vocalEndTriggerMs: -1,
      decisionStartMs: -1
    })
    expect(t).toBe(200_000 - 3000 - BEAT_TRIGGER_MARGIN_MS)
  })
})

describe('analyzeVocalStart（下一首人声起点）', () => {
  it('器乐前奏 + 人声 → 返回人声起点（≈ 前奏长度）', () => {
    const sr = 44100
    // 5s 低频器乐前奏（500Hz，无 1k-4kHz 人声频段能量）+ 15s 人声谐波
    const data = concatChannels(makeToneChannel(5, 500, 0.3, sr), makeVocalChannel(15, sr))
    const start = analyzeVocalStart(data, sr)
    // 人声起点 ≈ 前奏长度 5s（容忍窗口边界效应 ±2s）
    expect(start).toBeGreaterThanOrEqual(3)
    expect(start).toBeLessThan(7)
  })

  it('开头即人声（无前奏）→ 无相对跃升，返回 -1（调用方回退到内容起点 ≈ 0）', () => {
    const sr = 44100
    // 人声从第 0 秒开始：相对 ~2s 基线的占比"跃升"不存在（基线本身已是人声占比），
    // detectVocalRise 检测不到显著跃升 → 返回 -1，由调用方沿用内容起点逻辑（≈ 0）
    expect(analyzeVocalStart(makeVocalChannel(10, sr), sr)).toBe(-1)
  })

  it('纯器乐（无人声信号）→ 返回 -1', () => {
    // 全段 500Hz 纯音，无 1k-4kHz 人声频段能量，占比无跃升
    expect(analyzeVocalStart(makeToneChannel(10, 500, 0.3, 44100), 44100)).toBe(-1)
  })

  it('异步版本与同步结果一致', async () => {
    const sr = 44100
    const data = concatChannels(makeToneChannel(5, 500, 0.3, sr), makeVocalChannel(15, sr))
    const sync = analyzeVocalStart(data, sr)
    const asyncResult = await analyzeVocalStartAsync(data, sr)
    expect(sync).toBeGreaterThanOrEqual(3)
    expect(asyncResult).toBe(sync)
  })

  it('maxSec 限定扫描范围：默认 30s 窗口外的人声起点检测不到，扩大窗口后命中', () => {
    const sr = 44100
    // 35s 低频器乐前奏 + 10s 人声：人声起点 35s 超出默认 CONTENT_ANALYSIS_SEC=30 扫描窗口
    const data = concatChannels(makeToneChannel(35, 500, 0.3, sr), makeVocalChannel(10, sr))
    // 默认 maxSec=30：窗口内（前 30s）全为器乐，无显著人声跃升 → -1
    expect(analyzeVocalStart(data, sr)).toBe(-1)
    // maxSec=45 覆盖整个人声段 → 返回人声起点 ≈ 35s
    const start = analyzeVocalStart(data, sr, 45)
    expect(start).toBeGreaterThanOrEqual(33)
    expect(start).toBeLessThanOrEqual(37)
  })
})
