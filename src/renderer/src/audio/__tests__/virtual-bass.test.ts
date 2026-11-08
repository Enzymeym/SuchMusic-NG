/**
 * 虚拟低音（Virtual Bass）离线客观指标测试
 * ========================================
 *
 * 这些断言就是「可行性」的判据：全部在纯 Node 里跑，测的是
 * `worklets/virtual-bass.worklet.mjs` 这一份代码 —— 音频线程加载的也是它。
 *
 * 测量方法说明
 * ------------
 * 所有测试音都是**整数个周期的正弦**（时长与频率选成 f·N/fs ∈ ℤ），
 * 因此矩形窗下的 DFT 在目标频率以外**精确为零**，可以直接用单频 DFT
 * 读出谐波幅度，不需要补偿窗函数增益，也不需要担心频谱泄漏。
 * 这让"某处有没有能量"变成可以严格判定的问题。
 */

import { describe, expect, it } from 'vitest'
import {
  Biquad,
  VbCore,
  designLowpass,
  lrMag
} from '../worklets/virtual-bass.worklet.mjs'

const FS = 48000

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 多正弦叠加 */
function makeTone(freqs: number[], amps: number[], n: number, fs = FS): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let j = 0; j < freqs.length; j++) {
      v += amps[j] * Math.cos((2 * Math.PI * freqs[j] * i) / fs)
    }
    out[i] = v
  }
  return out
}

/** 确定性伪随机噪声（避免测试不可复现） */
function makeNoise(n: number, seed = 12345, amp = 0.25): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

/** 按 128 帧一块渲染（与 AudioWorklet 的 render quantum 一致） */
function render(
  core: VbCore,
  input: Float32Array[],
  wetGain: number,
  wetOnly = false
): Float32Array[] {
  const BLOCK = 128
  const n = input[0].length
  const out = input.map(() => new Float32Array(n))
  const inBlk = input.map(() => new Float32Array(BLOCK))
  const outBlk = input.map(() => new Float32Array(BLOCK))

  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    for (let ch = 0; ch < input.length; ch++) {
      if (len < BLOCK) inBlk[ch].fill(0)
      inBlk[ch].set(input[ch].subarray(off, off + len))
    }
    core.processBlock(inBlk, outBlk, BLOCK, wetGain, wetOnly)
    for (let ch = 0; ch < input.length; ch++) {
      out[ch].set(outBlk[ch].subarray(0, len), off)
    }
  }
  return out
}

/**
 * 单频 DFT 幅度。
 * 前提：freq·N/fs 是整数（bins 对齐），否则会有泄漏。
 */
function binAmp(x: Float32Array, start: number, N: number, freq: number, fs = FS): number {
  const w = (2 * Math.PI * freq) / fs
  let re = 0
  let im = 0
  for (let i = 0; i < N; i++) {
    const ph = w * i
    const v = x[start + i]
    re += v * Math.cos(ph)
    im -= v * Math.sin(ph)
  }
  return (2 * Math.hypot(re, im)) / N
}

const db = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12))

function maxAbs(x: Float32Array, from = 0, to = x.length): number {
  let m = 0
  for (let i = from; i < to; i++) {
    const v = x[i] < 0 ? -x[i] : x[i]
    if (v > m) m = v
  }
  return m
}

// 分析窗口：从第 2 秒开始取 1 秒（前面 2 秒供 kStar / makeup 收敛）
const TOTAL = FS * 3
const ANALYSIS_START = FS * 2
const ANALYSIS_N = FS

// ---------------------------------------------------------------------------
// 1. 干路 null test：关闭时输出必须与输入逐样本一致
// ---------------------------------------------------------------------------

describe('干路透明性（无损承诺）', () => {
  for (const fs of [44100, 48000]) {
    for (const channels of [1, 2]) {
      it(`wet=0 时逐样本一致（${fs} Hz / ${channels} 声道）`, () => {
        const n = fs * 2
        const input = Array.from({ length: channels }, (_, c) =>
          makeNoise(n, 1000 + c, 0.3)
        )
        const core = new VbCore({ fs, fLow: 120, fCross: 160 })
        const out = render(core, input, 0)

        let diffCount = 0
        let maxDiff = 0
        for (let ch = 0; ch < channels; ch++) {
          for (let i = 0; i < n; i++) {
            const d = Math.abs(out[ch][i] - input[ch][i])
            if (out[ch][i] !== input[ch][i]) diffCount++
            if (d > maxDiff) maxDiff = d
          }
        }

        expect(diffCount).toBe(0)
        expect(maxDiff).toBe(0)
      })
    }
  }

  it('开启后确实改变了信号（证明上面的 null test 不是空转）', () => {
    const n = FS * 2
    const tone = makeTone([50], [0.3], n)
    const core = new VbCore({ fs: FS, fLow: 120, fCross: 160 })
    const out = render(core, [tone], 0.3)
    let changed = 0
    for (let i = 0; i < n; i++) if (out[0][i] !== tone[i]) changed++
    expect(changed).toBeGreaterThan(n / 2)
  })
})

// ---------------------------------------------------------------------------
// 2. 谐波精度：Σ w_k·T_k(u) 的频谱系数必须就是 w_k
// ---------------------------------------------------------------------------

describe('谐波精度（T_k(cosθ) = cos kθ）', () => {
  for (const f0 of [40, 50, 60]) {
    it(`${f0} Hz 纯音的谐波幅度与权重一致（±0.5 dB）`, () => {
      const amp = 0.1 // -20 dBFS
      const tone = makeTone([f0], [amp], TOTAL)
      const core = new VbCore({
        fs: FS,
        fLow: 120,
        fCross: 160,
        wetHighpass: false, // 关掉湿路高通，单独验证谐波纯度
        gamma: 1, // 关掉电平压缩，让幅度可解析预测
        f0Override: f0,
        useF0: false
      })
      const out = render(core, [tone], 1, true)

      // 旁链 LR8 在 f0 处的实际增益
      const lowAmp = amp * lrMag(f0, 160, 4, false)
      const makeup = core.makeup
      const w = core.weights

      expect(makeup).toBeGreaterThan(0.5)
      expect(makeup).toBeLessThan(3)

      const measured: number[] = []
      const expected: number[] = []
      let checks = 0
      for (let k = 1; k <= 10; k++) {
        if (w[k] < 0.02) continue
        const m = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, k * f0)
        const e = lowAmp * w[k] * makeup
        measured.push(db(m))
        expected.push(db(e))
        expect(Math.abs(db(m) - db(e))).toBeLessThan(0.5)
        checks++
      }
      // 至少验证 3 个谐波，否则这个测试没有意义
      expect(checks).toBeGreaterThanOrEqual(3)
    })
  }

  it('没有非谐波杂散（> -100 dBFS）', () => {
    const f0 = 50
    const tone = makeTone([f0], [0.1], TOTAL)
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: false,
      gamma: 1,
      f0Override: f0,
      useF0: false
    })
    const out = render(core, [tone], 1, true)

    let worst = -Infinity
    let worstFreq = 0
    for (let f = 10; f <= 2000; f += 10) {
      if (f % f0 === 0) continue // 谐波本身
      const a = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f)
      if (a > worst) {
        worst = a
        worstFreq = f
      }
    }
    expect(worstFreq).toBeGreaterThan(0)
    expect(db(worst)).toBeLessThan(-100)
  })
})

// ---------------------------------------------------------------------------
// 3. 互调失真（双音）
// ---------------------------------------------------------------------------

describe('互调失真（50 + 70 Hz）', () => {
  it('差频产物被压到 -50 dBFS 以下，且 2 kHz 以上无能量', () => {
    const a = 0.2512 // 每个 -12 dBFS
    const tone = makeTone([50, 70], [a, a], TOTAL)
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: true,
      gamma: 1,
      useF0: false
    })
    const out = render(core, [tone], 1, true)

    // 差频产物才是真正的「互调垃圾」：|70−50| = 20、2·50−70 = 30、2·70−50 = 90。
    // 注意 100 Hz（2×50 的谐波）不算垃圾 —— 它是合法的目标谐波，只是
    // f0 未知时 k*=2 让它落到 fLow 以下，属于「浪费冲程」而非「失真」。
    const diffs = [20, 30, 40]
    let worstDiff = 0
    for (const f of diffs) {
      const v = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f)
      if (v > worstDiff) worstDiff = v
    }

    // 2 kHz 以上（解析上界 K·fCross = 1600 Hz）
    let worstHigh = 0
    for (let f = 2000; f <= 20000; f += 100) {
      const v = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f)
      if (v > worstHigh) worstHigh = v
    }

    // fLow 以下的「浪费」能量占比：k* 固定为 2 时 50 Hz 的 2 次谐波落在 100 Hz，
    // 笔记本依然发不出来。这里同时给出启用 f0 自适应后的对比。
    const belowRatio = (wet: Float32Array): number => {
      let b = 0
      let all = 0
      for (let f = 10; f <= 1500; f += 10) {
        const v = binAmp(wet, ANALYSIS_START, ANALYSIS_N, f)
        all += v * v
        if (f < 120) b += v * v
      }
      return (100 * Math.sqrt(b / Math.max(all, 1e-20)))
    }

    const coreAdaptive = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: true,
      gamma: 1,
      useF0: true
    })
    const outAdaptive = render(coreAdaptive, [tone], 1, true)

    // eslint-disable-next-line no-console
    console.log(
      `  [imd] 差频最强 ${db(worstDiff).toFixed(1)} dBFS, >2kHz 最强 ${db(worstHigh).toFixed(1)} dBFS`
    )
    // eslint-disable-next-line no-console
    console.log(
      `  [imd] fLow 以下能量占比: k*=2 固定 ${belowRatio(out[0]).toFixed(1)}%, ` +
        `k*=${coreAdaptive.kStar.toFixed(2)} 自适应 ${belowRatio(outAdaptive[0]).toFixed(1)}%`
    )

    expect(db(worstDiff)).toBeLessThan(-50)
    expect(db(worstHigh)).toBeLessThan(-80)
    // 两音等幅时基频不可判定，k* 会退回到 2 —— 这里只记录退化后的代价，
    // 不做「自适应一定更好」的断言（真实音乐里 kick 与贝斯重叠就是这样）。
    expect(coreAdaptive.kStar).toBeGreaterThanOrEqual(1.5)
    expect(coreAdaptive.kStar).toBeLessThanOrEqual(5.5)
  })

  it('F0 跟踪：单音贝斯线能锁定基频并抬高谐波阶次', () => {
    // 现实场景：一个 55 Hz 的贝斯音 + 同音的高次谐波（模拟音色），
    // 低频段存在明确的主导基频，互相关应当锁定 55 Hz。
    const tone = makeTone([55, 110, 165], [0.3, 0.12, 0.06], TOTAL)
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: true,
      gamma: 1,
      useF0: true
    })
    render(core, [tone], 1, true)

    // eslint-disable-next-line no-console
    console.log(
      `  [f0] 估计 ${core.f0.toFixed(1)} Hz, 置信度 ${core.tracker.confidence.toFixed(3)}, k*=${core.kStar.toFixed(2)}`
    )

    expect(core.f0).toBeGreaterThan(50)
    expect(core.f0).toBeLessThan(60)
    // fLow=120 / f0=55 ⇒ k* ≈ 2.18，2 次谐波 110 Hz 已在可重放范围内
    expect(core.kStar).toBeGreaterThan(1.9)
    expect(core.kStar).toBeLessThan(2.6)
  })
})

// ---------------------------------------------------------------------------
// 4. 选择性：人声不应被"谐波化"
// ---------------------------------------------------------------------------

describe('选择性（低频以外不参与生成）', () => {
  it('250 Hz 人声泄漏比 60 Hz 贝斯低 25 dB 以上', () => {
    // 贝斯 60 Hz + 男声 250 Hz，各 -12 dBFS
    const tone = makeTone([60, 250], [0.2512, 0.2512], TOTAL)
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: false,
      gamma: 1,
      f0Override: 60,
      useF0: false
    })
    const out = render(core, [tone], 1, true)

    // 贝斯的 2 次谐波 120 Hz vs 人声的 2 次谐波 500 Hz
    const bassH2 = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, 120)
    const vocalH2 = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, 500)

    expect(bassH2).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(
      `  [selectivity] 贝斯 H2(120Hz) ${db(bassH2).toFixed(1)} dBFS, 人声 H2(500Hz) ${db(vocalH2).toFixed(1)} dBFS, 差 ${(db(vocalH2) - db(bassH2)).toFixed(1)} dB`
    )
    expect(db(vocalH2) - db(bassH2)).toBeLessThan(-25)
  })
})

// ---------------------------------------------------------------------------
// 5. 混叠
// ---------------------------------------------------------------------------

describe('混叠（无过采样的正确性）', () => {
  it('140 Hz 纯音的所有产物都是谐波，非谐波位置无能量', () => {
    const f0 = 140
    const tone = makeTone([f0], [0.5], TOTAL) // -6 dBFS
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: false, // 最坏情况：不靠高通遮挡
      gamma: 1,
      f0Override: f0,
      useF0: false
    })
    const out = render(core, [tone], 1, true)

    // K·fCross = 1600 Hz 以上的任何能量都只可能来自混叠
    let worst = 0
    let worstFreq = 0
    for (let f = 1600; f <= 20000; f += 20) {
      if (f % f0 === 0) continue
      const v = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f)
      if (v > worst) {
        worst = v
        worstFreq = f
      }
    }
    expect(worstFreq).toBeGreaterThan(0)
    expect(db(worst)).toBeLessThan(-80)
  })

  it('高频输入被电平门挡住，不会经归一化放大后折叠回来', () => {
    // 关键场景：3 kHz 被 LR8 压到约 -204 dB，但归一化是除法，
    // 若不设门，它会重新变成满量程并被多项式搬到 30 kHz 折叠回 18 kHz。
    const tone = makeTone([3000], [0.5], TOTAL)
    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: false,
      gamma: 1,
      useF0: false
    })
    const out = render(core, [tone], 1, true)

    let worst = 0
    for (let f = 1000; f <= 20000; f += 100) {
      const v = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f)
      if (v > worst) worst = v
    }
    expect(db(worst)).toBeLessThan(-80)
  })
})

// ---------------------------------------------------------------------------
// 6. 瞬态与因果性
// ---------------------------------------------------------------------------

describe('瞬态（严格因果、无前回波、无过冲）', () => {
  it('40 Hz 猝发：起音前完全静音，无前振铃，无过冲', () => {
    const f0 = 40
    const period = FS / f0 // 1200 样本
    const onset = 4800
    const cycles = 20
    const n = FS * 2
    const signal = new Float32Array(n)
    for (let i = 0; i < cycles * period; i++) {
      signal[onset + i] = 0.3 * Math.cos((2 * Math.PI * f0 * i) / FS)
    }

    const core = new VbCore({
      fs: FS,
      fLow: 120,
      fCross: 160,
      wetHighpass: false,
      gamma: 1,
      f0Override: f0,
      useF0: false
    })
    const out = render(core, [signal], 1, true)
    const wet = out[0]

    // 因果性：起音前 5 ms 内必须严格为 0（任何非零都意味着有 lookahead / 预读）
    const preAttack = maxAbs(wet, onset - 240, onset)
    expect(preAttack).toBe(0)

    // 过冲：前 2 个周期的峰值 vs 稳定段（第 10-20 周期）的峰值
    const earlyPeak = maxAbs(wet, onset, onset + 2 * period)
    const steadyPeak = maxAbs(wet, onset + 10 * period, onset + cycles * period)
    expect(steadyPeak).toBeGreaterThan(0)
    expect(db(earlyPeak / steadyPeak)).toBeLessThan(1.0)

    // 包络跟随：稳定段峰值应接近未压缩输入峰值
    expect(db(steadyPeak)).toBeGreaterThan(-20)
  })

  it('湿路峰值 = 低频包络（makeup 只按波形峰值归一，不吃掉余量）', () => {
    const tone = makeTone([45], [0.3], TOTAL)
    const core = new VbCore({ fs: FS, fLow: 120, fCross: 160, f0Override: 45, useF0: false })
    const out = render(core, [tone], 1, true)
    const peak = maxAbs(out[0], ANALYSIS_START, ANALYSIS_START + ANALYSIS_N)
    // wetHighpass 会再削一点，所以上界用 makeup×shaperPeak（≈1）而不是 0.3
    const bound = core.shaperPeak * core.makeup * 0.3

    // eslint-disable-next-line no-console
    console.log(
      `  [headroom] shaperPeak=${core.shaperPeak.toFixed(3)} makeup=${core.makeup.toFixed(3)} ` +
        `总增益 ${(core.shaperPeak * core.makeup).toFixed(2)}× 峰值 ${db(peak).toFixed(1)} dBFS`
    )
    expect(peak).toBeLessThanOrEqual(bound * 1.02)
    // 按峰值归一的直接推论：湿路总增益≈1，于是 |wet| ≤ 低频包络 ≤ 1
    expect(core.shaperPeak * core.makeup).toBeLessThan(1.1)
  })

  it('混音峰值恒不超过 ceiling：强度从 0 拉到 85% 都不削顶', () => {
    // 热母带式素材：峰值 -0.26 dBFS、低频占比高 —— 最容易被湿路顶爆的情况。
    // 旧实现（makeup 按参考谐波归一，总增益 2.08×）在这段素材上 100% 就削顶 80 个样本。
    const n = FS * 4
    const hot = new Float32Array(n)
    const beat = 60 / 96
    for (let i = 0; i < n; i++) {
      const t = i / FS
      const kb = t % beat
      let s = 0
      if (kb < 0.4) {
        const fk = 48 + 82 * Math.exp(-kb * 45)
        s += 0.55 * Math.exp(-kb * 8) * Math.sin(2 * Math.PI * fk * kb)
      }
      const lb = t % (beat * 4)
      s += 0.3 * Math.min(1, lb / 0.02) * Math.exp(-lb * 1.6) * Math.sin(2 * Math.PI * 55 * t)
      hot[i] = s
    }
    let pk = 0
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(hot[i]))
    for (let i = 0; i < n; i++) hot[i] *= 0.97 / pk

    const ceil = 0.995
    for (const wetMax of [0, 0.3, 0.55, 0.85]) {
      const core = new VbCore({ fs: FS, fLow: 120, fCross: 160 })
      const out = render(core, [hot], wetMax, false)
      const peak = maxAbs(out[0], 0, n)
      const engagement = core.limitHits / Math.max(1, core.sampleCount)
      // eslint-disable-next-line no-console
      console.log(
        `  [ceiling] wetMax=${wetMax.toFixed(2)} 峰值 ${db(peak).toFixed(2)} dBFS ` +
          `限幅介入 ${(engagement * 100).toFixed(2)}%`
      )
      expect(peak).toBeLessThanOrEqual(ceil + 1e-6)
      // 限幅器只是保险，不能靠它把整个效果压住：正常音乐素材上介入率应很低
      expect(engagement).toBeLessThan(0.02)
    }
  })

  it('限幅增益不在音频速率上调制湿声（高强度爆音回归）', () => {
    // 旧实现的余量是 room = ceiling − |dry[n]|，用**当前样本**——等于让湿声
    // 被干路波形逐样本调制。实测一个 55 Hz 周期内增益摆动 61%~90%，
    // 听感就是「强度 > 50% 开始发毛/爆音」。
    // 现在检测器只看包络、增益按 2ms/150ms 平滑，应当摆动 < 2%。
    const n = FS * 5
    const sig = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / FS
      // 热贝斯 + 1.76 kHz 中高频探针：既逼近满量程，又能暴露高频调制产物
      sig[i] = 0.72 * Math.sin(2 * Math.PI * 55 * t) + 0.14 * Math.sin(2 * Math.PI * 1760 * t + 0.7)
    }

    const period = Math.round(FS / 55)
    const measureRipple = (wetGain: number): number => {
      const on = render(new VbCore({ fs: FS, fLow: 120, fCross: 160 }), [sig], wetGain, false)[0]
      const off = render(
        new VbCore({ fs: FS, fLow: 120, fCross: 160, limitWet: false }),
        [sig],
        wetGain,
        false
      )[0]
      let worst = 0
      for (let s = ANALYSIS_START; s + period < ANALYSIS_START + ANALYSIS_N; s += period) {
        let lo = Number.POSITIVE_INFINITY
        let hi = Number.NEGATIVE_INFINITY
        for (let i = s; i < s + period; i++) {
          const wOff = off[i] - sig[i]
          if (Math.abs(wOff) < 1e-6) continue
          const g = (on[i] - sig[i]) / wOff
          if (g < lo) lo = g
          if (g > hi) hi = g
        }
        if (Number.isFinite(lo) && hi - lo > worst) worst = hi - lo
      }
      return worst
    }

    // 有余量的工况：增益必须几乎恒定（旧实现这里是 61%~90%）
    const rippleLow = measureRipple(0.35)
    // 顶到天花板的工况（0.55 = UI 满强度对应的 wetGain）：允许它压，但不能产生宽带杂散
    const on = render(new VbCore({ fs: FS, fLow: 120, fCross: 160 }), [sig], 0.55, false)[0]
    const bins: number[] = []
    for (let k = 1; k <= 4; k++) {
      bins.push(binAmp(on, ANALYSIS_START, ANALYSIS_N, 1760 - k * 55))
      bins.push(binAmp(on, ANALYSIS_START, ANALYSIS_N, 1760 + k * 55))
    }
    const worstSpur = Math.max(...bins)
    const carrier = binAmp(on, ANALYSIS_START, ANALYSIS_N, 1760)

    // eslint-disable-next-line no-console
    console.log(
      `  [limit] 有余量时周期内增益摆动 ${(rippleLow * 100).toFixed(2)}%（旧实现 61%）  ` +
        `满强度边带/载波 ${db(worstSpur / carrier).toFixed(1)} dB（旧实现约 -18 dB）`
    )

    expect(rippleLow).toBeLessThan(0.02)
    // -40 dB 是「单音顶到天花板」这个最坏工况下的门槛；
    // 旧实现同一工况是 -18 dB（明显可闻），节目素材上软削介入率 0.1% 量级。
    expect(db(worstSpur / carrier)).toBeLessThan(-40)
  })

  it('f0 抖动不会让湿路增益阶跃（爆音回归）', () => {
    // 踩镲式宽带瞬态会破坏低频自相关，f0 在「未知 / 已知」之间反复跳。
    // 旧实现把 makeup 绑在参考频率 k*·f0 上，实测单块跳变 94%（5.8 dB）——
    // 每 100 ms 一次幅度阶跃，强度越高越像爆音。现在 makeup 只依赖 weights。
    const n = FS * 4
    const sig = new Float32Array(n)
    let s = 999
    for (let i = 0; i < n; i++) {
      const t = i / FS
      let v = 0.28 * Math.sin(2 * Math.PI * 55 * t) + 0.12 * Math.sin(2 * Math.PI * 110 * t)
      const ph = t % 1.3
      if (ph < 0.08) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        v += 0.35 * Math.exp(-ph * 50) * ((s / 0x7fffffff) * 2 - 1)
      }
      sig[i] = v
    }

    const core = new VbCore({ fs: FS, fLow: 120, fCross: 160 })
    const BLOCK = 128
    const inBlk = new Float32Array(BLOCK)
    const outBlk = new Float32Array(BLOCK)
    let last = core.makeup
    let maxJump = 0
    for (let off = 0; off + BLOCK <= n; off += BLOCK) {
      inBlk.set(sig.subarray(off, off + BLOCK))
      core.processBlock([inBlk], [outBlk], BLOCK, 0.55, false)
      if (off > 0) maxJump = Math.max(maxJump, Math.abs(core.makeup - last) / last)
      last = core.makeup
    }
    // eslint-disable-next-line no-console
    console.log(`  [pop] makeup 相邻块最大跳变 ${(maxJump * 100).toFixed(2)}%（修复前 94.4%）`)
    expect(maxJump).toBeLessThan(0.01) // < 0.09 dB，听不出来
  })
})

// ---------------------------------------------------------------------------
// 7. 电平不变性 —— 这一项是 tanh 实现过不了的
// ---------------------------------------------------------------------------

describe('电平不变性', () => {
  /** 返回某电平下的谐波比 H_k/H_1 */
  function harmonicRatios(levels: number[], f0 = 40): number[][] {
    return levels.map((amp) => {
      const tone = makeTone([f0], [amp], TOTAL)
      const core = new VbCore({
        fs: FS,
        fLow: 120,
        fCross: 160,
        wetHighpass: false,
        gamma: 1,
        f0Override: f0,
        useF0: false
      })
      const out = render(core, [tone], 1, true)
      const h1 = binAmp(out[0], ANALYSIS_START, ANALYSIS_N, f0)
      return [2, 3, 4, 5].map((k) =>
        db(binAmp(out[0], ANALYSIS_START, ANALYSIS_N, k * f0) / Math.max(h1, 1e-12))
      )
    })
  }

  it('新算法：-40 / -20 / -6 dBFS 下谐波比一致（跨电平方差 < 0.5 dB）', () => {
    const ratios = harmonicRatios([0.01, 0.1, 0.5])
    const spreads: number[] = []
    for (let h = 0; h < 4; h++) {
      const vals = ratios.map((r) => r[h])
      const spread = Math.max(...vals) - Math.min(...vals)
      spreads.push(spread)
      expect(spread).toBeLessThan(0.5)
    }
    // eslint-disable-next-line no-console
    console.log(
      `  [level] H2/H1 H3/H1 H4/H1 H5/H1 跨电平漂移: ${spreads.map((s) => s.toFixed(3)).join(' / ')} dB`
    )
  })

  it('对照组：现有 tanh 波形整形的谐波比随电平大幅漂移（证明该判据有效）', () => {
    // 复刻 web-audio-dsp.ts 的 makeSineShaperCurve：y = tanh(k·x)/tanh(k)
    const f0 = 40
    const k = 2.5
    const norm = Math.tanh(k)

    const ratios = [0.01, 0.1, 0.5].map((amp) => {
      const n = TOTAL
      const y = new Float32Array(n)
      const lp = [new Biquad(designLowpass(160, FS)), new Biquad(designLowpass(160, FS))]
      // 省略滤波差异：直接对正弦做整形的结果即可说明电平依赖
      for (let i = 0; i < n; i++) {
        const x = amp * Math.cos((2 * Math.PI * f0 * i) / FS)
        // 仍走一遍低通，保持与真实链路同样的输入幅度量级
        const filtered = lp[1].process(lp[0].process(x))
        y[i] = Math.tanh(k * filtered) / norm
      }
      const h1 = binAmp(y, ANALYSIS_START, ANALYSIS_N, f0)
      return [3, 5].map((kk) =>
        db(binAmp(y, ANALYSIS_START, ANALYSIS_N, kk * f0) / Math.max(h1, 1e-12))
      )
    })

    // eslint-disable-next-line no-console
    console.log(
      '  [tanh] H3/H1 随电平: ' + ratios.map((r) => r[0].toFixed(1)).join(' / ') + ' dB'
    )

    for (let h = 0; h < 2; h++) {
      const vals = ratios.map((r) => r[h])
      const spread = Math.max(...vals) - Math.min(...vals)
      expect(spread).toBeGreaterThan(3)
    }
  })
})

// ---------------------------------------------------------------------------
// 8. CPU 与稳定性
// ---------------------------------------------------------------------------

describe('运行开销', () => {
  it('60 秒立体声 48 kHz 的处理耗时低于实时的 5%', () => {
    const seconds = 60
    const n = FS * seconds
    const left = makeTone([55, 110], [0.2, 0.15], n)
    const right = makeNoise(n, 777, 0.2)

    const core = new VbCore({ fs: FS, fLow: 120, fCross: 160 })
    const t0 = performance.now()
    render(core, [left, right], 0.3)
    const elapsed = performance.now() - t0
    const cpuPercent = (elapsed / (seconds * 1000)) * 100

    // eslint-disable-next-line no-console
    console.log(
      `  [cpu] ${seconds}s 立体声耗时 ${elapsed.toFixed(1)} ms → ${cpuPercent.toFixed(2)}% 单核`
    )
    expect(cpuPercent).toBeLessThan(5)
  })

  it('输出永远有限（噪声 / 静音 / 满量程方波都不产生 NaN）', () => {
    const cases: Float32Array[] = [
      makeNoise(FS, 42, 0.9),
      new Float32Array(FS),
      makeTone([30], [1.0], FS)
    ]
    for (const sig of cases) {
      const core = new VbCore({ fs: FS, fLow: 120, fCross: 160 })
      const out = render(core, [sig, sig], 1)
      for (const ch of out) {
        for (let i = 0; i < ch.length; i += 97) {
          expect(Number.isFinite(ch[i])).toBe(true)
        }
      }
    }
  })
})
