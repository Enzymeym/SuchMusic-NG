/**
 * 起始点检测模型（梅尔谱特征 + 小型 MLP + 与 DSP 检测融合）
 *
 * 数据流（与 transition-dsp.ts 的 RMS 检测并行）：
 *   时域帧 (256) → FFT 幅度谱 (129) → 梅尔滤波器组 (16 频带) → 归一化特征
 *   → [上一帧特征(16), 当前帧特征(16)] → MLP → 起始点概率
 *
 * 推理后端：
 * - 主后端 onnxruntime-web（WASM）。wasm 二进制由宿主环境注入
 *   （Electron 主进程 IPC；见 src/main/ipc/analyzer.ts 与 getHostWasmBinary）。
 * - 内置参考实现（referenceOnsetProbability）作为无条件兜底：
 *   使用与 ONNX 图完全一致的 Gemm+Relu+Sigmoid 数学，权重内嵌在
 *   onset-model-data.ts。即使 onnxruntime 无法初始化，模型依然可用。
 *
 * 融合逻辑（fuseOnset）：
 * - 模型"概率上升沿"（概率高且较上一帧显著上升）→ 直接判为起始点
 * - DSP 起始点被模型低概率否决（< MODEL_GATE_LOW）→ 抑制（模型门控）
 *
 * 本模块为纯 TS（无 DOM/Node API），可在 Web Worker、主线程与单元测试中运行。
 */

import {
  ONSET_MODEL_BASE64,
  ONSET_MODEL_B1,
  ONSET_MODEL_B2,
  ONSET_MODEL_HIDDEN_SIZE,
  ONSET_MODEL_INPUT_NAME,
  ONSET_MODEL_INPUT_SIZE,
  ONSET_MODEL_OUTPUT_NAME,
  ONSET_MODEL_W1,
  ONSET_MODEL_W2
} from './model/onset-model-data'

// ====== 特征提取常量（与生成脚本的模型输入布局保持一致） ======

/** 分析帧大小（与 web-audio-engine.ts 的 AnalyserNode fftSize 一致） */
export const FEATURE_FFT_SIZE = 256
/** 梅尔频带数（模型输入 = 2 × 频带数：上一帧 + 当前帧） */
export const MEL_BAND_COUNT = 16
/** 梅尔滤波器组最低频率（Hz，避免低频巨三角滤波器） */
export const MEL_FMIN_HZ = 30
/**
 * 幅度谱归一化基数：满幅正弦（幅度 1.0）在 256 点 FFT 峰值 bin 的幅度为
 * N/2 = 128，故 MAG_NORM = 128 时满幅信号的频带特征约为 1.0。
 * 模型 THRESH = 0.25 即"满幅的四分之一"量级的显著跃变。
 */
export const MAG_NORM = FEATURE_FFT_SIZE / 2

// ====== 融合阈值（与生成脚本的手工权重设计配套） ======

/** 模型概率视为"命中"的高阈值 */
export const MODEL_HIT_THRESHOLD = 0.6
/** 命中时相对上一帧的最小上升量（抑制稳态高概率误报） */
export const MODEL_DELTA_THRESHOLD = 0.25

// ====== FFT 幅度谱 ======

/**
 * 计算时域帧的幅度谱（迭代基 2 FFT，无窗口）
 * @param frame 长度须为 2 的幂（实际为 256）
 * @returns 幅度谱 [frame.length/2 + 1]
 */
export function computeMagnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  re.set(frame)

  // 位反转重排
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const t = re[i]
      re[i] = re[j]
      re[j] = t
    }
  }

  // 蝶形运算
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + half] = aRe - bRe
        im[i + k + half] = aIm - bIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }

  const mag = new Float32Array(n / 2 + 1)
  for (let k = 0; k <= n / 2; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
  }
  return mag
}

// ====== 梅尔滤波器组 ======

/** 频率转梅尔刻度 */
function hzToMel(freqHz: number): number {
  return 2595 * Math.log10(1 + freqHz / 700)
}

/** 梅尔刻度转频率 */
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/** 梅尔滤波器组缓存（按采样率） */
const melFilterbankCache = new Map<number, Float32Array>()

/**
 * 构建梅尔滤波器组 [MEL_BAND_COUNT × (FEATURE_FFT_SIZE/2+1)]
 * 三角滤波器在梅尔刻度上等间距，每行归一化到最大值为 1
 * （使"满幅正弦落在频带中心"时该频带特征约为 1.0）。
 */
export function getMelFilterbank(sampleRate: number): Float32Array {
  const cached = melFilterbankCache.get(sampleRate)
  if (cached) return cached

  const bins = FEATURE_FFT_SIZE / 2 + 1
  const maxFreq = sampleRate / 2
  const melMin = hzToMel(MEL_FMIN_HZ)
  const melMax = hzToMel(maxFreq)

  // 18 个梅尔刻度等距点：fmin, c0..c15, fmax
  const totalPoints = MEL_BAND_COUNT + 2
  const melPoints = new Array<number>(totalPoints)
  for (let i = 0; i < totalPoints; i++) {
    melPoints[i] = melMin + ((melMax - melMin) * i) / (totalPoints - 1)
  }

  const weights = new Float32Array(MEL_BAND_COUNT * bins)
  for (let b = 0; b < MEL_BAND_COUNT; b++) {
    const leftHz = melToHz(melPoints[b])
    const centerHz = melToHz(melPoints[b + 1])
    const rightHz = melToHz(melPoints[b + 2])
    let max = 0
    for (let k = 0; k < bins; k++) {
      const freq = (k * sampleRate) / FEATURE_FFT_SIZE
      let w = 0
      if (freq >= leftHz && freq <= rightHz) {
        if (freq <= centerHz) {
          w = (freq - leftHz) / Math.max(centerHz - leftHz, 1e-6)
        } else {
          w = (rightHz - freq) / Math.max(rightHz - centerHz, 1e-6)
        }
      }
      weights[b * bins + k] = w
      if (w > max) max = w
    }
    // 行归一化到最大值 1
    if (max > 0) {
      for (let k = 0; k < bins; k++) {
        weights[b * bins + k] /= max
      }
    }
  }

  melFilterbankCache.set(sampleRate, weights)
  return weights
}

// ====== 特征提取 ======

/**
 * 提取单帧的梅尔幅度特征（16 维）
 * @param frame 时域帧（AnalyserNode getFloatTimeDomainData 的快照）
 * @param sampleRate 采样率（决定梅尔滤波器组的频率范围）
 * @returns 归一化梅尔特征 [MEL_BAND_COUNT]
 */
export function extractFrameFeatures(frame: Float32Array, sampleRate: number): Float32Array {
  const bins = FEATURE_FFT_SIZE / 2 + 1
  const magnitude = computeMagnitudeSpectrum(frame)
  const filterbank = getMelFilterbank(sampleRate)
  const features = new Float32Array(MEL_BAND_COUNT)
  for (let b = 0; b < MEL_BAND_COUNT; b++) {
    let sum = 0
    const offset = b * bins
    for (let k = 0; k < bins; k++) {
      sum += filterbank[offset + k] * magnitude[k]
    }
    features[b] = Math.min(1, sum / MAG_NORM)
  }
  return features
}

/**
 * 组装模型输入：[上一帧特征(16), 当前帧特征(16)]
 * 布局与生成脚本的 W1 权重（prev 位置 -1、curr 位置 +1）严格对应。
 */
export function buildModelInput(prevFeatures: Float32Array, currFeatures: Float32Array): Float32Array {
  const input = new Float32Array(ONSET_MODEL_INPUT_SIZE)
  input.set(prevFeatures.subarray(0, MEL_BAND_COUNT))
  input.set(currFeatures.subarray(0, MEL_BAND_COUNT), MEL_BAND_COUNT)
  return input
}

// ====== 参考实现（与 ONNX 图数学一致，无条件兜底） ======

/**
 * 使用内嵌权重执行与 ONNX 图一致的推理：
 * features → Gemm(W1,B1,transB=1) → Relu → Gemm(W2,B2,transB=1) → Sigmoid
 * @param input 模型输入 [ONSET_MODEL_INPUT_SIZE]
 * @returns 起始点概率 (0~1)
 */
export function referenceOnsetProbability(input: Float32Array | number[]): number {
  const hidden = new Array<number>(ONSET_MODEL_HIDDEN_SIZE)
  for (let i = 0; i < ONSET_MODEL_HIDDEN_SIZE; i++) {
    let sum = ONSET_MODEL_B1[i]
    const base = i * ONSET_MODEL_INPUT_SIZE
    for (let j = 0; j < ONSET_MODEL_INPUT_SIZE; j++) {
      sum += ONSET_MODEL_W1[base + j] * input[j]
    }
    hidden[i] = sum > 0 ? sum : 0
  }
  let score = ONSET_MODEL_B2[0]
  for (let i = 0; i < ONSET_MODEL_HIDDEN_SIZE; i++) {
    score += ONSET_MODEL_W2[i] * hidden[i]
  }
  return 1 / (1 + Math.exp(-score))
}

// ====== 与 DSP 检测的融合 ======

/**
 * 融合 DSP 能量突增检测与模型起始点概率（增强式：模型只补充，不否决）
 * - 模型不可用（prob 为 null）时退化为纯 DSP 结果
 * - 模型"上升沿"命中（概率高且相对上一帧显著上升）→ 判定为起始点
 * - 否则沿用 DSP 结果（RMS 能量突增检测保持权威）
 *
 * 说明：模型权重以"稳态概率约 0.27"为基线，"上升沿"规则保证持续大声
 * 播放（概率恒定）不会产生误报，同时避免低概率否决伤害 DSP 检测。
 */
export function fuseOnset(dspOnset: boolean, prob: number | null, prevProb: number | null): boolean {
  if (prob === null) return dspOnset
  const prev = prevProb ?? prob
  const modelOnset = prob >= MODEL_HIT_THRESHOLD && prob - prev >= MODEL_DELTA_THRESHOLD
  return dspOnset || modelOnset
}

// ====== 宿主 wasm 二进制获取 ======

/**
 * 从宿主环境获取 onnxruntime 所需的 wasm 二进制
 * - Electron 环境：window.api.analyzer.getWasmBinary()（主进程 IPC 读取）
 * - 其他环境（纯浏览器）：返回 null，模型退化为内置参考实现
 */
export async function getHostWasmBinary(): Promise<Uint8Array | null> {
  const hostApi = (globalThis as { api?: { analyzer?: { getWasmBinary?: () => Promise<unknown> } } }).api
  try {
    const bin = await hostApi?.analyzer?.getWasmBinary?.()
    if (bin == null) return null
    const bytes = new Uint8Array(bin as ArrayBuffer | ArrayLike<number>)
    return bytes.length > 0 ? bytes : null
  } catch (e) {
    console.warn('[OnsetModel] 获取 WASM 二进制失败，使用内置参考实现:', e)
    return null
  }
}

// ====== 模型推理封装 ======

/** onnxruntime 最小结构类型（仅本项目用到的 API） */
interface OrtLike {
  env: {
    wasm: {
      numThreads?: number
      wasmBinary?: ArrayBufferLike | Uint8Array
    }
  }
  InferenceSession: {
    create(
      model: Uint8Array,
      options?: { executionProviders?: string[] }
    ): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>
    }>
  }
  Tensor: new (type: string, data: ArrayLike<number>, dims: number[]) => unknown
}

export interface OnsetModelOptions {
  /** 提供 onnxruntime 所需的 wasm 二进制；返回 null 时仅使用内置参考实现 */
  wasmBinaryProvider?: () => Promise<Uint8Array | null>
}

/**
 * 起始点检测模型
 *
 * - init()：异步初始化 onnxruntime 会话（幂等，失败自动降级为参考实现）
 * - predict()：输入 [32] 特征，返回起始点概率；会话不可用时走参考实现
 */
export class OnsetModel {
  private ort: OrtLike | null = null
  private session: Awaited<ReturnType<OrtLike['InferenceSession']['create']>> | null = null
  private initPromise: Promise<boolean> | null = null
  private wasmBinaryProvider: OnsetModelOptions['wasmBinaryProvider']

  constructor(options: OnsetModelOptions = {}) {
    this.wasmBinaryProvider = options.wasmBinaryProvider
  }

  /** 是否已就绪（onnxruntime 会话创建成功） */
  get ready(): boolean {
    return this.session !== null
  }

  /**
   * 初始化推理后端（幂等）
   * @returns 是否成功创建 onnxruntime 会话（false 时模型仍可通过参考实现工作）
   */
  init(): Promise<boolean> {
    if (!this.initPromise) {
      this.initPromise = this.doInit()
    }
    return this.initPromise
  }

  /**
   * 重新初始化（幂等）。用于 wasm 二进制晚于首次 init() 到达的场景：
   * 首次 init 时 provider 返回 null 导致创建会话失败，待 wasm 就绪后调用此方法重试。
   */
  retryInit(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    this.initPromise = null
    return this.init()
  }

  private async doInit(): Promise<boolean> {
    try {
      const ort = await import('onnxruntime-web/wasm')
      ort.env.wasm.numThreads = 1
      const wasmBinary = await this.wasmBinaryProvider?.()
      if (wasmBinary) {
        ort.env.wasm.wasmBinary = wasmBinary
      }
      const modelBytes = base64ToBytes(ONSET_MODEL_BASE64)
      const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
      this.ort = ort as unknown as OrtLike
      this.session = session as Awaited<ReturnType<OrtLike['InferenceSession']['create']>>
      console.log('[OnsetModel] onnxruntime 会话就绪')
      return true
    } catch (e) {
      console.log('[OnsetModel] onnxruntime 初始化失败，使用内置参考实现（功能不受影响）:', e)
      return false
    }
  }

  /**
   * 推理起始点概率
   * @param input 模型输入 [ONSET_MODEL_INPUT_SIZE]
   * @returns 起始点概率 (0~1)
   */
  async predict(input: Float32Array | number[]): Promise<number> {
    if (this.session && this.ort) {
      try {
        const tensor = new this.ort.Tensor('float32', input as Float32Array, [1, ONSET_MODEL_INPUT_SIZE])
        const results = await this.session.run({ [ONSET_MODEL_INPUT_NAME]: tensor })
        const data = results[ONSET_MODEL_OUTPUT_NAME].data
        return data[0]
      } catch (e) {
        // 推理失败时关闭会话，后续帧直接走参考实现，避免反复失败
        console.warn('[OnsetModel] 推理失败，降级内置参考实现:', e)
        this.session = null
      }
    }
    return referenceOnsetProbability(input)
  }
}

/** base64 字符串解码为 Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
