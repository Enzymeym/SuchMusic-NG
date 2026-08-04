/**
 * 实时过渡点分析器（主线程封装）
 *
 * 统一入口：内部优先使用 Web Worker 执行流式 DSP（transition-analyzer.worker.ts），
 * Worker 不可用（如受限环境）时静默降级为在主线程直接运行 StreamingAnalyzer。
 * 两种模式对外暴露完全一致的接口，调用方无需关心执行位置。
 *
 * 使用方式（配合任务 4 的过渡调度）：
 * - start(trackId, durationMs)：开始分析新曲目
 * - pushFrame(data, positionSec?)：播放中持续投递时域帧
 * - setNextHead(channelData, sampleRate)：下一首预解码完成后投递头部数据
 * - onDecision(cb)：接收实时决策（到达过渡点时触发）
 */

import { StreamingAnalyzer, analyzeHead } from './transition-dsp'
import {
  OnsetModel,
  buildModelInput,
  extractFrameFeatures,
  fuseOnset,
  getHostWasmBinary,
  MEL_BAND_COUNT
} from './onset-model'
import type { StreamingFrameResult, TransitionDecision } from './transition-dsp'
import type { AnalyzerWorkerCommand, AnalyzerWorkerEvent } from './transition-analyzer.worker'

export type {
  EnergySample,
  HeadFeatures,
  TailFeatures,
  TransitionStrategy
} from './transition-dsp'

/** 分析执行位置：Web Worker 或主线程（降级） */
export type AnalyzerExecutionMode = 'worker' | 'fallback'

/** AnalyserNode 帧大小（与 web-audio-engine.ts 的 fftSize 保持一致） */
const ANALYSER_FRAME_SIZE = 256

export interface TransitionAnalyzerOptions {
  /** 优先使用 Web Worker（创建失败时静默降级主线程） */
  preferWorker?: boolean
  /** 默认采样率（缺省 44100；实际以解码结果为准） */
  sampleRate?: number
}

/** 过渡决策回调 */
export type DecisionCallback = (decision: TransitionDecision, trackId: string) => void
/** 起始点事件回调 */
export type OnsetCallback = (positionSec: number, trackId: string) => void

/**
 * 实时过渡点分析器
 *
 * 单例使用：同一时刻只分析一首"当前曲"（trackId 相同），
 * 切歌时调用 start() 或 abort() 切换分析目标。
 */
export class TransitionAnalyzer {
  private worker: Worker | null = null
  private fallback: StreamingAnalyzer | null = null
  private mode: AnalyzerExecutionMode = 'fallback'
  private trackId = ''
  private sampleRate: number
  private frameCount = 0
  private _latestDecision: TransitionDecision | null = null
  private decisionCallbacks: DecisionCallback[] = []
  private onsetCallbacks: OnsetCallback[] = []
  private disposed = false
  /** 是否已向 Worker 投递过 WASM 二进制（避免重复 IPC 读取） */
  private modelWasmSent = false
  /** 降级模式下的模型管线 */
  private fallbackModel: OnsetModel | null = null
  private fallbackPrevFeatures: Float32Array | null = null
  private fallbackPrevProb: number | null = null
  /** 降级模式的逐帧推理串行队列（避免异步推理乱序） */
  private fallbackQueue: Promise<void> = Promise.resolve()

  /** 当前环境是否支持 Web Worker */
  static isWorkerAvailable(): boolean {
    return typeof Worker !== 'undefined'
  }

  constructor(options: TransitionAnalyzerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44100

    const preferWorker = options.preferWorker ?? true
    if (preferWorker && TransitionAnalyzer.isWorkerAvailable()) {
      try {
        const worker = new Worker(new URL('./transition-analyzer.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (event: MessageEvent<AnalyzerWorkerEvent>) => this.handleWorkerEvent(event.data)
        this.worker = worker
        this.mode = 'worker'
      } catch (e) {
        // Worker 创建失败（例如 CSP 限制），静默降级，不影响功能
        console.log('[TransitionAnalyzer] Worker 创建失败，降级主线程计算:', e)
        this.worker = null
        this.mode = 'fallback'
      }
    }
  }

  /** 当前执行模式（worker / fallback） */
  get executionMode(): AnalyzerExecutionMode {
    return this.mode
  }

  /** 最近一次产出的决策（可能为 null） */
  get latestDecision(): TransitionDecision | null {
    return this._latestDecision
  }

  /**
   * 开始分析新曲目（重置内部状态）
   * @param trackId 曲目标识（用于区分消息归属）
   * @param durationMs 曲目总时长（毫秒）
   */
  start(trackId: string, durationMs: number): void {
    this.trackId = trackId
    this.frameCount = 0
    this._latestDecision = null
    this.fallbackPrevFeatures = null
    this.fallbackPrevProb = null

    if (this.worker) {
      const cmd: AnalyzerWorkerCommand = { type: 'init', trackId, durationMs, sampleRate: this.sampleRate }
      this.worker.postMessage(cmd)
    } else {
      this.fallback = new StreamingAnalyzer(trackId, durationMs, this.sampleRate)
      this.ensureFallbackModel()
    }
  }

  /**
   * 投递一帧时域采样（AnalyserNode fftSize=256，快照语义，调用方保留所有权）
   * @param data 时域采样数据
   * @param positionSec 该帧对应的播放位置（秒）；缺省按帧数累计估算
   */
  pushFrame(data: Float32Array, positionSec?: number): void {
    const pos = positionSec ?? (this.frameCount * ANALYSER_FRAME_SIZE) / this.sampleRate
    this.frameCount++

    if (this.worker) {
      const cmd: AnalyzerWorkerCommand = { type: 'time-domain', trackId: this.trackId, data, positionSec: pos }
      this.worker.postMessage(cmd)
    } else if (this.fallback) {
      const result = this.fallback.update(data, pos)
      this.enqueueFallbackFrame(result, data)
    }
  }

  /**
   * 投递下一首歌曲的头部声道数据（预解码完成后调用）
   * 头部数据通过 Transferable 转移所有权，调用后 channelData 不可再使用
   * @param channelData 单声道 PCM 数据
   * @param sampleRate 下一首歌曲的采样率
   */
  setNextHead(channelData: Float32Array, sampleRate: number): void {
    if (this.worker) {
      const cmd: AnalyzerWorkerCommand = { type: 'head-data', trackId: this.trackId, channelData, sampleRate }
      this.worker.postMessage(cmd, [channelData.buffer as ArrayBuffer])
    } else if (this.fallback) {
      const head = analyzeHead(channelData, sampleRate)
      this.fallback.setHeadFeatures(head)
      const decision = this.fallback.evaluate()
      if (decision) this.emitDecision(decision)
    }
  }

  /**
   * 主动请求最近一次决策（Worker 模式下异步返回最新决策）
   */
  requestDecision(): void {
    if (this.worker) {
      const cmd: AnalyzerWorkerCommand = { type: 'request-decision', trackId: this.trackId }
      this.worker.postMessage(cmd)
    }
  }

  /** 注册过渡决策回调，返回取消注册函数 */
  onDecision(callback: DecisionCallback): () => void {
    this.decisionCallbacks.push(callback)
    return () => {
      this.decisionCallbacks = this.decisionCallbacks.filter((cb) => cb !== callback)
    }
  }

  /** 注册起始点事件回调，返回取消注册函数 */
  onOnset(callback: OnsetCallback): () => void {
    this.onsetCallbacks.push(callback)
    return () => {
      this.onsetCallbacks = this.onsetCallbacks.filter((cb) => cb !== callback)
    }
  }

  /** 放弃当前曲目的分析（手动切歌/中断过渡时调用） */
  abort(): void {
    if (this.worker) {
      const cmd: AnalyzerWorkerCommand = { type: 'abort', trackId: this.trackId }
      this.worker.postMessage(cmd)
    } else if (this.fallback) {
      this.fallback.reset()
    }
    this.fallbackPrevFeatures = null
    this.fallbackPrevProb = null
    this._latestDecision = null
  }

  /** 释放资源（组件卸载时调用） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
    this.fallback = null
    this.decisionCallbacks = []
    this.onsetCallbacks = []
    this._latestDecision = null
  }

  // ====== 内部实现 ======

  private handleWorkerEvent(event: AnalyzerWorkerEvent): void {
    if (event.type === 'ready') {
      this.sendModelWasmToWorker()
      return
    }
    if (event.type === 'onset') {
      this.emitOnset(event.positionSec, event.trackId)
      return
    }
    if (event.type === 'decision') {
      this.emitDecision(event.decision, event.trackId)
    }
  }

  /**
   * 向 Worker 投递 onnxruntime 所需的 WASM 二进制（Worker ready 后触发一次）。
   * 获取失败时静默跳过：Worker 内模型会退化为内置参考实现，不影响功能。
   */
  private async sendModelWasmToWorker(): Promise<void> {
    if (this.modelWasmSent || !this.worker) return
    this.modelWasmSent = true
    try {
      const wasmBinary = await getHostWasmBinary()
      if (wasmBinary && this.worker) {
        const cmd: AnalyzerWorkerCommand = { type: 'model-wasm', wasmBinary }
        this.worker.postMessage(cmd, [wasmBinary.buffer as ArrayBuffer])
      }
    } catch (e) {
      console.warn('[TransitionAnalyzer] 获取 WASM 二进制失败，Worker 内模型将使用参考实现:', e)
    }
  }

  /** 降级模式：惰性创建模型并初始化（初始化失败自动降级参考实现） */
  private ensureFallbackModel(): OnsetModel {
    if (!this.fallbackModel) {
      this.fallbackModel = new OnsetModel({ wasmBinaryProvider: getHostWasmBinary })
      void this.fallbackModel.init()
    }
    return this.fallbackModel
  }

  /** 降级模式：把一帧分析排队，串行执行模型推理与融合，保证事件顺序 */
  private enqueueFallbackFrame(result: StreamingFrameResult, data: Float32Array): void {
    this.fallbackQueue = this.fallbackQueue.then(() => this.processFallbackFrame(result, data))
  }

  /** 降级模式：模型增强的起始点判定与事件下发 */
  private async processFallbackFrame(result: StreamingFrameResult, data: Float32Array): Promise<void> {
    let onset = result.onset
    const model = this.fallbackModel
    if (model) {
      const prev = this.fallbackPrevFeatures ?? new Float32Array(MEL_BAND_COUNT)
      const curr = extractFrameFeatures(data, this.sampleRate)
      this.fallbackPrevFeatures = curr
      const prob = await model.predict(buildModelInput(prev, curr))
      const prevProb = this.fallbackPrevProb
      this.fallbackPrevProb = prob
      onset = fuseOnset(result.onset, prob, prevProb)
    }
    if (onset) this.emitOnset(result.positionSec)
    if (result.decision) this.emitDecision(result.decision)
  }

  private emitOnset(positionSec: number, trackId: string = this.trackId): void {
    for (const cb of this.onsetCallbacks) cb(positionSec, trackId)
  }

  private emitDecision(decision: TransitionDecision, trackId: string = this.trackId): void {
    this._latestDecision = decision
    for (const cb of this.decisionCallbacks) cb(decision, trackId)
  }
}
