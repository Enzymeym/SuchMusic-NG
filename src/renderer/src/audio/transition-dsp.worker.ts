/**
 * 批量 DSP 计算 Web Worker
 *
 * 承载 Automix 流程中的 CPU 密集离线计算（transition-dsp.ts 的同步版本）：
 * - vocal-end: 人声结尾分析（当前曲结尾扫描最后一个持续人声段）
 * - content-start: 内容起点分析（下一曲开头，跳过前奏偏移）
 * - estimate-bpm: BPM 估计（当前曲结尾 / 下一曲开头 30s 节奏对比）
 * - stretch: WSOLA 变速不变调（下一曲 BPM 对齐）
 *
 * 这些计算原先在主线程上"分块让出"执行，虽避免卡死但仍持续抢占主线程
 * 时间片导致明显卡顿；搬到独立 Worker 后主线程零占用，UI 完全流畅。
 * Worker 线程内直接用同步版本（无需分块 yield），计算也更快。
 *
 * 消息协议（与 transition-dsp-worker.ts 配合）：
 * - vocal-end / content-start / estimate-bpm: 返回数值结果（number）
 * - stretch: 返回变速后的 PCM 数据（Transferable 转移所有权）
 * 每个请求携带自增 requestId，主线程据此匹配 Promise。
 */

import {
  analyzeContentStart,
  analyzeVocalEnd,
  analyzeVocalGap,
  analyzeVocalStart,
  estimateBpm,
  timeStretchPcm
} from './transition-dsp'

// ====== 消息协议类型 ======

export interface DspVocalEndCommand {
  type: 'vocal-end'
  requestId: number
  /** 单声道 PCM 数据（建议转移所有权） */
  channelData: Float32Array
  sampleRate: number
  /** 从结尾向前分析的范围（秒），缺省由 transition-dsp 默认值决定 */
  maxSec?: number
}

export interface DspContentStartCommand {
  type: 'content-start'
  requestId: number
  channelData: Float32Array
  sampleRate: number
  maxSec?: number
}

export interface DspEstimateBpmCommand {
  type: 'estimate-bpm'
  requestId: number
  channelData: Float32Array
  sampleRate: number
  /** 分析起点（秒，相对 channelData 开头） */
  startSec?: number
  /** 分析终点（秒，相对 channelData 开头，缺省为数据结尾） */
  endSec?: number
}

export interface DspStretchCommand {
  type: 'stretch'
  requestId: number
  channelData: Float32Array
  /** 输出/输入时长比例（<1 加速、>1 减速、≈1 原样返回） */
  ratio: number
}

export interface DspVocalGapCommand {
  type: 'vocal-gap'
  requestId: number
  /** 单声道 PCM 数据（建议转移所有权） */
  channelData: Float32Array
  sampleRate: number
  /** 从结尾向前分析无人声段的范围（秒），缺省由 transition-dsp 默认值决定 */
  windowSec?: number
}

export interface DspVocalStartCommand {
  type: 'vocal-start'
  requestId: number
  /** 单声道 PCM 数据（建议转移所有权） */
  channelData: Float32Array
  sampleRate: number
  /** 从数据开头向后扫描人声起点的范围（秒），缺省由 transition-dsp 默认值决定 */
  maxSec?: number
}

export type DspWorkerCommand =
  | DspVocalEndCommand
  | DspContentStartCommand
  | DspEstimateBpmCommand
  | DspStretchCommand
  | DspVocalGapCommand
  | DspVocalStartCommand

export interface DspReadyEvent {
  type: 'ready'
}

export interface DspResultEvent {
  type: 'result'
  requestId: number
  /** 数值结果：人声结尾位置（秒）/ 内容起点（秒）/ BPM */
  value: number
}

export interface DspResultStretchEvent {
  type: 'result-stretch'
  requestId: number
  /** 变速后的 PCM 数据（转移所有权） */
  data: Float32Array
}

export type DspWorkerEvent = DspReadyEvent | DspResultEvent | DspResultStretchEvent

// ====== 消息处理 ======

/** Worker 全局 postMessage 的签名（接收 transfer 数组）；window 版本的签名不同 */
const workerPostMessage = (
  self as unknown as {
    postMessage(message: unknown, transfer?: Transferable[]): void
  }
).postMessage

self.onmessage = (event: MessageEvent<DspWorkerCommand>) => {
  const msg = event.data
  switch (msg.type) {
    case 'vocal-end': {
      const value = analyzeVocalEnd(msg.channelData, msg.sampleRate, msg.maxSec)
      postMessage({ type: 'result', requestId: msg.requestId, value } satisfies DspResultEvent)
      break
    }
    case 'vocal-gap': {
      const g = analyzeVocalGap(msg.channelData, msg.sampleRate, msg.windowSec)
      postMessage({ type: 'result', requestId: msg.requestId, value: g ? g.startSec : -1 } satisfies DspResultEvent)
      break
    }
    case 'vocal-start': {
      const startSec = analyzeVocalStart(msg.channelData, msg.sampleRate, msg.maxSec)
      postMessage({ type: 'result', requestId: msg.requestId, value: startSec } satisfies DspResultEvent)
      break
    }
    case 'content-start': {
      const value = analyzeContentStart(msg.channelData, msg.sampleRate, msg.maxSec)
      postMessage({ type: 'result', requestId: msg.requestId, value } satisfies DspResultEvent)
      break
    }
    case 'estimate-bpm': {
      const value = estimateBpm(msg.channelData, msg.sampleRate, msg.startSec, msg.endSec)
      postMessage({ type: 'result', requestId: msg.requestId, value } satisfies DspResultEvent)
      break
    }
    case 'stretch': {
      const data = timeStretchPcm(msg.channelData, msg.ratio)
      workerPostMessage(
        { type: 'result-stretch', requestId: msg.requestId, data } satisfies DspResultStretchEvent,
        [data.buffer as ArrayBuffer]
      )
      break
    }
  }
}

// 通知主线程 Worker 已就绪
postMessage({ type: 'ready' } satisfies DspReadyEvent)
