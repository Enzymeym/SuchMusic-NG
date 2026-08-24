/**
 * 过渡调度控制器（智能过渡，扁平化）
 *
 * 重写自旧 Automix 架构（ML 模型 + Worker + 实时流式分析），简化为：
 * 1. onSongStarted：异步分析当前曲（结尾能量 / 结尾节奏 / 结尾调性），
 *    同时预解码下一首（readAudioFile IPC + loadNextFromArrayBuffer，不打断播放）
 * 2. 下一首解码后：分析其头部（节奏 / 调性 / 前奏偏移），等待当前曲分析就绪，
 *    经 computeTransitionPlan 联合决策得到触发点、过渡时长、变速比、变调量
 * 3. 对下一曲开头 STRETCH_HEAD_SEC 秒做 WSOLA 变速 + 相位声码器变调
 *    （节奏与调性向当前曲对齐，实现"完美过渡"），其余原速原调拼接
 * 4. onProgress 到达触发点：beginCrossfade 双源交叉淡化；完成回调更新 playerStore
 *
 * 公共 API（getTransitionController / init / onSongStarted / onProgress /
 * rearmAfterSeek / abort / dispose / isActive）与旧实现保持一致，
 * 10 处调用方（PlayerBar / usePlayerProgress / LyricPlayer 等）零改动。
 *
 * 仅 Web Audio 模式支持交叉淡化；WASAPI 模式的顺序淡入淡出由 PlayerBar 处理。
 */

import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { audioEngine } from './audio-engine'
import {
  BPM_ANALYSIS_WINDOW_SEC,
  BEAT_TRIGGER_MARGIN_MS,
  CONTENT_ANALYSIS_SEC,
  STRETCH_HEAD_SEC,
  TAIL_ANALYSIS_SEC,
  analyzeContentStartAsync,
  analyzeKeyAsync,
  analyzeTail,
  computeTransitionPlan,
  estimateBpm,
  pitchShiftPcmAsync,
  timeStretchPcmAsync
} from './transition-dsp'
import type { MusicKey, TailDecay, TransitionPlan } from './transition-dsp'

/** 读文件 IPC 超时（毫秒）：主进程读文件挂起时放弃预解码，避免解码流程卡死 */
const PRELOAD_READ_TIMEOUT_MS = 10000
/** 下一曲解码超时（毫秒）：浏览器解码超大文件过慢时放弃预解码，走常规切歌 */
const PRELOAD_DECODE_TIMEOUT_MS = 15000
/** 触发点时间预算（毫秒）：距最晚触发点不足该值时下一曲仍未就绪则放弃预解码，走常规硬切 */
const TRIGGER_GUARD_MS = 10000

/** 为 Promise 加超时：超时 reject（调用方 catch 降级），避免挂起的异步调用阻塞过渡流程 */
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: number | null = null
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label}超时(${timeoutMs}ms)`)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/** 当前曲分析结果（分析失败各字段回退为安全默认值） */
interface CurrentAnalysis {
  tail: TailDecay
  bpm: number
  key: MusicKey | null
}

/** readAudioFile IPC 返回结构（主进程 preload 签名） */
interface ReadAudioFileResult {
  success: boolean
  data?: Uint8Array | null
  error?: string
}

/** 安全默认值（分析失败时使用，保证过渡流程不中断） */
const EMPTY_ANALYSIS: CurrentAnalysis = {
  tail: { peakRms: 0, decayStartSec: -1, decayRate: 0 },
  bpm: 0,
  key: null
}

/**
 * 过渡调度控制器（单例使用）
 */
export class TransitionController {
  private player = usePlayerStore()
  private settings = useSettingsStore()

  /** 当前是否处于激活的过渡流程 */
  private active = false
  /** 当前曲目标识（用于异步分析结果的归属校验） */
  private trackId = ''
  /** 预解码并完成分析/处理的下一首（防重复触发） */
  private pendingSong: PlayerSong | null = null
  /** 下一首在播放列表中的索引 */
  private pendingIndex = -1
  /** 最终过渡计划（含触发点 / 时长 / 变速比 / 变调量 / 起始偏移） */
  private plan: TransitionPlan | null = null
  /** 是否已执行过渡（防重复触发） */
  private executed = false
  /** 下一首不可用（无下一首 / 远程 URL / 预解码失败），避免重复尝试 */
  private nextUnavailable = false
  /** 预解码进行中（防重复触发） */
  private preparing = false
  /** 当前曲异步分析（onSongStarted 启动，prepareNext 等待其完成） */
  private currentAnalysis: Promise<CurrentAnalysis> | null = null
  private initialized = false

  /** 当前是否为 Web Audio 模式（仅该模式支持交叉淡化） */
  private isWebAudioMode(): boolean {
    try {
      return this.settings.playback.audioOutputMode === 'webaudio'
    } catch {
      return false
    }
  }

  /** 是否正处于激活的过渡流程（PlayerBar 据此决定是否中断） */
  get isActive(): boolean {
    return this.active
  }

  /** 是否为本地文件（远程 URL 走流式播放，不支持预解码过渡） */
  private isLocalFile(song: PlayerSong): boolean {
    return !!song.filePath && !/^https?:\/\//.test(song.filePath)
  }

  /**
   * 初始化（PlayerBar onMounted 调用一次）：
   * 注册交叉淡化完成回调（sourceB 接管播放后更新 store 并开启下一曲循环）
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    audioEngine.setOnCrossfadeComplete(() => {
      this.finishTransition()
    })
  }

  /**
   * 歌曲开始播放时调用（PlayerBar 加载成功后）
   * 启动当前曲分析 + 下一首预解码（并行，均不打断播放）
   */
  onSongStarted(song: PlayerSong): void {
    this.active = this.player.transitionEnabled && this.isWebAudioMode() && this.isLocalFile(song)
    this.trackId = String(song.id ?? '')
    this.plan = null
    this.executed = false
    this.pendingSong = null
    this.pendingIndex = -1
    this.nextUnavailable = false
    this.preparing = false
    if (!this.active) {
      this.currentAnalysis = null
      return
    }
    // 异步分析当前曲（结尾能量 / 结尾节奏 / 结尾调性），与下一首预解码并行
    this.currentAnalysis = this.analyzeCurrentSong(this.trackId)
    void this.prepareNext()
  }

  /**
   * 播放进度更新（PlayerBar 进度轮询调用）
   * 到达触发点且过渡计划就绪时执行交叉淡化
   */
  onProgress(positionMs: number): void {
    if (!this.active || this.executed) return

    // 过渡计划尚未就绪：预解码时间预算守卫——距最晚触发点不足 TRIGGER_GUARD_MS
    // 时主动放弃预解码（本曲走常规硬切），避免解码/分析卡住时过渡无限等待
    if (!this.plan) {
      if (this.pendingSong || this.nextUnavailable || this.preparing) return
      if (positionMs >= this.guardTriggerMs() - TRIGGER_GUARD_MS) {
        this.nextUnavailable = true
        return
      }
      void this.prepareNext()
      return
    }

    if (positionMs >= this.plan.triggerMs) {
      this.executeTransition()
    }
  }

  /** 最晚可能的触发点（毫秒）：由过渡类型决定（smart 预留节拍对齐提前量） */
  private guardTriggerMs(): number {
    const durationMs = audioEngine.getDurationMs() || this.player.currentSong?.durationMs || 0
    const userMs = this.player.transitionDuration || DEFAULT_TRANSITION_MS
    return this.player.transitionType === 'crossfade'
      ? Math.max(0, durationMs - userMs)
      : Math.max(0, durationMs - userMs - BEAT_TRIGGER_MARGIN_MS)
  }

  /**
   * seek 后重新武装过渡流程（仅播放中且无活跃过渡时执行；
   * 暂停状态由恢复播放路径负责重新武装）
   */
  rearmAfterSeek(): void {
    if (!this.player.isPlaying || !this.player.currentSong) return
    if (this.active || this.executed) return
    this.onSongStarted(this.player.currentSong)
  }

  /** 放弃当前过渡流程（用户手动切歌 / seek / pause 时调用） */
  abort(): void {
    this.active = false
    this.executed = false
    this.plan = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.currentAnalysis = null
  }

  /** 释放资源（PlayerBar 卸载时调用） */
  dispose(): void {
    if (!this.initialized) return
    this.initialized = false
    this.active = false
    audioEngine.setOnCrossfadeComplete(null)
  }

  // ====== 内部实现 ======

  /**
   * 异步分析当前曲：结尾能量衰减（tail）、结尾节奏（BPM）、结尾调性（Key）。
   * 全部跑在主线程但分块让出（FFT 密集部分为分块异步版本），不阻塞播放。
   * 切歌后通过 trackId 归属校验丢弃结果。
   */
  private async analyzeCurrentSong(trackId: string): Promise<CurrentAnalysis> {
    if (!this.active || this.trackId !== trackId) return EMPTY_ANALYSIS
    const buf = audioEngine.currentAudioBuffer
    if (!buf) return EMPTY_ANALYSIS
    const channel = buf.getChannelData(0)
    const sampleRate = buf.sampleRate
    const durationSec = buf.duration
    try {
      const bpmStartSec = Math.max(0, durationSec - BPM_ANALYSIS_WINDOW_SEC)
      const [tail, bpm, key] = await Promise.all([
        analyzeTail(channel, sampleRate, TAIL_ANALYSIS_SEC),
        Promise.resolve().then(() => estimateBpm(channel, sampleRate, bpmStartSec, durationSec)),
        analyzeKeyAsync(channel, sampleRate, TAIL_ANALYSIS_SEC)
      ])
      if (!this.active || this.trackId !== trackId) return EMPTY_ANALYSIS
      return { tail, bpm, key }
    } catch (e) {
      console.warn('[TransitionController] 当前曲分析失败:', e)
      return EMPTY_ANALYSIS
    }
  }

  /**
   * 预解码下一首并完成分析与节奏/调性对齐
   * 复用 audioPlayerManager 的路径：readAudioFile IPC → decodeAudioData（loadNextFromArrayBuffer）
   */
  private async prepareNext(): Promise<void> {
    if (!this.active || this.pendingSong || this.nextUnavailable || this.preparing) {
      return
    }

    const next = this.player.getNextSong()
    if (!next) {
      this.nextUnavailable = true
      return
    }
    const filePath = next.filePath
    if (!filePath || /^https?:\/\//.test(filePath)) {
      // 无本地文件（远程 URL 走流式播放）时无法预解码，标记不可用避免反复尝试
      this.nextUnavailable = true
      return
    }
    const nextIndex = this.player.playlist.findIndex((s) => s.id === next.id)
    if (nextIndex < 0) return
    // 记录归属曲目：解码期间可能切歌，完成后需校验仍为当前曲目
    const targetTrackId = this.trackId

    const api = window.api?.audioEngine
    if (!api?.readAudioFile) {
      this.nextUnavailable = true
      return
    }

    this.preparing = true
    try {
      const readResult = await withTimeout<ReadAudioFileResult>(
        api.readAudioFile(filePath),
        PRELOAD_READ_TIMEOUT_MS,
        '读文件'
      )
      if (!readResult?.success) return

      const buffer = readResult.data!.buffer as ArrayBuffer
      const ok = await withTimeout(
        audioEngine.loadNextFromArrayBuffer(buffer),
        PRELOAD_DECODE_TIMEOUT_MS,
        '下一曲解码'
      )
      // 立即释放 IPC 返回的大数据引用，帮助 GC 及时回收
      readResult.data = null
      if (!ok) return
      // 中断（切歌/暂停）或已切到其他曲目后不再继续
      if (!this.active || this.trackId !== targetTrackId) return

      const nextAudio = audioEngine.nextAudioBuffer
      if (!nextAudio) return
      const channel = nextAudio.getChannelData(0)
      const sampleRate = nextAudio.sampleRate

      // 下一曲头部特征：节奏（BPM）/ 调性（Key）/ 前奏偏移（内容起点），并行计算
      const headSec = Math.min(STRETCH_HEAD_SEC, channel.length / sampleRate)
      const headSlice = channel.slice(0, Math.floor(headSec * sampleRate))
      const [nextBpm, nextKey, contentStartSec] = await Promise.all([
        estimateBpm(channel, sampleRate, 0, headSec),
        analyzeKeyAsync(headSlice, sampleRate, headSec),
        analyzeContentStartAsync(headSlice, sampleRate, CONTENT_ANALYSIS_SEC)
      ])
      if (!this.active || this.trackId !== targetTrackId) return

      // 等待当前曲分析就绪（与上一首预解码并行；失败时为安全默认值）
      const current = this.currentAnalysis
        ? await this.currentAnalysis
        : await this.analyzeCurrentSong(targetTrackId)
      if (!this.active || this.trackId !== targetTrackId) return

      const durationMs = audioEngine.getDurationMs() || this.player.currentSong?.durationMs || 0
      if (durationMs <= 0) return

      // 联合决策：触发点 / 过渡时长 / 变速比 / 变调量 / 起始偏移（两曲节奏与调性分析）
      const plan = computeTransitionPlan({
        durationMs,
        tail: current.tail,
        currentBpm: current.bpm,
        nextBpm,
        currentKey: current.key,
        nextKey,
        contentStartSec,
        userTransitionMs: this.player.transitionDuration || DEFAULT_TRANSITION_MS
      })

      // crossfade 类型：固定时长、固定倒数触发点（不做节拍提前量），其余计划参数保留
      let finalPlan = plan
      if (this.player.transitionType === 'crossfade') {
        finalPlan = {
          ...plan,
          triggerMs: Math.max(0, durationMs - plan.transitionDurationMs)
        }
      }

      // 对下一曲开头做变速/变调（节奏与调性向当前曲对齐，实现"完美过渡"）
      await this.alignNextAudio(plan)
      if (!this.active || this.trackId !== targetTrackId) return

      this.plan = finalPlan
      this.pendingSong = next
      this.pendingIndex = nextIndex
    } catch (e) {
      // 读文件/解码超时（IPC 或浏览器解码挂起）：放弃本曲预解码走常规切歌
      if (e instanceof Error && /超时/.test(e.message)) {
        this.nextUnavailable = true
      }
      console.warn('[TransitionController] 预解码下一首失败:', e)
    } finally {
      this.preparing = false
    }
  }

  /**
   * 对下一曲开头 STRETCH_HEAD_SEC 秒做节奏/调性对齐（WSOLA 变速 + 相位声码器变调），
   * 其余部分原速原调拼接，避免整曲处理耗时阻塞过渡。
   */
  private async alignNextAudio(plan: TransitionPlan): Promise<void> {
    const src = audioEngine.nextAudioBuffer
    if (!src) return
    const needsStretch = Math.abs(plan.stretchRatio - 1) >= 0.01
    const needsPitch = plan.pitchShiftSemitones !== 0
    if (!needsStretch && !needsPitch) return

    const headLen = Math.min(src.length, Math.floor(STRETCH_HEAD_SEC * src.sampleRate))
    const headOutLen = Math.round(headLen * plan.stretchRatio)
    const out = new AudioBuffer({
      numberOfChannels: src.numberOfChannels,
      length: Math.max(1, headOutLen + (src.length - headLen)),
      sampleRate: src.sampleRate
    })

    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const srcData = src.getChannelData(ch)
      // 拷贝头部到独立缓冲（避免时间拉伸/变调污染播放缓冲；typed array 泛型统一为 ArrayBuffer）
      let head: Float32Array<ArrayBuffer> = srcData.slice(0, headLen)
      if (needsStretch) head = new Float32Array(await timeStretchPcmAsync(head, plan.stretchRatio))
      if (needsPitch)
        head = new Float32Array(await pitchShiftPcmAsync(head, plan.pitchShiftSemitones))
      const outCh = out.getChannelData(ch)
      outCh.set(head.subarray(0, Math.min(head.length, out.length)), 0)
      // 尾部原速原调拼接
      const tailLen = Math.min(src.length - headLen, out.length - head.length)
      if (tailLen > 0) outCh.set(srcData.subarray(headLen, headLen + tailLen), head.length)
    }
    audioEngine.setNextAudioBuffer(out)
  }

  /** 执行过渡（统一为双源交叉淡化：两首歌同时淡入和淡出） */
  private executeTransition(): void {
    if (this.executed || !this.pendingSong || !this.plan) return
    this.executed = true
    this.player.setTransitioning(true)

    const fadeMs = this.plan.transitionDurationMs
    const ok = audioEngine.beginCrossfade(fadeMs, this.plan.startOffsetMs)
    if (!ok) {
      // 预解码失败或引擎不可用：回退到常规切歌路径
      this.rollback()
      return
    }

    // 交叉淡化已启动：下一首此刻已在淡入，立即切换歌曲信息，
    // 避免 UI（PlayerBar/PlayerPage/SMTC 等）在淡化期间仍显示旧曲信息
    this.player.setPosition(this.plan.startOffsetMs)
    this.player.setTransitionConsumed(true)
    this.player.previewTransitionSong(this.pendingSong, this.pendingIndex)
    const nextAudio = audioEngine.nextAudioBuffer
    if (nextAudio) {
      this.player.setDuration(Math.round(nextAudio.duration * 1000))
    }
  }

  /** 交叉淡化完成：sourceB 已接管播放，更新 store 并开启新循环 */
  private finishTransition(): void {
    if (!this.executed || !this.pendingSong) return
    const next = this.pendingSong
    const nextIndex = this.pendingIndex

    this.player.finishTransition(next, nextIndex)
    // 经变速/变调处理的歌曲实际缓冲时长与元数据不一致，写回真实时长，
    // 否则下一轮触发点计算与进度条/总时长基于错误时间轴
    const realDurationMs = audioEngine.getDurationMs()
    if (realDurationMs > 0) this.player.setDuration(realDurationMs)
    this.reset()
    // PlayerBar watch(currentSong) 检测 transitionConsumed 后调用 onSongStarted 开启新循环
  }

  /** 过渡执行失败：恢复状态并回到常规切歌流程 */
  private rollback(): void {
    this.executed = false
    this.plan = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.player.setTransitioning(false)
  }

  /** 重置单次过渡状态（过渡完成 / 中断共用） */
  private reset(): void {
    this.active = false
    this.executed = false
    this.plan = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.currentAnalysis = null
  }
}

/** 智能模式兜底过渡时长（毫秒） */
const DEFAULT_TRANSITION_MS = 3000

/**
 * 过渡控制器全局单例。
 * 由 PlayerBar 创建/初始化/驱动，PlayerPage 进度条等组件共享同一实例，
 * 确保任意入口的 seek / 切歌都能一致地中断过渡流程。
 */
let transitionControllerInstance: TransitionController | null = null

export function getTransitionController(): TransitionController {
  if (!transitionControllerInstance) {
    transitionControllerInstance = new TransitionController()
  }
  return transitionControllerInstance
}
