/**
 * 批量 DSP 计算 Worker 客户端（主线程）
 *
 * 封装 transition-dsp.worker.ts 的消息协议，向调用方暴露 Promise 接口：
 * - analyzeVocalEnd: 人声结尾分析（当前曲结尾）
 * - analyzeContentStart: 内容起点分析（下一曲前奏偏移）
 * - estimateBpm: BPM 估计
 * - timeStretch: WSOLA 变速不变调（BPM 对齐）
 *
 * 设计要点：
 * - 内部对传入声道数据先 slice 拷贝再转移所有权，绝不 detach 调用方的
 *   播放缓冲（AudioBuffer.getChannelData 返回的是底层缓冲）。
 * - Worker 不可用（创建失败 / 运行期出错）时静默降级为 transition-dsp 的
 *   分块异步版本（主线程让出），与原有行为保持一致。
 * - stretch 结果通过 Transferable 转移回主线程，避免大数据结构化克隆开销。
 */

import {
  analyzeContentStartAsync,
  analyzeVocalEndAsync,
  estimateBpm,
  timeStretchPcmAsync
} from './transition-dsp'
import type { DspWorkerCommand, DspWorkerEvent } from './transition-dsp.worker'

/** 挂起的请求记录 */
interface DspPendingRequest {
  resolve: (value: number | Float32Array) => void
  reject: (reason?: unknown) => void
}

/**
 * 批量 DSP 计算客户端
 * 单例使用：同一次过渡流程内共享一个 Worker 实例。
 */
export class DspWorkerClient {
  private worker: Worker | null = null
  private nextRequestId = 1
  private pending = new Map<number, DspPendingRequest>()
  private disposed = false

  private constructor(worker: Worker | null) {
    this.worker = worker
  }

  /** 当前是否运行在 Worker 中（false 表示降级主线程计算） */
  get isWorkerMode(): boolean {
    return this.worker !== null
  }

  /**
   * 创建客户端：优先创建 Web Worker；创建失败（受限环境）时返回降级实例，
   * 所有方法改走主线程分块异步版本，不影响功能。
   */
  static create(): DspWorkerClient {
    let worker: Worker | null = null
    try {
      worker = new Worker(new URL('./transition-dsp.worker.ts', import.meta.url), {
        type: 'module'
      })
    } catch (e) {
      console.log('[DspWorker] Worker 创建失败，降级主线程计算:', e)
      worker = null
    }

    const client = new DspWorkerClient(worker)
    if (worker) {
      worker.onmessage = (event: MessageEvent<DspWorkerEvent>) =>
        client.handleWorkerEvent(event.data)
      worker.onerror = () => {
        console.warn('[DspWorker] Worker 运行期出错，降级主线程计算')
        client.rejectAllPending()
      }
    }
    return client
  }

  /** 人声结尾分析：返回人声结尾位置（秒，相对歌曲开头）；未检测到人声返回 -1 */
  async analyzeVocalEnd(
    channelData: Float32Array,
    sampleRate: number,
    maxSec?: number
  ): Promise<number> {
    if (!this.worker) return analyzeVocalEndAsync(channelData, sampleRate, maxSec)
    return this.send<number>({ type: 'vocal-end', requestId: 0, channelData, sampleRate, maxSec })
  }

  /** 内容起点分析：返回应跳过的前奏长度（秒）；无前奏返回 0 */
  async analyzeContentStart(
    channelData: Float32Array,
    sampleRate: number,
    maxSec?: number
  ): Promise<number> {
    if (!this.worker) return analyzeContentStartAsync(channelData, sampleRate, maxSec)
    return this.send<number>({
      type: 'content-start',
      requestId: 0,
      channelData,
      sampleRate,
      maxSec
    })
  }

  /** BPM 估计：返回 60-180 的 BPM；数据不足 / 无法估计返回 0 */
  async estimateBpm(
    channelData: Float32Array,
    sampleRate: number,
    startSec = 0,
    endSec = channelData.length / sampleRate
  ): Promise<number> {
    if (!this.worker) return estimateBpm(channelData, sampleRate, startSec, endSec)
    return this.send<number>({
      type: 'estimate-bpm',
      requestId: 0,
      channelData,
      sampleRate,
      startSec,
      endSec
    })
  }

  /** WSOLA 变速不变调：返回变速后的 PCM 数据（与 timeStretchPcm 逐位一致） */
  async timeStretch(channelData: Float32Array, ratio: number): Promise<Float32Array> {
    if (!this.worker) return timeStretchPcmAsync(channelData, ratio)
    return this.send<Float32Array>({ type: 'stretch', requestId: 0, channelData, ratio })
  }

  /** 释放资源（终止 Worker；调用后不再使用本实例） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
    this.rejectAllPending()
  }

  // ====== 内部实现 ======

  /** 发送请求：声道数据拷贝后转移所有权（不影响调用方缓冲），并按 requestId 登记 Promise */
  private send<T extends number | Float32Array>(command: DspWorkerCommand): Promise<T> {
    const worker = this.worker
    if (!worker || this.disposed) return Promise.reject(new Error('DspWorker 不可用'))
    // 拷贝后再转移：AudioBuffer 的 getChannelData 返回底层缓冲，直接转移会 detach 播放缓冲
    const payload = command.channelData.slice()
    const requestId = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: number | Float32Array) => void,
        reject
      })
      const cmd = { ...command, requestId, channelData: payload } as DspWorkerCommand
      worker.postMessage(cmd, [payload.buffer as ArrayBuffer])
    })
  }

  private handleWorkerEvent(event: DspWorkerEvent): void {
    if (event.type === 'ready') return
    if (event.type === 'result' || event.type === 'result-stretch') {
      const req = this.pending.get(event.requestId)
      if (!req) return
      this.pending.delete(event.requestId)
      if (event.type === 'result') req.resolve(event.value)
      else req.resolve(event.data)
    }
  }

  /** 释放全部挂起请求（Worker 出错 / 销毁时调用，避免 Promise 悬挂） */
  private rejectAllPending(): void {
    for (const [, req] of this.pending) req.reject(new Error('DspWorker 不可用'))
    this.pending.clear()
    // 出错后本 Worker 不再可信，后续调用走降级路径
    this.worker = null
  }
}
