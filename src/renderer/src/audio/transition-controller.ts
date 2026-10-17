/**
 * 过渡调度控制器（智能过渡，扁平化）
 *
 * 重写自旧 Automix 架构（ML 模型 + Worker + 实时流式分析），简化为：
 * 1. onSongStarted：异步分析当前曲（结尾能量 / 结尾节奏 / 结尾调性 / 尾部拍网格），
 *    同时预解码下一首（readAudioFile IPC + loadNextFromArrayBuffer，不打断播放）
 * 2. 下一首解码后：分析其头部（节奏 / 调性 / 前奏偏移 / 头部拍网格），等待当前曲分析就绪，
 *    经 computeTransitionPlan 联合决策得到触发点、过渡时长、变速比、变调量
 * 3. 对下一曲开头 STRETCH_APPLY_SEC 秒做 WSOLA 变速（节奏向当前曲对齐），其余原速拼接
 * 4. onProgress 进入预调度窗口：一次性把双源交叉淡化排程到精确音频时刻
 *    （等功率曲线 + 可选 bass swap 低频避让）；完成回调更新 playerStore
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
import { getFirstLyricLineStartSec } from '../utils/lyric/lyricParser'
import { audioEngine } from './audio-engine'
import {
  BPM_ANALYSIS_WINDOW_SEC,
  BEAT_TRIGGER_MARGIN_MS,
  CONTENT_ANALYSIS_SEC,
  GRID_MIN_CONFIDENCE,
  STRETCH_APPLY_SEC,
  STRETCH_HEAD_SEC,
  TAIL_ANALYSIS_SEC,
  analyzeContentStartAsync,
  analyzeKeyAsync,
  analyzeTail,
  computeTransitionPlan,
  estimateBeatGrid,
  estimateBpm,
  timeStretchPcmAsync
} from './transition-dsp'
import type { MusicKey, TailDecay, TransitionPlan } from './transition-dsp'

/** 读文件 IPC 超时（毫秒）：主进程读文件挂起时放弃预解码，避免解码流程卡死 */
const PRELOAD_READ_TIMEOUT_MS = 10000
/** 下一曲解码超时（毫秒）：浏览器解码超大文件过慢时放弃预解码，走常规切歌 */
const PRELOAD_DECODE_TIMEOUT_MS = 15000
/** 触发点时间预算（毫秒）：距最晚触发点不足该值时下一曲仍未就绪则放弃预解码，走常规硬切 */
const TRIGGER_GUARD_MS = 10000
/**
 * 预解码启动提前量（毫秒）：仅在距最晚触发点不足该值时，才开始读文件 + 解码下一曲。
 *
 * 下一曲解码后是一整段 PCM AudioBuffer（立体声约 85MB/首）。若在歌曲开始即预解码，
 * 这份缓冲会在整首歌播放期间常驻内存；延迟到临近过渡点再解码，可让绝大部分播放时段
 * 只保留当前曲一份 PCM。该提前量远大于读文件 + 解码 + 特征分析的耗时（通常数秒），
 * 且始终大于 TRIGGER_GUARD_MS，保证过渡计划在触发点前就绪，不改变过渡行为。
 *
 * 30s 而非 60s：把「双份 PCM 并存」的高占用窗口再缩短一半，而解码预算仍有
 * 30s − TRIGGER_GUARD_MS(10s) = 20s，大于 PRELOAD_DECODE_TIMEOUT_MS(15s)。
 */
const PRELOAD_LEAD_MS = 30000
/**
 * 预调度提前量（毫秒）：进入该窗口即把交叉淡化一次性排程到精确的音频时刻，
 * 之后不再依赖 PlayerBar 250ms 轮询的判定精度（消除最多半拍的触发抖动）。
 */
const PRE_SCHEDULE_LEAD_MS = 500
/** 等功率曲线的感知接管点在 50% 处；线性曲线沿用旧折中值 0.44 */
const NEXT_LANDING_EARLY_RATIO_EQUAL_POWER = 0.5
const NEXT_LANDING_EARLY_RATIO_LINEAR = 0.44


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
  tail: { peakRms: 0, decayStartSec: -1, decayRate: 0, onsets: [] },
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
  /** 延迟切换 UI 曲目的定时器（预调度窗口内等待真正起播），中断/复位时清除 */
  private uiSwitchTimer: number | null = null
  private initialized = false

  /** 清除延迟 UI 切换定时器（过渡被中断/复位时调用，避免切回已作废的下一曲） */
  private clearUiSwitchTimer(): void {
    if (this.uiSwitchTimer !== null) {
      clearTimeout(this.uiSwitchTimer)
      this.uiSwitchTimer = null
    }
  }

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
    this.clearUiSwitchTimer()
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
    // 异步分析当前曲（结尾能量 / 结尾节奏 / 结尾调性）
    this.currentAnalysis = this.analyzeCurrentSong(this.trackId)
    // 注意：不在此处立即预解码下一曲。改由 onProgress 在临近过渡点（见 PRELOAD_LEAD_MS）
    // 时触发，避免下一曲整段 PCM 在本曲绝大部分播放期间常驻内存。
  }

  /**
   * 播放进度更新（PlayerBar 进度轮询调用）
   * 进入预调度窗口（距触发点 ≤ PRE_SCHEDULE_LEAD_MS）时一次性把交叉淡化
   * 排程到精确音频时刻并执行，之后不再依赖轮询精度
   */
  onProgress(positionMs: number): void {
    if (!this.active || this.executed) return

    // 过渡计划尚未就绪：预解码时间预算守卫——距最晚触发点不足 TRIGGER_GUARD_MS
    // 时主动放弃预解码（本曲走常规硬切），避免解码/分析卡住时过渡无限等待
    if (!this.plan) {
      if (this.pendingSong || this.nextUnavailable || this.preparing) return
      const latestTrigger = this.guardTriggerMs()
      if (positionMs >= latestTrigger - TRIGGER_GUARD_MS) {
        this.nextUnavailable = true
        return
      }
      // 临近过渡点才开始预解码：避免下一曲整段 PCM 长期常驻内存（见 PRELOAD_LEAD_MS）
      if (latestTrigger - positionMs > PRELOAD_LEAD_MS) return
      void this.prepareNext()
      return
    }

    // 进入预调度窗口即一次性排程到精确音频时刻（消除轮询粒度带来的触发抖动）
    if (this.plan.triggerMs - positionMs <= PRE_SCHEDULE_LEAD_MS) {
      this.executeTransition(positionMs)
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
    this.clearUiSwitchTimer()
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
    this.clearUiSwitchTimer()
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
      // 尾部拍网格（拍点相位 + 置信度）：以估计 BPM 为提示，对尾部窗口做梳状对齐，
      // 供 computeTransitionPlan 把触发点吸附到小节/乐句重拍。失败则保持缺省，回退 onset 吸附。
      try {
        const tailStartSec = Math.max(0, durationSec - TAIL_ANALYSIS_SEC)
        const grid = estimateBeatGrid(channel, sampleRate, tailStartSec, durationSec, bpm || 0)
        if (grid.bpm > 0) tail.grid = grid
      } catch (e) {
        console.warn('[TransitionController] 尾部拍网格分析失败:', e)
      }
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
      // analyzeKeyAsync 内部按 maxSec 截断采样范围，直接传整段 channel 即可，
      // 无需再 slice 一份约 30 秒的 Float32Array 副本（避免数 MB 的瞬时拷贝）。
      const [nextBpm, nextKey] = await Promise.all([
        estimateBpm(channel, sampleRate, 0, headSec),
        analyzeKeyAsync(channel, sampleRate, headSec)
      ])
      if (!this.active || this.trackId !== targetTrackId) return

      // 下一曲头部拍网格：用于把落点吸附到小节头（重拍），使 B 的重拍/首句落在 A 的拍点上
      const nextGrid = estimateBeatGrid(
        channel,
        sampleRate,
        0,
        Math.min(CONTENT_ANALYSIS_SEC, channel.length / sampleRate),
        nextBpm || 0
      )
      const beatAlign = this.player.transitionBeatAlign

      // 下一曲歌词预取：prepareNext 时 next.lyrics 通常尚未加载（歌词在切歌后才拉取），
      // 若为空则按网易云 ID / 标题歌手在线获取，否则内容起点只能靠音频检测而落不到首句。
      const nextLyrics = next.lyrics || (await this.fetchNextLyrics(next))
      if (nextLyrics && !next.lyrics) next.lyrics = nextLyrics

      // 下一曲"内容起点"（跳过前奏、落在开始演唱处）
      // 歌词首句时间仅在与音频检测的有声起点接近时被信任（歌词优先）；
      // 个别曲目歌词时间戳过早/无歌词时，以音频人声/能量起点为准，避免落在演唱之前。
      const lyricStartSec = getFirstLyricLineStartSec(nextLyrics, next.title)
      const audioStartSec = await analyzeContentStartAsync(
        channel,
        sampleRate,
        CONTENT_ANALYSIS_SEC
      )
      let contentStartSec: number
      if (lyricStartSec > 0 && lyricStartSec <= STRETCH_HEAD_SEC) {
        // 有有效歌词时以"首句歌词"对齐为落点（歌词优先）。
        // 不再用音频起点向上钳制：音频的"人声跃升"检测常因首句演唱
        // 能量/人声频段占比未明显突破阈值而漏检、落在第二句，导致过渡
        // 直接跳到第二句开始。仅歌词缺失时才退化为音频能量起点。
        contentStartSec = lyricStartSec
      } else {
        // 无有效歌词（或首句超窗）时，退化为音频人声/能量起点
        contentStartSec = audioStartSec
      }
      console.log(
        '[TransitionController] 下一曲内容起点',
        { title: next.title, audioStartSec, lyricStartSec, contentStartSec }
      )
      if (!this.active || this.trackId !== targetTrackId) return

      // 落点吸附到下一曲的小节头（原时间轴）：使 B 的重拍与 A 的拍点对齐，且最多提前一拍
      // （避免截掉首句）。必须在原时间轴吸附，之后才交给变速时间轴映射（见 computeTransitionPlan）。
      let nextDownbeatSec = contentStartSec
      if (beatAlign && nextGrid.bpm > 0 && nextGrid.confidence >= GRID_MIN_CONFIDENCE) {
        const periodMs = nextGrid.beatPeriodSec * 1000
        const anchorMs = nextGrid.phaseSec * 1000
        const barStepMs = periodMs * 4
        const contentMs = contentStartSec * 1000
        const k = Math.round((contentMs - anchorMs) / barStepMs)
        let candMs = anchorMs + k * barStepMs
        // 允许最多提前一拍；若最近小节头早于该下限，则顺延一个小节
        if (candMs < contentMs - periodMs) candMs += barStepMs
        const audioDurationMs = (channel.length / sampleRate) * 1000
        if (candMs >= 0 && candMs <= audioDurationMs) {
          nextDownbeatSec = candMs / 1000
        }
      }
      console.log('[TransitionController] 下一曲落点', {
        title: next.title,
        contentStartSec,
        nextDownbeatSec,
        gridConfidence: nextGrid.confidence,
        nextBpm
      })

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
        contentStartSec: nextDownbeatSec,
        nextDownbeatSec,
        userTransitionMs: this.player.transitionDuration || DEFAULT_TRANSITION_MS,
        beatAlignEnabled: beatAlign
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
   * 预取下一首歌词文本（主歌词）
   * 歌词通常在歌曲成为当前曲后才拉取，预解码阶段 next.lyrics 多为空，
   * 这里按来源补拉：网易云曲目用 sourceSongId，其余用"标题 + 歌手"在线匹配。
   * @returns 主歌词文本（无/失败返回空串）
   */
  private async fetchNextLyrics(next: PlayerSong): Promise<string> {
    try {
      if (
        (next.source === 'wy' || next.source === 'netease') &&
        next.sourceSongId != null
      ) {
        const result = await window.electron.ipcRenderer.invoke(
          'lyric:fetch-wy',
          String(next.sourceSongId)
        )
        return (result as { lyrics?: string } | null)?.lyrics || ''
      }
      if (next.title) {
        const result = await window.electron.ipcRenderer.invoke('lyric:fetch-local', {
          title: next.title,
          artist: next.artist || ''
        })
        return (result as { lyrics?: string } | null)?.lyrics || ''
      }
    } catch (e) {
      console.warn('[TransitionController] 预取下一首歌词失败:', e)
    }
    return ''
  }

  /**
   * 对下一曲开头 STRETCH_APPLY_SEC 秒做节奏对齐（仅 WSOLA 变速，不变调），
   * 其余部分原速拼接，避免整曲处理耗时阻塞过渡，也让变速影响在几秒内结束。
   * 变速会改变音高走向，故这里只变速速度、不做变调，保证人声/调性听感尽量自然。
   */
  private async alignNextAudio(plan: TransitionPlan): Promise<void> {
    const src = audioEngine.nextAudioBuffer
    if (!src) return
    const needsStretch = Math.abs(plan.stretchRatio - 1) >= 0.01
    if (!needsStretch) return

    const headLen = Math.min(src.length, Math.floor(STRETCH_APPLY_SEC * src.sampleRate))
    const headOutLen = Math.round(headLen * plan.stretchRatio)
    const out = new AudioBuffer({
      numberOfChannels: src.numberOfChannels,
      length: Math.max(1, headOutLen + (src.length - headLen)),
      sampleRate: src.sampleRate
    })

    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const srcData = src.getChannelData(ch)
      // WSOLA 变速只读输入、只写输出，故传入 subarray 视图即可，无需先 slice 一份副本；
      // timeStretchPcmAsync 直接返回新建的独立缓冲（|ratio-1|<0.01 时原样返回输入，此时同样不被修改）。
      const head = await timeStretchPcmAsync(srcData.subarray(0, headLen), plan.stretchRatio)
      const outCh = out.getChannelData(ch)
      outCh.set(head.subarray(0, Math.min(head.length, out.length)), 0)
      // 尾部原速拼接
      const tailLen = Math.min(src.length - headLen, out.length - head.length)
      if (tailLen > 0) outCh.set(srcData.subarray(headLen, headLen + tailLen), head.length)
    }
    audioEngine.setNextAudioBuffer(out)
  }

  /** 执行过渡（统一为双源交叉淡化：两首歌同时淡入和淡出） */
  private executeTransition(currentPositionMs: number): void {
    if (this.executed || !this.pendingSong || !this.plan) return
    this.executed = true
    this.player.setTransitioning(true)

    const fadeMs = this.plan.transitionDurationMs
    const curve = this.player.transitionCurve
    const bassSwap = this.player.transitionBassSwap

    // 让"首句歌词开始"落在交叉淡化中段、两曲音量大致持平的感知接管点，
    // 而不是淡入起点或淡出尾端：
    // - 从淡入起点就播首句：首句在低音量淡入期被"吃掉"，淡完后已是首句结尾；
    // - 退回整段 fadeMs：又会在淡出期提前暴露一大段前奏，显得过早。
    // 等功率曲线中点在 50%（cos45°=sin45°≈0.707，两曲等响）；线性曲线沿用旧折中值 0.44。
    const landingRatio =
      curve === 'linear' ? NEXT_LANDING_EARLY_RATIO_LINEAR : NEXT_LANDING_EARLY_RATIO_EQUAL_POWER
    const backoffMs = Math.round(fadeMs * landingRatio)
    const effectiveOffsetMs = Math.max(0, this.plan.startOffsetMs - backoffMs)

    // 精确调度：把交叉淡化排程到 triggerMs 对应的音频时刻，而非"下一次轮询才启动"。
    // startDelayMs 补偿当前进度与触发点的差值，抖动由 AudioContext 时钟保证（采样级）。
    const startDelayMs = Math.max(0, Math.round(this.plan.triggerMs - currentPositionMs))

    const ok = audioEngine.beginCrossfade(fadeMs, effectiveOffsetMs, startDelayMs, {
      curve,
      bassSwap
    })
    if (!ok) {
      // 预解码失败或引擎不可用：回退到常规切歌路径
      this.rollback()
      return
    }

    const pendingSong = this.pendingSong
    const pendingIndex = this.pendingIndex
    const startOffsetMs = this.plan.startOffsetMs

    // 交叉淡化起播后才切换歌曲信息，避免 UI（PlayerBar/PlayerPage/SMTC）在延迟窗口内
    // 提前切到下一曲、导致进度条跳变（引擎在起播前仍报当前曲位置）
    const applyUiSwitch = (): void => {
      this.player.setPosition(startOffsetMs)
      this.player.setTransitionConsumed(true)
      this.player.previewTransitionSong(pendingSong, pendingIndex)
      const nextAudio = audioEngine.nextAudioBuffer
      if (nextAudio) {
        this.player.setDuration(Math.round(nextAudio.duration * 1000))
      }
    }

    if (startDelayMs > 0) {
      this.clearUiSwitchTimer()
      this.uiSwitchTimer = window.setTimeout(() => {
        this.uiSwitchTimer = null
        // 若期间被中断（切歌/seek/pause）则已 clearUiSwitchTimer，回调不会到达此处
        applyUiSwitch()
      }, startDelayMs)
    } else {
      applyUiSwitch()
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
    this.clearUiSwitchTimer()
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
