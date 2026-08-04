/**
 * 过渡调度控制器（Automix 智能过渡）
 *
 * 负责完整过渡流程：
 * 1. 预解码：播放中获取下一首歌曲，读取文件并通过 Web Audio 解码（不打断当前播放）
 * 2. 头部分析：预解码完成后将下一首头部声道数据投递给实时分析器
 * 3. 触发判定：监听播放进度，到达触发点（smart 按决策 / crossfade 按固定时长）后
 *    smart 模式等待下一个拍点（onset）执行交叉淡化（节奏/BPM 动态对齐，非固定时间）；
 *    下一曲从"跳过前奏"的内容起点偏移处开始播放
 * 4. 完成收尾：交叉淡化完成后更新 playerStore（currentSong/currentIndex），
 *    transitionConsumed 标志让 PlayerBar 跳过重复加载
 * 5. 中断：用户手动切歌 / seek / pause 时放弃过渡，走现有快速切换路径
 *
 * 仅 Web Audio 模式支持交叉淡化；WASAPI 模式的顺序淡入淡出由 PlayerBar/任务 5 处理。
 */

import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { audioEngine } from './audio-engine'
import { TransitionAnalyzer } from './transition-analyzer'
import { DspWorkerClient } from './transition-dsp-worker'
import {
  BPM_ANALYSIS_WINDOW_SEC,
  BPM_MATCH_THRESHOLD,
  CONTENT_ANALYSIS_SEC,
  HEAD_ANALYSIS_SEC,
  MIN_TRANSITION_MS,
  VOCAL_END_ANALYSIS_SEC,
  computeSmartTriggerMs
} from './transition-dsp'
import type { TransitionDecision } from './transition-dsp'

/**
 * 节拍对齐兜底等待窗口（毫秒）：到达触发点后等待下一个拍点的最长时长
 * 无拍点（静音尾奏等）时由定时器直接执行过渡，避免挂起
 */
const BEAT_WAIT_DEFAULT_MS = 1500
/** 节拍对齐最大等待窗口（毫秒），由 BPM 估算得出后取两者较小值 */
const BEAT_WAIT_MAX_MS = 2500
/** 近期拍点保留时长（毫秒），用于节拍周期（BPM）估算 */
const BEAT_HISTORY_MS = 8000
/**
 * BPM 对齐变速窗口（秒）：仅对下一曲开头这 N 秒做变速（覆盖前奏偏移 + 过渡淡化窗口），
 * 其余部分原速拼接。整曲 WSOLA 变速需数分钟，会阻塞 prepareNext 导致错过触发窗口。
 */
const STRETCH_HEAD_SEC = 30
/** 变速超时（毫秒）：Worker 在限定时间内未完成则放弃变速（保持原速），确保过渡不被阻塞 */
const STRETCH_TIMEOUT_MS = 60000

// #region debug-point helper:dbg-log
const dbgLog = (hypothesisId: string, location: string, msg: string, data: Record<string, unknown> = {}): void => {
  try {
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'first-play-no-transition',
        runId: 'pre',
        hypothesisId,
        location,
        msg: `[DEBUG] ${msg}`,
        data,
        ts: Date.now()
      })
    }).catch(() => {})
  } catch {
    /* 忽略 */
  }
}
// #endregion

/**
 * 过渡调度控制器（单例使用）
 */
export class TransitionController {
  private player = usePlayerStore()
  private settings = useSettingsStore()
  private analyzer: TransitionAnalyzer | null = null
  /** 批量 DSP 计算客户端（人声结尾/前奏偏移/BPM/变速跑在 Worker 线程，主线程零占用） */
  private dsp: DspWorkerClient | null = null

  /** 当前是否处于激活的过渡流程 */
  private active = false
  /** 当前曲目标识（用于分析器归属） */
  private trackId = ''
  /** 预解码中的下一首（防重复触发） */
  private pendingSong: PlayerSong | null = null
  /** 下一首在播放列表中的索引 */
  private pendingIndex = -1
  /** 最近一次分析决策 */
  private decision: TransitionDecision | null = null
  /** 是否已执行过渡（防重复触发） */
  private executed = false
  /** 下一首不可用（无下一首 / 远程 URL），避免重复尝试预解码 */
  private nextUnavailable = false
  /** 预解码进行中（防重复触发；确保偏移计算完成前 pendingSong 不就绪） */
  private decoding = false
  /** 下一曲起始偏移（毫秒，跳过前奏），预解码后计算 */
  private nextStartOffsetMs = 0
  /** 当前曲人声结尾触发点（毫秒，smart 优先据此触发）；-1 表示未分析/未检测到人声 */
  private vocalEndTriggerMs = -1
  /** 当前曲结尾 30s 的 BPM（BPM_A）；0 表示未分析/无法估计 */
  private currentBpm = 0
  /** 下一曲开头 30s 的 BPM（BPM_B）；0 表示未分析/无法估计 */
  private nextBpm = 0
  /** 是否已对下一曲执行 BPM 对齐变速（同一曲只变一次） */
  private tempoStretched = false
  /** 近期检测到的拍点（毫秒），用于节拍对齐与 BPM 估算 */
  private recentOnsets: number[] = []
  /** 节拍对齐已就绪的触发点（毫秒）；-1 表示未武装 */
  private armedTriggerMs = -1
  /** 节拍对齐兜底定时器（无拍点时直接执行过渡） */
  private beatWaitTimer: number | null = null
  /** 最近一次进度轮询位置（毫秒），供时域帧位置估算 */
  private lastPositionMs = 0
  /** 释放函数列表 */
  private disposeFns: Array<() => void> = []
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
    const filePath = (song as any).filePath as string | undefined
    return !!filePath && !/^https?:\/\//.test(filePath)
  }

  /**
   * 初始化（PlayerBar onMounted 调用一次）：
   * - 创建实时分析器并注册决策回调
   * - 注册时域帧采集回调（Web Audio 模式）
   * - 注册交叉淡化完成回调
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    this.dsp = DspWorkerClient.create()
    this.analyzer = new TransitionAnalyzer()
    this.disposeFns.push(
      this.analyzer.onDecision((decision) => {
        this.decision = decision
      })
    )

    // 拍点（起始点）事件：维护近期拍点序列（节拍对齐 / BPM 估算），
    // 到达触发点后等待的下一个拍点即在拍点上执行过渡（节奏对齐，非固定时间）
    this.disposeFns.push(
      this.analyzer.onOnset((positionSec) => {
        this.recentOnsets.push(positionSec * 1000)
        const cutoff = this.lastPositionMs - BEAT_HISTORY_MS
        if (cutoff > 0) {
          this.recentOnsets = this.recentOnsets.filter((p) => p >= cutoff)
        }
        if (this.armedTriggerMs >= 0 && positionSec * 1000 >= this.armedTriggerMs) {
          this.executeTransition()
        }
      })
    )

    // 时域帧采集：每次 RAF tick 将当前帧交给分析器（位置用最近轮询值近似）
    this.disposeFns.push(
      audioEngine.onTimeDomainData((data) => {
        if (!this.active || !this.analyzer) return
        this.analyzer.pushFrame(data, this.lastPositionMs / 1000)
      })
    )

    // 交叉淡化完成：sourceB 已接管播放，更新 store
    audioEngine.setOnCrossfadeComplete(() => {
      this.finishTransition()
    })
  }

  /**
   * 歌曲开始播放时调用（PlayerBar 加载成功后）
   * 启动新曲目的过渡循环：开始分析 + 触发下一首预解码
   */
  onSongStarted(song: PlayerSong): void {
    this.active = this.player.transitionEnabled && this.isWebAudioMode() && this.isLocalFile(song)
    this.trackId = String(song.id ?? '')
    // #region debug-point A:on-song-started
    dbgLog('A', 'transition-controller.ts:onSongStarted', 'onSongStarted', {
      transitionEnabled: this.player.transitionEnabled,
      outputMode: this.settings.playback.audioOutputMode,
      isLocal: this.isLocalFile(song),
      active: this.active,
      songId: this.trackId,
      durationMs: song.durationMs || audioEngine.getDurationMs()
    })
    // #endregion
    this.decision = null
    this.executed = false
    this.pendingSong = null
    this.pendingIndex = -1
    this.nextUnavailable = false
    this.nextStartOffsetMs = 0
    this.vocalEndTriggerMs = -1
    this.currentBpm = 0
    this.nextBpm = 0
    this.tempoStretched = false
    this.recentOnsets = []
    this.clearBeatWait()

    if (!this.active) return

    // 时长缺失时用引擎实际时长，保证分析器"临近结尾"窗口与触发逻辑正确
    const durationMs = song.durationMs || audioEngine.getDurationMs()
    this.analyzer?.start(this.trackId, durationMs)
    // 异步分析当前曲"人声结尾"位置（smart 过渡优先在该处触发）
    this.scheduleVocalEndAnalysis()
    // 立即预解码下一首
    void this.prepareNext()
  }

  /**
   * 异步分析当前曲"人声结尾"位置（Web Audio 模式）
   * 智能过渡应"从上一首人声接近结尾处"开始：找到最后一个持续人声段的
   * 结束位置作为触发点，下一曲从人声起点（跳过前奏偏移）进入。
   * 延迟执行，避免阻塞播放启动路径；切歌后通过 trackId 归属校验丢弃结果。
   */
  private scheduleVocalEndAnalysis(): void {
    const trackId = this.trackId
    window.setTimeout(() => {
      void this.analyzeVocalEndLater(trackId)
    }, 60)
  }

  /**
   * 异步分析当前曲"人声结尾"位置与结尾 BPM（在 DSP Worker 线程中执行，
   * 主线程零占用，避免扫描结尾 90s 数千个 FFT 造成卡顿）。
   * 切歌后通过 trackId 归属校验丢弃结果。
   */
  private async analyzeVocalEndLater(trackId: string): Promise<void> {
    if (!this.active || this.trackId !== trackId) return
    const buf = audioEngine.currentAudioBuffer
    const dsp = this.dsp
    if (!buf || !dsp) return
    const channel = buf.getChannelData(0)
    const sampleRate = buf.sampleRate
    const durationSec = buf.duration
    // 拷贝出分析区间再交给 Worker（直接转移会 detach 播放缓冲）：
    // - 结尾 90s：人声结尾扫描（歌曲不足 90s 时取整曲）
    // - 结尾 30s：当前曲 BPM（与下一曲开头 30s 对比，节奏差异大时对下一曲变速对齐）
    const tailStart = Math.max(
      0,
      channel.length - Math.floor(Math.min(VOCAL_END_ANALYSIS_SEC, durationSec) * sampleRate)
    )
    const bpmStart = Math.max(0, channel.length - Math.floor(BPM_ANALYSIS_WINDOW_SEC * sampleRate))
    let bpm = 0
    let endSec = -1
    try {
      // 并行计算，均跑在 Worker 线程，不占主线程
      const [b, e] = await Promise.all([
        dsp.estimateBpm(channel.slice(bpmStart), sampleRate),
        dsp.analyzeVocalEnd(channel.slice(tailStart), sampleRate)
      ])
      bpm = b
      endSec = e
    } catch {
      // Worker 不可用（如销毁时挂起请求被拒绝），跳过本次分析
      return
    }
    // 分析期间可能已切歌 / 中断过渡
    if (!this.active || this.trackId !== trackId) return
    if (bpm > 0) this.currentBpm = bpm
    if (endSec < 0) return
    this.vocalEndTriggerMs = Math.round(endSec * 1000)
    // 短曲 / 播放已越过有效触发点时立即进入节拍等待，避免错过触发点
    if (this.active && !this.executed && this.pendingSong) {
      const triggerMs = computeSmartTriggerMs({
        durationMs: Math.round(buf.duration * 1000),
        transitionMs: this.player.transitionDuration,
        vocalEndTriggerMs: this.vocalEndTriggerMs,
        decisionStartMs: this.decision?.startPositionMs ?? -1
      })
      if (this.lastPositionMs >= triggerMs) {
        this.armBeatWait(triggerMs)
      }
    }
  }

  /**
   * 播放进度更新（PlayerBar 进度轮询调用）
   * 到达触发点且预解码就绪时执行过渡
   */
  onProgress(positionMs: number): void {
    this.lastPositionMs = positionMs
    // #region debug-point C:on-progress
    dbgLog('C', 'transition-controller.ts:onProgress', 'onProgress', {
      positionMs,
      active: this.active,
      executed: this.executed,
      hasPending: !!this.pendingSong,
      nextUnavailable: this.nextUnavailable,
      decoding: this.decoding
    })
    // #endregion
    if (!this.active || this.executed) return

    // 预解码尚未就绪时保持尝试（歌曲较长时延迟解码可节省内存）
    if (!this.pendingSong && !this.nextUnavailable) {
      void this.prepareNext()
      return
    }
    if (!this.pendingSong) return

    // 时长缺失（元数据未解析）时用引擎实际时长兜底，避免触发点永远不可达
    let durationMs = this.player.currentSong?.durationMs ?? 0
    if (durationMs <= 0) {
      durationMs = audioEngine.getDurationMs()
    }
    if (durationMs <= 0) return

    const transitionMs = this.player.transitionDuration
    let triggerMs: number
    if (this.player.transitionType === 'smart') {
      // 智能：优先用当前曲"人声结尾"触发点（过渡从上一首人声接近结尾处开始，
      // 下一曲从人声起点进入）；未检测到人声（器乐曲）时回退实时分析决策。
      // 分析点缺失或过晚时，最晚不晚于"结尾前 过渡时长 + 节拍提前量"，
      // 保证"节拍对齐等待 + 完整淡化"在歌曲自然结束前完成——避免触发点落在
      // 最后几秒、淡化被歌曲结束截断而失去丝滑感（甚至错过过渡走常规切歌）
      triggerMs = computeSmartTriggerMs({
        durationMs,
        transitionMs,
        vocalEndTriggerMs: this.vocalEndTriggerMs,
        decisionStartMs: this.decision?.startPositionMs ?? -1
      })
    } else {
      // crossfade：固定倒数 transitionMs 处开始
      triggerMs = Math.max(0, durationMs - transitionMs)
    }

    // #region debug-point D:trigger-check
    dbgLog('D', 'transition-controller.ts:onProgress', 'trigger-check', {
      positionMs,
      durationMs,
      transitionMs,
      triggerMs,
      reached: positionMs >= triggerMs,
      type: this.player.transitionType
    })
    // #endregion
    if (positionMs >= triggerMs) {
      if (this.player.transitionType === 'smart') {
        // 智能过渡：节拍对齐——等待下一个拍点再过渡，而非固定时间点
        this.armBeatWait(triggerMs)
      } else {
        this.executeTransition()
      }
    }
  }

  /**
   * 节拍对齐武装：到达触发点后不立即过渡，等待下一个拍点（onset）对齐节奏执行。
   * 若长时间无拍点（静音尾奏等），由兜底定时器直接执行，避免挂起。
   * @param triggerMs 自然触发点（毫秒）
   */
  private armBeatWait(triggerMs: number): void {
    if (this.executed || this.armedTriggerMs >= 0) return
    this.armedTriggerMs = triggerMs

    // 由近期拍点间隔（BPM）估算等待窗口：最多等 ~1.5 个节拍，避免节奏过慢时等待过长
    const beatMs = this.estimateBeatMs()
    let waitMs = beatMs > 0 ? Math.min(BEAT_WAIT_MAX_MS, beatMs * 1.5) : BEAT_WAIT_DEFAULT_MS
    // 兜底：等待窗口不超过"歌曲剩余时间 - 淡化时长"，避免节拍等待 + 淡化
    // 超过歌曲自然结束（淡化被 sourceA 结束截断会失去丝滑感）
    const durationMs = audioEngine.getDurationMs()
    const runwayMs = durationMs - this.lastPositionMs - this.player.transitionDuration
    if (runwayMs > 0) waitMs = Math.min(waitMs, runwayMs)
    this.beatWaitTimer = window.setTimeout(() => {
      this.beatWaitTimer = null
      this.armedTriggerMs = -1
      this.executeTransition()
    }, waitMs)
  }

  /** 取消节拍对齐等待（切歌 / 过渡完成 / 中断时调用） */
  private clearBeatWait(): void {
    if (this.beatWaitTimer !== null) {
      clearTimeout(this.beatWaitTimer)
      this.beatWaitTimer = null
    }
    this.armedTriggerMs = -1
  }

  /**
   * 估算当前节拍周期（毫秒）：取近期拍点间隔的中位数。
   * 拍点数据不足时返回 0，调用方回退到默认等待窗口。
   */
  private estimateBeatMs(): number {
    const onsets = this.recentOnsets
    if (onsets.length < 4) return 0
    const intervals: number[] = []
    for (let i = 1; i < onsets.length; i++) {
      const d = onsets[i] - onsets[i - 1]
      if (d >= 200 && d <= 2000) intervals.push(d)
    }
    if (intervals.length < 2) return 0
    intervals.sort((a, b) => a - b)
    return intervals[Math.floor(intervals.length / 2)]
  }

  /**
   * seek 后重新武装过渡流程
   * seek 会中断当前过渡（abort 后 active=false），若不在 seek 后重新开启当前曲的
   * 过渡循环，剩余播放时间内智能过渡将不再触发——表现为"只有从头到尾播放歌曲才生效"。
   * 仅播放中且当前无活跃过渡时执行；暂停状态由恢复播放路径（togglePlay）负责重新武装。
   */
  rearmAfterSeek(): void {
    if (!this.player.isPlaying || !this.player.currentSong) return
    if (this.active || this.executed) return
    this.onSongStarted(this.player.currentSong)
  }

  /**
   * 放弃当前过渡流程（用户手动切歌 / seek / pause 时调用）
   * 注意：不修改 isTransitioning（引擎打断交叉淡化会触发 onended，
   * handleSongEnd 依赖 isTransitioning 防重入；由调用方在引擎操作后统一重置）
   */
  abort(): void {
    this.active = false
    this.executed = false
    this.decision = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.nextStartOffsetMs = 0
    this.vocalEndTriggerMs = -1
    this.recentOnsets = []
    this.clearBeatWait()
    this.analyzer?.abort()
  }

  /** 释放资源（PlayerBar 卸载时调用） */
  dispose(): void {
    if (!this.initialized) return
    this.initialized = false
    this.active = false
    this.disposeFns.forEach((fn) => fn())
    this.disposeFns = []
    audioEngine.setOnCrossfadeComplete(null)
    this.analyzer?.dispose()
    this.analyzer = null
    this.dsp?.dispose()
    this.dsp = null
  }

  // ====== 内部实现 ======

  /**
   * 预解码下一首并投递头部特征
   * 复用 audioPlayerManager 的路径：readAudioFile IPC → decodeAudioData（loadNextFromArrayBuffer）
   */
  private async prepareNext(): Promise<void> {
    if (!this.active || this.pendingSong || this.nextUnavailable || this.decoding) {
      // #region debug-point B:prepare-skip
      if (this.decoding) {
        dbgLog('B', 'transition-controller.ts:prepareNext', 'prepareNext 卡住(decoding=true)', {
          active: this.active,
          hasPending: !!this.pendingSong,
          nextUnavailable: this.nextUnavailable
        })
      }
      // #endregion
      return
    }

    const next = this.player.getNextSong()
    // #region debug-point B:prepare-entry
    dbgLog('B', 'transition-controller.ts:prepareNext', 'prepareNext 入口', {
      hasNext: !!next,
      nextId: next ? String(next.id) : '',
      currentIndex: this.player.currentIndex,
      playlistLen: this.player.playlist.length
    })
    // #endregion
    if (!next) {
      this.nextUnavailable = true
      return
    }
    const filePath = (next as any).filePath as string | undefined
    if (!filePath || /^https?:\/\//.test(filePath)) {
      // 无本地文件（远程 URL 走流式播放）时无法预解码，标记不可用避免反复尝试
      this.nextUnavailable = true
      return
    }

    const nextIndex = this.player.playlist.findIndex((s) => s.id === next.id)
    if (nextIndex < 0) return
    // 记录归属曲目：解码期间可能切歌，完成后需校验仍为当前曲目
    const targetTrackId = this.trackId

    const api = (window as any).api?.audioEngine
    if (!api?.readAudioFile) {
      this.nextUnavailable = true
      return
    }

    // 解码期间置位：防止重复触发，并确保"下一曲起始偏移"计算完成前
    // onProgress 不会把 pendingSong 视为就绪（避免偏移为 0 的过渡）
    this.decoding = true
    try {
      const readResult = await api.readAudioFile(filePath)
      if (!readResult?.success) return

      const buffer = readResult.data!.buffer as ArrayBuffer
      const ok = await audioEngine.loadNextFromArrayBuffer(buffer)
      // 立即释放 IPC 返回的大数据引用，帮助 GC 及时回收
      ;(readResult as any).data = null
      if (!ok) return
      // 中断（切歌/暂停）或已切到其他曲目后不再登记下一首
      if (!this.active || this.trackId !== targetTrackId) return

      // 等待当前曲结尾 BPM 分析就绪（用于与下一曲开头 BPM 对比，节奏差异大时变速对齐）
      await this.waitForCurrentBpm()
      const dsp = this.dsp
      if (!dsp) return

      const nextAudio = audioEngine.nextAudioBuffer
      if (!nextAudio) return

      // 下一曲开头 30s 区间（BPM 与内容起点分析共用）：
      // 拷贝后交给 Worker 计算，直接转移会 detach 播放缓冲
      const channel = nextAudio.getChannelData(0)
      const headSlice = channel.slice(
        0,
        Math.min(
          channel.length,
          Math.floor(Math.max(CONTENT_ANALYSIS_SEC, BPM_ANALYSIS_WINDOW_SEC) * nextAudio.sampleRate)
        )
      )
      // 下一曲开头 BPM_ANALYSIS_WINDOW_SEC 秒的节奏（Worker 中计算，不占主线程）；
      // 分析失败时降级为 0（跳过变速对齐），不阻断过渡流程
      this.nextBpm = await dsp.estimateBpm(headSlice, nextAudio.sampleRate).catch(() => 0)

      // 下一曲起始偏移（跳过前奏）：扫描下一首前 CONTENT_ANALYSIS_SEC 秒找到内容起点
      // （Worker 中计算，不占主线程）；分析失败时降级为 0（从头播放）
      let startOffsetSec = await dsp
        .analyzeContentStart(headSlice, nextAudio.sampleRate)
        .catch(() => 0)

      // 头部特征分析：取下一首前 HEAD_ANALYSIS_SEC 秒的声道 0 数据（拷贝后投递，避免 detach 播放缓冲）
      // 用变速前的缓冲：变速不变调，头部能量特征不受影响
      if (this.analyzer) {
        const headLen = Math.min(channel.length, Math.floor(HEAD_ANALYSIS_SEC * nextAudio.sampleRate))
        const headData = channel.slice(0, headLen)
        this.analyzer.setNextHead(headData, nextAudio.sampleRate)
      }

      // BPM 差异较大时对下一曲变速不变调（使节奏与当前曲一致）；偏移换算到变速后时间轴
      startOffsetSec = await this.maybeTempoStretch(startOffsetSec)

      // 全部就绪后再登记为待过渡下一首
      this.nextStartOffsetMs = Math.round(startOffsetSec * 1000)
      this.pendingSong = next
      this.pendingIndex = nextIndex
      // #region debug-point B:pending-set
      dbgLog('B', 'transition-controller.ts:prepareNext', 'pendingSong 就绪', {
        nextId: String(next.id),
        nextStartOffsetMs: this.nextStartOffsetMs,
        nextBpm: this.nextBpm,
        currentBpm: this.currentBpm
      })
      // #endregion
    } catch (e) {
      // #region debug-point B:prepare-error
      dbgLog('B', 'transition-controller.ts:prepareNext', 'prepareNext 异常', {
        error: String(e),
        active: this.active,
        trackId: this.trackId,
        targetTrackId
      })
      // #endregion
      console.warn('[TransitionController] 预解码下一首失败:', e)
    } finally {
      this.decoding = false
    }
  }

  /**
   * 等待当前曲结尾 BPM 分析就绪（scheduleVocalEndAnalysis 异步计算）
   * 超时未就绪则视为不可用，保持原速过渡
   * @param timeoutMs 最长等待时间（毫秒）
   */
  private async waitForCurrentBpm(timeoutMs = 800): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.active) return
      if (this.currentBpm > 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * BPM 对齐变速：上一曲结尾 30s 与下一曲开头 30s 的 BPM 差异超过阈值时，
   * 对下一曲做变速不变调（WSOLA），使两段节奏一致后交叉过渡；
   * 差异在阈值内时保持原速。
   * @param offsetSec 下一曲内容起点偏移（秒，原时间轴）
   * @returns 变速后（或原速）时间轴上的内容起点偏移（秒）
   */
  private async maybeTempoStretch(offsetSec: number): Promise<number> {
    if (this.tempoStretched) return offsetSec
    if (!this.active || this.currentBpm <= 0 || this.nextBpm <= 0) return offsetSec

    // 目标：下一曲变速到与当前曲一致的 BPM（ratio = 下一曲 BPM / 当前曲 BPM）
    const ratio = this.nextBpm / this.currentBpm
    if (Math.abs(1 - ratio) <= BPM_MATCH_THRESHOLD) {
      this.tempoStretched = true
      return offsetSec
    }

    const src = audioEngine.nextAudioBuffer
    if (!src) return offsetSec
    this.tempoStretched = true
    try {
      const stretched = await this.stretchAudioBuffer(src, ratio)
      if (stretched && this.active) {
        audioEngine.setNextAudioBuffer(stretched)
        // 内容起点在变速后时间轴上的位置：
        // 头部（STRETCH_HEAD_SEC 内）被拉伸 ratio 倍，尾部原速顺延
        return offsetSec < STRETCH_HEAD_SEC
          ? offsetSec * ratio
          : STRETCH_HEAD_SEC * ratio + (offsetSec - STRETCH_HEAD_SEC)
      }
    } catch (e) {
      console.warn('[TransitionController] BPM 对齐变速失败，保持原速:', e)
    }
    return offsetSec
  }

  /** 对下一曲缓冲做变速不变调（逐声道 WSOLA，Worker 中执行不占主线程），返回变速后的 AudioBuffer。
   *  仅对开头 STRETCH_HEAD_SEC 秒变速（覆盖前奏偏移 + 过渡淡化窗口），其余原速拼接，
   *  避免整曲变速耗时数分钟阻塞 prepareNext 错过触发窗口；超时则放弃变速保持原速。 */
  private async stretchAudioBuffer(src: AudioBuffer, ratio: number): Promise<AudioBuffer | null> {
    const dsp = this.dsp
    if (!dsp) return null
    try {
      const headLen = Math.min(src.length, Math.floor(STRETCH_HEAD_SEC * src.sampleRate))
      const tailLen = src.length - headLen
      const headOutLen = Math.round(headLen * ratio)
      const out = new AudioBuffer({
        numberOfChannels: src.numberOfChannels,
        length: Math.max(1, headOutLen + tailLen),
        sampleRate: src.sampleRate
      })
      for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const srcData = src.getChannelData(ch)
        // 仅对头部窗口变速（客户端内部会拷贝数据再转移，不会 detach 播放缓冲）；
        // 超时抛错 → 整体放弃变速（保持原速过渡），避免阻塞 prepareNext
        const headData = await this.withStretchTimeout(
          dsp.timeStretch(srcData.subarray(0, headLen), ratio),
          STRETCH_TIMEOUT_MS
        )
        const outCh = out.getChannelData(ch)
        outCh.set(headData, 0)
        if (tailLen > 0) {
          // 尾部原速拼接
          outCh.set(srcData.subarray(headLen), headOutLen)
        }
      }
      return out
    } catch (e) {
      console.warn('[TransitionController] 变速失败，保持原速:', e)
      return null
    }
  }

  /** 为 Worker 变速请求加超时（超时即拒绝，调用方降级为原速过渡） */
  private withStretchTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: number | null = null
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`变速超时(${timeoutMs}ms)`)), timeoutMs)
    })
    // 超时定时器必须在竞态尘埃落定（成功 / 失败 / 超时）后再清理。
    // 旧实现用 try/finally 在 Promise.race 构造后立即 clearTimeout，导致超时永不触发，
    // Worker 变速一旦挂起，prepareNext 永远卡在 decoding=true，过渡永不执行。
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer !== null) clearTimeout(timer)
    })
  }

  /** 执行过渡（统一为双源交叉淡化：两首歌同时淡入和淡出） */
  private executeTransition(): void {
    if (this.executed || !this.pendingSong) return
    this.clearBeatWait()
    this.executed = true
    this.player.setTransitioning(true)
    // #region debug-point E:execute-entry
    dbgLog('E', 'transition-controller.ts:executeTransition', 'executeTransition 入口', {
      pendingId: String(this.pendingSong.id),
      lastPositionMs: this.lastPositionMs,
      transitionDuration: this.player.transitionDuration,
      engDurationMs: audioEngine.getDurationMs(),
      engCrossfading: audioEngine.isCrossfading
    })
    // #endregion

    // 淡化时长按剩余播放时间收敛：触发点 + 节拍等待已消耗部分时间，
    // 避免淡化时长超过实际剩余时间（否则 sourceA 提前结束、淡化被截断）
    let fadeMs = this.player.transitionDuration
    // 过渡时长硬上限：持久化配置可能被写坏为超大值（如 10000ms），
    // 10 秒线性淡入会让下一首在数秒内几乎听不到声音，听感为"切歌后无声"
    const MAX_TRANSITION_MS = 8000
    fadeMs = Math.min(fadeMs, MAX_TRANSITION_MS)
    const remainingMs = audioEngine.getDurationMs() - Math.max(0, this.lastPositionMs)
    if (remainingMs > MIN_TRANSITION_MS) {
      fadeMs = Math.min(fadeMs, Math.max(MIN_TRANSITION_MS, remainingMs))
    } else if (remainingMs > 0) {
      // 剩余时间不足以完成一次最小淡化：按剩余时间收窄，避免淡化被歌曲结束截断
      fadeMs = Math.min(fadeMs, remainingMs)
    }

    // crossfade / smart：双源交叉淡化，下一曲从跳过前奏的偏移处开始
    const ok = audioEngine.beginCrossfade(fadeMs, this.nextStartOffsetMs)
    // #region debug-point E:crossfade-result
    dbgLog('E', 'transition-controller.ts:executeTransition', 'beginCrossfade 结果', {
      ok,
      fadeMs,
      nextStartOffsetMs: this.nextStartOffsetMs
    })
    // #endregion
    if (!ok) {
      // 预解码失败或引擎不可用：回退到常规切歌路径
      this.rollback()
      return
    }

    // 交叉淡化已启动：下一首此刻已在淡入，立即切换歌曲信息，
    // 避免 UI（PlayerBar/PlayerPage/SMTC 等）在淡化期间仍显示旧曲信息。
    // - setTransitionConsumed 先置位，PlayerBar 的 watch 检测到 currentSong
    //   变化后跳过重复加载（音频已由交叉淡化接管）
    // - 进度同步到下一曲起始偏移处（引擎在交叉淡化期间已按下一曲报告位置），
    //   并用解码真实时长校准进度比例，避免进度条瞬时跳变
    this.player.setPosition(this.nextStartOffsetMs)
    this.player.setTransitionConsumed(true)
    this.player.previewTransitionSong(this.pendingSong, this.pendingIndex)
    const nextAudio = audioEngine.nextAudioBuffer
    if (nextAudio) {
      this.player.setDuration(Math.round(nextAudio.duration * 1000))
    }
  }

  /** 交叉淡化完成：sourceB 已接管播放，更新 store 并开启新循环 */
  private finishTransition(): void {
    if (!this.pendingSong) {
      this.rollback()
      return
    }
    // #region debug-point E:finish
    dbgLog('E', 'transition-controller.ts:finishTransition', 'finishTransition 完成', {
      nextId: String(this.pendingSong.id)
    })
    // #endregion
    const next = this.pendingSong
    const nextIndex = this.pendingIndex

    this.player.finishTransition(next, nextIndex)
    this.active = false
    this.executed = false
    this.decision = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.nextStartOffsetMs = 0
    this.vocalEndTriggerMs = -1
    this.recentOnsets = []
    this.clearBeatWait()
    // PlayerBar watch(currentSong) 检测 transitionConsumed 后调用 onSongStarted 开启新循环
  }

  /** 过渡执行失败：恢复状态并回到常规切歌流程 */
  private rollback(): void {
    this.executed = false
    this.decision = null
    this.pendingSong = null
    this.pendingIndex = -1
    this.nextStartOffsetMs = 0
    this.vocalEndTriggerMs = -1
    this.recentOnsets = []
    this.clearBeatWait()
    this.player.setTransitioning(false)
  }
}

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
