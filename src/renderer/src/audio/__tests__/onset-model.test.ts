/**
 * onset-model.ts 起始点检测模型的单元测试
 *
 * 覆盖：
 * - FFT 幅度谱（bin 中心正弦的幅度正确性）
 * - 梅尔滤波器组/特征提取（静音 → 全零；单音 → 能量落入预期低频带）
 * - 模型输入组装布局 [prev(16), curr(16)]
 * - 参考推理（内嵌权重）与手工设计权重的手算结果一致
 * - 融合逻辑（增强式：模型只补充、不否决 DSP）
 * - OnsetModel 封装（onnxruntime 路径 / 降级参考实现路径）
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OnsetModel,
  buildModelInput,
  computeMagnitudeSpectrum,
  extractFrameFeatures,
  fuseOnset,
  getMelFilterbank,
  referenceOnsetProbability,
  MEL_BAND_COUNT,
  MODEL_DELTA_THRESHOLD,
  MODEL_HIT_THRESHOLD
} from '../onset-model'

const SAMPLE_RATE = 44100
const FRAME_SIZE = 256

/** 构造 bin 中心正弦帧（bin k 的频率 = k * sampleRate / frameSize） */
function makeToneFrame(bin: number, amplitude: number, frameSize = FRAME_SIZE): Float32Array {
  const frame = new Float32Array(frameSize)
  const freq = (bin * SAMPLE_RATE) / frameSize
  for (let i = 0; i < frameSize; i++) {
    frame[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amplitude
  }
  return frame
}

/** 构造多个 bin 中心正弦叠加帧（用于宽带起始点） */
function makeMultiToneFrame(
  bins: number[],
  amplitude: number,
  frameSize = FRAME_SIZE
): Float32Array {
  const frame = new Float32Array(frameSize)
  for (const bin of bins) {
    const freq = (bin * SAMPLE_RATE) / frameSize
    for (let i = 0; i < frameSize; i++) {
      frame[i] += Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amplitude
    }
  }
  return frame
}

/** 按 [prev(16), curr(16)] 布局组装模型输入 */
function makeInput(prev: number[], curr: number[]): Float32Array {
  const input = new Float32Array(MEL_BAND_COUNT * 2)
  prev.forEach((v, i) => (input[i] = v))
  curr.forEach((v, i) => (input[MEL_BAND_COUNT + i] = v))
  return input
}

describe('computeMagnitudeSpectrum（FFT 幅度谱）', () => {
  it('静音帧幅度谱全为 0', () => {
    const mag = computeMagnitudeSpectrum(new Float32Array(FRAME_SIZE))
    for (const v of mag) expect(v).toBe(0)
  })

  it('bin 中心正弦的峰值幅度约为 A*N/2，且能量集中在对应 bin', () => {
    const bin = 4
    const amplitude = 0.5
    const mag = computeMagnitudeSpectrum(makeToneFrame(bin, amplitude))
    // 256 点 FFT：峰值幅度 ≈ A * N/2 = 64
    expect(mag[bin]).toBeCloseTo((amplitude * FRAME_SIZE) / 2, 0)
    // 其余 bin 幅度远小于峰值
    let sideEnergy = 0
    for (let k = 0; k < mag.length; k++) {
      if (k !== bin) sideEnergy += mag[k]
    }
    expect(sideEnergy).toBeLessThan(mag[bin] * 0.01)
  })
})

describe('getMelFilterbank / extractFrameFeatures（梅尔特征提取）', () => {
  it('滤波器组尺寸为 16 × 129，且每行归一化到最大值 1', () => {
    const fb = getMelFilterbank(SAMPLE_RATE)
    expect(fb.length).toBe(MEL_BAND_COUNT * (FRAME_SIZE / 2 + 1))
    for (let b = 0; b < MEL_BAND_COUNT; b++) {
      let max = 0
      for (let k = 0; k < FRAME_SIZE / 2 + 1; k++) {
        expect(fb[b * (FRAME_SIZE / 2 + 1) + k]).toBeGreaterThanOrEqual(0)
        max = Math.max(max, fb[b * (FRAME_SIZE / 2 + 1) + k])
      }
      expect(max).toBeCloseTo(1, 5)
    }
  })

  it('静音帧特征全为 0', () => {
    const features = extractFrameFeatures(new Float32Array(FRAME_SIZE), SAMPLE_RATE)
    expect(features.length).toBe(MEL_BAND_COUNT)
    for (const v of features) expect(v).toBe(0)
  })

  it('低频单音的能量落在低频梅尔频带，且取值有界', () => {
    const features = extractFrameFeatures(makeToneFrame(4, 0.5), SAMPLE_RATE)
    for (const v of features) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    const argmax = [...features].indexOf(Math.max(...features))
    expect(argmax).toBeGreaterThan(0)
    expect(argmax).toBeLessThanOrEqual(5) // bin 4 ≈ 689Hz，位于低频半区
    expect(features[argmax]).toBeGreaterThan(0.05)
  })
})

describe('buildModelInput（模型输入布局）', () => {
  it('输出为 [上一帧(16), 当前帧(16)]', () => {
    const prev = new Float32Array(MEL_BAND_COUNT).fill(0.1)
    const curr = new Float32Array(MEL_BAND_COUNT).fill(0.2)
    const input = buildModelInput(prev, curr)
    expect(input.length).toBe(MEL_BAND_COUNT * 2)
    for (let i = 0; i < MEL_BAND_COUNT; i++) {
      expect(input[i]).toBeCloseTo(0.1, 6)
      expect(input[MEL_BAND_COUNT + i]).toBeCloseTo(0.2, 6)
    }
  })
})

describe('referenceOnsetProbability（参考推理，权重设计的手算校验）', () => {
  const steady = new Array(MEL_BAND_COUNT).fill(0.5)

  it('稳态（prev === curr）概率约为 sigmoid(-1) ≈ 0.269', () => {
    const p = referenceOnsetProbability(makeInput(steady, steady))
    expect(p).toBeCloseTo(1 / (1 + Math.exp(1)), 4)
    expect(p).toBeLessThan(MODEL_HIT_THRESHOLD)
  })

  it('16 频带同时跃变 0.5（强起始点）概率约为 sigmoid(3) ≈ 0.953', () => {
    const quiet = new Array(MEL_BAND_COUNT).fill(0)
    const loud = new Array(MEL_BAND_COUNT).fill(0.5)
    const p = referenceOnsetProbability(makeInput(quiet, loud))
    expect(p).toBeCloseTo(1 / (1 + Math.exp(-3)), 4)
    expect(p).toBeGreaterThan(MODEL_HIT_THRESHOLD)
  })

  it('8 频带跃变 0.5 概率约为 sigmoid(1) ≈ 0.731', () => {
    const prev = new Array(MEL_BAND_COUNT).fill(0)
    const curr = new Array(MEL_BAND_COUNT).fill(0.5)
    curr.forEach((_, i) => (curr[i] = i < 8 ? 0.5 : 0))
    const p = referenceOnsetProbability(makeInput(prev, curr))
    expect(p).toBeCloseTo(1 / (1 + Math.exp(-1)), 4)
  })

  it('缓变（8 频带跃变 0.3）概率约为 sigmoid(-0.6) ≈ 0.354，低于命中阈值', () => {
    const prev = new Array(MEL_BAND_COUNT).fill(0)
    const curr = new Array(MEL_BAND_COUNT).fill(0.3)
    curr.forEach((_, i) => (curr[i] = i < 8 ? 0.3 : 0))
    const p = referenceOnsetProbability(makeInput(prev, curr))
    expect(p).toBeCloseTo(1 / (1 + Math.exp(0.6)), 4)
    expect(p).toBeLessThan(MODEL_HIT_THRESHOLD)
  })

  it('单频带跃变不足以触发（窄带能量变化不视为起始点）', () => {
    const prev = new Array(MEL_BAND_COUNT).fill(0)
    const curr = new Array(MEL_BAND_COUNT).fill(0)
    curr[0] = 0.5
    const p = referenceOnsetProbability(makeInput(prev, curr))
    expect(p).toBeLessThan(MODEL_HIT_THRESHOLD)
  })
})

describe('fuseOnset（与 DSP 检测融合）', () => {
  it('模型不可用时退化为纯 DSP 结果', () => {
    expect(fuseOnset(true, null, null)).toBe(true)
    expect(fuseOnset(false, null, null)).toBe(false)
  })

  it('模型上升沿命中（概率高且显著上升）时判定为起始点', () => {
    expect(fuseOnset(false, 0.95, 0.27)).toBe(true)
    expect(
      fuseOnset(false, MODEL_HIT_THRESHOLD, MODEL_HIT_THRESHOLD - MODEL_DELTA_THRESHOLD - 0.01)
    ).toBe(true)
  })

  it('稳态高概率（无上升沿）不误报', () => {
    expect(fuseOnset(false, 0.95, 0.95)).toBe(false)
    expect(fuseOnset(false, 0.95, 0.9)).toBe(false)
  })

  it('模型不否决 DSP 起始点（增强式融合）', () => {
    expect(fuseOnset(true, 0.3, 0.27)).toBe(true)
  })

  it('无 DSP 且模型概率未达阈值时不判定', () => {
    expect(fuseOnset(false, 0.3, 0.27)).toBe(false)
    expect(fuseOnset(false, 0.5, 0.27)).toBe(false)
  })
})

describe('端到端管线（静音 → 宽带起始点）', () => {
  it('静音 → 多频带强起始点，模型概率超过命中阈值', () => {
    const quiet = new Float32Array(FRAME_SIZE)
    const loud = makeMultiToneFrame([4, 8, 16, 32, 64, 96, 120], 0.9)
    const prevFeatures = extractFrameFeatures(quiet, SAMPLE_RATE)
    const currFeatures = extractFrameFeatures(loud, SAMPLE_RATE)
    const prob = referenceOnsetProbability(buildModelInput(prevFeatures, currFeatures))
    expect(prob).toBeGreaterThan(MODEL_HIT_THRESHOLD)
    expect(fuseOnset(false, prob, 0.27)).toBe(true)
  })

  it('连续两帧相同内容（稳态）概率低于命中阈值', () => {
    const loud = makeMultiToneFrame([4, 8, 16, 32, 64, 96, 120], 0.9)
    const f1 = extractFrameFeatures(loud, SAMPLE_RATE)
    const f2 = extractFrameFeatures(loud, SAMPLE_RATE)
    const prob = referenceOnsetProbability(buildModelInput(f1, f2))
    expect(prob).toBeLessThan(MODEL_HIT_THRESHOLD)
  })
})

describe('OnsetModel（推理封装）', () => {
  it('未初始化时 predict 走内置参考实现', async () => {
    const model = new OnsetModel()
    const input = makeInput(new Array(MEL_BAND_COUNT).fill(0), new Array(MEL_BAND_COUNT).fill(0.5))
    expect(await model.predict(input)).toBeCloseTo(referenceOnsetProbability(input), 6)
  })

  it('init 总是返回布尔值（初始化失败不影响功能）', async () => {
    const model = new OnsetModel()
    const ok = await model.init()
    expect(typeof ok).toBe('boolean')
  })

  it('onnxruntime 会话就绪时 predict 返回会话输出', async () => {
    const model = new OnsetModel()
    // 白盒注入假会话，验证 ort 路径
    const fakeSession = {
      run: async () => ({ onset_prob: { data: new Float32Array([0.42]) } })
    }
    ;(model as unknown as { session: unknown }).session = fakeSession
    ;(model as unknown as { ort: unknown }).ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[]
        ) {}
      }
    }
    expect(await model.predict(new Float32Array(MEL_BAND_COUNT * 2))).toBeCloseTo(0.42, 6)
  })

  it('会话推理失败后降级参考实现，且不再重试会话', async () => {
    const model = new OnsetModel()
    const input = makeInput(new Array(MEL_BAND_COUNT).fill(0), new Array(MEL_BAND_COUNT).fill(0.5))
    const failingSession = { run: async () => Promise.reject(new Error('boom')) }
    ;(model as unknown as { session: unknown }).session = failingSession
    ;(model as unknown as { ort: unknown }).ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[]
        ) {}
      }
    }
    expect(await model.predict(input)).toBeCloseTo(referenceOnsetProbability(input), 6)
    // 会话已被关闭，第二次 predict 直接走参考实现
    expect(await model.predict(input)).toBeCloseTo(referenceOnsetProbability(input), 6)
  })

  // 端到端模型校验：onnxruntime 真实会话输出须与内置参考实现一致
  // （读取本地 node_modules 的 wasm，避免网络依赖；缺失时整组跳过）
  const localWasmPath = join(
    process.cwd(),
    'node_modules',
    'onnxruntime-web',
    'dist',
    'ort-wasm-simd-threaded.wasm'
  )
  describe.skipIf(!existsSync(localWasmPath))('端到端（onnxruntime 真实推理）', () => {
    it('会话推理输出与参考实现一致（覆盖稳态/强起始点/缓变）', async () => {
      const wasmBinary = new Uint8Array(readFileSync(localWasmPath))
      const model = new OnsetModel({ wasmBinaryProvider: async () => wasmBinary })
      expect(await model.init()).toBe(true)

      const steady = new Array(MEL_BAND_COUNT).fill(0.5)
      const prev = new Array(MEL_BAND_COUNT).fill(0)
      const slowCurr = new Array(MEL_BAND_COUNT).fill(0)
      slowCurr.forEach((_, i) => (slowCurr[i] = i < 8 ? 0.3 : 0))
      const cases = [
        makeInput(steady, steady),
        makeInput(prev, new Array(MEL_BAND_COUNT).fill(0.5)),
        makeInput(prev, slowCurr)
      ]
      for (const input of cases) {
        const fromSession = await model.predict(input)
        expect(fromSession).toBeCloseTo(referenceOnsetProbability(input), 4)
      }
    })
  })
})
