/**
 * 实时过渡点分析 Web Worker
 *
 * 在独立线程中执行流式 DSP 分析（transition-dsp.ts 的 StreamingAnalyzer），
 * 避免时域帧分析阻塞渲染主线程。
 *
 * 自 v1.0-beta3 起接入起始点检测模型（onset-model.ts）：
 * - 每帧提取梅尔谱特征 → MLP 推理起始点概率 → 与 RMS 能量突增检测融合
 * - 模型推理通过 onnxruntime-web（WASM）执行，wasm 二进制由主线程
 *   经 'model-wasm' 消息注入；无法初始化时自动降级内置参考实现
 *
 * 消息协议（与 transition-analyzer.ts 配合）：
 * - init: 开始分析新曲目（重置状态）
 * - time-domain: 投递一帧时域采样（AnalyserNode fftSize=256），返回起始点事件/决策
 * - head-data: 投递下一首歌曲的头部声道数据（可转移所有权），触发重新评估
 * - request-decision: 主动请求最近一次决策
 * - model-wasm: 注入 onnxruntime 所需的 WASM 二进制
 * - abort: 放弃指定曲目的分析
 *
 * 通过结构化克隆传输数据；head-data 的声道数据使用 Transferable 转移所有权。
 */

import { StreamingAnalyzer, analyzeHead } from './transition-dsp'
import { OnsetModel, buildModelInput, extractFrameFeatures, fuseOnset, MEL_BAND_COUNT } from './onset-model'
import type { TransitionDecision } from './transition-dsp'

// ====== 消息协议类型 ======

export interface AnalyzerInitCommand {
  type: 'init'
  trackId: string
  durationMs: number
  sampleRate: number
}

export interface AnalyzerTimeDomainCommand {
  type: 'time-domain'
  trackId: string
  /** 一帧时域采样（快照语义，Worker 内只读） */
  data: Float32Array
  /** 该帧对应的播放位置（秒），缺省由 Worker 按帧数估算 */
  positionSec?: number
}

export interface AnalyzerHeadDataCommand {
  type: 'head-data'
  trackId: string
  /** 下一首歌曲单声道 PCM 数据（建议转移所有权） */
  channelData: Float32Array
  sampleRate: number
}

export interface AnalyzerRequestDecisionCommand {
  type: 'request-decision'
  trackId: string
}

export interface AnalyzerModelWasmCommand {
  type: 'model-wasm'
  /** onnxruntime-web 所需的 WASM 二进制（建议转移所有权） */
  wasmBinary: Uint8Array
}

export interface AnalyzerAbortCommand {
  type: 'abort'
  trackId: string
}

export type AnalyzerWorkerCommand =
  | AnalyzerInitCommand
  | AnalyzerTimeDomainCommand
  | AnalyzerHeadDataCommand
  | AnalyzerRequestDecisionCommand
  | AnalyzerModelWasmCommand
  | AnalyzerAbortCommand

export interface AnalyzerReadyEvent {
  type: 'ready'
}

export interface AnalyzerOnsetEvent {
  type: 'onset'
  trackId: string
  positionSec: number
}

export interface AnalyzerDecisionEvent {
  type: 'decision'
  trackId: string
  decision: TransitionDecision
}

export type AnalyzerWorkerEvent = AnalyzerReadyEvent | AnalyzerOnsetEvent | AnalyzerDecisionEvent

// ====== Worker 内部状态 ======

/** 当前分析的曲目表 */
const analyzers = new Map<string, StreamingAnalyzer>()
/** 各曲目已收到的时域帧数（用于位置兜底估算） */
const frameCounts = new Map<string, number>()
/** 各曲目上一帧的梅尔特征（模型输入上下文） */
const prevFeaturesMap = new Map<string, Float32Array>()
/** 各曲目上一帧的模型概率（融合用"上升沿"判定） */
const prevProbsMap = new Map<string, number>()
/** AnalyserNode 帧大小（与 web-audio-engine.ts 的 fftSize 保持一致） */
const FRAME_SIZE = 256

/** 起始点检测模型（全 Worker 共享，无状态） */
let onsetModel: OnsetModel | null = null
/** 主线程注入的 onnxruntime WASM 二进制 */
let modelWasmBinary: Uint8Array | null = null

/** 惰性创建并初始化模型（幂等；初始化失败会自动降级参考实现） */
function ensureModel(): void {
  if (onsetModel) return
  onsetModel = new OnsetModel({ wasmBinaryProvider: async () => modelWasmBinary })
  void onsetModel.init()
}

/** 重置某曲目的模型上下文（切歌/重开时调用） */
function resetModelState(trackId: string): void {
  prevFeaturesMap.delete(trackId)
  prevProbsMap.delete(trackId)
}

/**
 * 模型增强的起始点判定：
 * 特征提取 → 模型推理 → 与 DSP 检测融合
 */
async function evaluateModelOnset(
  analyzer: StreamingAnalyzer,
  trackId: string,
  frame: Float32Array,
  dspOnset: boolean
): Promise<boolean> {
  if (!onsetModel) return dspOnset
  const prev = prevFeaturesMap.get(trackId) ?? new Float32Array(MEL_BAND_COUNT)
  const curr = extractFrameFeatures(frame, analyzer.sampleRate)
  prevFeaturesMap.set(trackId, curr)
  const input = buildModelInput(prev, curr)
  const prob = await onsetModel.predict(input)
  const prevProb = prevProbsMap.get(trackId) ?? null
  prevProbsMap.set(trackId, prob)
  return fuseOnset(dspOnset, prob, prevProb)
}

async function handleCommand(msg: AnalyzerWorkerCommand): Promise<void> {
  if (msg.type === 'init') {
    const analyzer = new StreamingAnalyzer(msg.trackId, msg.durationMs, msg.sampleRate)
    analyzers.set(msg.trackId, analyzer)
    frameCounts.set(msg.trackId, 0)
    resetModelState(msg.trackId)
    ensureModel()
    return
  }

  if (msg.type === 'abort') {
    analyzers.delete(msg.trackId)
    frameCounts.delete(msg.trackId)
    resetModelState(msg.trackId)
    return
  }

  if (msg.type === 'model-wasm') {
    modelWasmBinary = msg.wasmBinary
    if (!onsetModel) {
      ensureModel()
    } else if (!onsetModel.ready) {
      // wasm 晚于首次 init 到达：重试初始化（首次可能因缺 wasm 失败而降级）
      void onsetModel.retryInit()
    }
    return
  }

  const analyzer = analyzers.get(msg.trackId)
  if (!analyzer) return

  switch (msg.type) {
    case 'time-domain': {
      const count = frameCounts.get(msg.trackId) ?? 0
      frameCounts.set(msg.trackId, count + 1)
      const positionSec = msg.positionSec ?? (count * FRAME_SIZE) / analyzer.sampleRate
      const result = analyzer.update(msg.data, positionSec)
      const onset = await evaluateModelOnset(analyzer, msg.trackId, msg.data, result.onset)
      if (onset) {
        postMessage({ type: 'onset', trackId: msg.trackId, positionSec: result.positionSec } satisfies AnalyzerOnsetEvent)
      }
      if (result.decision) {
        postMessage({ type: 'decision', trackId: msg.trackId, decision: result.decision } satisfies AnalyzerDecisionEvent)
      }
      break
    }
    case 'head-data': {
      const head = analyzeHead(msg.channelData, msg.sampleRate)
      analyzer.setHeadFeatures(head)
      const decision = analyzer.evaluate()
      if (decision) {
        postMessage({ type: 'decision', trackId: msg.trackId, decision } satisfies AnalyzerDecisionEvent)
      }
      break
    }
    case 'request-decision': {
      const decision = analyzer.latestDecision
      if (decision) {
        postMessage({ type: 'decision', trackId: msg.trackId, decision } satisfies AnalyzerDecisionEvent)
      }
      break
    }
  }
}

self.onmessage = (event: MessageEvent<AnalyzerWorkerCommand>) => {
  void handleCommand(event.data)
}

// 通知主线程 Worker 已就绪
postMessage({ type: 'ready' } satisfies AnalyzerReadyEvent)
